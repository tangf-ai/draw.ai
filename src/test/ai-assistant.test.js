import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {
	buildChatCompletionUrl,
	buildModelsUrl,
	createAiAssistantService,
	normalizeAiConfig,
	parseAiResponseText,
	validateAiPlan
} from '../main/ai-assistant.js';

class MemoryStore
{
	constructor() { this.values = new Map(); }
	get(key) { return this.values.get(key); }
	set(key, value) { this.values.set(key, value); }
	delete(key) { this.values.delete(key); }
}

function unavailableSafeStorage()
{
	return {
		isEncryptionAvailable() { return true; },
		encryptString(value) { return Buffer.from(value); },
		decryptString(value)
		{
			if (value.toString() === 'replacement-key') return 'replacement-key';
			throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
		}
	};
}

test('normalizes OpenAI-compatible endpoints', () =>
{
	assert.deepEqual(normalizeAiConfig({baseUrl: 'https://example.com/v1/', model: 'demo'}), {
		baseUrl: 'https://example.com/v1', model: 'demo', customPrompt: '', optimizationFocus: ''
	});
	assert.equal(buildChatCompletionUrl('https://example.com/v1'),
		'https://example.com/v1/chat/completions');
	assert.equal(buildChatCompletionUrl('http://127.0.0.1:11434/v1/chat/completions'),
		'http://127.0.0.1:11434/v1/chat/completions');
	assert.equal(buildModelsUrl('https://example.com/v1'), 'https://example.com/v1/models');
	assert.equal(buildModelsUrl('https://example.com/v1/chat/completions'),
		'https://example.com/v1/models');
	assert.throws(() => normalizeAiConfig({baseUrl: 'file:///tmp/model'}), /HTTP or HTTPS/);
});

test('parses plain and fenced JSON responses', () =>
{
	assert.equal(parseAiResponseText('{"reply":"ok","operations":[]}').reply, 'ok');
	assert.equal(parseAiResponseText('```json\n{"reply":"ok","operations":[]}\n```').reply, 'ok');
	assert.throws(() => parseAiResponseText('not json'), /invalid JSON/);
});

test('validates supported operations and temporary references', () =>
{
	const result = validateAiPlan({
		reply: '增加一个节点并连接',
		operations: [
			{type: 'addNode', ref: 'new_result', label: '结果', x: 300, y: 100,
				width: 120, height: 60, shape: 'rounded', style: {fillColor: '#ffffff'}},
			{type: 'connect', sourceId: '1', targetId: 'new_result', label: ''},
			{type: 'applyLayout', layout: 'horizontal', ids: ['1', 'new_result']}
		]
	}, {cells: [{id: '1'}]});

	assert.equal(result.operations.length, 3);
	assert.equal(result.operations[0].ref, 'new_result');
	assert.throws(() => validateAiPlan({operations: [
		{type: 'updateLabel', id: 'missing', label: 'x'}
	]}, {cells: [{id: '1'}]}), /does not exist/);
	assert.throws(() => validateAiPlan({operations: [
		{type: 'setStyle', id: '1', style: {image: 'https://example.com/a.png'}}
	]}, {cells: [{id: '1'}]}), /not allowed/);
});

test('repairs invalid and repeated temporary references while preserving operation order', () =>
{
	const result = validateAiPlan({operations: [
		{type: 'addNode', ref: 'ocr_service', label: 'OCR 服务', x: 100, y: 100,
			width: 120, height: 60},
		{type: 'connect', sourceId: '1', targetId: 'ocr_service'},
		{type: 'addNode', ref: 'ocr_service', label: 'OCR 复核', x: 300, y: 100,
			width: 120, height: 60},
		{type: 'connect', sourceId: 'ocr_service', targetId: '2'}
	]}, {cells: [{id: '1'}, {id: '2'}]});

	assert.equal(result.operations[0].ref, 'new_ocr_service');
	assert.equal(result.operations[1].targetId, 'new_ocr_service');
	assert.equal(result.operations[2].ref, 'new_ocr_service_2');
	assert.equal(result.operations[3].sourceId, 'new_ocr_service_2');
	assert.equal(result.repairCount, 2);
});

test('stores configuration without exposing the API key and validates model output', async () =>
{
	const store = new MemoryStore();
	let sentRequest;
	const service = createAiAssistantService({
		store,
		fetchImpl: async (requestUrl, request) =>
		{
			sentRequest = {requestUrl, request};
			return {
				ok: true,
				async json()
				{
					return {choices: [{message: {content:
						'{"reply":"已修改","operations":[{"type":"updateLabel","id":"1","label":"新名称"}]}'}}]};
				}
			};
		}
	});

	const saved = service.saveConfig({baseUrl: 'https://example.com/v1', model: 'demo', apiKey: 'secret',
		customPrompt: '使用煤矿行业术语', optimizationFocus: '优先优化布局和连线'});
	assert.equal(saved.hasApiKey, true);
	assert.equal(saved.customPrompt, '使用煤矿行业术语');
	assert.equal(saved.optimizationFocus, '优先优化布局和连线');
	assert.equal(service.getConfig().apiKey, undefined);

	const plan = await service.chat({
		messages: [{role: 'user', content: '改名'}],
		context: {scope: 'selection', cells: [{id: '1', type: 'vertex', label: '旧名称'}]}
	});

	assert.equal(plan.operations[0].label, '新名称');
	assert.equal(sentRequest.requestUrl, 'https://example.com/v1/chat/completions');
	assert.equal(sentRequest.request.headers.Authorization, 'Bearer secret');
	const requestBody = JSON.parse(sentRequest.request.body);
	assert.equal(requestBody.stream, true);
	assert.match(requestBody.messages[0].content, /使用煤矿行业术语/);
	assert.match(requestBody.messages[0].content, /优先优化布局和连线/);
	assert.match(requestBody.messages[0].content, /always take precedence/);
	const cleared = service.saveConfig({baseUrl: 'https://example.com/v1', model: 'demo',
		customPrompt: '', optimizationFocus: ''});
	assert.equal(cleared.customPrompt, '');
	assert.equal(cleared.optimizationFocus, '');
});

test('tests the configured endpoint and returns selectable models without saving secrets', async () =>
{
	const store = new MemoryStore();
	let sentRequest;
	const service = createAiAssistantService({
		store,
		fetchImpl: async (requestUrl, request) =>
		{
			sentRequest = {requestUrl, request};
			return {
				ok: true,
				status: 200,
				async json()
				{
					return {data: [{id: 'model-b'}, {id: 'model-a'}, {id: 'model-a'}]};
				}
			};
		}
	});

	const result = await service.testConfig({
		baseUrl: 'https://example.com/v1',
		model: 'model-a',
		apiKey: 'temporary-secret'
	});

	assert.deepEqual(result.models, ['model-a', 'model-b']);
	assert.equal(result.selectedModelAvailable, true);
	assert.equal(sentRequest.requestUrl, 'https://example.com/v1/models');
	assert.equal(sentRequest.request.headers.Authorization, 'Bearer temporary-secret');
	assert.equal(service.getConfig().hasApiKey, false);
});

test('recovers from an API key encrypted by a different app identity', async () =>
{
	const store = new MemoryStore();
	store.set('aiAssistant.config', {baseUrl: 'https://example.com/v1', model: 'demo'});
	store.set('aiAssistant.apiKey', {type: 'safeStorage', value: 'c3RhbGUta2V5'});
	let requestCount = 0;
	const service = createAiAssistantService({
		store,
		safeStorage: unavailableSafeStorage(),
		fetchImpl: async () => { requestCount++; throw new Error('must not fetch'); }
	});

	const config = service.getConfig();
	assert.equal(config.hasApiKey, false);
	assert.equal(config.apiKeyRecoveryRequired, true);
	assert.equal(store.get('aiAssistant.apiKey'), undefined);

	await assert.rejects(service.chat({
		messages: [{role: 'user', content: '分析当前图'}],
		context: {scope: 'page', cells: []}
	}), /重新填写并保存 API Key/);
	assert.equal(requestCount, 0);

	const saved = service.saveConfig({baseUrl: 'https://example.com/v1', model: 'demo', apiKey: 'replacement-key'});
	assert.equal(saved.hasApiKey, true);
	assert.equal(saved.apiKeyRecoveryRequired, false);
});

test('sends a validated image as an OpenAI-compatible multimodal message', async () =>
{
	const store = new MemoryStore();
	let sentRequest;
	const pngDataUrl = 'data:image/png;base64,iVBORw0KGgo=';
	const service = createAiAssistantService({
		store,
		fetchImpl: async (requestUrl, request) =>
		{
			sentRequest = {requestUrl, request};
			return {
				ok: true,
				status: 200,
				async json() { return {choices: [{message: {content:
					'{"reply":"已识别草稿","operations":[]}'}}]}; }
			};
		}
	});
	service.saveConfig({baseUrl: 'https://example.com/v1', model: 'vision-demo'});

	await service.chat({
		messages: [{role: 'user', content: '把手绘草稿还原成流程图'}],
		context: {scope: 'page', cells: []},
		image: {name: '草稿.png', mimeType: 'image/png', dataUrl: pngDataUrl}
	});

	const body = JSON.parse(sentRequest.request.body);
	assert.match(body.messages[0].content, /handwritten boxes, arrows, labels/);
	assert.deepEqual(body.messages[1].content, [
		{type: 'text', text: '把手绘草稿还原成流程图'},
		{type: 'image_url', image_url: {url: pngDataUrl, detail: 'high'}}
	]);
	assert.match(body.messages.at(-1).content, /^DIAGRAM_CONTEXT_JSON:/);
});

test('rejects spoofed image attachments before making a network request', async () =>
{
	const store = new MemoryStore();
	let requestCount = 0;
	const service = createAiAssistantService({
		store,
		fetchImpl: async () => { requestCount++; throw new Error('must not fetch'); }
	});
	service.saveConfig({baseUrl: 'https://example.com/v1', model: 'vision-demo'});
	const input = {
		messages: [{role: 'user', content: '识别图片'}],
		context: {scope: 'page', cells: []}
	};

	await assert.rejects(service.chat({...input, image: {
		mimeType: 'image/gif', dataUrl: 'data:image/gif;base64,R0lGODlh'
	}}), /仅支持 PNG/);
	await assert.rejects(service.chat({...input, image: {
		mimeType: 'image/png', dataUrl: 'data:image/png;base64,/9j/4AAQSkY='
	}}), /实际格式与文件类型不一致/);
	assert.equal(requestCount, 0);
});

test('explains when the selected model rejects visual input', async () =>
{
	const store = new MemoryStore();
	const service = createAiAssistantService({
		store,
		fetchImpl: async () => ({
			ok: false,
			status: 400,
			async json() { return {error: {message: 'This model does not support image_url input'}}; }
		})
	});
	service.saveConfig({baseUrl: 'https://example.com/v1', model: 'text-only'});

	await assert.rejects(service.chat({
		messages: [{role: 'user', content: '识别图片'}],
		context: {scope: 'page', cells: []},
		image: {mimeType: 'image/png', dataUrl: 'data:image/png;base64,iVBORw0KGgo='}
	}), /当前模型不支持图片输入/);
});

test('parses streamed chat completions and reports live progress', async () =>
{
	const store = new MemoryStore();
	const encoder = new TextEncoder();
	const contentParts = [
		'{"reply":"正在生成',
		'结构","operations":[{"type":"updateLabel",',
		'"id":"1","label":"新名称"}]}'
	];
	const service = createAiAssistantService({
		store,
		fetchImpl: async () => ({
			ok: true,
			status: 200,
			headers: {get: () => 'text/event-stream'},
			body: new ReadableStream({
				start(controller)
				{
					for (const content of contentParts)
					{
						controller.enqueue(encoder.encode('data: ' + JSON.stringify({
							choices: [{delta: {content}}]
						}) + '\n\n'));
					}

					controller.enqueue(encoder.encode('data: [DONE]\n\n'));
					controller.close();
				}
			})
		})
	});
	service.saveConfig({baseUrl: 'https://example.com/v1', model: 'demo'});
	const progress = [];
	const plan = await service.chat({
		messages: [{role: 'user', content: '改名'}],
		context: {scope: 'selection', cells: [{id: '1', type: 'vertex', label: '旧名称'}]}
	}, event => progress.push(event));

	assert.equal(plan.reply, '正在生成结构');
	assert.equal(plan.operations[0].label, '新名称');
	const stages = progress.map(event => event.stage);
	assert.equal(stages[0], 'connecting');
	assert.equal(stages[1], 'receiving');
	assert.ok(stages.filter(stage => stage === 'streaming').length >= 1);
	assert.deepEqual(stages.slice(-2), ['validating', 'ready']);
	assert.equal(progress.filter(event => event.preview).at(-1).preview, '正在生成结构');
});

test('keeps the AI tabs attached to floating Sketch and Minimal format windows', async () =>
{
	const pluginSource = await readFile(new URL(
		'../../drawio/src/main/webapp/plugins/ai-assistant.js', import.meta.url), 'utf8');
	const electronSource = await readFile(new URL(
		'../../drawio/src/main/webapp/js/diagramly/ElectronApp.js', import.meta.url), 'utf8');
	const bootstrapSource = await readFile(new URL(
		'../../drawio/src/main/webapp/js/bootstrap.js', import.meta.url), 'utf8');

	assert.match(pluginSource,
		/formatWindow\.content\.classList\.contains\('geFormatContainer'\)/);
	assert.match(pluginSource,
		/this\.container\.__drawioAiFormatView/);
	assert.match(pluginSource,
		/var nextContainer = getActiveFormatContainer\(\)/);
	assert.match(pluginSource,
		/ui\.__drawioAiCreateFormatPatched/);
	assert.match(pluginSource,
		/installAiAssistant\(ui\)/);
	assert.match(pluginSource, /测试连接/);
	assert.match(pluginSource, /自定义提示词/);
	assert.match(pluginSource, /重点优化内容/);
	assert.match(pluginSource, /AI_API_KEY_RECOVERY_REQUIRED/);
	assert.match(pluginSource, /旧密钥无法读取/);
	assert.match(pluginSource, /request\('aiTestConfig'/);
	assert.match(pluginSource, /graph\.setEnabled\(false\)/);
	assert.match(pluginSource, /updateProgress/);
	assert.match(pluginSource, /回撤本次修改/);
	assert.match(pluginSource, /function rollbackLastAiChange\(\)/);
	assert.match(pluginSource,
		/history\[undoManager\.indexOfNextAdd - 1\] !== lastAiChange\.edit/);
	assert.match(pluginSource, /message\.appendChild\(actions\)/);
	assert.match(pluginSource, /addListener\(mxEvent\.ADD, updateRollbackState\)/);
	assert.match(pluginSource, /image\/png,image\/jpeg,image\/webp/);
	assert.match(pluginSource, /function attachImageFile\(file\)/);
	assert.match(pluginSource, /promptInput\.addEventListener\('paste'/);
	assert.match(pluginSource, /composer\.addEventListener\('drop'/);
	assert.match(pluginSource, /最长边|2048/);
	assert.match(pluginSource, /请根据这张图片还原为可编辑的图/);
	assert.doesNotMatch(pluginSource, /createObjectURL/,
		'blob URLs are blocked by the editor CSP; image decoding must use data URLs');
	assert.doesNotMatch(pluginSource,
		/ui\.formatContainer == null/);
	assert.doesNotMatch(pluginSource,
		/ui\.editor\.chromeless/,
		'Minimal uses chromeless editor mode and must still load the assistant');
	assert.ok(electronSource.indexOf('\n\tloadAiAssistant();') <
		electronSource.indexOf('\n\tvar origAppMain = App.main;'),
		'AI assistant must load before a possibly completed App.main');
	assert.match(electronSource,
		/App\.pluginsLoaded\[aiAssistantPluginUrl\] = true/);
	const pluginLoad = bootstrapSource.indexOf('mxscript(aiAssistantPluginUrl');
	const appReady = bootstrapSource.indexOf("mxscript('js/PostConfig.js', finishAppLoad)");
	assert.ok(pluginLoad >= 0 && appReady > pluginLoad,
		'production bootstrap must load the AI assistant before App.main can run');
	assert.match(bootstrapSource, /App\.initPluginCallback\(\)/);
	assert.match(bootstrapSource, /App\.embedModePluginsCount\+\+/);
});
