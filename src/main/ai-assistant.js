import {
	assessDiagramQuality,
	deleteAiMemory,
	formatMemoriesForPrompt,
	listAiMemories,
	retrieveRelevantMemories,
	saveAiCorrection
} from './ai-memory.js';

const CONFIG_KEY = 'aiAssistant.config';
const SECRET_KEY = 'aiAssistant.apiKey';
const SECRET_RECOVERY_KEY = 'aiAssistant.apiKeyRecoveryRequired';
const API_KEY_RECOVERY_CODE = 'AI_API_KEY_RECOVERY_REQUIRED';
const API_KEY_RECOVERY_MESSAGE = '已保存的 API Key 无法在当前设备读取，请在 AI 设置中重新填写并保存 API Key。';
const MAX_OPERATIONS = 80;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const ALLOWED_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

export const DEFAULT_AI_CONFIG = Object.freeze({
	baseUrl: 'https://api.openai.com/v1',
	model: '',
	customPrompt: '',
	optimizationFocus: ''
});

const allowedShapes = new Set(['rectangle', 'rounded', 'ellipse', 'diamond', 'note']);
const allowedLayouts = new Set(['horizontal', 'vertical', 'tree', 'circle']);
const allowedStyleKeys = new Set([
	'fillColor', 'strokeColor', 'fontColor', 'rounded', 'dashed', 'shadow',
	'fontStyle', 'shape', 'align', 'verticalAlign', 'endArrow', 'edgeStyle',
	'opacity', 'strokeWidth'
]);

function requiredString(value, name, maxLength = 500)
{
	if (typeof value !== 'string' || value.trim() === '')
	{
		throw new Error(`${name} is required`);
	}

	const result = value.trim();

	if (result.length > maxLength)
	{
		throw new Error(`${name} is too long`);
	}

	return result;
}

function optionalString(value, name, maxLength = 500)
{
	if (value == null || value === '') return '';
	return requiredString(value, name, maxLength);
}

function boundedNumber(value, name, min, max, required = true)
{
	if (value == null && !required) return null;

	if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
	{
		throw new Error(`${name} is invalid`);
	}

	return value;
}

export function normalizeAiConfig(input, fallback = DEFAULT_AI_CONFIG)
{
	input = input != null && typeof input === 'object' ? input : {};
	const rawBaseUrl = optionalString(input.baseUrl, 'baseUrl', 2048) || fallback.baseUrl;
	const hasCustomPrompt = Object.prototype.hasOwnProperty.call(input, 'customPrompt');
	const hasOptimizationFocus = Object.prototype.hasOwnProperty.call(input, 'optimizationFocus');
	let parsed;

	try
	{
		parsed = new URL(rawBaseUrl);
	}
	catch (e)
	{
		throw new Error('AI service URL is invalid');
	}

	if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
	{
		throw new Error('AI service URL must use HTTP or HTTPS');
	}

	if (parsed.username || parsed.password || parsed.search || parsed.hash)
	{
		throw new Error('AI service URL cannot contain credentials, query parameters, or a fragment');
	}

	parsed.pathname = parsed.pathname.replace(/\/+$/, '');

	return {
		baseUrl: parsed.toString().replace(/\/$/, ''),
		model: optionalString(input.model, 'model', 200) || fallback.model || '',
		customPrompt: hasCustomPrompt ? optionalString(input.customPrompt, 'customPrompt', 12000) :
			fallback.customPrompt || '',
		optimizationFocus: hasOptimizationFocus ?
			optionalString(input.optimizationFocus, 'optimizationFocus', 4000) :
			fallback.optimizationFocus || ''
	};
}

export function buildChatCompletionUrl(baseUrl)
{
	const normalized = normalizeAiConfig({baseUrl}).baseUrl;

	return /\/chat\/completions$/i.test(new URL(normalized).pathname) ?
		normalized : normalized + '/chat/completions';
}

export function buildModelsUrl(baseUrl)
{
	const normalized = normalizeAiConfig({baseUrl}).baseUrl;
	const parsed = new URL(normalized);

	if (/\/chat\/completions$/i.test(parsed.pathname))
	{
		parsed.pathname = parsed.pathname.replace(/\/chat\/completions$/i, '/models');
	}
	else
	{
		parsed.pathname += '/models';
	}

	return parsed.toString();
}

function normalizeStyle(style)
{
	if (style == null) return {style: {}, repairCount: 0};

	if (typeof style !== 'object' || Array.isArray(style))
	{
		throw new Error('style must be an object');
	}

	const result = {};
	let repairCount = 0;

	for (const [key, rawValue] of Object.entries(style))
	{
		if (!allowedStyleKeys.has(key))
		{
			throw new Error(`style key is not allowed: ${key}`);
		}

		if (!['string', 'number', 'boolean'].includes(typeof rawValue))
		{
			repairCount++;
			continue;
		}

		const value = String(rawValue).trim();

		if (value.length > 80 || /[;=<>]/.test(value))
		{
			repairCount++;
			continue;
		}

		if (/Color$/.test(key) && !/^(#[0-9a-fA-F]{3,8}|none|transparent|default)$/.test(value))
		{
			repairCount++;
			continue;
		}

		if (['rounded', 'dashed', 'shadow'].includes(key) && !/^[01]$/.test(value))
		{
			repairCount++;
			continue;
		}

		if (key === 'fontStyle' && !/^[0-7]$/.test(value))
		{
			repairCount++;
			continue;
		}

		if (key === 'shape' && !/^(ellipse|rhombus|note|cloud|cylinder)$/.test(value))
		{
			repairCount++;
			continue;
		}

		if (key === 'align' && !/^(left|center|right)$/.test(value))
		{
			repairCount++;
			continue;
		}

		if (key === 'verticalAlign' && !/^(top|middle|bottom)$/.test(value))
		{
			repairCount++;
			continue;
		}

		if (key === 'endArrow' && !/^(none|classic|block|open|oval|diamond)$/.test(value))
		{
			repairCount++;
			continue;
		}

		if (key === 'edgeStyle' && !/^(none|orthogonalEdgeStyle|elbowEdgeStyle|entityRelationEdgeStyle)$/.test(value))
		{
			repairCount++;
			continue;
		}

		if (key === 'opacity' && (!/^\d+(?:\.\d+)?$/.test(value) || Number(value) > 100))
		{
			repairCount++;
			continue;
		}

		if (key === 'strokeWidth' && (!/^\d+(?:\.\d+)?$/.test(value) || Number(value) > 20))
		{
			repairCount++;
			continue;
		}

		result[key] = value;
	}

	return {style: result, repairCount};
}

function operationId(value, name, availableIds)
{
	const id = requiredString(value, name, 100);

	if (!availableIds.has(id))
	{
		throw new Error(`${name} does not exist in the supplied diagram context: ${id}`);
	}

	return id;
}

function repairTemporaryReferences(operations, contextIds)
{
	const availableIds = new Set(contextIds);
	const aliases = new Map();
	let repairCount = 0;

	function mapped(value)
	{
		const key = typeof value === 'string' ? value.trim() : value;
		return aliases.has(key) ? aliases.get(key) : value;
	}

	function mappedList(values)
	{
		return Array.isArray(values) ? values.map(mapped) : values;
	}

	const repaired = operations.map((operation, index) =>
	{
		if (operation == null || typeof operation !== 'object' || Array.isArray(operation))
		{
			return operation;
		}

		if (operation.type === 'addNode')
		{
			const rawRef = typeof operation.ref === 'string' ? operation.ref.trim() : '';
			let body = rawRef.replace(/^new_/i, '').replace(/[^A-Za-z0-9_-]+/g, '_').
				replace(/^_+|_+$/g, '').slice(0, 48);

			if (body === '') body = `node_${index + 1}`;
			let ref = `new_${body}`;
			let suffix = 2;

			while (availableIds.has(ref))
			{
				const suffixText = `_${suffix++}`;
				ref = `new_${body.slice(0, 48 - suffixText.length)}${suffixText}`;
			}

			if (ref !== rawRef) repairCount++;
			if (rawRef !== '') aliases.set(rawRef, ref);
			availableIds.add(ref);
			return {...operation, ref};
		}

		switch (operation.type)
		{
		case 'updateLabel':
		case 'moveResize':
		case 'setStyle':
			return {...operation, id: mapped(operation.id)};
		case 'connect':
			return {...operation, sourceId: mapped(operation.sourceId),
				targetId: mapped(operation.targetId)};
		case 'deleteCells':
		case 'applyLayout':
			return {...operation, ids: mappedList(operation.ids)};
		default:
			return operation;
		}
	});

	return {operations: repaired, repairCount};
}

export function validateAiPlan(plan, context)
{
	if (plan == null || typeof plan !== 'object' || Array.isArray(plan))
	{
		throw new Error('AI response must be a JSON object');
	}

	const contextCells = context != null && Array.isArray(context.cells) ? context.cells : [];
	const availableIds = new Set(contextCells.map(cell => cell != null ? cell.id : null).
		filter(id => typeof id === 'string' && id !== ''));
	const rawOperations = Array.isArray(plan.operations) ? plan.operations : [];
	const repaired = repairTemporaryReferences(rawOperations, availableIds);
	const operations = repaired.operations;

	if (operations.length > MAX_OPERATIONS)
	{
		throw new Error(`AI response contains more than ${MAX_OPERATIONS} operations`);
	}

	const normalized = [];
	let styleRepairCount = 0;

	function normalizedStyle(style)
	{
		const result = normalizeStyle(style);
		styleRepairCount += result.repairCount;
		return result.style;
	}

	for (let i = 0; i < operations.length; i++)
	{
		const operation = operations[i];

		if (operation == null || typeof operation !== 'object' || Array.isArray(operation))
		{
			throw new Error(`operation ${i + 1} is invalid`);
		}

		const type = requiredString(operation.type, `operation ${i + 1} type`, 40);
		let next;

		switch (type)
		{
		case 'addNode':
		{
			const ref = requiredString(operation.ref, 'addNode.ref', 52);

			if (!/^new_[A-Za-z0-9_-]{1,48}$/.test(ref) || availableIds.has(ref))
			{
				throw new Error(`addNode.ref is invalid or duplicated: ${ref}`);
			}

			const shape = optionalString(operation.shape, 'addNode.shape', 20) || 'rounded';

			if (!allowedShapes.has(shape)) throw new Error(`addNode.shape is invalid: ${shape}`);

			next = {
				type,
				ref,
				label: requiredString(operation.label, 'addNode.label', 500),
				x: boundedNumber(operation.x, 'addNode.x', -100000, 100000),
				y: boundedNumber(operation.y, 'addNode.y', -100000, 100000),
				width: boundedNumber(operation.width, 'addNode.width', 20, 2000),
				height: boundedNumber(operation.height, 'addNode.height', 20, 2000),
				shape,
				style: normalizedStyle(operation.style)
			};
			availableIds.add(ref);
			break;
		}
		case 'updateLabel':
			next = {type, id: operationId(operation.id, 'updateLabel.id', availableIds),
				label: requiredString(operation.label, 'updateLabel.label', 500)};
			break;
		case 'moveResize':
			next = {type, id: operationId(operation.id, 'moveResize.id', availableIds),
				x: boundedNumber(operation.x, 'moveResize.x', -100000, 100000, false),
				y: boundedNumber(operation.y, 'moveResize.y', -100000, 100000, false),
				width: boundedNumber(operation.width, 'moveResize.width', 20, 2000, false),
				height: boundedNumber(operation.height, 'moveResize.height', 20, 2000, false)};
			break;
		case 'connect':
			next = {type,
				sourceId: operationId(operation.sourceId, 'connect.sourceId', availableIds),
				targetId: operationId(operation.targetId, 'connect.targetId', availableIds),
				label: optionalString(operation.label, 'connect.label', 500),
				style: normalizedStyle(operation.style)};
			break;
		case 'setStyle':
			next = {type, id: operationId(operation.id, 'setStyle.id', availableIds),
				style: normalizedStyle(operation.style)};
			if (Object.keys(next.style).length === 0)
			{
				continue;
			}
			break;
		case 'deleteCells':
			if (!Array.isArray(operation.ids) || operation.ids.length === 0 || operation.ids.length > 50)
			{
				throw new Error('deleteCells.ids is invalid');
			}
			next = {type, ids: [...new Set(operation.ids.map(id =>
				operationId(id, 'deleteCells.id', availableIds)))]};
			break;
		case 'applyLayout':
		{
			const layout = requiredString(operation.layout, 'applyLayout.layout', 20);

			if (!allowedLayouts.has(layout)) throw new Error(`applyLayout.layout is invalid: ${layout}`);

			const ids = operation.ids == null ? [] : operation.ids;

			if (!Array.isArray(ids) || ids.length > 100) throw new Error('applyLayout.ids is invalid');
			next = {type, layout, ids: [...new Set(ids.map(id =>
				operationId(id, 'applyLayout.id', availableIds)))]};
			break;
		}
		default:
			throw new Error(`operation type is not allowed: ${type}`);
		}

		normalized.push(next);
	}

	return {
		reply: optionalString(plan.reply, 'reply', 2000) ||
			(normalized.length > 0 ? '已生成绘图修改方案。' : '没有需要应用的绘图修改。'),
		operations: normalized,
		repairCount: repaired.repairCount + styleRepairCount,
		temporaryReferenceRepairCount: repaired.repairCount,
		styleRepairCount
	};
}

export function parseAiResponseText(text)
{
	text = requiredString(text, 'AI response', 200000);
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
	const candidate = fenced != null ? fenced[1] : text;

	try
	{
		return JSON.parse(candidate);
	}
	catch (e)
	{
		const start = candidate.indexOf('{');
		const end = candidate.lastIndexOf('}');

		if (start >= 0 && end > start)
		{
			try
			{
				return JSON.parse(candidate.slice(start, end + 1));
			}
			catch (ignored) {}
		}

		throw new Error('AI returned invalid JSON');
	}
}

function validateChatInput(input)
{
	if (input == null || typeof input !== 'object') throw new Error('AI request is invalid');
	const context = input.context;

	if (context == null || typeof context !== 'object' || !Array.isArray(context.cells))
	{
		throw new Error('Diagram context is invalid');
	}

	if (context.cells.length > 300) throw new Error('Diagram context contains more than 300 cells');
	const scope = context.scope == null ? 'page' : context.scope;

	if (scope !== 'selection' && scope !== 'page')
	{
		throw new Error('Diagram context scope is invalid');
	}

	const messages = Array.isArray(input.messages) ? input.messages : [];

	if (messages.length === 0 || messages.length > 20) throw new Error('Chat history is invalid');

	return {
		context: {...context, scope},
		messages: messages.map((message, index) => ({
			role: message != null && message.role === 'assistant' ? 'assistant' : 'user',
			content: requiredString(message != null ? message.content : null,
				`message ${index + 1}`, 6000)
		})),
		image: validateImageAttachment(input.image)
	};
}

function validateImageAttachment(image)
{
	if (image == null) return null;

	if (typeof image !== 'object' || Array.isArray(image))
	{
		throw new Error('图片附件无效');
	}

	const mimeType = requiredString(image.mimeType, '图片类型', 50).toLowerCase();

	if (!ALLOWED_IMAGE_MIME_TYPES.has(mimeType))
	{
		throw new Error('仅支持 PNG、JPEG 或 WebP 图片');
	}

	const dataUrl = requiredString(image.dataUrl, '图片内容', MAX_IMAGE_BYTES * 2);
	const match = dataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/);

	if (match == null || match[1] !== mimeType || match[2].length % 4 !== 0)
	{
		throw new Error('图片内容格式无效');
	}

	const bytes = Buffer.from(match[2], 'base64');

	if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES)
	{
		throw new Error('图片不能超过 10MB');
	}

	const isPng = bytes.length >= 8 && bytes.subarray(0, 8).
		equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
	const isJpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
	const isWebp = bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
		bytes.subarray(8, 12).toString('ascii') === 'WEBP';
	const signatureMatches = mimeType === 'image/png' ? isPng :
		(mimeType === 'image/jpeg' ? isJpeg : isWebp);

	if (!signatureMatches)
	{
		throw new Error('图片实际格式与文件类型不一致');
	}

	return {mimeType, dataUrl};
}

function apiKeyRecoveryError()
{
	const error = new Error(API_KEY_RECOVERY_MESSAGE);
	error.code = API_KEY_RECOVERY_CODE;
	return error;
}

function markSecretForRecovery(store, removeSecret = false)
{
	if (store == null) return;

	try
	{
		if (removeSecret) store.delete(SECRET_KEY);
		store.set(SECRET_RECOVERY_KEY, true);
	}
	catch (e)
	{
		// Keep the original decryption failure actionable even if settings cannot
		// be updated, rather than leaking a platform-specific safeStorage error.
	}
}

function clearSecretRecovery(store)
{
	if (store == null) return;

	try { store.delete(SECRET_RECOVERY_KEY); }
	catch (e) {}
}

function isSecretRecoveryRequired(store)
{
	return store != null && store.get(SECRET_RECOVERY_KEY) === true;
}

function hasStoredSecret(store)
{
	if (store == null) return false;
	const stored = store.get(SECRET_KEY);

	return stored != null && typeof stored === 'object' && typeof stored.value === 'string' &&
		stored.value !== '' && (stored.type === 'safeStorage' || stored.type === 'plain');
}

function readSecret(store, safeStorage)
{
	if (store == null) return '';
	const stored = store.get(SECRET_KEY);

	if (stored == null || typeof stored !== 'object' || typeof stored.value !== 'string') return '';

	if (stored.type === 'safeStorage')
	{
		if (safeStorage == null || !safeStorage.isEncryptionAvailable())
		{
			markSecretForRecovery(store);
			throw apiKeyRecoveryError();
		}

		try
		{
			const value = safeStorage.decryptString(Buffer.from(stored.value, 'base64'));
			clearSecretRecovery(store);
			return value;
		}
		catch (e)
		{
			// A key encrypted under a prior app identity cannot be recovered after
			// migration. Remove only this stale secret and ask the user to save it again.
			markSecretForRecovery(store, true);
			throw apiKeyRecoveryError();
		}
	}

	clearSecretRecovery(store);
	return stored.type === 'plain' ? stored.value : '';
}

function writeSecret(store, safeStorage, value)
{
	if (store == null) throw new Error('Application settings are unavailable');

	if (safeStorage != null && safeStorage.isEncryptionAvailable())
	{
		store.set(SECRET_KEY, {
			type: 'safeStorage',
			value: safeStorage.encryptString(value).toString('base64')
		});
	}
	else
	{
		store.set(SECRET_KEY, {type: 'plain', value});
	}

	clearSecretRecovery(store);
}

function getStoredConfig(store)
{
	const stored = store != null ? store.get(CONFIG_KEY) : null;

	try
	{
		return normalizeAiConfig(stored || DEFAULT_AI_CONFIG);
	}
	catch (e)
	{
		return {...DEFAULT_AI_CONFIG};
	}
}

const SYSTEM_PROMPT = `You are the built-in diagram assistant for draw.ai Desktop.
Return exactly one JSON object and no markdown. The object must be:
{"reply":"short Chinese explanation","operations":[...]}

Allowed operations:
- {"type":"addNode","ref":"new_unique_id","label":"...","x":0,"y":0,"width":120,"height":60,"shape":"rectangle|rounded|ellipse|diamond|note","style":{...}}
- {"type":"updateLabel","id":"existing_or_new_id","label":"..."}
- {"type":"moveResize","id":"existing_or_new_id","x":0,"y":0,"width":120,"height":60} (include only fields to change)
- {"type":"connect","sourceId":"...","targetId":"...","label":"...","style":{...}}
- {"type":"setStyle","id":"...","style":{...}}
- {"type":"deleteCells","ids":["..."]}
- {"type":"applyLayout","layout":"horizontal|vertical|tree|circle","ids":["..."]}

Style keys are limited to fillColor, strokeColor, fontColor, rounded, dashed, shadow,
fontStyle, shape, align, verticalAlign, endArrow, edgeStyle, opacity, and strokeWidth.
For any *Color style, use only a literal #RGB, #RRGGBB, #RRGGBBAA, none, transparent, or default.
Do not use a style key or theme token such as fontColor as a color value.
Use only IDs supplied in the diagram context or refs introduced by an earlier addNode.
Every addNode.ref must start with new_, contain only ASCII letters, digits, underscores, or
hyphens, be unique across the response, and never reuse an ID from the diagram context.
Do not return XML, scripts, links, images, data URIs, or unsupported operations.
When an input image is present, reconstruct it as editable diagram nodes and edges. Carefully
recognize handwritten boxes, arrows, labels, groups, hierarchy, and reading order. Preserve the
meaning even when the sketch is rough or incomplete. Never embed or trace the source image as
an image element on the canvas.
If the user is asking a question that needs no diagram mutation, return an empty operations array.`;

function buildSystemPrompt(config, memories = [], qualityIssues = [], scope = 'page')
{
	const sections = [SYSTEM_PROMPT];

	if (scope === 'selection')
	{
		sections.push('REQUEST_SCOPE: SELECTION_ONLY. The diagram context contains only the cells selected by the user. Modify, delete, move, style, connect, or lay out only the supplied existing IDs. Never infer, inspect, or change an unlisted existing cell. New cells are allowed only when directly required by the user request, and may connect only to supplied IDs or refs created earlier in this response.');
	}
	else
	{
		sections.push('REQUEST_SCOPE: FULL_PAGE. The diagram context contains the current page. Apply changes only to IDs supplied in that context or refs created earlier in this response.');
	}

	if (config.optimizationFocus !== '')
	{
		sections.push(`USER_OPTIMIZATION_FOCUS:\n${config.optimizationFocus}`);
	}

	if (config.customPrompt !== '')
	{
		sections.push(`USER_CUSTOM_INSTRUCTIONS:\n${config.customPrompt}`);
	}

	const memoryPrompt = formatMemoriesForPrompt(memories);

	if (memoryPrompt !== '')
	{
		sections.push(memoryPrompt);
	}

	if (qualityIssues.length > 0)
	{
		sections.push('DETERMINISTIC_DIAGRAM_QUALITY_ISSUES_JSON:\n' +
			JSON.stringify(qualityIssues) +
			'\nAddress these issues only when relevant to the user request. Do not delete or broadly rearrange the diagram without an explicit request.');
	}

	sections.push('The built-in output schema, allowed operations, reference rules, and safety rules always take precedence.');
	return sections.join('\n\n');
}

function contentText(content)
{
	if (typeof content === 'string') return content;

	if (Array.isArray(content))
	{
		return content.map(part => part != null && typeof part.text === 'string' ?
			part.text : '').join('');
	}

	return '';
}

function responseContent(body)
{
	const choice = body != null && Array.isArray(body.choices) ? body.choices[0] : null;

	return choice != null ? contentText(choice.message != null ?
		choice.message.content : choice.text) : '';
}

function responseError(body, status)
{
	const message = body != null && body.error != null ? body.error.message : null;
	return new Error(message || `AI service returned HTTP ${status}`);
}

function imageResponseError(body, status)
{
	const error = responseError(body, status);

	if ((status === 400 || status === 415 || status === 422) &&
		/(image|vision|visual|multimodal|multi-modal|content type|image_url)/i.test(error.message))
	{
		return new Error('当前模型不支持图片输入，请在 AI 设置中选择支持视觉的模型');
	}

	return error;
}

function requestMessages(request, config, memories = [], qualityIssues = [])
{
	const messages = request.messages.map(message => ({...message}));

	if (request.image != null)
	{
		let attached = false;

		for (let index = messages.length - 1; index >= 0; index--)
		{
			if (messages[index].role === 'user')
			{
				messages[index].content = [
					{type: 'text', text: messages[index].content},
					{type: 'image_url', image_url: {url: request.image.dataUrl, detail: 'high'}}
				];
				attached = true;
				break;
			}
		}

		if (!attached) throw new Error('图片附件缺少用户提示词');
	}

	return [
		{role: 'system', content: buildSystemPrompt(config, memories, qualityIssues,
			request.context.scope)},
		...messages,
		{role: 'user', content: 'DIAGRAM_CONTEXT_JSON:\n' + JSON.stringify(request.context)}
	];
}

function notifyProgress(callback, stage, details = {})
{
	if (typeof callback === 'function') callback({stage, ...details});
}

function partialReply(text)
{
	const match = /"reply"\s*:\s*"/.exec(text);

	if (match == null) return '';

	let result = '';
	let index = match.index + match[0].length;

	while (index < text.length)
	{
		const character = text[index++];

		if (character === '"') break;

		if (character !== '\\')
		{
			result += character;
			continue;
		}

		if (index >= text.length) break;
		const escaped = text[index++];

		if (escaped === 'n') result += '\n';
		else if (escaped === 'r') result += '\r';
		else if (escaped === 't') result += '\t';
		else if (escaped === 'b') result += '\b';
		else if (escaped === 'f') result += '\f';
		else if (escaped === 'u')
		{
			const hex = text.slice(index, index + 4);

			if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
			result += String.fromCharCode(parseInt(hex, 16));
			index += 4;
		}
		else
		{
			result += escaped;
		}
	}

	return result;
}

async function readStreamingContent(response, onProgress)
{
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let pending = '';
	let content = '';
	let lastReportedLength = 0;

	function processLine(line)
	{
		if (!line.startsWith('data:')) return;
		const data = line.slice(5).trim();

		if (data === '' || data === '[DONE]') return;
		let body;

		try { body = JSON.parse(data); } catch (e) { return; }

		if (body.error != null) throw responseError(body, response.status);
		const choice = Array.isArray(body.choices) ? body.choices[0] : null;
		const delta = choice != null ? contentText(choice.delta != null ?
			choice.delta.content : (choice.message != null ? choice.message.content : choice.text)) : '';
		content += delta;

		if (content.length === 0 || (content.length - lastReportedLength < 24 &&
			partialReply(content) === '')) return;

		lastReportedLength = content.length;
		notifyProgress(onProgress, 'streaming', {
			receivedCharacters: content.length,
			preview: partialReply(content).slice(0, 800)
		});
	}

	while (true)
	{
		const result = await reader.read();
		pending += decoder.decode(result.value || new Uint8Array(), {stream: !result.done});
		const lines = pending.split(/\r?\n/);
		pending = lines.pop() || '';

		for (const line of lines) processLine(line);
		if (result.done) break;
	}

	if (pending !== '') processLine(pending);
	return content;
}

function requestHeaders(apiKey, accept)
{
	const headers = {'Content-Type': 'application/json'};

	if (accept != null) headers.Accept = accept;
	if (apiKey !== '') headers.Authorization = `Bearer ${apiKey}`;
	return headers;
}

export function createAiAssistantService({store, safeStorage, fetchImpl = globalThis.fetch,
	getWorkspaceRoot = () => store?.get('workspaceRoot')})
{
	function workspaceRoot()
	{
		return typeof getWorkspaceRoot === 'function' ? getWorkspaceRoot() : null;
	}

	return {
		getConfig()
		{
			const config = getStoredConfig(store);
			const apiKeyRecoveryRequired = isSecretRecoveryRequired(store);

			// Loading the assistant at startup must not trigger a macOS Keychain
			// authorization dialog. The secret is decrypted only for a user action.
			return {...config, hasApiKey: !apiKeyRecoveryRequired && hasStoredSecret(store),
				apiKeyRecoveryRequired};
		},

		saveConfig(input)
		{
			if (store == null) throw new Error('Application settings are unavailable');
			const config = normalizeAiConfig(input, getStoredConfig(store));
			config.model = requiredString(config.model, 'model', 200);
			store.set(CONFIG_KEY, config);

			if (input != null && input.clearApiKey === true)
			{
				store.delete(SECRET_KEY);
				clearSecretRecovery(store);
			}
			else if (input != null && typeof input.apiKey === 'string' && input.apiKey.trim() !== '')
			{
				writeSecret(store, safeStorage, input.apiKey.trim());
			}

			return {...config, hasApiKey: hasStoredSecret(store),
				apiKeyRecoveryRequired: false};
		},

		async chat(input, onProgress)
		{
			if (typeof fetchImpl !== 'function') throw new Error('Network requests are unavailable');
			const request = validateChatInput(input);
			const config = getStoredConfig(store);
			config.model = requiredString(config.model, 'model', 200);
			if (isSecretRecoveryRequired(store)) throw apiKeyRecoveryError();
			const apiKey = readSecret(store, safeStorage);
			const headers = requestHeaders(apiKey, 'text/event-stream, application/json');
			const latestUserMessage = [...request.messages].reverse().find(message => message.role === 'user');
			let memories = [];
			let qualityIssues = [];

			try
			{
				qualityIssues = assessDiagramQuality(request.context);
			}
			catch (error)
			{
				qualityIssues = [];
			}

			try
			{
				memories = await retrieveRelevantMemories(workspaceRoot(), {
					prompt: latestUserMessage?.content || '', context: request.context
				});
			}
			catch (error)
			{
				// Missing, unreadable, or malformed workspace memory must never block chat.
				memories = [];
			}
			notifyProgress(onProgress, 'connecting', {
				host: new URL(config.baseUrl).host,
				model: config.model,
				memoryCount: memories.length,
				qualityIssueCount: qualityIssues.length
			});

			const response = await fetchImpl(buildChatCompletionUrl(config.baseUrl), {
				method: 'POST',
				headers,
				redirect: 'error',
				signal: AbortSignal.timeout(90000),
				body: JSON.stringify({
					model: config.model,
					temperature: 0.1,
					stream: true,
					messages: requestMessages(request, config, memories, qualityIssues)
				})
			});

			const contentType = response.headers != null && typeof response.headers.get === 'function' ?
				(response.headers.get('content-type') || '') : '';
			let body = null;
			let content = '';

			if (!response.ok)
			{
				try { body = await response.json(); } catch (e) {}
				throw request.image != null ? imageResponseError(body, response.status) :
					responseError(body, response.status);
			}

			notifyProgress(onProgress, 'receiving');

			if (/text\/event-stream/i.test(contentType) && response.body != null &&
				typeof response.body.getReader === 'function')
			{
				content = await readStreamingContent(response, onProgress);
			}
			else
			{
				try { body = await response.json(); } catch (e) {}
				content = responseContent(body);
			}

			notifyProgress(onProgress, 'validating');
			const plan = validateAiPlan(parseAiResponseText(content), request.context);
			plan.usedMemories = memories.map(memory => ({id: memory.id, prompt: memory.prompt,
				categories: memory.categories}));
			plan.qualityIssues = qualityIssues;
			notifyProgress(onProgress, 'ready', {operationCount: plan.operations.length,
				repairCount: plan.repairCount,
				temporaryReferenceRepairCount: plan.temporaryReferenceRepairCount,
				styleRepairCount: plan.styleRepairCount});
			return plan;
		},

		async listMemories()
		{
			return listAiMemories(workspaceRoot());
		},

		async saveCorrection(input)
		{
			return saveAiCorrection(workspaceRoot(), input);
		},

		async deleteMemory(id)
		{
			return deleteAiMemory(workspaceRoot(), id);
		},

		async testConfig(input)
		{
			if (typeof fetchImpl !== 'function') throw new Error('Network requests are unavailable');
			const config = normalizeAiConfig(input, getStoredConfig(store));
			const suppliedKey = input != null && typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
			if (suppliedKey === '' && isSecretRecoveryRequired(store)) throw apiKeyRecoveryError();
			const apiKey = suppliedKey !== '' ? suppliedKey : readSecret(store, safeStorage);
			const startedAt = Date.now();
			const response = await fetchImpl(buildModelsUrl(config.baseUrl), {
				method: 'GET',
				headers: requestHeaders(apiKey, 'application/json'),
				redirect: 'error',
				signal: AbortSignal.timeout(15000)
			});
			let body = null;

			try { body = await response.json(); } catch (e) {}

			if (!response.ok) throw responseError(body, response.status);
			const data = body != null && Array.isArray(body.data) ? body.data : [];
			const models = [...new Set(data.map(item => typeof item === 'string' ? item :
				(item != null ? item.id : null)).filter(id => typeof id === 'string' && id.trim() !== '').
				map(id => id.trim()))].sort((a, b) => a.localeCompare(b));

			return {
				ok: true,
				latencyMs: Math.max(0, Date.now() - startedAt),
				models,
				selectedModelAvailable: config.model === '' || models.length === 0 || models.includes(config.model)
			};
		}
	};
}
