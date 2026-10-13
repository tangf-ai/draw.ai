import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {PassThrough} from 'node:stream';
import {runInNewContext} from 'node:vm';
import test from 'node:test';
import {
	buildLocalEngineEnvironment,
	createWorkspaceAgentService,
	readWorkspaceAgentPiProfile,
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

function argumentValue(args, name)
{
	const index = args.indexOf(name);
	return index === -1 ? null : args[index + 1];
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

test('desktop Agent environment finds Pi installed by a node version manager', () =>
{
	const nvmRoot = path.join('/home/dev', '.nvm', 'versions', 'node');
	const listDirectories = directory => directory === nvmRoot ? ['v9.0.0', 'v24.11.0'] : [];
	const env = buildLocalEngineEnvironment({HOME: '/home/dev', PATH: '/usr/bin'}, 'linux',
		listDirectories);
	const entries = env.PATH.split(path.delimiter);
	const current = path.join(nvmRoot, 'v24.11.0', 'bin');
	const older = path.join(nvmRoot, 'v9.0.0', 'bin');

	assert.ok(entries.includes(current), 'nvm versions are searched');
	assert.ok(entries.includes(older));
	assert.ok(entries.indexOf(current) < entries.indexOf(older), 'the newest node version wins');
	assert.ok(entries.includes(path.join('/home/dev', '.bun', 'bin')));
	assert.ok(entries.includes(path.join('/home/dev', '.local', 'share', 'fnm', 'aliases',
		'default', 'bin')));
});

test('Workspace Agent defaults to the Pi CLI profile', () =>
{
	const store = new MemoryStore();
	store.set('workspaceAgent.piProfile', {command: '/opt/pi', model: 'deepseek-v4-flash'});
	assert.deepEqual(readWorkspaceAgentPiProfile(store),
		{command: '/opt/pi', model: 'deepseek-v4-flash'});
	assert.deepEqual(readWorkspaceAgentPiProfile(new MemoryStore()),
		{command: 'pi', model: ''});
	assert.deepEqual(readWorkspaceAgentPiProfile(undefined), {command: 'pi', model: ''});
});

test('Workspace Agent persists validated Pi model configuration for the next turn', async () =>
{
	const files = await fixture();
	const store = new MemoryStore();
	const service = createWorkspaceAgentService({
		store,
		getWorkspaceRoot: () => files.root,
		getPiProfile: () => readWorkspaceAgentPiProfile(store),
		stateDir: files.stateDir,
		spawnImpl: () => { throw new Error('Pi should not start while testing configuration'); }
	});

	try
	{
		assert.deepEqual(service.getProfile(), {command: 'pi', model: ''});
		assert.deepEqual(service.setProfile({command: '/opt/pi', model: 'deepseek-v4-flash'}),
			{command: '/opt/pi', model: 'deepseek-v4-flash'});
		assert.deepEqual(service.getProfile(), {command: '/opt/pi', model: 'deepseek-v4-flash'});
		assert.deepEqual(store.get('workspaceAgent.piProfile'),
			{command: '/opt/pi', model: 'deepseek-v4-flash'});
		assert.throws(() => service.setProfile({command: '/opt/pi\n--unsafe'}),
			error => error.code === 'WORKSPACE_AGENT_INVALID_INPUT');
		assert.throws(() => service.setProfile({command: '/opt/pi', model: 'x'.repeat(201)}),
			error => error.code === 'WORKSPACE_AGENT_INVALID_INPUT');
	}
	finally
	{
		service.stop();
		await rm(files.temporary, {recursive: true, force: true});
	}
});

// Minimal Pi RPC server: JSONL commands on stdin, responses and events on stdout.
function fakePiRpc({onPrompt, onUiResponse, onGetState, onGetModels} = {})
{
	const requests = [];
	const spawns = [];
	let spawnCount = 0;

	const spawnImpl = (command, args) =>
	{
		spawnCount++;
		spawns.push({command, args});
		const child = new EventEmitter();
		child.stdin = new PassThrough();
		child.stdout = new PassThrough();
		child.stderr = new PassThrough();
		child.kill = () => {};
		let pending = '';

		const send = message => child.stdout.write(`${JSON.stringify(message)}\n`);
		const succeed = (request, data) => send({id: request.id, type: 'response',
			command: request.type, success: true, data});

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

				if (request.type === 'get_state')
				{
					const state = onGetState ? onGetState({request, args, spawnCount}) :
						{sessionId: argumentValue(args, '--session-id'), messageCount: 1};
					succeed(request, state);
				}
				else if (request.type === 'get_available_models')
				{
					if (onGetModels) onGetModels({request, send, child, succeed});
					else succeed(request, {models: []});
				}
				else if (request.type === 'prompt')
				{
					succeed(request, {});
					queueMicrotask(async () =>
					{
						if (onPrompt) await onPrompt({request, send, args, child, spawnCount});
						else
						{
							send({type: 'message_end', message: {role: 'assistant',
								content: [{type: 'text', text: '完成'}], stopReason: 'stop'}});
							send({type: 'agent_settled'});
						}
					});
				}
				else if (request.type === 'extension_ui_response')
				{
					onUiResponse?.({request, send, child});
				}
				else if (request.type === 'abort' || request.type === 'steer')
				{
					succeed(request, {});
				}
				else succeed(request, {});
			}
		});

		return child;
	};

	return {spawnImpl, requests, spawns, get spawnCount() { return spawnCount; }};
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
		getPiProfile: () => ({command: '/opt/pi', model: 'test-model'}),
		stateDir: files.stateDir,
		spawnImpl: server.spawnImpl
	});
}

const PAGE_CONTEXT = {scope: 'page', pageId: 'page-1', pageName: 'Page-1', cells: []};

test('lists Pi models with an ephemeral process without changing profile or conversation', async () =>
{
	const files = await fixture();
	const store = new MemoryStore();
	let child;
	const server = fakePiRpc({onGetModels: ({child: process, request, succeed}) =>
	{
		child = process;
		succeed(request, {models: [
			{provider: 'z-provider', id: 'second', name: 'Second', apiKey: 'not-for-renderer'},
			{provider: 'a-provider', id: 'first', name: 'First'},
			{provider: 'a-provider', id: 'first', name: 'First'},
			{provider: 'invalid', id: 'line\nbreak'},
			{id: 'missing-provider'}
		]});
	}});
	const service = serviceFor(files, server, store);

	try
	{
		const stateBefore = await service.getState();
		assert.deepEqual(await service.listModels({command: '/custom/pi'}), {models: [
			{provider: 'a-provider', id: 'first', name: 'First'},
			{provider: 'z-provider', id: 'second', name: 'Second'}
		]});
		assert.equal(server.spawns[0].command, '/custom/pi');
		assert.deepEqual(server.spawns[0].args, ['--mode', 'rpc', '--no-session']);
		assert.equal(child.stdin.writableEnded, true, 'discovery process is stopped');
		assert.deepEqual(await service.getState(), stateBefore);
		assert.deepEqual(service.getProfile(), {command: '/opt/pi', model: 'test-model'});
		assert.equal(store.get('workspaceAgent.piProfile'), undefined);
		assert.deepEqual(server.requests.map(request => request.type), ['get_available_models']);
	}
	finally
	{
		service.stop();
		await rm(files.temporary, {recursive: true, force: true});
	}
});

test('model discovery works before workspace setup and stops Pi after RPC failure', async () =>
{
	const files = await fixture();
	let child;
	let fail = true;
	const server = fakePiRpc({onGetModels: ({child: process, request, send, succeed}) =>
	{
		child = process;
		if (fail) send({type: 'response', id: request.id, success: false, error: 'models unavailable'});
		else succeed(request, {models: []});
	}});
	const service = createWorkspaceAgentService({stateDir: files.stateDir,
		getWorkspaceRoot: () => null, spawnImpl: server.spawnImpl});
	try
	{
		await assert.rejects(service.listModels(), /models unavailable/);
		assert.equal(child.stdin.writableEnded, true);
		fail = false;
		assert.deepEqual(await service.listModels(), {models: []});
		assert.equal(server.spawns[1].command, 'pi');
		await assert.rejects(service.listModels({command: 'pi\n--invalid'}),
			error => error.code === 'WORKSPACE_AGENT_INVALID_INPUT');
	}
	finally
	{
		service.stop();
		await rm(files.temporary, {recursive: true, force: true});
	}
});

test('keeps one Pi process and resumes a persistent workspace session', async () =>
{
	const files = await fixture();
	const server = fakePiRpc();
	const store = new MemoryStore();
	let service = serviceFor(files, server, store);

	try
	{
		await service.chat({prompt: '检查图纸', filePath: files.diagram, context: PAGE_CONTEXT});
		await service.chat({prompt: '再检查一次', filePath: files.diagram, context: PAGE_CONTEXT});

		const prompts = server.requests.filter(request => request.type === 'prompt');
		const states = server.requests.filter(request => request.type === 'get_state');
		assert.equal(server.spawnCount, 1);
		assert.equal(states.length, 1, 'a live Pi process is verified once');
		assert.equal(prompts.length, 2);
		assert.ok(prompts[0].message.includes('architecture.drawio'));
		assert.ok(prompts[0].message.includes('DRAW_AI_CONTEXT_JSON'));

		const sessionId = (await service.getState()).sessionId;
		assert.match(sessionId, /^[0-9a-f-]{36}$/);
		assert.equal(argumentValue(server.spawns[0].args, '--session-id'), sessionId);
		assert.deepEqual((await service.getState()).messages.map(message => message.text),
			['检查图纸', '完成', '再检查一次', '完成']);

		service.stop();
		service = serviceFor(files, server, store);
		await service.chat({prompt: '应用重启后继续', filePath: files.diagram, context: PAGE_CONTEXT});

		assert.equal(server.spawnCount, 2, 'a resumed session starts a new Pi process');
		assert.equal((await service.getState()).sessionId, sessionId,
			'the conversation identifier survives a restart');
		assert.equal(argumentValue(server.spawns[1].args, '--session-id'), sessionId,
			'the restarted Pi process resumes the stored session');
		assert.equal(server.requests.filter(request => request.type === 'get_state').length, 2);
	}
	finally
	{
		service.stop();
		await rm(files.temporary, {recursive: true, force: true});
	}
});

test('starts Pi in RPC mode with the workspace session and no legacy Codex flags', async () =>
{
	const files = await fixture();
	let capturedArgs = null;
	let capturedCommand = null;
	const server = fakePiRpc();
	const originalSpawn = server.spawnImpl;

	const service = createWorkspaceAgentService({
		store: new MemoryStore(),
		getWorkspaceRoot: () => files.root,
		getPiProfile: () => ({command: '/opt/pi', model: 'm4/gpt-5.6-sol'}),
		stateDir: files.stateDir,
		spawnImpl: (command, args, options) =>
		{
			capturedCommand = command;
			capturedArgs = args;
			return originalSpawn(command, args, options);
		}
	});

	try
	{
		await service.chat({prompt: '检查图纸', filePath: files.diagram, context: PAGE_CONTEXT});
		assert.equal(capturedCommand, '/opt/pi');
		assert.deepEqual(capturedArgs.slice(0, 2), ['--mode', 'rpc']);
		assert.equal(capturedArgs[capturedArgs.indexOf('--session-dir') + 1],
			path.join(files.stateDir, 'pi-sessions'));
		assert.match(argumentValue(capturedArgs, '--session-id'), /^[0-9a-f-]{36}$/);
		assert.equal(argumentValue(capturedArgs, '--model'), 'm4/gpt-5.6-sol');
		assert.match(argumentValue(capturedArgs, '--append-system-prompt'), /Workspace Agent/);
		assert.ok(!capturedArgs.includes('app-server'));
	}
	finally
	{
		service.stop();
		await rm(files.temporary, {recursive: true, force: true});
	}
});

test('never replaces the current conversation when Pi cannot resume the session', async () =>
{
	const files = await fixture();
	const store = new MemoryStore();
	const initialServer = fakePiRpc();
	let service = serviceFor(files, initialServer, store);

	try
	{
		await service.chat({prompt: '第一轮', filePath: files.diagram, context: PAGE_CONTEXT});
		const sessionId = (await service.getState()).sessionId;
		service.stop();

		const failingServer = fakePiRpc({onGetState: ({args}) =>
			({sessionId: argumentValue(args, '--session-id'), messageCount: 0})});
		service = serviceFor(files, failingServer, store);
		await assert.rejects(service.chat({prompt: '继续上一轮', filePath: files.diagram,
			context: PAGE_CONTEXT}),
			error => error.code === 'WORKSPACE_AGENT_THREAD_RESUME_FAILED' &&
				/无法继续当前 Agent 对话/.test(error.message));
		assert.equal(failingServer.requests.filter(request => request.type === 'get_state').length, 1);
		assert.equal(failingServer.requests.filter(request => request.type === 'prompt').length, 0);
		assert.equal((await service.getState()).sessionId, sessionId);
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
	const server = fakePiRpc({onPrompt: async ({send}) =>
	{
		await writeFile(files.diagram, UPDATED_DIAGRAM, 'utf8');
		send({type: 'tool_execution_start', toolCallId: 'write-1', toolName: 'write',
			args: {path: files.diagram, content: UPDATED_DIAGRAM}});
		send({type: 'tool_execution_end', toolCallId: 'write-1', toolName: 'write',
			result: {}, isError: false});
		send({type: 'message_end', message: {role: 'assistant',
			content: [{type: 'text', text: '已更新架构图'}], stopReason: 'stop'}});
		send({type: 'agent_settled'});
	}});
	const service = serviceFor(files, server);

	try
	{
		const result = await service.chat({prompt: '更新节点', filePath: files.diagram,
			context: {scope: 'selection', pageId: 'page-1', pageName: 'Page-1', cells: [{id: '1'}]}});
		assert.deepEqual(result.changes, [{path: 'architecture.drawio', kind: 'modified'}]);
		assert.equal(result.canRollback, true);
		assert.equal(result.reply, '已更新架构图');
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

function diagramWith(value)
{
	return '<mxfile host="draw.ai"><diagram id="page-1" name="Page-1"><mxGraphModel><root>'
		+ `<mxCell id="0"/><mxCell id="1" value="${value}" vertex="1" parent="0"/>`
		+ '</root></mxGraphModel></diagram></mxfile>';
}

test('records size, mtime, and digest for every checkpointed diagram', async () =>
{
	const files = await fixture();
	const server = fakePiRpc({onPrompt: async ({send}) =>
	{
		await writeFile(files.diagram, UPDATED_DIAGRAM, 'utf8');
		send({type: 'message_end', message: {role: 'assistant',
			content: [{type: 'text', text: '完成'}], stopReason: 'stop'}});
		send({type: 'agent_settled'});
	}});
	const store = new MemoryStore();
	const service = serviceFor(files, server, store);

	try
	{
		await service.chat({prompt: '更新节点', filePath: files.diagram, context: PAGE_CONTEXT});
		const session = Object.values(store.get('workspaceAgent.piSessions'))[0];
		const result = JSON.parse(await readFile(
			path.join(session.lastCheckpoint.directory, 'result.json'), 'utf8'));

		assert.equal(result.before.length, 1);
		assert.equal(result.after.length, 1);

		for (const item of [...result.before, ...result.after])
		{
			assert.equal(typeof item.size, 'number');
			assert.equal(typeof item.mtimeMs, 'number');
			assert.match(item.hash, /^[0-9a-f]{64}$/);
		}
	}
	finally
	{
		service.stop();
		await rm(files.temporary, {recursive: true, force: true});
	}
});

test('reused digests still notice an external diagram change between turns', async () =>
{
	const files = await fixture();
	const external = diagramWith('EXTERNAL');
	let turn = 0;
	const server = fakePiRpc({onPrompt: async ({send}) =>
	{
		turn++;
		await writeFile(files.diagram, turn === 1 ? diagramWith('V1') : diagramWith('V2'), 'utf8');
		send({type: 'message_end', message: {role: 'assistant',
			content: [{type: 'text', text: `完成 ${turn}`}], stopReason: 'stop'}});
		send({type: 'agent_settled'});
	}});
	const store = new MemoryStore();
	const service = serviceFor(files, server, store);

	try
	{
		// Turn 1 stores a checkpoint whose "after" manifest is reused next turn.
		await service.chat({prompt: '第一轮', filePath: files.diagram, context: PAGE_CONTEXT});

		// Something outside the Agent rewrites the diagram before the next turn.
		await writeFile(files.diagram, external, 'utf8');
		await service.chat({prompt: '第二轮', filePath: files.diagram, context: PAGE_CONTEXT});

		await service.rollback();
		assert.equal(await readFile(files.diagram, 'utf8'), external,
			'the pre-turn state must include the external change, not the reused digest');
	}
	finally
	{
		service.stop();
		await rm(files.temporary, {recursive: true, force: true});
	}
});

test('streams assistant text and reasoning without splitting on Unicode line separators', async () =>
{
	const files = await fixture();
	const expected = `第一行\u2028第二行 ${'x'.repeat(10)}`;
	const server = fakePiRpc({onPrompt: async ({send}) =>
	{
		send({type: 'message_update', assistantMessageEvent: {type: 'thinking_delta', delta: '思考中'}});
		send({type: 'message_update', assistantMessageEvent: {type: 'text_delta', delta: '第一行\u2028'}});
		send({type: 'message_update', assistantMessageEvent: {type: 'text_delta', delta: '第二行 '}});
		send({type: 'message_update', assistantMessageEvent: {type: 'text_delta', delta: 'x'.repeat(10)}});
		send({type: 'message_end', message: {role: 'assistant',
			content: [{type: 'text', text: expected}], stopReason: 'stop'}});
		send({type: 'agent_settled'});
	}});
	const service = serviceFor(files, server);
	const progress = [];

	try
	{
		const result = await service.chat({prompt: '写两行', filePath: files.diagram,
			context: PAGE_CONTEXT}, event => progress.push(event));
		assert.equal(result.reply, expected);
		assert.ok(progress.some(event => event.type === 'reasoning' && event.delta === '思考中'));
		assert.ok(progress.filter(event => event.type === 'message-delta').length === 3);
	}
	finally
	{
		service.stop();
		await rm(files.temporary, {recursive: true, force: true});
	}
});

test('keeps the tool target in the completion activity when Pi omits tool args', async () =>
{
	const files = await fixture();
	const server = fakePiRpc({onPrompt: ({send}) =>
	{
		send({type: 'tool_execution_start', toolCallId: 'read-1', toolName: 'read',
			args: {path: 'architecture.drawio'}});
		send({type: 'tool_execution_end', toolCallId: 'read-1', toolName: 'read',
			result: {}, isError: false});
		send({type: 'message_end', message: {role: 'assistant',
			content: [{type: 'text', text: '完成'}], stopReason: 'stop'}});
		send({type: 'agent_settled'});
	}});
	const service = serviceFor(files, server);
	const progress = [];

	try
	{
		await service.chat({prompt: '读取图纸', filePath: files.diagram, context: PAGE_CONTEXT},
			event => progress.push(event));
		const activities = progress.filter(event => event.type === 'activity');
		assert.equal(activities[0].kind, 'read');
		assert.match(activities[0].label, /architecture\.drawio/);
		assert.equal(activities[1].status, 'done');
		assert.match(activities[1].label, /architecture\.drawio/,
			'the finished label must keep the tool target');
	}
	finally
	{
		service.stop();
		await rm(files.temporary, {recursive: true, force: true});
	}
});

test('automatically restores the checkpoint when Pi writes invalid draw.io XML', async () =>
{
	const files = await fixture();
	const server = fakePiRpc({onPrompt: async ({send}) =>
	{
		await writeFile(files.diagram, '<mxfile><diagram>', 'utf8');
		send({type: 'message_end', message: {role: 'assistant',
			content: [{type: 'text', text: '完成'}], stopReason: 'stop'}});
		send({type: 'agent_settled'});
	}});
	const service = serviceFor(files, server);

	try
	{
		await assert.rejects(service.chat({prompt: '破坏图纸', filePath: files.diagram,
			context: PAGE_CONTEXT}),
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

test('routes Pi extension dialogs through the Agent approval channel', async () =>
{
	const files = await fixture();
	let uiResponse = null;
	const server = fakePiRpc({
		onPrompt: ({send}) =>
		{
			send({type: 'extension_ui_request', id: 'ui-confirm-1', method: 'confirm',
				title: '允许执行命令？', message: 'node validate.js'});
		},
		onUiResponse: ({request, send}) =>
		{
			uiResponse = request;
			send({type: 'message_end', message: {role: 'assistant',
				content: [{type: 'text', text: '审批后完成'}], stopReason: 'stop'}});
			send({type: 'agent_settled'});
		}
	});
	const service = serviceFor(files, server);
	let approval = null;
	let approvalPromise = null;

	try
	{
		const result = await service.chat({prompt: '验证图纸', filePath: files.diagram,
			context: PAGE_CONTEXT}, event =>
		{
			if (event.type === 'approval')
			{
				approval = event.approval;
				approvalPromise = service.approve({id: approval.id, decision: 'accept'});
			}
		});
		await approvalPromise;

		assert.equal(approval.type, 'confirm');
		assert.match(approval.detail, /允许执行命令/);
		assert.equal(uiResponse.type, 'extension_ui_response');
		assert.equal(uiResponse.id, 'ui-confirm-1');
		assert.equal(uiResponse.confirmed, true);
		assert.equal(result.reply, '审批后完成');
	}
	finally
	{
		service.stop();
		await rm(files.temporary, {recursive: true, force: true});
	}
});

test('returns a selected option value to the Pi extension dialog', async () =>
{
	const files = await fixture();
	let uiResponse = null;
	const server = fakePiRpc({
		onPrompt: ({send}) =>
		{
			send({type: 'extension_ui_request', id: 'ui-select-1', method: 'select',
				title: '选择布局', options: ['紧凑', '宽松']});
		},
		onUiResponse: ({request, send}) =>
		{
			uiResponse = request;
			send({type: 'agent_settled'});
		}
	});
	const service = serviceFor(files, server);
	let approval = null;
	let approvalPromise = null;

	try
	{
		await service.chat({prompt: '选择布局', filePath: files.diagram, context: PAGE_CONTEXT},
			event =>
			{
				if (event.type === 'approval')
				{
					approval = event.approval;
					approvalPromise = service.approve({id: approval.id, decision: 'accept',
						value: '紧凑'});
				}
			});
		await approvalPromise;

		assert.deepEqual(approval.options, ['紧凑', '宽松']);
		assert.equal(uiResponse.value, '紧凑');
	}
	finally
	{
		service.stop();
		await rm(files.temporary, {recursive: true, force: true});
	}
});

test('restores the checkpoint immediately when Pi exits during a turn', async () =>
{
	const files = await fixture();
	const server = fakePiRpc({onPrompt: async ({child}) =>
	{
		await writeFile(files.diagram, UPDATED_DIAGRAM, 'utf8');
		child.emit('close', 1);
	}});
	const service = serviceFor(files, server);

	try
	{
		const startedAt = Date.now();
		await assert.rejects(service.chat({prompt: '更新后异常退出', filePath: files.diagram,
			context: PAGE_CONTEXT}),
			error => error.code === 'WORKSPACE_AGENT_PI_EXITED');
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
	const server = fakePiRpc({onPrompt: ({send}) => new Promise(resolve =>
	{
		finishTurn = () =>
		{
			send({type: 'message_end', message: {role: 'assistant',
				content: [{type: 'text', text: '已按补充要求完成'}], stopReason: 'stop'}});
			send({type: 'agent_settled'});
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
		assert.ok(server.requests.some(request => request.type === 'steer' &&
			request.message === '再把节点名称改短'));
	}
	finally
	{
		service.stop();
		await rm(files.temporary, {recursive: true, force: true});
	}
});

test('reports an aborted Pi turn as an interrupt and rolls the diagram back', async () =>
{
	const files = await fixture();
	let finishTurn;
	const server = fakePiRpc({onPrompt: ({send}) => new Promise(resolve =>
	{
		finishTurn = () =>
		{
			writeFile(files.diagram, UPDATED_DIAGRAM, 'utf8').then(() =>
			{
				send({type: 'message_end', message: {role: 'assistant', content: [],
					stopReason: 'aborted'}});
				send({type: 'agent_settled'});
				resolve();
			});
		};
		setImmediate(finishTurn);
	})});
	const service = serviceFor(files, server);

	try
	{
		await assert.rejects(service.chat({prompt: '停止', filePath: files.diagram,
			context: PAGE_CONTEXT}),
			error => error.code === 'WORKSPACE_AGENT_INTERRUPTED');
		assert.equal(await readFile(files.diagram, 'utf8'), ORIGINAL_DIAGRAM);
	}
	finally
	{
		service.stop();
		await rm(files.temporary, {recursive: true, force: true});
	}
});

test('reports a clear error when the Pi CLI is not installed', async () =>
{
	const files = await fixture();
	const service = createWorkspaceAgentService({
		store: new MemoryStore(),
		getWorkspaceRoot: () => files.root,
		getPiProfile: () => ({command: 'draw-ai-missing-pi-binary', model: ''}),
		stateDir: files.stateDir
	});

	try
	{
		await assert.rejects(service.chat({prompt: '检查图纸', filePath: files.diagram,
			context: PAGE_CONTEXT}),
			error => error.code === 'WORKSPACE_AGENT_PI_NOT_FOUND');
		assert.equal(await readFile(files.diagram, 'utf8'), ORIGINAL_DIAGRAM);
	}
	finally
	{
		service.stop();
		await rm(files.temporary, {recursive: true, force: true});
	}
});

test('composer button stops a running task, preserves the draft, and defers abort until ready', async () =>
{
	const source = await readFile(new URL(
		'../../drawio/src/main/webapp/plugins/workspace-agent.js', import.meta.url), 'utf8');
	const functionSource = name =>
	{
		const start = source.indexOf(`\tfunction ${name}(`);
		const end = source.indexOf('\n\tfunction ', start + 1);
		assert.ok(start >= 0 && end > start);
		return source.slice(start, end);
	};
	let prompts = 0;
	const requests = [];
	const run = {status: {textContent: ''}};
	const context = {agentBusy: false, agentStopping: false, agentInterruptReady: false,
		agentDisposed: false, agentInput: {value: 'unsent draft'},
		request: action => { requests.push(action); return Promise.resolve(true); },
		sendAgentPrompt: () => { prompts++; }, ensureAgentRun: () => run,
		updateAgentControls: () => {}, scrollAgentMessages: () => {}};
	runInNewContext(['requestAgentStop', 'stopAgent', 'handleAgentSendClick', 'updateAgentProgress']
		.map(functionSource).join('\n'), context);
	context.handleAgentSendClick();
	assert.equal(prompts, 1);
	context.agentBusy = true;
	context.agentInterruptReady = true;
	context.handleAgentSendClick();
	context.handleAgentSendClick();
	assert.deepEqual(requests, ['workspaceAgentInterrupt'], 'repeated clicks do not duplicate abort');
	assert.equal(prompts, 1, 'busy button never submits another prompt');
	assert.equal(context.agentInput.value, 'unsent draft');
	context.agentStopping = false;
	context.agentInterruptReady = false;
	context.handleAgentSendClick();
	assert.equal(requests.length, 1, 'preparing task has no backend turn to abort yet');
	context.updateAgentProgress({type: 'status', phase: 'connecting'});
	assert.deepEqual(requests, ['workspaceAgentInterrupt', 'workspaceAgentInterrupt']);
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
	assert.match(pluginSource, /createButton\('geAgentLauncher', '✦ AI 助手'/);
	assert.doesNotMatch(pluginSource, /ui\.formatWidth\s*=/,
		'floating assistant must not resize the diagram inspector');
	assert.doesNotMatch(pluginSource, /快速编辑/);
	assert.doesNotMatch(electronSource, /var aiAssistantPluginUrl/);
	assert.match(electronSource, /var workspaceAgentPluginUrl = '\.\/plugins\/workspace-agent\.js'/);
	assert.doesNotMatch(pluginSource, /\bai(?:GetConfig|SaveConfig|ActivateEngine|TestConfig|Chat|ListMemories|SaveCorrection|DeleteMemory)\b/);
	assert.match(pluginSource, /workspaceAgentChat/);
	assert.match(pluginSource, /workspaceAgentGetProfile/);
	assert.match(pluginSource, /workspaceAgentSetProfile/);
	assert.match(pluginSource, /agentInput\.disabled = agentLoading/);
	assert.match(pluginSource, /agentInput\.focus\(\)/);
	assert.match(pluginSource, /agentState\.sessionId \? '继续当前对话'/);
	assert.match(pluginSource, /'当前对话 · '/);
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
