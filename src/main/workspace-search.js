import {promises as fs, constants} from 'node:fs';
import {inflateRaw} from 'node:zlib';
import {promisify} from 'node:util';
import {DOMParser} from '@xmldom/xmldom';
import {getWorkspaceFile, readWorkspace} from './workspace-files.js';

const inflate = promisify(inflateRaw);
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_DECODED_BYTES = 16 * 1024 * 1024;
const MAX_SEARCH_BYTES = 64 * 1024 * 1024;
const MAX_CACHE_CHARACTERS = 16 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set(['drawio', 'dio', 'xml', 'svg', 'mmd', 'mermaid', 'csv']);

function parseXml(content)
{
	let invalid = false;
	const document = new DOMParser({errorHandler: {
		warning: () => { invalid = true; },
		error: () => { invalid = true; },
		fatalError: () => { invalid = true; }
	}}).parseFromString(content, 'text/xml');
	if (invalid || !document?.documentElement) throw new Error('无法解析图纸');
	return document.documentElement;
}

function plainLabel(value)
{
	// Labels may contain HTML, but never insert that HTML into the renderer.
	const text = value.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
		.replace(/<br\s*\/?\s*>|<\/(?:div|p|li|tr|h[1-6])\s*>/gi, ' ')
		.replace(/<\/?[a-z][^>]*>/gi, '');
	const document = new DOMParser({errorHandler: () => {}})
		.parseFromString('<div>' + text + '</div>', 'text/html');
	return document.documentElement.textContent.replace(/\s+/g, ' ').trim();
}

function graphText(model)
{
	const labels = [];
	for (const cell of Array.from(model.getElementsByTagName('mxCell')))
	{
		const value = cell.getAttribute('value');
		if (value) labels.push(plainLabel(value));
		// Custom object labels are stored on an element wrapping the mxCell.
		const parent = cell.parentNode;
		if (parent?.nodeType === 1 && parent.tagName !== 'root')
		{
			const label = parent.getAttribute('label');
			if (label) labels.push(plainLabel(label));
		}
	}
	return labels.join('\n');
}

async function diagramText(content, extension)
{
	if (['mmd', 'mermaid', 'csv'].includes(extension)) return {text: content, incomplete: false};
	let root = parseXml(content);
	if (extension === 'svg')
	{
		const embedded = root.getAttribute('content');
		if (embedded) root = parseXml(embedded);
		else return {text: Array.from(root.getElementsByTagName('text')).map(node => node.textContent).join('\n'), incomplete: false};
	}
	if (root.tagName === 'mxGraphModel') return {text: graphText(root), incomplete: false};
	if (root.tagName !== 'mxfile') throw new Error('不是 draw.io 图纸');
	const labels = [];
	let decodedBytes = 0;
	let incomplete = false;
	for (const diagram of Array.from(root.getElementsByTagName('diagram')))
	{
		labels.push(diagram.getAttribute('name') || '');
		try
		{
			let model = diagram.getElementsByTagName('mxGraphModel')[0];
			if (!model)
			{
				let data = diagram.textContent.trim();
				if (!data.startsWith('<'))
				{
					data = decodeURIComponent((await inflate(Buffer.from(data, 'base64'),
						{maxOutputLength: MAX_DECODED_BYTES - decodedBytes})).toString('utf8'));
				}
				decodedBytes += Buffer.byteLength(data);
				if (decodedBytes > MAX_DECODED_BYTES) throw new Error('图纸内容过大');
				model = parseXml(data);
			}
			if (model.tagName !== 'mxGraphModel') throw new Error('图纸页面无效');
			labels.push(graphText(model));
		}
		catch (error)
		{
			incomplete = true;
		}
	}
	return {text: labels.join('\n'), incomplete};
}

function snippet(text, query)
{
	const compact = text.replace(/\s+/g, ' ').trim();
	const index = compact.toLowerCase().indexOf(query);
	if (index < 0) return null;
	const start = Math.max(0, index - 24);
	const end = Math.min(compact.length, index + query.length + 60);
	return (start ? '…' : '') + compact.slice(start, end) + (end < compact.length ? '…' : '');
}

export function createWorkspaceSearcher()
{
	const cache = new Map();
	let cacheCharacters = 0;
	function remove(key)
	{
		cacheCharacters -= cache.get(key)?.text.length || 0;
		cache.delete(key);
	}

	return async function searchWorkspace(root, value)
	{
		if (typeof value !== 'string' || value.length > 256) throw new Error('搜索内容需在 256 个字符以内');
		const query = value.trim().toLowerCase();
		const state = await readWorkspace(root);
		const results = [];
		const files = [];
		const livePaths = new Set();
		function visit(nodes)
		{
			for (const node of nodes)
			{
				if (query && node.name.toLowerCase().includes(query))
				{
					results.push({relativePath: node.relativePath, match: 'name', snippet: null});
				}
				if (node.type === 'directory') visit(node.children);
				else
				{
					files.push(node);
					livePaths.add(state.root + '/' + node.relativePath);
				}
			}
		}
		visit(state.tree);
		for (const key of cache.keys()) if (!livePaths.has(key)) remove(key);
		if (!query) return {root: state.root, query, results: [], skippedFiles: 0};
		let skippedFiles = 0;
		let readBytes = 0;
		let next = 0;
		const nameMatches = new Set(results.map(result => result.relativePath));
		async function worker()
		{
			while (next < files.length)
			{
				const node = files[next++];
				if (!TEXT_EXTENSIONS.has(node.extension)) continue;
				const key = state.root + '/' + node.relativePath;
				try
				{
					const item = await getWorkspaceFile(state.root, node.relativePath);
					const stat = await fs.stat(item.absolutePath);
					const version = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
					let entry = cache.get(key);
					if (!entry || entry.version !== version)
					{
						remove(key);
						if (stat.size > MAX_FILE_BYTES || readBytes + stat.size > MAX_SEARCH_BYTES)
						{
							skippedFiles++;
							continue;
						}
						readBytes += stat.size;
						const handle = await fs.open(item.absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
						let data;
						try
						{
							const buffer = Buffer.alloc(Math.min(stat.size + 1, MAX_FILE_BYTES + 1));
							let length = 0;
							while (length < buffer.length)
							{
								const {bytesRead} = await handle.read(buffer, length, buffer.length - length, length);
								if (!bytesRead) break;
								length += bytesRead;
							}
							if (length > MAX_FILE_BYTES || length > stat.size) throw new Error('图纸文件已变化或过大，请重试');
							data = buffer.subarray(0, length).toString('utf8');
						}
						finally { await handle.close(); }
						entry = {...await diagramText(data, node.extension), version};
						remove(key);
						cache.set(key, entry);
						cacheCharacters += entry.text.length;
						while (cacheCharacters > MAX_CACHE_CHARACTERS) remove(cache.keys().next().value);
					}
					if (entry.incomplete) skippedFiles++;
					if (!nameMatches.has(node.relativePath))
					{
						const match = snippet(entry.text, query);
						if (match != null) results.push({relativePath: node.relativePath, match: 'content', snippet: match});
					}
				}
				catch (error) { skippedFiles++; }
			}
		}
		await Promise.all(Array.from({length: 4}, () => worker()));
		return {root: state.root, query, results, skippedFiles};
	};
}
