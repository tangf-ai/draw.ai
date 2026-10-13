import {spawn as nodeSpawn} from 'node:child_process';
import crypto from 'node:crypto';
import {createReadStream, readdirSync, constants as fsConstants, promises as fs} from 'node:fs';
import path from 'node:path';
import {StringDecoder} from 'node:string_decoder';
import {DOMParser} from '@xmldom/xmldom';

const SESSION_STORE_KEY = 'workspaceAgent.piSessions';
const PI_PROFILE_STORE_KEY = 'workspaceAgent.piProfile';
const DEFAULT_PI_COMMAND = 'pi';
const PI_SESSION_DIRECTORY = 'pi-sessions';
const CHECKPOINT_RESULT_FILE = 'result.json';
const MAX_MESSAGES = 100;
const MAX_PROMPT_LENGTH = 30000;
const MAX_CONTEXT_LENGTH = 300000;
const MAX_DRAWIO_FILES = 1000;
const MAX_DRAWIO_FILE_BYTES = 64 * 1024 * 1024;
const MAX_CHECKPOINT_BYTES = 512 * 1024 * 1024;
const MAX_CHECKPOINTS = 20;
const TURN_TIMEOUT_MS = 10 * 60 * 1000;
const RPC_TIMEOUT_MS = 30000;
const MAX_STDERR_LENGTH = 200000;
const SKIPPED_DIRECTORIES = new Set(['.git', '.draw.ai', 'node_modules']);

function defaultListDirectories(directory)
{
	try
	{
		return readdirSync(directory, {withFileTypes: true}).
			filter(entry => entry.isDirectory()).map(entry => entry.name);
	}
	catch (error)
	{
		return [];
	}
}

function compareNodeVersions(left, right)
{
	const parse = value => String(value).replace(/^v/, '').split('.').
		map(part => parseInt(part, 10) || 0);
	const leftParts = parse(left);
	const rightParts = parse(right);

	for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index++)
	{
		const difference = (rightParts[index] || 0) - (leftParts[index] || 0);
		if (difference !== 0) return difference;
	}

	return 0;
}

// GUI launches on macOS do not inherit the login shell's PATH, so a `pi`
// installed by nvm, fnm, pnpm, yarn, or bun is invisible unless its bin
// directory is added explicitly.
function versionManagerCandidates(home, listDirectories)
{
	const candidates = [];
	const nvmRoot = path.join(home, '.nvm', 'versions', 'node');

	for (const version of listDirectories(nvmRoot).slice().sort(compareNodeVersions))
	{
		candidates.push(path.join(nvmRoot, version, 'bin'));
	}

	candidates.push(
		path.join(home, '.local', 'share', 'fnm', 'aliases', 'default', 'bin'),
		path.join(home, 'Library', 'Application Support', 'fnm', 'aliases', 'default', 'bin'),
		path.join(home, '.nodenv', 'shims'),
		path.join(home, 'Library', 'pnpm'),
		path.join(home, '.local', 'share', 'pnpm'),
		path.join(home, '.yarn', 'bin'),
		path.join(home, '.bun', 'bin'));

	return candidates;
}

export function buildLocalEngineEnvironment(source = process.env, platform = process.platform,
	listDirectories = defaultListDirectories)
{
	const env = {...source};
	const home = source.HOME || source.USERPROFILE || '';
	const candidates = [];

	if (home !== '')
	{
		candidates.push(path.join(home, '.local', 'bin'), path.join(home, 'bin'),
			path.join(home, '.volta', 'bin'), path.join(home, '.asdf', 'shims'),
			path.join(home, '.local', 'share', 'mise', 'shims'));
		candidates.push(...versionManagerCandidates(home, listDirectories));

		if (platform === 'win32') candidates.push(path.join(home, 'AppData', 'Roaming', 'npm'));
	}

	if (platform === 'darwin') candidates.push('/opt/homebrew/bin', '/usr/local/bin');
	if (source.APPDATA) candidates.push(path.join(source.APPDATA, 'npm'));
	candidates.push(...String(source.PATH || source.Path || '').split(path.delimiter));
	env.PATH = [...new Set(candidates.filter(Boolean))].join(path.delimiter);
	return env;
}

export function readWorkspaceAgentPiProfile(store)
{
	const current = store?.get(PI_PROFILE_STORE_KEY);
	const source = current != null && typeof current === 'object' ? current : {};

	try
	{
		return normalizeWorkspaceAgentPiProfile({
			command: typeof source.command === 'string' && source.command.trim() !== '' ?
				source.command : DEFAULT_PI_COMMAND,
			model: source.model
		});
	}
	catch (error)
	{
		return {command: DEFAULT_PI_COMMAND, model: ''};
	}
}

function normalizeWorkspaceAgentPiProfile(value)
{
	const source = value != null && typeof value === 'object' ? value : {};
	const command = typeof source.command === 'string' ? source.command.trim() : '';
	const model = typeof source.model === 'string' ? source.model.trim() : '';

	if (command === '' || command.length > 2048 || /[\0\r\n]/.test(command))
	{
		throw agentError('Pi 命令无效', 'WORKSPACE_AGENT_INVALID_INPUT');
	}

	if (model.length > 200 || /[\0\r\n]/.test(model))
	{
		throw agentError('模型名称无效', 'WORKSPACE_AGENT_INVALID_INPUT');
	}

	return {command, model};
}

function agentError(message, code)
{
	const error = new Error(message);
	if (code) error.code = code;
	return error;
}

function cleanText(value, label, maxLength)
{
	if (typeof value !== 'string' || value.trim() === '')
	{
		throw agentError(`${label}不能为空`, 'WORKSPACE_AGENT_INVALID_INPUT');
	}

	const result = value.trim();

	if (result.length > maxLength)
	{
		throw agentError(`${label}过长`, 'WORKSPACE_AGENT_INVALID_INPUT');
	}

	return result;
}

function normalizeRelativePath(value)
{
	return value.split(path.sep).join('/');
}

function isInside(root, candidate)
{
	const relative = path.relative(root, candidate);
	return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) &&
		!path.isAbsolute(relative);
}

function workspaceKey(root)
{
	return crypto.createHash('sha256').update(root).digest('hex').slice(0, 24);
}

function fileHash(filePath)
{
	return new Promise((resolve, reject) =>
	{
		const hash = crypto.createHash('sha256');
		const stream = createReadStream(filePath);
		stream.on('error', reject);
		stream.on('data', chunk => hash.update(chunk));
		stream.on('end', () => resolve(hash.digest('hex')));
	});
}

function readSessions(store)
{
	const sessions = store?.get(SESSION_STORE_KEY);
	return sessions != null && typeof sessions === 'object' && !Array.isArray(sessions) ?
		{...sessions} : {};
}

function readSession(store, root)
{
	const value = readSessions(store)[workspaceKey(root)];

	if (value == null || typeof value !== 'object' || value.root !== root)
	{
		return {root, sessionId: null, messages: [], lastCheckpoint: null};
	}

	return {
		root,
		sessionId: typeof value.sessionId === 'string' ? value.sessionId : null,
		messages: Array.isArray(value.messages) ? value.messages.slice(-MAX_MESSAGES) : [],
		lastCheckpoint: value.lastCheckpoint != null && typeof value.lastCheckpoint === 'object' ?
			value.lastCheckpoint : null
	};
}

function writeSession(store, session)
{
	if (store == null) return;
	const sessions = readSessions(store);
	session.messages = session.messages.slice(-MAX_MESSAGES);
	sessions[workspaceKey(session.root)] = session;
	store.set(SESSION_STORE_KEY, sessions);
}

function appendMessage(store, session, message)
{
	session.messages.push({id: crypto.randomUUID(), createdAt: Date.now(), ...message});
	writeSession(store, session);
}

async function resolveWorkspaceRoot(getWorkspaceRoot)
{
	const configured = typeof getWorkspaceRoot === 'function' ? getWorkspaceRoot() : null;

	if (typeof configured !== 'string' || configured === '')
	{
		throw agentError('请先设置图纸工作区', 'WORKSPACE_AGENT_NO_WORKSPACE');
	}

	let root;

	try
	{
		root = await fs.realpath(path.resolve(configured));
		const stat = await fs.stat(root);
		if (!stat.isDirectory()) throw new Error('not a directory');
	}
	catch (error)
	{
		throw agentError('图纸工作区不可用，请重新选择工作区', 'WORKSPACE_AGENT_NO_WORKSPACE');
	}

	return root;
}

async function resolveDiagramPath(root, filePath)
{
	const requested = path.resolve(cleanText(filePath, '当前图文件', 4096));
	let resolved;

	try
	{
		resolved = await fs.realpath(requested);
	}
	catch (error)
	{
		throw agentError('当前图文件不存在', 'WORKSPACE_AGENT_FILE_NOT_FOUND');
	}

	if (!isInside(root, resolved) || path.extname(resolved).toLowerCase() !== '.drawio')
	{
		throw agentError('Workspace Agent 只能操作工作区中的 .drawio 文件',
			'WORKSPACE_AGENT_FILE_OUTSIDE_WORKSPACE');
	}

	return resolved;
}

// `knownHashes` maps a relative path to a previously recorded manifest entry.
// When size and mtime still match, the stored digest is reused so an unchanged
// diagram does not have to be read again on every Agent turn.
async function scanDrawioFiles(root, {onFile, knownHashes} = {})
{
	let count = 0;
	let totalBytes = 0;
	const manifest = [];

	async function visit(directory)
	{
		const entries = await fs.readdir(directory, {withFileTypes: true});
		entries.sort((left, right) => left.name.localeCompare(right.name));

		for (const entry of entries)
		{
			const absolutePath = path.join(directory, entry.name);

			if (entry.isSymbolicLink()) continue;

			if (entry.isDirectory())
			{
				if (!SKIPPED_DIRECTORIES.has(entry.name)) await visit(absolutePath);
				continue;
			}

			if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.drawio') continue;
			count++;

			if (count > MAX_DRAWIO_FILES)
			{
				throw agentError(`工作区超过 ${MAX_DRAWIO_FILES} 个图文件，无法建立安全检查点`,
					'WORKSPACE_AGENT_CHECKPOINT_LIMIT');
			}

			const stat = await fs.stat(absolutePath);

			if (stat.size > MAX_DRAWIO_FILE_BYTES)
			{
				throw agentError(`图文件过大，无法建立安全检查点：${entry.name}`,
					'WORKSPACE_AGENT_CHECKPOINT_LIMIT');
			}

			const relativePath = normalizeRelativePath(path.relative(root, absolutePath));
			totalBytes += stat.size;

			if (totalBytes > MAX_CHECKPOINT_BYTES)
			{
				throw agentError('工作区图文件总量过大，无法建立安全检查点',
					'WORKSPACE_AGENT_CHECKPOINT_LIMIT');
			}

			const known = knownHashes?.get(relativePath);
			const hash = known != null && known.size === stat.size && known.mtimeMs === stat.mtimeMs ?
				known.hash : await fileHash(absolutePath);
			const item = {path: relativePath, size: stat.size, mtimeMs: stat.mtimeMs, hash};
			manifest.push(item);
			if (onFile) await onFile(item, absolutePath);
		}
	}

	await visit(root);
	return manifest;
}

async function writeJson(filePath, value)
{
	await fs.writeFile(filePath, JSON.stringify(value, null, 2), {encoding: 'utf8', flag: 'wx'});
}

async function createCheckpoint(root, stateDir, knownHashes)
{
	const checkpointRoot = path.join(stateDir, 'checkpoints', workspaceKey(root));
	const id = `${Date.now()}-${crypto.randomUUID()}`;
	const directory = path.join(checkpointRoot, id);
	const filesDirectory = path.join(directory, 'files');
	await fs.mkdir(filesDirectory, {recursive: true});

	try
	{
		const before = await scanDrawioFiles(root, {knownHashes, onFile: async (item, sourcePath) =>
		{
			const snapshotPath = path.join(filesDirectory, ...item.path.split('/'));
			await fs.mkdir(path.dirname(snapshotPath), {recursive: true});
			// COPYFILE_FICLONE asks APFS for a copy-on-write clone and falls back
			// to a regular copy where reflinks are unavailable.
			await fs.copyFile(sourcePath, snapshotPath, fsConstants.COPYFILE_FICLONE);
		}});
		const checkpoint = {id, root, directory, createdAt: Date.now(), before};
		await writeJson(path.join(directory, 'checkpoint.json'), checkpoint);
		return checkpoint;
	}
	catch (error)
	{
		await fs.rm(directory, {recursive: true, force: true}).catch(() => {});
		throw error;
	}
}

function manifestMap(manifest)
{
	return new Map(manifest.map(item => [item.path, item]));
}

function diffManifests(before, after)
{
	const beforeMap = manifestMap(before);
	const afterMap = manifestMap(after);
	const changes = [];

	for (const [filePath, item] of afterMap)
	{
		const previous = beforeMap.get(filePath);
		if (previous == null) changes.push({path: filePath, kind: 'created'});
		else if (previous.hash !== item.hash) changes.push({path: filePath, kind: 'modified'});
	}

	for (const filePath of beforeMap.keys())
	{
		if (!afterMap.has(filePath)) changes.push({path: filePath, kind: 'deleted'});
	}

	return changes.sort((left, right) => left.path.localeCompare(right.path));
}

export async function validateDrawioFile(filePath)
{
	const data = await fs.readFile(filePath, 'utf8');
	const errors = [];
	const parser = new DOMParser({
		errorHandler: {
			warning() {},
			error(message) { errors.push(String(message)); },
			fatalError(message) { errors.push(String(message)); }
		}
	});
	const document = parser.parseFromString(data, 'application/xml');
	const root = document.documentElement;
	const rootName = root?.localName || root?.nodeName;

	if (errors.length > 0 || (rootName !== 'mxfile' && rootName !== 'mxGraphModel'))
	{
		throw agentError(`图文件 XML 无效：${path.basename(filePath)}`,
			'WORKSPACE_AGENT_INVALID_DRAWIO');
	}

	if (rootName === 'mxfile' && root.getElementsByTagName('diagram').length === 0)
	{
		throw agentError(`图文件不包含 Page：${path.basename(filePath)}`,
			'WORKSPACE_AGENT_INVALID_DRAWIO');
	}

	return true;
}

async function replaceFile(snapshotPath, targetPath)
{
	const data = await fs.readFile(snapshotPath);
	await fs.mkdir(path.dirname(targetPath), {recursive: true});
	const temporaryPath = path.join(path.dirname(targetPath),
		`.draw-ai-restore-${path.basename(targetPath)}-${crypto.randomUUID()}`);

	try
	{
		await fs.writeFile(temporaryPath, data, {flag: 'wx'});
		await fs.rename(temporaryPath, targetPath);
	}
	catch (error)
	{
		await fs.copyFile(snapshotPath, targetPath);
		await fs.unlink(temporaryPath).catch(() => {});
	}
}

async function restoreCheckpoint(checkpoint, changes)
{
	const changedPaths = new Set(changes.map(change => change.path));
	const beforeMap = manifestMap(checkpoint.before);

	for (const change of changes)
	{
		const targetPath = path.join(checkpoint.root, ...change.path.split('/'));

		if (change.kind === 'created' && !beforeMap.has(change.path))
		{
			await fs.unlink(targetPath).catch(error =>
			{
				if (error.code !== 'ENOENT') throw error;
			});
		}
	}

	for (const item of checkpoint.before)
	{
		if (!changedPaths.has(item.path)) continue;
		const snapshotPath = path.join(checkpoint.directory, 'files', ...item.path.split('/'));
		const targetPath = path.join(checkpoint.root, ...item.path.split('/'));
		await replaceFile(snapshotPath, targetPath);
		await validateDrawioFile(targetPath);
	}
}

async function saveCheckpointResult(checkpoint, after, changes)
{
	const result = {...checkpoint, after, changes};
	await writeJson(path.join(checkpoint.directory, CHECKPOINT_RESULT_FILE), result);
	return {id: checkpoint.id, directory: checkpoint.directory, createdAt: checkpoint.createdAt};
}

async function readCheckpointResult(reference)
{
	if (reference == null || typeof reference.directory !== 'string')
	{
		throw agentError('没有可撤回的 Agent 修改', 'WORKSPACE_AGENT_NO_CHECKPOINT');
	}

	try
	{
		const data = await fs.readFile(path.join(reference.directory, CHECKPOINT_RESULT_FILE), 'utf8');
		return JSON.parse(data);
	}
	catch (error)
	{
		throw agentError('Agent 检查点已经不可用', 'WORKSPACE_AGENT_NO_CHECKPOINT');
	}
}

async function pruneCheckpoints(stateDir, root, keepDirectory)
{
	const checkpointRoot = path.join(stateDir, 'checkpoints', workspaceKey(root));
	let entries;

	try
	{
		entries = await fs.readdir(checkpointRoot, {withFileTypes: true});
	}
	catch (error)
	{
		return;
	}

	const directories = entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort().reverse();

	for (const name of directories.slice(MAX_CHECKPOINTS))
	{
		const candidate = path.join(checkpointRoot, name);
		if (candidate !== keepDirectory) await fs.rm(candidate, {recursive: true, force: true});
	}
}

function redactSensitive(value)
{
	return String(value || '').replace(
		/(api[_-]?key|token|authorization|password)(["'=:\s]+)[^\s,"'}]+/ig,
		'$1$2[REDACTED]').slice(0, 4000);
}

// Pi speaks strict JSONL on stdin/stdout: records are delimited by LF only.
// Node's readline also splits on U+2028/U+2029, which are legal inside JSON
// strings, so the client frames records itself with a StringDecoder.
function attachJsonlReader(stream, onLine)
{
	const decoder = new StringDecoder('utf8');
	let buffer = '';

	function drain(final)
	{
		buffer += final ? decoder.end() : '';

		while (true)
		{
			const index = buffer.indexOf('\n');
			if (index === -1) break;
			const line = buffer.slice(0, index).replace(/\r$/, '');
			buffer = buffer.slice(index + 1);
			if (line !== '') onLine(line);
		}

		if (final && buffer !== '')
		{
			const line = buffer.replace(/\r$/, '');
			buffer = '';
			if (line !== '') onLine(line);
		}
	}

	stream.on('data', chunk =>
	{
		buffer += decoder.write(chunk);
		drain(false);
	});
	stream.on('end', () => drain(true));
}

const PI_DIALOG_METHODS = new Set(['confirm', 'select', 'input', 'editor']);

class PiRpcClient
{
	constructor({command, cwd, sessionDirectory, sessionId, model, spawnImpl, ephemeral = false,
		onEvent, onUiRequest, onExit})
	{
		this.command = command;
		this.cwd = cwd;
		this.sessionDirectory = sessionDirectory;
		this.sessionId = sessionId;
		this.model = model;
		this.spawnImpl = spawnImpl;
		this.ephemeral = ephemeral;
		this.onEvent = onEvent;
		this.onUiRequest = onUiRequest;
		this.onExit = onExit;
		this.child = null;
		this.starting = null;
		this.pending = new Map();
		this.nextId = 0;
		this.stderr = '';
		this.expectedClose = false;
		this.exitHandled = false;
		this.exitError = null;
	}

	buildArgs()
	{
		if (this.ephemeral) return ['--mode', 'rpc', '--no-session'];

		const args = ['--mode', 'rpc', '--session-dir', this.sessionDirectory,
			'--session-id', this.sessionId, '--append-system-prompt', workspaceDeveloperInstructions()];

		if (this.model !== '') args.push('--model', this.model);
		return args;
	}

	async start()
	{
		if (this.child != null) return;
		if (this.starting != null) return this.starting;

		this.starting = (async () =>
		{
			this.expectedClose = false;
			this.exitHandled = false;
			this.exitError = null;
			this.stderr = '';

			try
			{
				this.child = this.spawnImpl(this.command, this.buildArgs(), {
					cwd: this.cwd,
					env: buildLocalEngineEnvironment(),
					stdio: ['pipe', 'pipe', 'pipe'],
					windowsHide: true
				});
			}
			catch (error)
			{
				throw agentError(`无法启动 Pi：${error.message}`,
					error.code === 'ENOENT' ? 'WORKSPACE_AGENT_PI_NOT_FOUND' : 'WORKSPACE_AGENT_START_FAILED');
			}

			attachJsonlReader(this.child.stdout, line => this.handleLine(line));
			this.child.stderr.on('data', chunk =>
			{
				this.stderr += chunk.toString();
				if (this.stderr.length > MAX_STDERR_LENGTH)
				{
					this.stderr = this.stderr.slice(-MAX_STDERR_LENGTH);
				}
			});
			this.child.on('error', error => this.handleExit(error));
			this.child.on('close', code =>
			{
				if (!this.expectedClose)
				{
					const detail = this.stderr.trim();
					this.handleExit(agentError(detail || `Pi 已退出（状态 ${code}）`,
						'WORKSPACE_AGENT_PI_EXITED'));
				}
			});
		})();

		try
		{
			await this.starting;
		}
		finally
		{
			this.starting = null;
		}
	}

	send(message)
	{
		if (this.child == null || this.child.stdin.destroyed)
		{
			throw agentError('Pi 未连接', 'WORKSPACE_AGENT_NOT_CONNECTED');
		}

		this.child.stdin.write(`${JSON.stringify(message)}\n`);
	}

	async request(type, params = {}, timeoutMs = RPC_TIMEOUT_MS)
	{
		await this.start();

		if (this.child == null || this.child.stdin.destroyed)
		{
			throw this.exitError || agentError('Pi 未连接', 'WORKSPACE_AGENT_NOT_CONNECTED');
		}

		const id = `draw-ai-${++this.nextId}`;

		return new Promise((resolve, reject) =>
		{
			const timer = setTimeout(() =>
			{
				this.pending.delete(id);
				reject(agentError(`Pi 请求超时：${type}`, 'WORKSPACE_AGENT_RPC_TIMEOUT'));
			}, timeoutMs);
			this.pending.set(id, {resolve, reject, timer});

			try
			{
				this.send({id, type, ...params});
			}
			catch (error)
			{
				clearTimeout(timer);
				this.pending.delete(id);
				reject(this.exitError || error);
			}
		});
	}

	respond(payload)
	{
		this.send({type: 'extension_ui_response', ...payload});
	}

	handleLine(line)
	{
		let message;

		try { message = JSON.parse(line); }
		catch (error) { return; }

		if (message.type === 'extension_ui_request')
		{
			this.onUiRequest?.(message);
			return;
		}

		if (message.type === 'response')
		{
			const pending = this.pending.get(message.id);
			if (pending == null) return;
			clearTimeout(pending.timer);
			this.pending.delete(message.id);

			if (message.success === false)
			{
				pending.reject(agentError(message.error || 'Pi 请求失败', 'WORKSPACE_AGENT_RPC_FAILED'));
			}
			else pending.resolve(message.data);
			return;
		}

		this.onEvent?.(message);
	}

	handleExit(error)
	{
		if (this.exitHandled) return;
		this.exitHandled = true;
		const failure = error instanceof Error ?
			(error.code === 'ENOENT' ?
				agentError(`无法启动 Pi：${error.message}`, 'WORKSPACE_AGENT_PI_NOT_FOUND') : error) :
			agentError(String(error), 'WORKSPACE_AGENT_PI_EXITED');
		for (const pending of this.pending.values())
		{
			clearTimeout(pending.timer);
			pending.reject(failure);
		}
		this.pending.clear();
		this.child = null;
		this.exitError = failure;
		this.onExit?.(failure);
	}

	stop()
	{
		this.expectedClose = true;
		for (const pending of this.pending.values())
		{
			clearTimeout(pending.timer);
			pending.reject(agentError('Pi 已停止', 'WORKSPACE_AGENT_STOPPED'));
		}
		this.pending.clear();
		try { this.child?.stdin.end(); } catch (error) {}
		try { this.child?.kill(); } catch (error) {}
		this.child = null;
	}
}

function workspaceDeveloperInstructions()
{
	return [
		'You are the draw.ai Workspace Agent. Work only inside the supplied diagram workspace.',
		'Read the existing .drawio files before editing and preserve their current mxfile/mxGraphModel format.',
		'Use tools to inspect and edit files directly. Do not return a fixed operation JSON plan.',
		'Do not access paths outside the workspace, use the network, delete diagram files, or create auxiliary files.',
		'When the turn identifies selected cells, restrict diagram changes to those cell IDs and their necessary internal edges.',
		'When no cells are selected, obey the supplied current-page or multi-page scope.',
		'After editing, re-read the modified file and verify that it remains valid draw.io XML.',
		'Return a concise Chinese summary of the files and Pages changed.'
	].join('\n');
}

function scopeInstruction(context)
{
	if (context?.scope === 'selection')
	{
		const ids = Array.isArray(context.cells) ? context.cells.map(cell => cell?.id).
			filter(id => typeof id === 'string') : [];
		return `本轮只允许修改选中图形，允许的 cell ID：${ids.join(', ') || '无'}。`;
	}

	if (context?.scope === 'pages')
	{
		const pages = Array.isArray(context.pages) ? context.pages.map(page =>
			`${page?.pageName || '未命名'}(${page?.pageId || ''})`) : [];
		return `本轮页面范围：${pages.join('、')}。`;
	}

	return `本轮页面范围：当前 Page ${context?.pageName || ''}(${context?.pageId || ''})。`;
}

function buildTurnPrompt(prompt, relativeFilePath, context)
{
	const contextJson = JSON.stringify(context || {});

	if (contextJson.length > MAX_CONTEXT_LENGTH)
	{
		throw agentError('当前图纸上下文过大，请缩小 Page 范围', 'WORKSPACE_AGENT_CONTEXT_TOO_LARGE');
	}

	return [
		`当前主图文件：${relativeFilePath}`,
		scopeInstruction(context),
		'除非用户明确点名工作区中的另一个 .drawio 文件，否则只修改当前主图文件。',
		`DRAW_AI_CONTEXT_JSON:\n${contextJson}`,
		`用户要求：\n${prompt}`
	].join('\n\n');
}

function assistantText(message)
{
	const content = message?.content;

	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';

	return content.filter(part => part?.type === 'text' && typeof part.text === 'string')
		.map(part => part.text).join('');
}

function toolActivity(message, phase)
{
	const name = String(message?.toolName || '');
	const args = message?.args != null && typeof message.args === 'object' ? message.args : {};
	const running = phase === 'start';

	if (name === 'bash')
	{
		const command = redactSensitive(args.command || '正在运行命令');
		return {kind: 'command', label: running ? command : `命令执行完成：${command}`};
	}

	if (name === 'edit' || name === 'write')
	{
		const file = path.basename(String(args.path || '图文件'));
		return {kind: 'file', label: running ? `正在修改 ${file}` : `已修改 ${file}`};
	}

	if (name === 'read' || name === 'grep' || name === 'find' || name === 'ls')
	{
		const file = args.path != null ? path.basename(String(args.path)) : '工作区';
		return {kind: 'read', label: running ? `正在读取 ${file}` : `已读取 ${file}`};
	}

	return {kind: 'command', label: running ? `正在执行 ${name || '工具'}` : `已完成 ${name || '工具'}`};
}

function changeSummary(changes)
{
	return changes.map(change => ({path: change.path, kind: change.kind}));
}

function uiRequestDetail(request)
{
	const title = typeof request.title === 'string' ? request.title.trim() : '';
	const message = typeof request.message === 'string' ? request.message.trim() : '';
	const placeholder = typeof request.placeholder === 'string' ? request.placeholder.trim() : '';
	const detail = [title, message, placeholder !== '' && request.method === 'input' ? placeholder : '']
		.filter(part => part !== '').join('\n');
	return redactSensitive(detail || 'Pi 请求继续执行');
}

export function createWorkspaceAgentService({
	store,
	getWorkspaceRoot,
	getPiProfile,
	stateDir,
	spawnImpl = nodeSpawn
})
{
	if (typeof stateDir !== 'string' || stateDir === '')
	{
		throw new Error('Workspace Agent state directory is required');
	}

	const sessionDirectory = path.join(stateDir, PI_SESSION_DIRECTORY);
	let client = null;
	let clientKey = null;
	let verifiedKey = null;
	let active = null;
	let approvalCounter = 0;
	const pendingApprovals = new Map();
	const modelClients = new Set();

	function progress(type, data = {})
	{
		active?.onProgress?.({type, ...data});
	}

	function settleActive(stopReason, errorMessage)
	{
		if (active == null || active.finished) return;
		active.finished = true;

		if (stopReason === 'error')
		{
			active.rejectTurn(agentError(errorMessage || 'Pi 执行失败', 'WORKSPACE_AGENT_TURN_FAILED'));
		}
		else if (stopReason === 'aborted')
		{
			active.rejectTurn(agentError('任务已停止，未完成的修改已经撤回', 'WORKSPACE_AGENT_INTERRUPTED'));
		}
		else active.resolveTurn();
	}

	function handleEvent(message)
	{
		if (active == null || active.finished) return;

		if (message.type === 'agent_start')
		{
			progress('status', {phase: 'working', label: 'Pi 正在处理图纸'});
		}
		else if (message.type === 'message_update')
		{
			const event = message.assistantMessageEvent || {};

			if (event.type === 'text_delta')
			{
				const delta = typeof event.delta === 'string' ? event.delta : '';
				active.streamed += delta;
				progress('message-delta', {delta});
			}
			else if (event.type === 'thinking_delta')
			{
				progress('reasoning', {delta: String(event.delta || '').slice(0, 1200)});
			}
		}
		else if (message.type === 'message_end')
		{
			const item = message.message;

			if (item?.role === 'assistant')
			{
				active.lastAssistant = assistantText(item);
				active.stopReason = item.stopReason;
				active.errorMessage = item.errorMessage;
			}
		}
		else if (message.type === 'tool_execution_start')
		{
			// Pi omits args on tool_execution_end, so remember them for the summary.
			active.tools.set(message.toolCallId, {toolName: message.toolName, args: message.args});
			progress('activity', {id: message.toolCallId, status: 'running',
				...toolActivity(message, 'start')});
		}
		else if (message.type === 'tool_execution_end')
		{
			const started = active.tools.get(message.toolCallId);
			active.tools.delete(message.toolCallId);
			const item = {toolName: message.toolName || started?.toolName,
				args: message.args != null ? message.args : started?.args};
			progress('activity', {id: message.toolCallId, status: message.isError ? 'failed' : 'done',
				...toolActivity(item, 'end')});
		}
		else if (message.type === 'agent_settled')
		{
			settleActive(active.stopReason, active.errorMessage);
		}
	}

	function handleUiRequest(request)
	{
		if (!PI_DIALOG_METHODS.has(request.method))
		{
			// notify/setStatus/setWidget/setTitle/set_editor_text are fire-and-forget.
			return;
		}

		if (active == null || active.finished)
		{
			client?.respond({id: request.id, cancelled: true});
			return;
		}

		const requestId = `approval-${++approvalCounter}`;
		pendingApprovals.set(requestId, {uiId: request.id, method: request.method});
		const approval = {id: requestId, type: request.method, detail: uiRequestDetail(request)};

		if (request.method === 'select' && Array.isArray(request.options))
		{
			approval.options = request.options.slice(0, 12).map(option => String(option).slice(0, 200));
		}

		if (request.method === 'input' || request.method === 'editor')
		{
			approval.valueRequired = true;
			if (typeof request.prefill === 'string') approval.prefill = request.prefill.slice(0, 4000);
		}

		progress('approval', {approval});
	}

	function cancelPendingApprovals()
	{
		for (const pending of pendingApprovals.values())
		{
			try { client?.respond({id: pending.uiId, cancelled: true}); }
			catch (error) {}
		}

		pendingApprovals.clear();
	}

	function handleClientExit(error)
	{
		pendingApprovals.clear();
		verifiedKey = null;

		if (active != null && !active.finished)
		{
			active.finished = true;
			active.rejectTurn(error);
		}
	}

	async function ensureClient(root, profile, sessionId, expectResume)
	{
		const command = cleanText(profile?.command || DEFAULT_PI_COMMAND, 'Pi 命令', 2048);
		const model = typeof profile?.model === 'string' ? profile.model.trim() : '';
		const key = [command, root, sessionId, model].join('\0');

		if (client == null || clientKey !== key)
		{
			client?.stop();
			await fs.mkdir(sessionDirectory, {recursive: true});
			client = new PiRpcClient({command, cwd: root, sessionDirectory, sessionId, model, spawnImpl,
				onEvent: handleEvent, onUiRequest: handleUiRequest, onExit: handleClientExit});
			clientKey = key;
			verifiedKey = null;
		}

		await client.start();

		if (verifiedKey !== key)
		{
			const state = await client.request('get_state');

			if (state?.sessionId !== sessionId)
			{
				throw agentError('Pi 返回了不一致的对话标识', 'WORKSPACE_AGENT_THREAD_RESUME_FAILED');
			}

			if (expectResume && Number(state?.messageCount || 0) === 0)
			{
				throw agentError('无法继续当前 Agent 对话：Pi 找不到已保存的会话。请重试，或明确新建对话',
					'WORKSPACE_AGENT_THREAD_RESUME_FAILED');
			}

			verifiedKey = key;
		}

		return client;
	}

	async function rollbackFailedTurn(checkpoint)
	{
		const current = await scanDrawioFiles(checkpoint.root, {knownHashes: manifestMap(checkpoint.before)});
		const changes = diffManifests(checkpoint.before, current);
		if (changes.length > 0) await restoreCheckpoint(checkpoint, changes);
		await fs.rm(checkpoint.directory, {recursive: true, force: true}).catch(() => {});
		return changes;
	}

	async function readKnownHashes(session)
	{
		if (session.lastCheckpoint == null) return null;

		try
		{
			const previous = await readCheckpointResult(session.lastCheckpoint);
			return manifestMap(previous.after);
		}
		catch (error)
		{
			return null;
		}
	}

	return {
		async getState()
		{
			const profile = typeof getPiProfile === 'function' ? getPiProfile() :
				{command: DEFAULT_PI_COMMAND, model: ''};
			let root = null;

			try { root = await resolveWorkspaceRoot(getWorkspaceRoot); }
			catch (error)
			{
				return {configured: false, busy: false, sessionId: null, messages: [], canRollback: false,
					command: profile.command || DEFAULT_PI_COMMAND, model: profile.model || ''};
			}

			const session = readSession(store, root);
			return {
				configured: true,
				root,
				busy: active != null,
				sessionId: session.sessionId,
				messages: session.messages,
				canRollback: session.lastCheckpoint != null,
				command: profile?.command || DEFAULT_PI_COMMAND,
				model: profile?.model || ''
			};
		},

		getProfile()
		{
			const profile = typeof getPiProfile === 'function' ? getPiProfile() : {};
			return {command: profile.command || DEFAULT_PI_COMMAND, model: profile.model || ''};
		},

		async listModels(input = {})
		{
			const current = typeof getPiProfile === 'function' ? getPiProfile() : {};
			const {command} = normalizeWorkspaceAgentPiProfile({
				command: input.command == null ? current.command || DEFAULT_PI_COMMAND : input.command,
				model: ''
			});
			const configuredRoot = typeof getWorkspaceRoot === 'function' ? getWorkspaceRoot() : null;
			await fs.mkdir(stateDir, {recursive: true});
			const cwd = configuredRoot ? await resolveWorkspaceRoot(getWorkspaceRoot) : stateDir;
			const discovery = new PiRpcClient({command, cwd, spawnImpl, ephemeral: true,
				onUiRequest: request => discovery.respond({id: request.id, cancelled: true})});
			modelClients.add(discovery);

			try
			{
				const result = await discovery.request('get_available_models');
				if (!Array.isArray(result?.models))
				{
					throw agentError('Pi 未返回有效的模型列表', 'WORKSPACE_AGENT_RPC_FAILED');
				}
				const unique = new Map();

				for (const model of result.models)
				{
					if (typeof model?.provider !== 'string' || typeof model?.id !== 'string' ||
						!model.provider || !model.id) continue;
					const value = `${model.provider}/${model.id}`;
					if (value.length > 200 || /[\0\r\n]/.test(value)) continue;
					unique.set(value, {provider: model.provider, id: model.id,
						name: typeof model.name === 'string' ? model.name : model.id});
				}

				return {models: Array.from(unique.values()).sort((a, b) =>
					`${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`))};
			}
			finally
			{
				discovery.stop();
				modelClients.delete(discovery);
			}
		},

		setProfile(input)
		{
			if (active != null) throw agentError('请先停止当前任务，再修改模型配置', 'WORKSPACE_AGENT_BUSY');
			if (store == null) throw agentError('无法保存模型配置', 'WORKSPACE_AGENT_CONFIG_ERROR');
			const current = typeof getPiProfile === 'function' ? getPiProfile() :
				{command: DEFAULT_PI_COMMAND, model: ''};
			const source = input != null && typeof input === 'object' ? input : {};
			const profile = normalizeWorkspaceAgentPiProfile({
				command: source.command == null ? current.command : source.command,
				model: source.model == null ? current.model : source.model
			});
			store.set(PI_PROFILE_STORE_KEY, profile);
			return profile;
		},

		async chat(input, onProgress)
		{
			if (active != null)
			{
				throw agentError('Workspace Agent 正在执行，请先停止或补充要求',
					'WORKSPACE_AGENT_BUSY');
			}

			input = input != null && typeof input === 'object' ? input : {};
			const prompt = cleanText(input.prompt, '问题', MAX_PROMPT_LENGTH);
			const root = await resolveWorkspaceRoot(getWorkspaceRoot);
			const filePath = await resolveDiagramPath(root, input.filePath);
			const relativeFilePath = normalizeRelativePath(path.relative(root, filePath));
			const session = readSession(store, root);
			const profile = typeof getPiProfile === 'function' ? getPiProfile() : {};
			const expectResume = session.sessionId != null && session.messages.some(message =>
				message.role === 'assistant' && message.status === 'completed');
			const sessionId = session.sessionId != null ? session.sessionId : crypto.randomUUID();
			let checkpoint;

			onProgress?.({type: 'status', phase: 'checkpoint', label: '正在建立安全检查点'});
			checkpoint = await createCheckpoint(root, stateDir, await readKnownHashes(session));
			appendMessage(store, session, {role: 'user', text: prompt, filePath: relativeFilePath});

			try
			{
				await ensureClient(root, profile, sessionId, expectResume);
				session.sessionId = sessionId;
				writeSession(store, session);

				let resolveTurn;
				let rejectTurn;
				const turnPromise = new Promise((resolve, reject) =>
				{
					resolveTurn = resolve;
					rejectTurn = reject;
				});
				turnPromise.catch(() => {});
				active = {root, sessionId, onProgress, resolveTurn, rejectTurn, finished: false,
					streamed: '', lastAssistant: '', stopReason: null, errorMessage: null,
					tools: new Map(), session, relativeFilePath};
				onProgress?.({type: 'status', phase: 'connecting', label: '正在连接 Pi'});

				const timeout = setTimeout(() =>
				{
					if (active != null && !active.finished)
					{
						active.finished = true;
						active.rejectTurn(agentError('Pi 执行超时', 'WORKSPACE_AGENT_TURN_TIMEOUT'));
						cancelPendingApprovals();
						client.request('abort', {}, RPC_TIMEOUT_MS).catch(() => {});
					}
				}, TURN_TIMEOUT_MS);

				let turnError = null;

				try
				{
					await client.request('prompt', {
						message: buildTurnPrompt(prompt, relativeFilePath, input.context)
					});
					await turnPromise;
				}
				catch (error)
				{
					turnError = error;
				}
				finally
				{
					clearTimeout(timeout);
				}

				if (turnError != null)
				{
					await rollbackFailedTurn(checkpoint);
					appendMessage(store, session, {role: 'assistant', text: turnError.message,
						status: turnError.code === 'WORKSPACE_AGENT_INTERRUPTED' ? 'interrupted' : 'failed'});
					throw turnError;
				}

				onProgress?.({type: 'status', phase: 'validating', label: '正在校验图文件'});
				const after = await scanDrawioFiles(root, {knownHashes: manifestMap(checkpoint.before)});
				const changes = diffManifests(checkpoint.before, after);

				if (changes.some(change => change.kind === 'deleted'))
				{
					await restoreCheckpoint(checkpoint, changes);
					throw agentError('Pi 删除了图文件，安全策略已自动撤回本轮修改',
						'WORKSPACE_AGENT_UNSAFE_CHANGE');
				}

				try
				{
					for (const change of changes)
					{
						await validateDrawioFile(path.join(root, ...change.path.split('/')));
					}
				}
				catch (error)
				{
					await restoreCheckpoint(checkpoint, changes);
					throw agentError(`${error.message}，已自动撤回本轮修改`, error.code);
				}

				let checkpointReference = null;

				if (changes.length > 0)
				{
					checkpointReference = await saveCheckpointResult(checkpoint, after, changes);
					session.lastCheckpoint = checkpointReference;
					await pruneCheckpoints(stateDir, root, checkpoint.directory);
				}
				else
				{
					await fs.rm(checkpoint.directory, {recursive: true, force: true});
				}

				const finalMessage = active.lastAssistant || active.streamed ||
					(changes.length > 0 ? '图纸修改完成' : '本轮没有修改图文件');
				appendMessage(store, session, {role: 'assistant', text: finalMessage,
					status: 'completed', changes: changeSummary(changes), checkpointId: checkpointReference?.id || null});
				writeSession(store, session);
				onProgress?.({type: 'status', phase: 'completed', label: '修改与校验完成',
					changes: changeSummary(changes)});

				return {reply: finalMessage, changes: changeSummary(changes), sessionId,
					canRollback: checkpointReference != null};
			}
			catch (error)
			{
				if (checkpoint != null)
				{
					const resultPath = path.join(checkpoint.directory, CHECKPOINT_RESULT_FILE);
					const resultExists = await fs.access(resultPath).then(() => true).catch(() => false);
					if (!resultExists) await rollbackFailedTurn(checkpoint).catch(() => {});
				}
				throw error;
			}
			finally
			{
				active = null;
				cancelPendingApprovals();
			}
		},

		async approve(input)
		{
			input = input != null && typeof input === 'object' ? input : {};
			const requestId = cleanText(input.id, '审批请求', 100);
			const pending = pendingApprovals.get(requestId);

			if (pending == null)
			{
				throw agentError('审批请求已经失效', 'WORKSPACE_AGENT_APPROVAL_EXPIRED');
			}

			const decision = cleanText(input.decision, '审批决定', 40);
			const allowed = new Set(['accept', 'decline', 'cancel']);
			if (!allowed.has(decision)) throw agentError('审批决定无效', 'WORKSPACE_AGENT_INVALID_INPUT');

			if (decision === 'cancel')
			{
				client.respond({id: pending.uiId, cancelled: true});
			}
			else if (pending.method === 'confirm')
			{
				client.respond({id: pending.uiId, confirmed: decision === 'accept'});
			}
			else if (decision === 'accept')
			{
				const value = typeof input.value === 'string' ? input.value : '';
				client.respond({id: pending.uiId, value});
			}
			else
			{
				client.respond({id: pending.uiId, cancelled: true});
			}

			pendingApprovals.delete(requestId);
			progress('approval-resolved', {id: requestId, decision});
			return true;
		},

		async steer(text)
		{
			if (active == null)
			{
				throw agentError('当前没有正在执行的 Agent 任务', 'WORKSPACE_AGENT_NOT_BUSY');
			}

			const prompt = cleanText(text, '补充要求', 10000);
			await client.request('steer', {message: prompt});
			appendMessage(store, active.session, {role: 'user', text: prompt,
				filePath: active.relativeFilePath, steered: true});
			progress('steered', {text: prompt});
			return true;
		},

		async interrupt()
		{
			if (active == null) return false;
			cancelPendingApprovals();
			await client.request('abort', {}, TURN_TIMEOUT_MS);
			return true;
		},

		async newThread()
		{
			if (active != null) throw agentError('请先停止当前任务', 'WORKSPACE_AGENT_BUSY');
			const root = await resolveWorkspaceRoot(getWorkspaceRoot);
			const session = readSession(store, root);
			session.sessionId = null;
			session.messages = [];
			writeSession(store, session);
			return {sessionId: null, messages: [], canRollback: session.lastCheckpoint != null};
		},

		async rollback()
		{
			if (active != null) throw agentError('请先停止当前任务', 'WORKSPACE_AGENT_BUSY');
			const root = await resolveWorkspaceRoot(getWorkspaceRoot);
			const session = readSession(store, root);
			const checkpoint = await readCheckpointResult(session.lastCheckpoint);

			if (checkpoint.root !== root)
			{
				throw agentError('检查点不属于当前工作区', 'WORKSPACE_AGENT_NO_CHECKPOINT');
			}

			const current = await scanDrawioFiles(root);
			const currentMap = manifestMap(current);
			const expectedMap = manifestMap(checkpoint.after);

			for (const change of checkpoint.changes)
			{
				const currentItem = currentMap.get(change.path);
				const expectedItem = expectedMap.get(change.path);
				if ((currentItem?.hash || null) !== (expectedItem?.hash || null))
				{
					throw agentError(`图文件之后又被修改，已拒绝覆盖：${change.path}`,
						'WORKSPACE_AGENT_ROLLBACK_CONFLICT');
				}
			}

			await restoreCheckpoint(checkpoint, checkpoint.changes);
			session.lastCheckpoint = null;
			appendMessage(store, session, {role: 'assistant', text: '已撤回上一轮 Agent 对图文件的修改',
				status: 'rolled-back', changes: changeSummary(checkpoint.changes)});
			writeSession(store, session);
			return {ok: true, changes: changeSummary(checkpoint.changes)};
		},

		stop()
		{
			for (const discovery of modelClients) discovery.stop();
			modelClients.clear();
			client?.stop();
			client = null;
			clientKey = null;
			verifiedKey = null;
		}
	};
}
