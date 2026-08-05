import {promises as fs} from 'fs';
import path from 'path';
import crypto from 'crypto';

const METADATA_DIRECTORY = '.drawio-workspace';
const MEMORY_FILE = 'assistant-memory.json';
const MEMORY_VERSION = 1;
const MAX_FILE_SIZE = 512 * 1024;
const MAX_MEMORIES = 100;
const MAX_CHANGES = 80;
const MAX_CELLS = 300;
const MAX_RETRIEVED = 5;
const STYLE_KEYS = new Set([
	'fillColor', 'strokeColor', 'fontColor', 'rounded', 'dashed', 'shadow',
	'fontStyle', 'shape', 'align', 'verticalAlign', 'endArrow', 'edgeStyle',
	'opacity', 'strokeWidth'
]);
const MEMORY_CATEGORIES = new Set(['labels', 'geometry', 'styles', 'structure', 'connections']);
const QUALITY_ISSUE_TYPES = new Set([
	'invalidGeometry', 'outOfBounds', 'overlap', 'invalidConnection', 'inconsistentAlignment',
	'inconsistentSpacing'
]);

function memoryError(message, code)
{
	const error = new Error(message);
	error.code = code;
	return error;
}

function boundedString(value, maxLength = 500)
{
	return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').
		replace(/\s+/g, ' ').trim().slice(0, maxLength) : '';
}

function finiteNumber(value)
{
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeGeometry(value)
{
	if (value == null || typeof value !== 'object' || Array.isArray(value)) return null;
	const geometry = {};

	for (const key of ['x', 'y', 'width', 'height'])
	{
		const number = finiteNumber(value[key]);
		if (number != null && Math.abs(number) <= 100000) geometry[key] = number;
	}

	return Object.keys(geometry).length > 0 ? geometry : null;
}

function normalizeStyle(value)
{
	if (value == null || typeof value !== 'object' || Array.isArray(value)) return {};
	const style = {};

	for (const [key, raw] of Object.entries(value))
	{
		if (!STYLE_KEYS.has(key) || !['string', 'number', 'boolean'].includes(typeof raw)) continue;
		const normalized = boundedString(String(raw), 80);
		if (normalized !== '') style[key] = normalized;
	}

	return style;
}

function normalizeCell(value)
{
	if (value == null || typeof value !== 'object' || Array.isArray(value)) return null;
	const id = boundedString(value.id, 100);
	if (id === '') return null;
	const type = value.type === 'edge' ? 'edge' : 'vertex';
	const result = {id, type, label: boundedString(value.label, 500), style: normalizeStyle(value.style)};
	const geometry = normalizeGeometry(value.geometry);
	if (geometry != null) result.geometry = geometry;

	if (type === 'edge')
	{
		result.sourceId = boundedString(value.sourceId, 100) || null;
		result.targetId = boundedString(value.targetId, 100) || null;
	}

	return result;
}

export function normalizeDiagramSnapshot(value)
{
	if (value == null || typeof value !== 'object' || !Array.isArray(value.cells))
	{
		throw memoryError('图形快照无效', 'INVALID_MEMORY_INPUT');
	}

	if (value.cells.length > MAX_CELLS)
	{
		throw memoryError('图形快照超过 300 个图形', 'INVALID_MEMORY_INPUT');
	}

	return {
		scope: value.scope === 'selection' ? 'selection' : 'page',
		pageName: boundedString(value.pageName, 200),
		cells: value.cells.map(normalizeCell).filter(Boolean)
	};
}

function equalValue(left, right)
{
	return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function compactCell(cell)
{
	const result = {type: cell.type, label: cell.label};
	if (cell.geometry != null) result.geometry = cell.geometry;
	if (Object.keys(cell.style).length > 0) result.style = cell.style;
	if (cell.type === 'edge')
	{
		result.sourceId = cell.sourceId;
		result.targetId = cell.targetId;
	}
	return result;
}

function normalizeCompactCell(value)
{
	if (value == null || typeof value !== 'object' || Array.isArray(value)) return null;
	const type = value.type === 'edge' ? 'edge' : 'vertex';
	const result = {type, label: boundedString(value.label, 500)};
	const geometry = normalizeGeometry(value.geometry);
	if (geometry != null) result.geometry = geometry;
	const style = normalizeStyle(value.style);
	if (Object.keys(style).length > 0) result.style = style;
	if (type === 'edge')
	{
		result.sourceId = boundedString(value.sourceId, 100) || null;
		result.targetId = boundedString(value.targetId, 100) || null;
	}
	return result;
}

function normalizeStoredChange(value)
{
	if (value == null || typeof value !== 'object' || Array.isArray(value)) return null;
	const type = boundedString(value.type, 40);
	const cellId = boundedString(value.cellId, 100);
	if (cellId === '') return null;

	if (type === 'label')
	{
		return {type, cellId, from: boundedString(value.from, 500), to: boundedString(value.to, 500)};
	}

	if (type === 'geometry')
	{
		return {type, cellId, from: normalizeGeometry(value.from), to: normalizeGeometry(value.to)};
	}

	if (type === 'style')
	{
		const key = boundedString(value.key, 40);
		if (!STYLE_KEYS.has(key)) return null;
		return {type, cellId, key, from: value.from == null ? null : boundedString(String(value.from), 80),
			to: value.to == null ? null : boundedString(String(value.to), 80)};
	}

	if (type === 'connection')
	{
		function endpoints(item)
		{
			if (item == null || typeof item !== 'object' || Array.isArray(item)) return null;
			return {sourceId: boundedString(item.sourceId, 100) || null,
				targetId: boundedString(item.targetId, 100) || null};
		}
		return {type, cellId, from: endpoints(value.from), to: endpoints(value.to)};
	}

	if (['cellAdded', 'connectionAdded'].includes(type))
	{
		const after = normalizeCompactCell(value.after);
		return after == null ? null : {type, cellId, after};
	}

	if (['cellDeleted', 'connectionDeleted'].includes(type))
	{
		const before = normalizeCompactCell(value.before);
		return before == null ? null : {type, cellId, before};
	}

	return null;
}

function normalizeQualityIssue(value)
{
	if (value == null || typeof value !== 'object' || Array.isArray(value) ||
		!QUALITY_ISSUE_TYPES.has(value.type) || !Array.isArray(value.cellIds)) return null;
	const cellIds = value.cellIds.map(id => boundedString(id, 100)).filter(Boolean).slice(0, 12);
	return cellIds.length > 0 ? {type: value.type, cellIds} : null;
}

export function deriveCorrection(afterAiInput, correctedInput)
{
	const afterAi = normalizeDiagramSnapshot(afterAiInput);
	const corrected = normalizeDiagramSnapshot(correctedInput);
	const beforeById = new Map(afterAi.cells.map(cell => [cell.id, cell]));
	const afterById = new Map(corrected.cells.map(cell => [cell.id, cell]));
	const changes = [];
	const categories = new Set();

	function add(change, category)
	{
		if (changes.length >= MAX_CHANGES) return;
		changes.push(change);
		categories.add(category);
	}

	for (const [id, before] of beforeById)
	{
		const after = afterById.get(id);

		if (after == null)
		{
			add({type: before.type === 'edge' ? 'connectionDeleted' : 'cellDeleted',
				cellId: id, before: compactCell(before)}, before.type === 'edge' ? 'connections' : 'structure');
			continue;
		}

		if (before.label !== after.label)
		{
			add({type: 'label', cellId: id, from: before.label, to: after.label}, 'labels');
		}

		if (!equalValue(before.geometry, after.geometry))
		{
			add({type: 'geometry', cellId: id, from: before.geometry || null,
				to: after.geometry || null}, 'geometry');
		}

		const styleKeys = new Set([...Object.keys(before.style), ...Object.keys(after.style)]);

		for (const key of styleKeys)
		{
			if (before.style[key] !== after.style[key])
			{
				add({type: 'style', cellId: id, key,
					from: before.style[key] ?? null, to: after.style[key] ?? null}, 'styles');
			}
		}

		if (before.type === 'edge' &&
			(before.sourceId !== after.sourceId || before.targetId !== after.targetId))
		{
			add({type: 'connection', cellId: id,
				from: {sourceId: before.sourceId, targetId: before.targetId},
				to: {sourceId: after.sourceId, targetId: after.targetId}}, 'connections');
		}
	}

	for (const [id, after] of afterById)
	{
		if (!beforeById.has(id))
		{
			add({type: after.type === 'edge' ? 'connectionAdded' : 'cellAdded',
				cellId: id, after: compactCell(after)}, after.type === 'edge' ? 'connections' : 'structure');
		}
	}

	return {changes, categories: [...categories], truncated: changes.length >= MAX_CHANGES};
}

function rectanglesOverlap(left, right)
{
	return left.x < right.x + right.width && left.x + left.width > right.x &&
		left.y < right.y + right.height && left.y + left.height > right.y;
}

function median(values)
{
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

export function assessDiagramQuality(snapshotInput)
{
	const snapshot = normalizeDiagramSnapshot(snapshotInput);
	const issues = [];
	const vertices = snapshot.cells.filter(cell => cell.type === 'vertex' && cell.geometry != null);
	const ids = new Set(snapshot.cells.map(cell => cell.id));

	for (const cell of vertices)
	{
		const geometry = cell.geometry;
		if (geometry.width == null || geometry.height == null || geometry.width <= 0 || geometry.height <= 0)
		{
			issues.push({type: 'invalidGeometry', cellIds: [cell.id]});
		}
		else if ((geometry.x ?? 0) < 0 || (geometry.y ?? 0) < 0 ||
			(geometry.x ?? 0) + geometry.width > 10000 || (geometry.y ?? 0) + geometry.height > 10000)
		{
			issues.push({type: 'outOfBounds', cellIds: [cell.id]});
		}
	}

	for (let i = 0; i < vertices.length && issues.length < 30; i++)
	{
		for (let j = i + 1; j < vertices.length && issues.length < 30; j++)
		{
			const left = vertices[i].geometry;
			const right = vertices[j].geometry;
			if (left.width > 0 && left.height > 0 && right.width > 0 && right.height > 0 &&
				rectanglesOverlap(left, right))
			{
				issues.push({type: 'overlap', cellIds: [vertices[i].id, vertices[j].id]});
			}
		}
	}

	for (const edge of snapshot.cells.filter(cell => cell.type === 'edge'))
	{
		if (edge.sourceId == null || edge.targetId == null || !ids.has(edge.sourceId) || !ids.has(edge.targetId))
		{
			issues.push({type: 'invalidConnection', cellIds: [edge.id]});
		}
	}

	if (vertices.length >= 3)
	{
		const xs = vertices.map(cell => Math.round((cell.geometry.x ?? 0) / 10) * 10);
		const ys = vertices.map(cell => Math.round((cell.geometry.y ?? 0) / 10) * 10);
		const aligned = Math.max(...[xs, ys].map(values => Math.max(...values.map(value =>
			values.filter(candidate => candidate === value).length))));
		if (aligned < Math.ceil(vertices.length / 2))
		{
			issues.push({type: 'inconsistentAlignment', cellIds: vertices.slice(0, 12).map(cell => cell.id)});
		}
	}

	if (vertices.length >= 4)
	{
		const centers = vertices.map(cell => ({id: cell.id,
			x: (cell.geometry.x ?? 0) + (cell.geometry.width ?? 0) / 2,
			y: (cell.geometry.y ?? 0) + (cell.geometry.height ?? 0) / 2}));
		const spreadX = Math.max(...centers.map(item => item.x)) - Math.min(...centers.map(item => item.x));
		const spreadY = Math.max(...centers.map(item => item.y)) - Math.min(...centers.map(item => item.y));
		const horizontal = spreadX >= spreadY;
		const crossSpread = horizontal ? spreadY : spreadX;
		const averageCrossSize = vertices.reduce((sum, cell) => sum +
			(horizontal ? (cell.geometry.height ?? 0) : (cell.geometry.width ?? 0)), 0) / vertices.length;

		if (crossSpread <= Math.max(20, averageCrossSize))
		{
			centers.sort((left, right) => horizontal ? left.x - right.x : left.y - right.y);
			const gaps = [];
			for (let index = 1; index < centers.length; index++)
			{
				gaps.push((horizontal ? centers[index].x - centers[index - 1].x :
					centers[index].y - centers[index - 1].y));
			}
			const typicalGap = median(gaps);
			if (Math.max(...gaps) - Math.min(...gaps) > Math.max(30, typicalGap * 0.4))
			{
				issues.push({type: 'inconsistentSpacing', cellIds: centers.slice(0, 12).map(item => item.id)});
			}
		}
	}

	return issues.slice(0, 30);
}

async function getMemoryPaths(root, createDirectory = false)
{
	if (typeof root !== 'string' || root.trim() === '' || root.includes('\0'))
	{
		throw memoryError('尚未设置统一工作区', 'WORKSPACE_NOT_CONFIGURED');
	}

	const resolvedRoot = path.resolve(root);
	const realRoot = await fs.realpath(resolvedRoot);
	const rootStat = await fs.stat(realRoot);
	if (!rootStat.isDirectory()) throw memoryError('统一工作区路径无效', 'INVALID_WORKSPACE');
	const directory = path.join(realRoot, METADATA_DIRECTORY);

	try
	{
		const stat = await fs.lstat(directory);
		if (stat.isSymbolicLink() || !stat.isDirectory())
		{
			throw memoryError('AI 记忆目录无效', 'INVALID_MEMORY_STORE');
		}
	}
	catch (error)
	{
		if (error.code !== 'ENOENT') throw error;
		if (createDirectory) await fs.mkdir(directory, {mode: 0o700});
	}

	return {root: realRoot, directory, file: path.join(directory, MEMORY_FILE)};
}

function normalizeStoredMemory(value)
{
	if (value == null || typeof value !== 'object' || Array.isArray(value)) return null;
	const id = boundedString(value.id, 80);
	const prompt = boundedString(value.prompt, 2000);
	const changes = Array.isArray(value.changes) ? value.changes.map(normalizeStoredChange).
		filter(Boolean).slice(0, MAX_CHANGES) : [];
	const categories = Array.isArray(value.categories) ? value.categories.
		map(item => boundedString(item, 40)).filter(item => MEMORY_CATEGORIES.has(item)).slice(0, 10) : [];
	if (id === '' || prompt === '' || changes.length === 0 || categories.length === 0) return null;
	return {
		id,
		createdAt: finiteNumber(value.createdAt) ?? Date.now(),
		updatedAt: finiteNumber(value.updatedAt) ?? finiteNumber(value.createdAt) ?? Date.now(),
		prompt,
		pageName: boundedString(value.pageName, 200),
		categories,
		changes,
		aiChanges: Array.isArray(value.aiChanges) ? value.aiChanges.map(normalizeStoredChange).
			filter(Boolean).slice(0, MAX_CHANGES) : [],
		qualityBefore: Array.isArray(value.qualityBefore) ? value.qualityBefore.
			map(normalizeQualityIssue).filter(Boolean).slice(0, 30) : [],
		qualityAfter: Array.isArray(value.qualityAfter) ? value.qualityAfter.
			map(normalizeQualityIssue).filter(Boolean).slice(0, 30) : []
	};
}

async function readStore(root)
{
	let paths;

	try { paths = await getMemoryPaths(root); }
	catch (error) { throw error; }

	try
	{
		const stat = await fs.lstat(paths.file);
		if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_FILE_SIZE)
		{
			return {version: MEMORY_VERSION, memories: []};
		}
		const parsed = JSON.parse(await fs.readFile(paths.file, 'utf8'));
		if (parsed == null || parsed.version !== MEMORY_VERSION || !Array.isArray(parsed.memories))
		{
			return {version: MEMORY_VERSION, memories: []};
		}
		return {version: MEMORY_VERSION, memories: parsed.memories.map(normalizeStoredMemory).
			filter(Boolean).slice(0, MAX_MEMORIES)};
	}
	catch (error)
	{
		if (error.code === 'ENOENT' || error instanceof SyntaxError)
		{
			return {version: MEMORY_VERSION, memories: []};
		}
		throw error;
	}
}

async function writeStore(root, store)
{
	const paths = await getMemoryPaths(root, true);
	const content = JSON.stringify({version: MEMORY_VERSION,
		memories: store.memories.slice(0, MAX_MEMORIES)}, null, 2) + '\n';
	if (Buffer.byteLength(content, 'utf8') > MAX_FILE_SIZE)
	{
		throw memoryError('AI 记忆文件超过大小限制', 'MEMORY_LIMIT_EXCEEDED');
	}
	const temporary = path.join(paths.directory, `.${MEMORY_FILE}.${crypto.randomUUID()}.tmp`);
	await fs.writeFile(temporary, content, {encoding: 'utf8', flag: 'wx', mode: 0o600});

	try
	{
		try
		{
			const existing = await fs.lstat(paths.file);
			if (existing.isSymbolicLink() || !existing.isFile())
			{
				throw memoryError('AI 记忆文件无效', 'INVALID_MEMORY_STORE');
			}
		}
		catch (error)
		{
			if (error.code !== 'ENOENT') throw error;
		}
		await fs.rename(temporary, paths.file);
	}
	catch (error)
	{
		await fs.rm(temporary, {force: true});
		throw error;
	}
}

function fingerprint(memory)
{
	return crypto.createHash('sha256').update(JSON.stringify({prompt: memory.prompt.toLowerCase(),
		categories: memory.categories, changes: memory.changes})).digest('hex');
}

function publicMemory(memory)
{
	return {id: memory.id, prompt: memory.prompt, pageName: memory.pageName,
		categories: memory.categories, changeCount: memory.changes.length,
		createdAt: memory.createdAt, updatedAt: memory.updatedAt};
}

export async function listAiMemories(root)
{
	const store = await readStore(root);
	return store.memories.sort((a, b) => b.updatedAt - a.updatedAt).map(publicMemory);
}

export async function saveAiCorrection(root, input)
{
	if (input == null || typeof input !== 'object')
	{
		throw memoryError('纠错内容无效', 'INVALID_MEMORY_INPUT');
	}
	const prompt = boundedString(input.prompt, 2000);
	if (prompt === '') throw memoryError('缺少产生本次修改的问题', 'INVALID_MEMORY_INPUT');
	const correction = deriveCorrection(input.afterAi, input.corrected);
	if (correction.changes.length === 0)
	{
		throw memoryError('没有检测到 AI 应用后的人工作图修改', 'NO_CORRECTION');
	}
	const corrected = normalizeDiagramSnapshot(input.corrected);
	const beforeAi = input.beforeAi != null ? normalizeDiagramSnapshot(input.beforeAi) : null;
	const aiCorrection = beforeAi != null ? deriveCorrection(beforeAi, input.afterAi) :
		{changes: []};
	const now = Date.now();
	const memory = {
		id: crypto.randomUUID(), createdAt: now, updatedAt: now, prompt,
		pageName: boundedString(input.pageName || corrected.pageName, 200),
		categories: correction.categories, changes: correction.changes,
		aiChanges: aiCorrection.changes,
		qualityBefore: assessDiagramQuality(input.afterAi),
		qualityAfter: assessDiagramQuality(input.corrected)
	};
	const store = await readStore(root);
	const hash = fingerprint(memory);
	const duplicate = store.memories.find(item => fingerprint(item) === hash);

	if (duplicate != null)
	{
		duplicate.updatedAt = now;
		await writeStore(root, store);
		return {...publicMemory(duplicate), deduplicated: true};
	}

	store.memories.unshift(memory);
	store.memories = store.memories.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_MEMORIES);
	await writeStore(root, store);
	return {...publicMemory(memory), deduplicated: false};
}

export async function deleteAiMemory(root, id)
{
	id = boundedString(id, 80);
	if (id === '') throw memoryError('记忆编号无效', 'INVALID_MEMORY_INPUT');
	const store = await readStore(root);
	const before = store.memories.length;
	store.memories = store.memories.filter(memory => memory.id !== id);
	if (store.memories.length === before) return false;
	await writeStore(root, store);
	return true;
}

function terms(value)
{
	const text = boundedString(value, 8000).toLowerCase();
	const matches = text.match(/[a-z0-9_\-]{2,}|[\u3400-\u9fff]{2,}/g) || [];
	const result = new Set();
	for (const match of matches)
	{
		result.add(match);
		if (/^[\u3400-\u9fff]+$/.test(match))
		{
			for (let index = 0; index < match.length - 1; index++) result.add(match.slice(index, index + 2));
		}
	}
	return result;
}

function memorySearchText(memory)
{
	return [memory.prompt, memory.pageName, memory.categories.join(' '),
		JSON.stringify(memory.changes)].join(' ');
}

export async function retrieveRelevantMemories(root, input, limit = MAX_RETRIEVED)
{
	const store = await readStore(root);
	const prompt = boundedString(input?.prompt, 6000);
	const context = input?.context != null ? normalizeDiagramSnapshot(input.context) :
		{pageName: '', cells: []};
	const queryTerms = terms([prompt, context.pageName,
		context.cells.map(cell => cell.label).join(' ')].join(' '));
	const scored = store.memories.map(memory =>
	{
		const candidateTerms = terms(memorySearchText(memory));
		let score = 0;
		for (const term of queryTerms) if (candidateTerms.has(term)) score += term.length > 2 ? 3 : 1;
		if (context.pageName !== '' && context.pageName === memory.pageName) score += 4;
		return {memory, score};
	}).filter(item => item.score > 0).sort((left, right) => right.score - left.score ||
		right.memory.updatedAt - left.memory.updatedAt).slice(0, Math.max(0, Math.min(MAX_RETRIEVED, limit)));

	return scored.map(item => ({...publicMemory(item.memory), score: item.score,
		changes: item.memory.changes, aiChanges: item.memory.aiChanges,
		qualityBefore: item.memory.qualityBefore,
		qualityAfter: item.memory.qualityAfter}));
}

export function formatMemoriesForPrompt(memories)
{
	if (!Array.isArray(memories) || memories.length === 0) return '';
	return 'CONFIRMED_USER_CORRECTION_MEMORY_JSON:\n' + JSON.stringify(memories.map(memory => ({
		prompt: memory.prompt, categories: memory.categories, aiChanges: memory.aiChanges,
		changes: memory.changes,
		qualityBefore: memory.qualityBefore, qualityAfter: memory.qualityAfter
	}))) + '\nUse these only as relevant user-confirmed preferences. Current request and diagram context take precedence.';
}
