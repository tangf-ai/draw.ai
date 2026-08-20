import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdir, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {PassThrough} from 'node:stream';
import test from 'node:test';
import {
	buildLocalEngineEnvironment,
	createWorkspaceAgentService,
	readWorkspaceAgentCodexProfile,
	validateDrawioFile
} from '../main/workspace-agent.js';

const ORIGINAL_DIAGRAM = '<mxfile host="draw.ai"><diagram id="page-1" name="Page-1"><mxGraphModel><root><mxCell id="0"/></root></mxGraphModel></diagram></mxfile>';
const UPDATED_DIAGRAM = '<mxfile host="draw.ai"><diagram id="page-1" name="Page-1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" value="Updated" vertex="1" parent="0"/></root></mxGraphModel></diagram></mxfile>';

class MemoryStore
{
	constructor() { this.values = new Map(); }
	get(key) { return this.values.get(key); }
	set(key, value) { this.values.set(key, structuredClone(value)); }
}

test('desktop Agent environment can find a CLI installed outside the app bundle', () =>
{
	const env = buildLocalEngineEnvironment({HOME: '/Users/example', PATH: '/usr/bin'}, 'darwin');
	const entries = env.PATH.split(path.delimiter);
	assert.ok(entries.includes(path.join('/Users/example', '.local', 'bin')));
	assert.ok(entries.includes('/opt/homebrew/bin'));
	assert.ok(entries.includes('/usr/local/bin'));
	assert.ok(entries.includes('/usr/bin'));
});

test('Workspace Agent keeps an existing Codex profile without the removed assistant settings', () =>
{
	const current = new MemoryStore();
	current.set('workspaceAgent.codexProfile', {command: '/opt/codex', model: 'gpt-test'});
	assert.deepEqual(readWorkspaceAgentCodexProfile(current),
		{command: '/opt/codex', model: 'gpt-test'});

	const legacy = new MemoryStore();
	legacy.set('aiAssistant.engineConfigs', {codex: {command: '/usr/local/bin/codex', model: 'legacy-model'}});
	assert.deepEqual(readWorkspaceAgentCodexProfile(legacy),
		{command: '/usr/local/bin/codex', model: 'legacy-model'});
	assert.deepEqual(readWorkspaceAgentCodexProfile(new MemoryStore()),
		{command: 'codex', model: ''});
});

test('Workspace Agent persists validated model configuration for the next turn', async () =>
{
	const files = await fixture();
	const store = new MemoryStore();
	const service = createWorkspaceAgentService({
		store,
		getWorkspaceRoot: () => files.root,
		getCodexProfile: () => readWorkspaceAgentCodexProfile(store),
		stateDir: files.stateDir,
		spawnImpl: () => { throw new Error('Codex should not start while testing configuration'); }
	});

	try
	{
		assert.deepEqual(service.getProfile(), {command: 'codex', model: ''});
		assert.deepEqual(service.setProfile({command: '/opt/codex', model: 'gpt-test'}),
			{command: '/opt/codex', model: 'gpt-test'});
		assert.deepEqual(service.getProfile(), {command: '/opt/codex', model: 'gpt-test'});
		assert.deepEqual(store.get('workspaceAgent.codexProfile'),
			{command: '/opt/codex', model: 'gpt-test'});
		assert.throws(() => service.setProfile({command: '/opt/codex\n--unsafe'}),
			error => error.code === 'WORKSPACE_AGENT_INVALID_INPUT');
		assert.throws(() => service.setProfile({command: '/opt/codex', model: 'x'.repeat(201)}),
			error => error.code === 'WORKSPACE_AGENT_INVALID_INPUT');
	}
	finally
	{
		service.stop();
		await rm(files.temporary, {recursive: true, force: true});
	}
});

function fakeAppServer({onTurn, onClientResponse} = {})
{
	const requests = [];
	let spawnCount = 0;
	let turnCount = 0;

	const spawnImpl = () =>
	{
		spawnCount++;
		const child = new EventEmitter();
		child.stdin = new PassThrough();
		child.stdout = new PassThrough();
		child.stderr = new PassThrough();
		child.kill = () => {};
		let pending = '';

		const send = message => child.stdout.write(`${JSON.stringify(message)}\n`);

		child.stdin.on('data', chunk =>
		{
			pending += chunk.toString();
			const lines = pending.split('\n');
			pending = lines.pop();

			for (const line of lines)
			{
				if (line === '') continue;
				const request = JSON.parse(line);
				requests.push(request);

				if (request.method === 'initialize')
				{
					send({id: request.id, result: {userAgent: 'test'}});
				}
				else if (request.method === 'thread/start')
				{
					send({id: request.id, result: {thread: {id: 'thread-1'}}});
				}
				else if (request.method === 'thread/resume')
				{
					send({id: request.id, result: {thread: {id: request.params.threadId}}});
				}
				else if (request.method === 'turn/start')
				{
					turnCount++;
					const turnId = `turn-${turnCount}`;
					send({id: request.id, result: {turn: {id: turnId, status: 'inProgress', items: []}}});
					queueMicrotask(async () =>
					{
						if (onTurn) await onTurn({request, send, turnId, turnCount, child});
						else
						{
							send({method: 'item/completed', params: {threadId: 'thread-1', turnId,
								item: {id: `message-${turnCount}`, type: 'agentMessage',
									phase: 'final_answer', text: `完成 ${turnCount}`}}});
							send({method: 'turn/completed', params: {threadId: 'thread-1',
								turn: {id: turnId, status: 'completed', items: []}}});
						}
					});
				}
					else if (request.method === 'turn/interrupt')
					{
						send({id: request.id, result: {}});
					}
					else if (request.method === 'turn/steer')
					{
						send({id: request.id, result: {}});
					}
				else if (request.id != null && request.method == null && onClientResponse)
				{
					onClientResponse({request, send});
				}
			}
		});

		return child;
	};

	return {spawnImpl, requests, get spawnCount() { return spawnCount; }};
}

async function fixture()
{
	const temporary = await mkdtemp(path.join(os.tmpdir(), 'draw-ai-agent-'));
	const root = path.join(temporary, 'workspace');
	const stateDir = path.join(temporary, 'state');
	const diagram = path.join(root, 'architecture.drawio');
	await mkdir(root, {recursive: true});
	await writeFile(diagram, ORIGINAL_DIAGRAM, 'utf8');
	return {temporary, root, stateDir, diagram};
}

function serviceFor(files, server, store = new MemoryStore())
{
	return createWorkspaceAgentService({
		store,
		getWorkspaceRoot: () => files.root,
		getCodexProfile: () => ({command: '/opt/codex', model: 'test-model'}),
		stateDir: files.stateDir,
		spawnImpl: server.spawnImpl
	});
}

test('keeps one App Server process and resumes a persistent workspace thread', async () =>
{
	const files = await fixture();
	const server = fakeAppServer();
	const service = serviceFor(files, server);

	try
	{
		await service.chat({prompt: '检查图纸', filePath: files.diagram,
			context: {scope: 'page', pageId: 'page-1', pageName: 'Page-1', cells: []}});
		await service.chat({prompt: '再检查一次', filePath: files.diagram,
			context: {scope: 'page', pageId: 'page-1', pageName: 'Page-1', cells: []}});

		const threadStart = server.requests.find(request => request.method === 'thread/start');
		const turnStarts = server.requests.filter(request => request.method === 'turn/start');
		assert.equal(server.spawnCount, 1);
		assert.equal(server.requests.filter(request => request.method === 'thread/start').length, 1);
		assert.equal(server.requests.filter(request => request.method === 'thread/resume').length, 1);
		assert.equal(threadStart.params.ephemeral, false);
		assert.equal(threadStart.params.sandbox, 'workspace-write');
		assert.equal(threadStart.params.approvalPolicy, 'on-request');
		assert.equal(threadStart.params.cwd, await realpath(files.root));
		assert.equal(turnStarts.length, 2);
		assert.equal(Object.prototype.hasOwnProperty.call(turnStarts[0].params, 'outputSchema'), false);
		assert.match(turnStarts[0].params.input[0].text, /architecture\.drawio/);
		assert.match(turnStarts[0].params.input[0].text, /DRAW_AI_CONTEXT_JSON/);
	}
	finally
	{
		service.stop();
		await rm(files.temporary, {recursive: true, force: true});
	}
});

test('creates a checkpoint and rolls back a valid Agent diagram edit', async () =>
{
	const files = await fixture();
	const server = fakeAppServer({onTurn: async ({send, turnId}) =>
	{
		await writeFile(files.diagram, UPDATED_DIAGRAM, 'utf8');
		send({method: 'item/started', params: {threadId: 'thread-1', turnId,
			item: {id: 'file-1', type: 'fileChange', status: 'inProgress'}}});
		send({method: 'item/completed', params: {threadId: 'thread-1', turnId,
			item: {id: 'message-1', type: 'agentMessage', phase: 'final_answer', text: '已更新架构图'}}});
		send({method: 'turn/completed', params: {threadId: 'thread-1',
			turn: {id: turnId, status: 'completed', items: []}}});
	}});
	const service = serviceFor(files, server);

	try
	{
		const result = await service.chat({prompt: '更新节点', filePath: files.diagram,
			context: {scope: 'selection', pageId: 'page-1', pageName: 'Page-1', cells: [{id: '1'}]}});
		assert.deepEqual(result.changes, [{path: 'architecture.drawio', kind: 'modified'}]);
		assert.equal(result.canRollback, true);
		assert.equal(await readFile(files.diagram, 'utf8'), UPDATED_DIAGRAM);

		await service.rollback();
		assert.equal(await readFile(files.diagram, 'utf8'), ORIGINAL_DIAGRAM);
		assert.equal((await service.getState()).canRollback, false);
	}
	finally
	{
		service.stop();
		await rm(files.temporary, {recursive: true, force: true});
	}
});

test('automatically restores the checkpoint when Codex writes invalid draw.io XML', async () =>
{
	const files = await fixture();
	const server = fakeAppServer({onTurn: async ({send, turnId}) =>
	{
		await writeFile(files.diagram, '<mxfile><diagram>', 'utf8');
		send({method: 'turn/completed', params: {threadId: 'thread-1',
			turn: {id: turnId, status: 'completed', items: []}}});
	}});
	const service = serviceFor(files, server);

	try
	{
		await assert.rejects(service.chat({prompt: '破坏图纸', filePath: files.diagram,
			context: {scope: 'page', pageId: 'page-1', cells: []}}),
			error => error.code === 'WORKSPACE_AGENT_INVALID_DRAWIO' && /自动撤回/.test(error.message));
		assert.equal(await readFile(files.diagram, 'utf8'), ORIGINAL_DIAGRAM);
		await validateDrawioFile(files.diagram);
	}
	finally
	{
		service.stop();
		await rm(files.temporary, {recursive: true, force: true});
	}
});

test('routes command approval requests through the Agent progress channel', async () =>
{
	const files = await fixture();
	let approvalResponse = null;
	const server = fakeAppServer({
		onTurn: async ({send, turnId}) =>
		{
			send({method: 'item/commandExecution/requestApproval', id: 'server-approval-1', params: {
				threadId: 'thread-1', turnId, itemId: 'command-1', startedAtMs: Date.now(),
				command: 'node validate.js', cwd: files.root
			}});
		},
		onClientResponse: ({request, send}) =>
		{
			if (request.id !== 'server-approval-1') return;
			approvalResponse = request.result;
			send({method: 'item/completed', params: {threadId: 'thread-1', turnId: 'turn-1',
				item: {id: 'message-1', type: 'agentMessage', phase: 'final_answer', text: '审批后完成'}}});
			send({method: 'turn/completed', params: {threadId: 'thread-1',
				turn: {id: 'turn-1', status: 'completed', items: []}}});
		}
	});
	const service = serviceFor(files, server);
	let approvalPromise;

	try
	{
		const result = await service.chat({prompt: '验证图纸', filePath: files.diagram,
			context: {scope: 'page', pageId: 'page-1', cells: []}}, event =>
		{
			if (event.type === 'approval')
			{
				approvalPromise = service.approve({id: event.approval.id, decision: 'accept'});
			}
		});
		await approvalPromise;
		assert.deepEqual(approvalResponse, {decision: 'accept'});
		assert.equal(result.reply, '审批后完成');
	}
	finally
	{
		service.stop();
		await rm(files.temporary, {recursive: true, force: true});
	}
});

test('restores the checkpoint immediately when App Server exits during a turn', async () =>
{
	const files = await fixture();
	const server = fakeAppServer({onTurn: async ({child}) =>
	{
		await writeFile(files.diagram, UPDATED_DIAGRAM, 'utf8');
		child.emit('close', 1);
	}});
	const service = serviceFor(files, server);

	try
	{
		const startedAt = Date.now();
		await assert.rejects(service.chat({prompt: '更新后异常退出', filePath: files.diagram,
			context: {scope: 'page', pageId: 'page-1', cells: []}}),
			error => error.code === 'WORKSPACE_AGENT_CODEX_EXITED');
		assert.ok(Date.now() - startedAt < 2000, 'unexpected exit should not wait for the turn timeout');
		assert.equal(await readFile(files.diagram, 'utf8'), ORIGINAL_DIAGRAM);
	}
	finally
	{
		service.stop();
		await rm(files.temporary, {recursive: true, force: true});
	}
});

test('persists requirements steered into the active workspace turn', async () =>
{
	const files = await fixture();
	let turnReady;
	let finishTurn;
	const ready = new Promise(resolve => { turnReady = resolve; });
	const server = fakeAppServer({onTurn: ({send, turnId}) => new Promise(resolve =>
	{
		finishTurn = () =>
		{
			send({method: 'item/completed', params: {threadId: 'thread-1', turnId,
				item: {id: 'message-steered', type: 'agentMessage', phase: 'final_answer',
					text: '已按补充要求完成'}}});
			send({method: 'turn/completed', params: {threadId: 'thread-1',
				turn: {id: turnId, status: 'completed', items: []}}});
			resolve();
		};
		setImmediate(turnReady);
	})});
	const service = serviceFor(files, server);

	try
	{
		const chat = service.chat({prompt: '先整理布局', filePath: files.diagram,
			context: {scope: 'page', pageId: 'page-1', cells: []}});
		await ready;
		await service.steer('再把节点名称改短');
		finishTurn();
		await chat;
		const state = await service.getState();
		assert.equal(state.messages.length, 3);
		assert.deepEqual(state.messages.map(message => message.text),
			['先整理布局', '再把节点名称改短', '已按补充要求完成']);
		assert.equal(state.messages[1].steered, true);
	}
	finally
	{
		service.stop();
		await rm(files.temporary, {recursive: true, force: true});
	}
});

test('editor Agent panel uses the file-safe direct editing lifecycle', async () =>
{
	const pluginSource = await readFile(new URL(
		'../../drawio/src/main/webapp/plugins/workspace-agent.js', import.meta.url), 'utf8');
	const electronSource = await readFile(new URL(
		'../../drawio/src/main/webapp/js/diagramly/ElectronApp.js', import.meta.url), 'utf8');
	const mainSource = await readFile(new URL('../main/electron.js', import.meta.url), 'utf8');
	const reloadStart = electronSource.indexOf('EditorUi.prototype.reloadExternalFile = function');
	const reloadEnd = electronSource.indexOf('\n\t// Watches the path for changes', reloadStart);
	const reloadSource = electronSource.slice(reloadStart, reloadEnd);
	assert.match(pluginSource, /createButton\('geAgentModeTab geAgentActive', '格式'\)/);
	assert.match(pluginSource, /createButton\('geAgentModeTab', 'Agent'\)/);
	assert.doesNotMatch(pluginSource, /快速编辑/);
	assert.doesNotMatch(electronSource, /var aiAssistantPluginUrl/);
	assert.match(electronSource, /var workspaceAgentPluginUrl = '\.\/plugins\/workspace-agent\.js'/);
	assert.doesNotMatch(pluginSource, /\bai(?:GetConfig|SaveConfig|ActivateEngine|TestConfig|Chat|ListMemories|SaveCorrection|DeleteMemory)\b/);
	assert.match(pluginSource, /workspaceAgentChat/);
	assert.match(pluginSource, /workspaceAgentGetProfile/);
	assert.match(pluginSource, /workspaceAgentSetProfile/);
	assert.match(pluginSource, /agentInput\.disabled = agentLoading/);
	assert.match(pluginSource, /agentInput\.focus\(\)/);
	assert.match(pluginSource, /配置 Agent 模型/);
	assert.match(pluginSource, /workspaceAgentApprove/);
	assert.match(pluginSource, /workspaceAgentSteer/);
	assert.match(pluginSource, /workspaceAgentInterrupt/);
	assert.match(pluginSource, /workspaceAgentRollback/);
	assert.match(pluginSource, /graph\.getSelectionCount\(\) > 0/);
	assert.match(pluginSource, /scope: 'pages'/);
	assert.match(pluginSource, /ui\.unwatchPath\(current\.path\)/);
	assert.match(pluginSource, /ui\.reloadExternalFile\(resolve/);
	assert.match(pluginSource, /ui\.synchronizeCurrentFile\(true\)/,
		'older editor bundles retain a force-reload fallback');
	assert.doesNotMatch(mainSource, /case 'aiGetConfig'/);
	assert.match(mainSource, /case 'workspaceAgentGetProfile'/);
	assert.match(mainSource, /case 'workspaceAgentSetProfile'/);
	assert.doesNotMatch(mainSource, /case 'aiChat'/);
	assert.doesNotMatch(mainSource, /case 'aiListMemories'/);
	assert.doesNotMatch(mainSource, /createAiAssistantService/);
	assert.ok(reloadStart >= 0 && reloadEnd > reloadStart);
	assert.match(reloadSource, /file\.getLatestVersion\(/);
	assert.match(reloadSource, /this\.replaceFileData\(latestData, null\)/);
	assert.doesNotMatch(reloadSource, /file\.reloadFile\(/,
		'Agent reload must not reapply stale local canvas patches');
});
