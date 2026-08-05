import { promises as fs, constants as fsConstants } from 'fs';
import path from 'path';
import crypto from 'crypto';

export const WORKSPACE_FILE_EXTENSIONS = new Set([
	'.drawio', '.dio', '.xml', '.vsdx', '.mmd', '.mermaid', '.csv',
	'.png', '.svg', '.pdf'
]);

const MAX_ENTRIES = 10000;
const MAX_DEPTH = 25;
const MAX_TEMPLATE_SIZE = 50 * 1024 * 1024;
const MAX_TEMPLATE_SOURCE_METADATA_SIZE = 64 * 1024;
const WORKSPACE_METADATA_DIRECTORY = '.drawio-workspace';
const WORKSPACE_TEMPLATE_FILE = 'default-template.drawio';
const WORKSPACE_TEMPLATE_SOURCE_FILE = 'template-source.json';
const TEMPLATE_SOURCE_METADATA_VERSION = 1;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const INVALID_NAME_CHARACTERS = /[<>:"/\\|?*\0]/;

function workspaceError(message, code)
{
	const error = new Error(message);
	error.code = code;
	return error;
}

export function validateWorkspaceName(value)
{
	if (typeof value !== 'string')
	{
		throw workspaceError('名称不能为空', 'INVALID_NAME');
	}

	const name = value.trim();

	if (!name || name === '.' || name === '..' || INVALID_NAME_CHARACTERS.test(name) ||
		name.endsWith('.') || name.endsWith(' ') || WINDOWS_RESERVED_NAME.test(name))
	{
		throw workspaceError('名称包含系统不允许的字符或格式', 'INVALID_NAME');
	}

	if (Buffer.byteLength(name, 'utf8') > 240)
	{
		throw workspaceError('名称过长', 'INVALID_NAME');
	}

	return name;
}

function ensureInside(root, target)
{
	if (target !== root && !target.startsWith(root + path.sep))
	{
		throw workspaceError('路径不在工作区内', 'PATH_NOT_AUTHORISED');
	}
}

async function getRealWorkspaceRoot(root)
{
	if (typeof root !== 'string' || !root || root.includes('\0'))
	{
		throw workspaceError('尚未设置工作区', 'WORKSPACE_NOT_CONFIGURED');
	}

	const resolved = path.resolve(root);
	const realRoot = await fs.realpath(resolved);
	const stat = await fs.stat(realRoot);

	if (!stat.isDirectory())
	{
		throw workspaceError('工作区路径不是目录', 'INVALID_WORKSPACE');
	}

	return realRoot;
}

async function resolveWorkspacePath(root, relativePath = '', options = {})
{
	const realRoot = await getRealWorkspaceRoot(root);

	if (typeof relativePath !== 'string' || relativePath.includes('\0') || path.isAbsolute(relativePath))
	{
		throw workspaceError('路径不在工作区内', 'PATH_NOT_AUTHORISED');
	}

	const resolved = path.resolve(realRoot, relativePath || '.');
	ensureInside(realRoot, resolved);

	if (options.forCreate)
	{
		const realParent = await fs.realpath(path.dirname(resolved));
		ensureInside(realRoot, realParent);
		return {root: realRoot, target: path.join(realParent, path.basename(resolved))};
	}

	const target = await fs.realpath(resolved);
	ensureInside(realRoot, target);
	return {root: realRoot, target: target};
}

function toRelative(root, target)
{
	return path.relative(root, target).split(path.sep).join('/');
}

function shouldIgnoreEntry(name)
{
	return name.startsWith('.') || name.startsWith('~$');
}

function sortNodes(a, b)
{
	if (a.type !== b.type)
	{
		return a.type === 'directory' ? -1 : 1;
	}

	return a.name.localeCompare(b.name, undefined, {numeric: true, sensitivity: 'base'});
}

async function scanDirectory(root, directory, depth, counter)
{
	if (depth > MAX_DEPTH)
	{
		return [];
	}

	const entries = await fs.readdir(directory, {withFileTypes: true});
	const nodes = [];

	for (const entry of entries)
	{
		if (counter.count >= MAX_ENTRIES || shouldIgnoreEntry(entry.name) || entry.isSymbolicLink())
		{
			continue;
		}

		const absolutePath = path.join(directory, entry.name);
		const relativePath = toRelative(root, absolutePath);

		if (entry.isDirectory())
		{
			counter.count++;
			const stat = await fs.stat(absolutePath);
			nodes.push({
				type: 'directory',
				name: entry.name,
				relativePath: relativePath,
				modifiedAt: stat.mtimeMs,
				children: await scanDirectory(root, absolutePath, depth + 1, counter)
			});
		}
		else if (entry.isFile() && WORKSPACE_FILE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
		{
			counter.count++;
			const stat = await fs.stat(absolutePath);
			nodes.push({
				type: 'file',
				name: entry.name,
				relativePath: relativePath,
				extension: path.extname(entry.name).slice(1).toLowerCase(),
				modifiedAt: stat.mtimeMs,
				size: stat.size
			});
		}
	}

	return nodes.sort(sortNodes);
}

function countNodes(nodes)
{
	return nodes.reduce((result, node) =>
	{
		if (node.type === 'directory')
		{
			result.directories++;
			const childCounts = countNodes(node.children);
			result.directories += childCounts.directories;
			result.files += childCounts.files;
		}
		else
		{
			result.files++;
		}

		return result;
	}, {directories: 0, files: 0});
}

export async function readWorkspace(root, options = {})
{
	const realRoot = await getRealWorkspaceRoot(root);
	const [tree, template] = await Promise.all([
		scanDirectory(realRoot, realRoot, 0, {count: 0}),
		getWorkspaceTemplate(realRoot, options)
	]);

	return {
		root: realRoot,
		name: path.basename(realRoot),
		tree: tree,
		counts: countNodes(tree),
		template: template
	};
}

async function getDirectory(root, relativePath)
{
	const resolved = await resolveWorkspacePath(root, relativePath);
	const stat = await fs.stat(resolved.target);

	if (!stat.isDirectory())
	{
		throw workspaceError('目标位置不是目录', 'NOT_A_DIRECTORY');
	}

	return resolved;
}

export async function createWorkspaceDirectory(root, parentRelativePath, value)
{
	const name = validateWorkspaceName(value);
	const parent = await getDirectory(root, parentRelativePath);
	const destination = await resolveWorkspacePath(parent.root,
		path.join(toRelative(parent.root, parent.target), name), {forCreate: true});

	try
	{
		await fs.mkdir(destination.target);
	}
	catch (error)
	{
		if (error.code === 'EEXIST')
		{
			throw workspaceError('同名目录已经存在', 'ALREADY_EXISTS');
		}

		throw error;
	}

	return toRelative(destination.root, destination.target);
}

function createDiagramXml()
{
	const id = crypto.randomUUID().replaceAll('-', '').slice(0, 20);
	const modified = new Date().toISOString();

	return `<mxfile host="Electron" modified="${modified}" agent="draw.ai Desktop"><diagram id="${id}" name="Page-1"><mxGraphModel dx="1200" dy="800" grid="0" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="0" pageScale="1" pageWidth="827" pageHeight="1169" math="0" shadow="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>`;
}

async function getTemplatePaths(root, createDirectory = false)
{
	const realRoot = await getRealWorkspaceRoot(root);
	const metadataDirectory = path.join(realRoot, WORKSPACE_METADATA_DIRECTORY);

	try
	{
		const stat = await fs.lstat(metadataDirectory);

		if (stat.isSymbolicLink() || !stat.isDirectory())
		{
			throw workspaceError('工作区模板目录无效', 'INVALID_TEMPLATE');
		}
	}
	catch (error)
	{
		if (error.code !== 'ENOENT') throw error;

		if (createDirectory)
		{
			await fs.mkdir(metadataDirectory, {mode: 0o700});
		}
	}

	if (createDirectory)
	{
		const realDirectory = await fs.realpath(metadataDirectory);
		ensureInside(realRoot, realDirectory);

		return {
			root: realRoot,
			directory: realDirectory,
			target: path.join(realDirectory, WORKSPACE_TEMPLATE_FILE),
			sourceMetadata: path.join(realDirectory, WORKSPACE_TEMPLATE_SOURCE_FILE)
		};
	}

	return {
		root: realRoot,
		directory: metadataDirectory,
		target: path.join(metadataDirectory, WORKSPACE_TEMPLATE_FILE),
		sourceMetadata: path.join(metadataDirectory, WORKSPACE_TEMPLATE_SOURCE_FILE)
	};
}

async function readTemplateFile(templatePath)
{
	const stat = await fs.lstat(templatePath);

	if (stat.isSymbolicLink() || !stat.isFile())
	{
		throw workspaceError('工作区模板文件无效', 'INVALID_TEMPLATE');
	}

	if (stat.size > MAX_TEMPLATE_SIZE)
	{
		throw workspaceError('工作区模板文件过大', 'INVALID_TEMPLATE');
	}

	const content = await fs.readFile(templatePath, 'utf8');

	if (!/^\uFEFF?\s*<mxfile(?:\s|>)/i.test(content) || !/<diagram(?:\s|>)/i.test(content))
	{
		throw workspaceError('工作区模板不是有效的 draw.io 文件', 'INVALID_TEMPLATE');
	}

	return {content: content, stat: stat};
}

function hashTemplateContent(content)
{
	return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function invalidTemplateSource()
{
	return workspaceError('模板来源记录无效，请重新导入模板', 'INVALID_TEMPLATE_SOURCE');
}

async function readTemplateSourceMetadata(paths)
{
	let stat;

	try
	{
		stat = await fs.lstat(paths.sourceMetadata);
	}
	catch (error)
	{
		if (error.code === 'ENOENT') return null;
		throw error;
	}

	if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_TEMPLATE_SOURCE_METADATA_SIZE)
	{
		throw invalidTemplateSource();
	}

	let metadata;

	try
	{
		metadata = JSON.parse(await fs.readFile(paths.sourceMetadata, 'utf8'));
	}
	catch (error)
	{
		throw invalidTemplateSource();
	}

	if (metadata == null || metadata.version !== TEMPLATE_SOURCE_METADATA_VERSION ||
		!['workspace', 'external'].includes(metadata.kind) || typeof metadata.path !== 'string' ||
		!metadata.path || metadata.path.includes('\0') || !SHA256_PATTERN.test(metadata.baselineHash) ||
		!Number.isFinite(metadata.sourceSize) || metadata.sourceSize < 0 ||
		!Number.isFinite(metadata.sourceModifiedAt) || metadata.sourceModifiedAt < 0)
	{
		throw invalidTemplateSource();
	}

	if ((metadata.kind === 'workspace' && path.isAbsolute(metadata.path)) ||
		(metadata.kind === 'external' && !path.isAbsolute(metadata.path)) ||
		path.extname(metadata.path).toLowerCase() !== '.drawio')
	{
		throw invalidTemplateSource();
	}

	return metadata;
}

async function writeTemplateSourceMetadata(paths, metadata)
{
	const suffix = crypto.randomUUID();
	const temporaryPath = path.join(paths.directory, `.template-source-${suffix}.tmp`);
	const backupPath = path.join(paths.directory, `.template-source-${suffix}.bak`);
	const content = `${JSON.stringify(metadata, null, 2)}\n`;
	let movedExisting = false;

	await fs.writeFile(temporaryPath, content, {encoding: 'utf8', flag: 'wx', mode: 0o600});

	try
	{
		try
		{
			const stat = await fs.lstat(paths.sourceMetadata);

			if (stat.isDirectory()) throw invalidTemplateSource();
			await fs.rename(paths.sourceMetadata, backupPath);
			movedExisting = true;
		}
		catch (error)
		{
			if (error.code !== 'ENOENT') throw error;
		}

		await fs.rename(temporaryPath, paths.sourceMetadata);
	}
	catch (error)
	{
		await fs.rm(temporaryPath, {force: true});

		if (movedExisting)
		{
			await fs.rename(backupPath, paths.sourceMetadata);
		}

		throw error;
	}

	if (movedExisting) await fs.rm(backupPath, {force: true});
}

async function createTemplateSourceMetadata(paths, sourcePath, source)
{
	const realSource = await fs.realpath(sourcePath);
	const isWorkspaceSource = realSource !== paths.root && realSource.startsWith(paths.root + path.sep);

	if (realSource === paths.target)
	{
		return null;
	}

	return {
		version: TEMPLATE_SOURCE_METADATA_VERSION,
		kind: isWorkspaceSource ? 'workspace' : 'external',
		path: isWorkspaceSource ? toRelative(paths.root, realSource) : realSource,
		baselineHash: hashTemplateContent(source.content),
		sourceSize: source.stat.size,
		sourceModifiedAt: source.stat.mtimeMs,
		importedAt: Date.now()
	};
}

async function resolveTemplateSourcePath(paths, metadata)
{
	if (metadata.kind === 'workspace')
	{
		return (await resolveWorkspacePath(paths.root, metadata.path)).target;
	}

	return metadata.path;
}

function validateTemplateStat(stat)
{
	if (stat.isSymbolicLink() || !stat.isFile())
	{
		throw workspaceError('模板来源文件无效', 'INVALID_TEMPLATE_SOURCE_FILE');
	}

	if (stat.size > MAX_TEMPLATE_SIZE)
	{
		throw workspaceError('模板来源文件过大', 'INVALID_TEMPLATE_SOURCE_FILE');
	}
}

async function readTrackedTemplateSource(paths, metadata, forceSourceRead = false)
{
	const sourcePath = await resolveTemplateSourcePath(paths, metadata);
	const stat = await fs.lstat(sourcePath);
	validateTemplateStat(stat);

	if (!forceSourceRead && stat.size === metadata.sourceSize &&
		stat.mtimeMs === metadata.sourceModifiedAt)
	{
		return {absolutePath: sourcePath, content: null, hash: metadata.baselineHash, stat: stat};
	}

	const source = await readTemplateFile(sourcePath);
	return {
		absolutePath: sourcePath,
		content: source.content,
		hash: hashTemplateContent(source.content),
		stat: source.stat
	};
}

function templateSourceErrorMessage(error)
{
	if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return '导入来源文件已经不存在';
	if (error?.code === 'EACCES' || error?.code === 'EPERM') return '没有权限读取导入来源文件';
	return error?.message || '无法检查导入来源文件';
}

async function getTemplateSourceState(paths, template, forceSourceRead = false)
{
	let metadata;

	try
	{
		metadata = await readTemplateSourceMetadata(paths);
	}
	catch (error)
	{
		return {
			tracked: true,
			status: 'unavailable',
			name: null,
			displayPath: null,
			portable: false,
			canUpdate: false,
			error: templateSourceErrorMessage(error)
		};
	}

	if (metadata == null)
	{
		return {tracked: false, status: 'untracked', canUpdate: false};
	}

	const sourceBase = {
		tracked: true,
		name: path.basename(metadata.path),
		displayPath: metadata.kind === 'workspace' ? metadata.path : path.basename(metadata.path),
		portable: metadata.kind === 'workspace'
	};

	let source;

	try
	{
		source = await readTrackedTemplateSource(paths, metadata, forceSourceRead);
	}
	catch (error)
	{
		return {
			...sourceBase,
			status: 'unavailable',
			canUpdate: false,
			error: templateSourceErrorMessage(error)
		};
	}

	const templateHash = hashTemplateContent(template.content);
	let status;

	if (source.hash === templateHash)
	{
		status = 'current';

		if (metadata.baselineHash !== source.hash || metadata.sourceSize !== source.stat.size ||
			metadata.sourceModifiedAt !== source.stat.mtimeMs)
		{
			metadata.baselineHash = source.hash;
			metadata.sourceSize = source.stat.size;
			metadata.sourceModifiedAt = source.stat.mtimeMs;

			try
			{
				await writeTemplateSourceMetadata(paths, metadata);
			}
			catch (error)
			{
				// A read-only workspace can still report whether both files match.
			}
		}
	}
	else
	{
		const sourceChanged = source.hash !== metadata.baselineHash;
		const templateChanged = templateHash !== metadata.baselineHash;
		status = sourceChanged && templateChanged ? 'conflict' :
			(sourceChanged ? 'source-updated' : 'template-modified');
	}

	return {
		...sourceBase,
		status: status,
		modifiedAt: source.stat.mtimeMs,
		canUpdate: status === 'source-updated' || status === 'conflict',
		error: null
	};
}

export async function getWorkspaceTemplate(root, options = {})
{
	const paths = await getTemplatePaths(root);
	let template;

	try
	{
		template = await readTemplateFile(paths.target);
	}
	catch (error)
	{
		if (error.code === 'ENOENT')
		{
			return {configured: false, invalid: false, modifiedAt: null, size: 0};
		}

		if (error.code === 'INVALID_TEMPLATE')
		{
			return {configured: true, invalid: true, modifiedAt: null, size: 0, error: error.message};
		}

		throw error;
	}

	return {
		configured: true,
		invalid: false,
		modifiedAt: template.stat.mtimeMs,
		size: template.stat.size,
		source: await getTemplateSourceState(paths, template, options.forceSourceRead === true)
	};
}

export async function getWorkspaceTemplatePath(root)
{
	const paths = await getTemplatePaths(root);

	try
	{
		await fs.lstat(paths.target);
		return paths.target;
	}
	catch (error)
	{
		if (error.code === 'ENOENT') return null;
		throw error;
	}
}

export async function getWorkspaceTemplateItem(root)
{
	const paths = await getTemplatePaths(root);

	try
	{
		const template = await readTemplateFile(paths.target);
		return {
			absolutePath: paths.target,
			configured: true,
			modifiedAt: template.stat.mtimeMs,
			size: template.stat.size
		};
	}
	catch (error)
	{
		if (error.code === 'ENOENT') return null;
		throw error;
	}
}

export async function ensureWorkspaceTemplate(root)
{
	const paths = await getTemplatePaths(root, true);
	let created = false;

	try
	{
		await fs.writeFile(paths.target, createDiagramXml(), {encoding: 'utf8', flag: 'wx', mode: 0o600});
		created = true;
	}
	catch (error)
	{
		if (error.code !== 'EEXIST') throw error;
	}

	if (created)
	{
		await fs.rm(paths.sourceMetadata, {force: true});
	}

	const template = await readTemplateFile(paths.target);
	return {
		absolutePath: paths.target,
		configured: true,
		invalid: false,
		modifiedAt: template.stat.mtimeMs,
		size: template.stat.size
	};
}

async function replaceTemplateFile(paths, content)
{
	const suffix = crypto.randomUUID();
	const temporaryPath = path.join(paths.directory, `.template-${suffix}.tmp`);
	const backupPath = path.join(paths.directory, `.template-${suffix}.bak`);
	let movedExisting = false;

	await fs.writeFile(temporaryPath, content, {encoding: 'utf8', flag: 'wx', mode: 0o600});

	try
	{
		try
		{
			const stat = await fs.lstat(paths.target);

			if (stat.isSymbolicLink() || !stat.isFile())
			{
				throw workspaceError('工作区模板文件无效', 'INVALID_TEMPLATE');
			}

			await fs.rename(paths.target, backupPath);
			movedExisting = true;
		}
		catch (error)
		{
			if (error.code !== 'ENOENT') throw error;
		}

		await fs.rename(temporaryPath, paths.target);
	}
	catch (error)
	{
		await fs.rm(temporaryPath, {force: true});

		if (movedExisting)
		{
			await fs.rename(backupPath, paths.target);
		}

		throw error;
	}

	if (movedExisting) await fs.rm(backupPath, {force: true});
}

export async function importWorkspaceTemplate(root, sourcePath)
{
	if (typeof sourcePath !== 'string' || !sourcePath || sourcePath.includes('\0') ||
		path.extname(sourcePath).toLowerCase() !== '.drawio')
	{
		throw workspaceError('请选择有效的 .drawio 模板文件', 'INVALID_TEMPLATE');
	}

	const source = await readTemplateFile(sourcePath);
	const paths = await getTemplatePaths(root, true);
	const metadata = await createTemplateSourceMetadata(paths, sourcePath, source);
	await replaceTemplateFile(paths, source.content);

	if (metadata == null)
	{
		await fs.rm(paths.sourceMetadata, {force: true});
	}
	else
	{
		await writeTemplateSourceMetadata(paths, metadata);
	}

	return {absolutePath: paths.target,
		...await getWorkspaceTemplate(paths.root, {forceSourceRead: true})};
}

export async function updateWorkspaceTemplateFromSource(root, force = false)
{
	const paths = await getTemplatePaths(root);
	const template = await getWorkspaceTemplate(paths.root, {forceSourceRead: true});

	if (!template.configured || template.invalid || !template.source?.tracked)
	{
		throw workspaceError('当前模板没有可更新的导入来源', 'TEMPLATE_SOURCE_UNAVAILABLE');
	}

	if (template.source.status === 'unavailable')
	{
		throw workspaceError(template.source.error || '模板来源不可用', 'TEMPLATE_SOURCE_UNAVAILABLE');
	}

	if (template.source.status === 'template-modified' ||
		(template.source.status === 'conflict' && force !== true))
	{
		throw workspaceError('当前模板包含单独修改，请确认后再使用源文件覆盖', 'TEMPLATE_UPDATE_CONFLICT');
	}

	if (template.source.status === 'current')
	{
		return {absolutePath: paths.target, ...template};
	}

	const metadata = await readTemplateSourceMetadata(paths);
	const source = await readTrackedTemplateSource(paths, metadata, true);
	await replaceTemplateFile(paths, source.content);
	metadata.baselineHash = source.hash;
	metadata.sourceSize = source.stat.size;
	metadata.sourceModifiedAt = source.stat.mtimeMs;
	metadata.importedAt = Date.now();
	await writeTemplateSourceMetadata(paths, metadata);

	return {absolutePath: paths.target,
		...await getWorkspaceTemplate(paths.root, {forceSourceRead: true})};
}

export async function removeWorkspaceTemplateSource(root)
{
	const paths = await getTemplatePaths(root);
	await fs.rm(paths.sourceMetadata, {force: true});
}

export async function createWorkspaceDiagram(root, parentRelativePath, value)
{
	let name = validateWorkspaceName(value);

	if (!path.extname(name))
	{
		name += '.drawio';
	}
	else if (path.extname(name).toLowerCase() !== '.drawio')
	{
		throw workspaceError('新建图文件必须使用 .drawio 扩展名', 'INVALID_EXTENSION');
	}

	const parent = await getDirectory(root, parentRelativePath);
	const destination = await resolveWorkspacePath(parent.root,
		path.join(toRelative(parent.root, parent.target), name), {forCreate: true});
	const template = await getWorkspaceTemplateItem(parent.root);
	const content = template == null ? createDiagramXml() :
		(await readTemplateFile(template.absolutePath)).content;

	try
	{
		await fs.writeFile(destination.target, content, {encoding: 'utf8', flag: 'wx'});
	}
	catch (error)
	{
		if (error.code === 'EEXIST')
		{
			throw workspaceError('同名图文件已经存在', 'ALREADY_EXISTS');
		}

		throw error;
	}

	return toRelative(destination.root, destination.target);
}

export async function renameWorkspaceItem(root, relativePath, value)
{
	const resolved = await resolveWorkspacePath(root, relativePath);
	const relative = toRelative(resolved.root, resolved.target);

	if (!relative)
	{
		throw workspaceError('不能重命名工作区根目录', 'ROOT_OPERATION_NOT_ALLOWED');
	}

	const stat = await fs.stat(resolved.target);
	let name = validateWorkspaceName(value);

	if (stat.isFile())
	{
		const currentExtension = path.extname(resolved.target);

		if (!path.extname(name))
		{
			name += currentExtension;
		}
		else if (path.extname(name).toLowerCase() !== currentExtension.toLowerCase())
		{
			throw workspaceError(`文件扩展名必须保持为 ${currentExtension}`, 'INVALID_EXTENSION');
		}
	}

	const destination = await resolveWorkspacePath(resolved.root,
		path.join(path.dirname(relative), name), {forCreate: true});

	if (destination.target === resolved.target)
	{
		return relative;
	}

	try
	{
		await fs.access(destination.target);
		throw workspaceError('同名文件或目录已经存在', 'ALREADY_EXISTS');
	}
	catch (error)
	{
		if (error.code !== 'ENOENT')
		{
			throw error;
		}
	}

	await fs.rename(resolved.target, destination.target);
	return toRelative(destination.root, destination.target);
}

export async function getWorkspaceItem(root, relativePath)
{
	const resolved = await resolveWorkspacePath(root, relativePath);
	const relative = toRelative(resolved.root, resolved.target);

	if (!relative)
	{
		throw workspaceError('不能对工作区根目录执行此操作', 'ROOT_OPERATION_NOT_ALLOWED');
	}

	const stat = await fs.stat(resolved.target);

	return {
		absolutePath: resolved.target,
		relativePath: relative,
		type: stat.isDirectory() ? 'directory' : 'file'
	};
}

async function getWorkspaceFileForTransfer(root, relativePath)
{
	const item = await getWorkspaceItem(root, relativePath);
	const inputRelativePath = relativePath.split(/[\\/]+/).join('/');
	const hasHiddenSegment = inputRelativePath.split('/').some(segment => segment.startsWith('.'));
	const extension = path.extname(item.absolutePath).toLowerCase();

	if (item.type !== 'file' || item.relativePath !== inputRelativePath || hasHiddenSegment ||
		!WORKSPACE_FILE_EXTENSIONS.has(extension))
	{
		throw workspaceError('只能移动或复制工作区中的图文件', 'INVALID_FILE_OPERATION');
	}

	return item;
}

async function ensureDestinationAvailable(target)
{
	try
	{
		await fs.access(target);
		throw workspaceError('目标目录中已有同名文件', 'ALREADY_EXISTS');
	}
	catch (error)
	{
		if (error.code !== 'ENOENT') throw error;
	}
}

async function nextAvailableCopyDestination(directory, fileName)
{
	const extension = path.extname(fileName);
	const base = path.basename(fileName, extension);
	const names = [fileName, `${base} - 副本${extension}`];
	let counter = 2;

	while (true)
	{
		const candidateName = names.shift() || `${base} - 副本 (${counter++})${extension}`;
		validateWorkspaceName(candidateName);
		const candidate = path.join(directory, candidateName);

		try
		{
			await fs.access(candidate);
		}
		catch (error)
		{
			if (error.code === 'ENOENT') return candidate;
			throw error;
		}
	}
}

export async function moveWorkspaceFile(root, relativePath, destinationRelativePath)
{
	const source = await getWorkspaceFileForTransfer(root, relativePath);
	const destinationDirectory = await getDirectory(root, destinationRelativePath);
	const destination = await resolveWorkspacePath(destinationDirectory.root,
		path.join(toRelative(destinationDirectory.root, destinationDirectory.target), path.basename(source.absolutePath)),
		{forCreate: true});

	if (destination.target === source.absolutePath)
	{
		throw workspaceError('文件已经在所选目录中', 'SAME_DIRECTORY');
	}

	await ensureDestinationAvailable(destination.target);
	await fs.rename(source.absolutePath, destination.target);
	return toRelative(destination.root, destination.target);
}

export async function copyWorkspaceFile(root, relativePath, destinationRelativePath)
{
	const source = await getWorkspaceFileForTransfer(root, relativePath);
	const destinationDirectory = await getDirectory(root, destinationRelativePath);
	let destination = await nextAvailableCopyDestination(destinationDirectory.target, path.basename(source.absolutePath));

	while (true)
	{
		ensureInside(destinationDirectory.root, destination);

		try
		{
			await fs.copyFile(source.absolutePath, destination, fsConstants.COPYFILE_EXCL);
			return toRelative(destinationDirectory.root, destination);
		}
		catch (error)
		{
			if (error.code !== 'EEXIST') throw error;
			destination = await nextAvailableCopyDestination(destinationDirectory.target, path.basename(source.absolutePath));
		}
	}
}

async function nextAvailableDestination(directory, fileName)
{
	const extension = path.extname(fileName);
	const base = path.basename(fileName, extension);
	let candidate = path.join(directory, fileName);
	let counter = 2;

	while (true)
	{
		try
		{
			await fs.access(candidate);
			candidate = path.join(directory, `${base} (${counter++})${extension}`);
		}
		catch (error)
		{
			if (error.code === 'ENOENT')
			{
				return candidate;
			}

			throw error;
		}
	}
}

export async function importWorkspaceFiles(root, parentRelativePath, sourcePaths)
{
	if (!Array.isArray(sourcePaths))
	{
		throw workspaceError('没有选择可导入的文件', 'NO_FILES');
	}

	const parent = await getDirectory(root, parentRelativePath);
	const imported = [];

	for (const sourcePath of sourcePaths)
	{
		if (typeof sourcePath !== 'string' || !sourcePath || sourcePath.includes('\0'))
		{
			continue;
		}

		const stat = await fs.lstat(sourcePath);
		const extension = path.extname(sourcePath).toLowerCase();

		if (!stat.isFile() || stat.isSymbolicLink() || !WORKSPACE_FILE_EXTENSIONS.has(extension))
		{
			continue;
		}

		const fileName = validateWorkspaceName(path.basename(sourcePath));
		const target = await nextAvailableDestination(parent.target, fileName);
		ensureInside(parent.root, target);
		await fs.copyFile(sourcePath, target, fsConstants.COPYFILE_EXCL);
		imported.push(toRelative(parent.root, target));
	}

	if (imported.length === 0)
	{
		throw workspaceError('没有可导入的图文件', 'NO_FILES');
	}

	return imported;
}
