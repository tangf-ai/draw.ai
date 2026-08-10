import {spawn as nodeSpawn} from 'node:child_process';
import crypto from 'node:crypto';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {DOMParser} from '@xmldom/xmldom';

const SESSION_STORE_KEY = 'workspaceAgent.sessions';
const CODEX_PROFILE_STORE_KEY = 'workspaceAgent.codexProfile';
const LEGACY_ENGINE_CONFIGS_KEY = 'aiAssistant.engineConfigs';
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

export function buildLocalEngineEnvironment(source = process.env, platform = process.platform)
{
	const env = {...source};
	const home = source.HOME || source.USERPROFILE || '';
	const candidates = [];

	if (home !== '')
	{
		candidates.push(path.join(home, '.local', 'bin'), path.join(home, 'bin'),
			path.join(home, '.volta', 'bin'), path.join(home, '.asdf', 'shims'),
			path.join(home, '.local', 'share', 'mise', 'shims'));

		if (platform === 'win32') candidates.push(path.join(home, 'AppData', 'Roaming', 'npm'));
	}

	if (platform === 'darwin') candidates.push('/opt/homebrew/bin', '/usr/local/bin');
	if (source.APPDATA) candidates.push(path.join(source.APPDATA, 'npm'));
	candidates.push(...String(source.PATH || source.Path || '').split(path.delimiter));
	env.PATH = [...new Set(candidates.filter(Boolean))].join(path.delimiter);
	return env;
}

export function readWorkspaceAgentCodexProfile(store)
{
	const current = store?.get(CODEX_PROFILE_STORE_KEY);
	const legacyProfiles = store?.get(LEGACY_ENGINE_CONFIGS_KEY);
	const legacy = legacyProfiles != null && typeof legacyProfiles === 'object' ? legacyProfiles.codex : null;
	const source = current != null && typeof current === 'object' ? current :
		(legacy != null && typeof legacy === 'object' ? legacy : {});
	const command = typeof source.command === 'string' && source.command.trim() !== '' &&
		!/[\0\r\n]/.test(source.command) ? source.command.trim() : 'codex';
	const model = typeof source.model === 'string' ? source.model.trim().slice(0, 200) : '';
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

function fileHash(data)
{
	return crypto.createHash('sha256').update(data).digest('hex');
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
		return {root, threadId: null, messages: [], lastCheckpoint: null};
	}

	return {
		root,
		threadId: typeof value.threadId === 'string' ? value.threadId : null,
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

async function scanDrawioFiles(root, onFile)
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

			const data = await fs.readFile(absolutePath);
			totalBytes += data.length;

			if (totalBytes > MAX_CHECKPOINT_BYTES)
			{
				throw agentError('工作区图文件总量过大，无法建立安全检查点',
					'WORKSPACE_AGENT_CHECKPOINT_LIMIT');
			}

			const relativePath = normalizeRelativePath(path.relative(root, absolutePath));
			const item = {path: relativePath, size: data.length, hash: fileHash(data)};
			manifest.push(item);
			if (onFile) await onFile(item, data);
		}
	}

	await visit(root);
	return manifest;
}

async function writeJson(filePath, value)
{
	await fs.writeFile(filePath, JSON.stringify(value, null, 2), {encoding: 'utf8', flag: 'wx'});
}

async function createCheckpoint(root, stateDir)
{
	const checkpointRoot = path.join(stateDir, 'checkpoints', workspaceKey(root));
	const id = `${Date.now()}-${crypto.randomUUID()}`;
	const directory = path.join(checkpointRoot, id);
	const filesDirectory = path.join(directory, 'files');
	await fs.mkdir(filesDirectory, {recursive: true});

	try
	{
		const before = await scanDrawioFiles(root, async (item, data) =>
		{
			const snapshotPath = path.join(filesDirectory, ...item.path.split('/'));
			await fs.mkdir(path.dirname(snapshotPath), {recursive: true});
			await fs.writeFile(snapshotPath, data, {flag: 'wx'});
		});
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

class AppServerClient
{
	constructor({command, cwd, spawnImpl, onNotification, onServerRequest, onExit})
	{
		this.command = command;
		this.cwd = cwd;
		this.spawnImpl = spawnImpl;
		this.onNotification = onNotification;
		this.onServerRequest = onServerRequest;
		this.onExit = onExit;
		this.child = null;
		this.starting = null;
		this.pending = new Map();
		this.nextId = 0;
		this.stderr = '';
		this.expectedClose = false;
		this.exitHandled = false;
	}

	async start()
	{
		if (this.child != null) return;
		if (this.starting != null) return this.starting;

		this.starting = (async () =>
		{
			this.expectedClose = false;
			this.exitHandled = false;
			this.stderr = '';

			try
			{
				this.child = this.spawnImpl(this.command, ['app-server', '--listen', 'stdio://'], {
					cwd: this.cwd,
					env: buildLocalEngineEnvironment(),
					stdio: ['pipe', 'pipe', 'pipe'],
					windowsHide: true
				});
			}
			catch (error)
			{
				throw agentError(`无法启动 Codex：${error.message}`,
					error.code === 'ENOENT' ? 'WORKSPACE_AGENT_CODEX_NOT_FOUND' : 'WORKSPACE_AGENT_START_FAILED');
			}

			const lines = readline.createInterface({input: this.child.stdout});
			lines.on('line', line => this.handleLine(line));
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
					this.handleExit(agentError(detail || `Codex 已退出（状态 ${code}）`,
						'WORKSPACE_AGENT_CODEX_EXITED'));
				}
			});

			await this.requestRaw('initialize', {
				clientInfo: {name: 'draw_ai', title: 'draw.ai', version: '1.0.0'}
			});
			this.send({method: 'initialized', params: {}});
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
			throw agentError('Codex App Server 未连接', 'WORKSPACE_AGENT_NOT_CONNECTED');
		}

		this.child.stdin.write(`${JSON.stringify(message)}\n`);
	}

	requestRaw(method, params, timeoutMs = RPC_TIMEOUT_MS)
	{
		const id = `draw-ai-${++this.nextId}`;

		return new Promise((resolve, reject) =>
		{
			const timer = setTimeout(() =>
			{
				this.pending.delete(id);
				reject(agentError(`Codex 请求超时：${method}`, 'WORKSPACE_AGENT_RPC_TIMEOUT'));
			}, timeoutMs);
			this.pending.set(id, {resolve, reject, timer});

			try
			{
				this.send({method, id, params});
			}
			catch (error)
			{
				clearTimeout(timer);
				this.pending.delete(id);
				reject(error);
			}
		});
	}

	async request(method, params, timeoutMs)
	{
		await this.start();
		return this.requestRaw(method, params, timeoutMs);
	}

	respond(id, result, error)
	{
		this.send(error == null ? {id, result} : {id, error});
	}

	handleLine(line)
	{
		let message;

		try { message = JSON.parse(line); }
		catch (error) { return; }

		const pending = this.pending.get(message.id);

		if (pending != null)
		{
			clearTimeout(pending.timer);
			this.pending.delete(message.id);
			if (message.error != null)
			{
				const error = agentError(message.error.message || 'Codex App Server 请求失败',
					'WORKSPACE_AGENT_RPC_FAILED');
				error.rpcCode = message.error.code;
				pending.reject(error);
			}
			else pending.resolve(message.result);
			return;
		}

		if (message.method != null && message.id != null)
		{
			this.onServerRequest?.(message);
		}
		else if (message.method != null)
		{
			this.onNotification?.(message);
		}
	}

	handleExit(error)
	{
		if (this.exitHandled) return;
		this.exitHandled = true;
		const failure = error instanceof Error ? error : agentError(String(error),
			'WORKSPACE_AGENT_CODEX_EXITED');
		for (const pending of this.pending.values())
		{
			clearTimeout(pending.timer);
			pending.reject(failure);
		}
		this.pending.clear();
		this.child = null;
		this.onExit?.(failure);
	}

	stop()
	{
		this.expectedClose = true;
		for (const pending of this.pending.values())
		{
			clearTimeout(pending.timer);
			pending.reject(agentError('Codex 已停止', 'WORKSPACE_AGENT_STOPPED'));
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

function commandSummary(item)
{
	const command = Array.isArray(item?.command) ? item.command.join(' ') : item?.command;
	return redactSensitive(command || item?.aggregatedOutput || '正在运行命令');
}

function changeSummary(changes)
{
	return changes.map(change => ({path: change.path, kind: change.kind}));
}

export function createWorkspaceAgentService({
	store,
	getWorkspaceRoot,
	getCodexProfile,
	stateDir,
	spawnImpl = nodeSpawn
})
{
	if (typeof stateDir !== 'string' || stateDir === '')
	{
		throw new Error('Workspace Agent state directory is required');
	}

	let client = null;
	let clientKey = null;
	let active = null;
	let approvalCounter = 0;
	const pendingApprovals = new Map();

	function progress(type, data = {})
	{
		active?.onProgress?.({type, ...data});
	}

	function finishActive(turn)
	{
		if (active == null || active.finished) return;
		active.finished = true;
		active.resolveTurn(turn);
	}

	function handleNotification(message)
	{
		if (active == null) return;
		const params = message.params || {};
		if (params.threadId != null && params.threadId !== active.threadId) return;

		if (message.method === 'turn/started')
		{
			active.turnId = params.turn?.id || active.turnId;
			progress('status', {phase: 'working', label: 'Codex 正在处理图纸'});
		}
		else if (message.method === 'item/agentMessage/delta')
		{
			const delta = typeof params.delta === 'string' ? params.delta : '';
			active.streamed += delta;
			progress('message-delta', {delta});
		}
		else if (message.method === 'item/reasoning/summaryTextDelta')
		{
			progress('reasoning', {delta: String(params.delta || '').slice(0, 1200)});
		}
		else if (message.method === 'item/started')
		{
			const item = params.item || {};

			if (item.type === 'commandExecution')
			{
				progress('activity', {id: item.id, status: 'running', kind: 'command',
					label: commandSummary(item)});
			}
			else if (item.type === 'fileChange')
			{
				progress('activity', {id: item.id, status: 'running', kind: 'file',
					label: '正在修改图文件'});
			}
		}
		else if (message.method === 'item/completed')
		{
			const item = params.item || {};

			if (item.type === 'agentMessage' && typeof item.text === 'string')
			{
				active.messages.push({text: item.text, phase: item.phase});
			}
			else if (item.type === 'commandExecution')
			{
				progress('activity', {id: item.id, status: item.status === 'failed' ? 'failed' : 'done',
					kind: 'command', label: commandSummary(item)});
			}
			else if (item.type === 'fileChange')
			{
				progress('activity', {id: item.id, status: item.status === 'failed' ? 'failed' : 'done',
					kind: 'file', label: '图文件修改完成'});
			}
		}
		else if (message.method === 'turn/completed')
		{
			finishActive(params.turn || {status: 'failed', error: {message: 'Codex 未返回结果'}});
		}
	}

	function handleServerRequest(message)
	{
		const supported = new Map([
			['item/commandExecution/requestApproval', 'command'],
			['item/fileChange/requestApproval', 'file'],
			['item/permissions/requestApproval', 'permissions']
		]);
		const type = supported.get(message.method);

		if (active == null || type == null)
		{
			client?.respond(message.id, null, {code: -32601, message: 'Unsupported request'});
			return;
		}

		const requestId = `approval-${++approvalCounter}`;
		const params = message.params || {};
		pendingApprovals.set(requestId, {rpcId: message.id, type, params});
		const detail = type === 'command' ? redactSensitive(params.command || params.reason || '') :
			(type === 'file' ? String(params.grantRoot || params.reason || '请求额外文件写入权限') :
				String(params.reason || '请求额外权限'));
		progress('approval', {approval: {id: requestId, type, detail,
			allowSession: type !== 'permissions'}});
	}

	function handleClientExit(error)
	{
		pendingApprovals.clear();

		if (active != null && !active.finished)
		{
			active.finished = true;
			active.rejectTurn(error);
		}
	}

	async function ensureClient(root, profile)
	{
		const command = cleanText(profile?.command || 'codex', 'Codex 命令', 2048);
		const key = `${command}\0${root}`;

		if (client == null || clientKey !== key)
		{
			client?.stop();
				client = new AppServerClient({command, cwd: root, spawnImpl,
					onNotification: handleNotification, onServerRequest: handleServerRequest,
					onExit: handleClientExit});
			clientKey = key;
		}

		await client.start();
		return client;
	}

	async function ensureThread(root, session, profile)
	{
		const params = {
			cwd: root,
			ephemeral: false,
			sandbox: 'workspace-write',
			approvalPolicy: 'on-request',
			approvalsReviewer: 'user',
			developerInstructions: workspaceDeveloperInstructions(),
			threadSource: 'draw.ai'
		};
		if (typeof profile?.model === 'string' && profile.model !== '') params.model = profile.model;

		if (session.threadId != null)
		{
			try
			{
				const resumed = await client.request('thread/resume', {threadId: session.threadId,
					cwd: root, sandbox: 'workspace-write', approvalPolicy: 'on-request',
					approvalsReviewer: 'user', developerInstructions: workspaceDeveloperInstructions(),
					...(params.model != null ? {model: params.model} : {})});
				if (resumed?.thread?.id === session.threadId) return session.threadId;
			}
			catch (error)
			{
				session.threadId = null;
			}
		}

		const started = await client.request('thread/start', params);
		const threadId = started?.thread?.id;

		if (typeof threadId !== 'string' || threadId === '')
		{
			throw agentError('Codex 没有创建对话', 'WORKSPACE_AGENT_THREAD_FAILED');
		}

		session.threadId = threadId;
		writeSession(store, session);
		return threadId;
	}

	async function rollbackFailedTurn(checkpoint)
	{
		const current = await scanDrawioFiles(checkpoint.root);
		const changes = diffManifests(checkpoint.before, current);
		if (changes.length > 0) await restoreCheckpoint(checkpoint, changes);
		await fs.rm(checkpoint.directory, {recursive: true, force: true}).catch(() => {});
		return changes;
	}

	return {
		async getState()
		{
			let root = null;

			try { root = await resolveWorkspaceRoot(getWorkspaceRoot); }
			catch (error)
			{
				return {configured: false, busy: false, threadId: null, messages: [], canRollback: false};
			}

			const session = readSession(store, root);
			const profile = typeof getCodexProfile === 'function' ? getCodexProfile() : {};
			return {
				configured: true,
				root,
				busy: active != null,
				threadId: session.threadId,
				messages: session.messages,
				canRollback: session.lastCheckpoint != null,
				command: profile?.command || 'codex',
				model: profile?.model || ''
			};
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
			const profile = typeof getCodexProfile === 'function' ? getCodexProfile() : {};
			let checkpoint;

			onProgress?.({type: 'status', phase: 'checkpoint', label: '正在建立安全检查点'});
			checkpoint = await createCheckpoint(root, stateDir);
			appendMessage(store, session, {role: 'user', text: prompt, filePath: relativeFilePath});

			try
			{
				await ensureClient(root, profile);
				const threadId = await ensureThread(root, session, profile);
				let resolveTurn;
				let rejectTurn;
				const turnPromise = new Promise((resolve, reject) =>
				{
					resolveTurn = resolve;
					rejectTurn = reject;
				});
				turnPromise.catch(() => {});
				active = {root, threadId, turnId: null, onProgress, resolveTurn, rejectTurn,
					finished: false, streamed: '', messages: [], session, relativeFilePath};
				onProgress?.({type: 'status', phase: 'connecting', label: '正在连接 Codex'});

				const started = await client.request('turn/start', {
					threadId,
					cwd: root,
					approvalPolicy: 'on-request',
					input: [{type: 'text', text: buildTurnPrompt(prompt, relativeFilePath, input.context)}]
				});
				active.turnId = started?.turn?.id || active.turnId;

				const timeout = setTimeout(() =>
				{
					if (active != null && !active.finished)
					{
						active.finished = true;
						active.rejectTurn(agentError('Codex 执行超时', 'WORKSPACE_AGENT_TURN_TIMEOUT'));
						client.request('turn/interrupt', {threadId, turnId: active.turnId}).catch(() => {});
					}
				}, TURN_TIMEOUT_MS);

				let turn;

				try { turn = await turnPromise; }
				finally { clearTimeout(timeout); }

				if (turn.status !== 'completed')
				{
					await rollbackFailedTurn(checkpoint);
					const message = turn.error?.message || (turn.status === 'interrupted' ?
						'任务已停止，未完成的修改已经撤回' : 'Codex 执行失败');
					appendMessage(store, session, {role: 'assistant', text: message, status: turn.status});
					throw agentError(message, turn.status === 'interrupted' ?
						'WORKSPACE_AGENT_INTERRUPTED' : 'WORKSPACE_AGENT_TURN_FAILED');
				}

				onProgress?.({type: 'status', phase: 'validating', label: '正在校验图文件'});
				const after = await scanDrawioFiles(root);
				const changes = diffManifests(checkpoint.before, after);

				if (changes.some(change => change.kind === 'deleted'))
				{
					await restoreCheckpoint(checkpoint, changes);
					throw agentError('Codex 删除了图文件，安全策略已自动撤回本轮修改',
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

				const finalMessage = [...active.messages].reverse().find(item =>
					item.phase === 'final_answer')?.text || active.messages.at(-1)?.text ||
					active.streamed || (changes.length > 0 ? '图纸修改完成' : '本轮没有修改图文件');
				appendMessage(store, session, {role: 'assistant', text: finalMessage,
					status: 'completed', changes: changeSummary(changes), checkpointId: checkpointReference?.id || null});
				writeSession(store, session);
				onProgress?.({type: 'status', phase: 'completed', label: '修改与校验完成',
					changes: changeSummary(changes)});

				return {reply: finalMessage, changes: changeSummary(changes), threadId,
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
				pendingApprovals.clear();
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
			const allowed = new Set(['accept', 'acceptForSession', 'decline', 'cancel']);
			if (!allowed.has(decision)) throw agentError('审批决定无效', 'WORKSPACE_AGENT_INVALID_INPUT');

			if (pending.type === 'permissions')
			{
				client.respond(pending.rpcId, decision === 'accept' || decision === 'acceptForSession' ? {
					permissions: pending.params.permissions || {},
					scope: decision === 'acceptForSession' ? 'session' : 'turn'
				} : {permissions: {}, scope: 'turn'});
			}
			else
			{
				client.respond(pending.rpcId, {decision});
			}

			pendingApprovals.delete(requestId);
			progress('approval-resolved', {id: requestId, decision});
			return true;
		},

		async steer(text)
		{
			if (active == null || active.turnId == null)
			{
				throw agentError('当前没有正在执行的 Agent 任务', 'WORKSPACE_AGENT_NOT_BUSY');
			}

			const prompt = cleanText(text, '补充要求', 10000);
			await client.request('turn/steer', {threadId: active.threadId,
				expectedTurnId: active.turnId, input: [{type: 'text', text: prompt}]});
			appendMessage(store, active.session, {role: 'user', text: prompt,
				filePath: active.relativeFilePath, steered: true});
			progress('steered', {text: prompt});
			return true;
		},

		async interrupt()
		{
			if (active == null || active.turnId == null) return false;
			await client.request('turn/interrupt', {threadId: active.threadId, turnId: active.turnId});
			return true;
		},

		async newThread()
		{
			if (active != null) throw agentError('请先停止当前任务', 'WORKSPACE_AGENT_BUSY');
			const root = await resolveWorkspaceRoot(getWorkspaceRoot);
			const session = readSession(store, root);
			session.threadId = null;
			session.messages = [];
			writeSession(store, session);
			return {threadId: null, messages: [], canRollback: session.lastCheckpoint != null};
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
			client?.stop();
			client = null;
			clientKey = null;
		}
	};
}
