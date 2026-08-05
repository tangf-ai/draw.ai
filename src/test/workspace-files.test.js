import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import {
	copyWorkspaceFile,
	createWorkspaceDiagram,
	createWorkspaceDirectory,
	ensureWorkspaceTemplate,
	getWorkspaceItem,
	getWorkspaceTemplate,
	getWorkspaceTemplateItem,
	importWorkspaceTemplate,
	importWorkspaceFiles,
	readWorkspace,
	renameWorkspaceItem,
	moveWorkspaceFile,
	updateWorkspaceTemplateFromSource,
	validateWorkspaceName
} from '../main/workspace-files.js';

async function createTempWorkspace(t)
{
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'drawio-workspace-'));
	t.after(() => fs.rm(root, {recursive: true, force: true}));
	return root;
}

describe('validateWorkspaceName', () =>
{
	test('trims a valid name', () =>
	{
		assert.equal(validateWorkspaceName('  系统架构  '), '系统架构');
	});

	test('rejects traversal and platform-invalid names', () =>
	{
		for (const name of ['', '..', '../escape', 'bad/name', 'bad\\name', 'CON', 'name.'])
		{
			assert.throws(() => validateWorkspaceName(name), /名称/);
		}
	});
});

describe('workspace file operations', () =>
{
	test('creates directories and a valid draw.io diagram', async (t) =>
	{
		const root = await createTempWorkspace(t);
		const directory = await createWorkspaceDirectory(root, '', '业务系统');
		const diagram = await createWorkspaceDiagram(root, directory, '统一认证架构');

		assert.equal(directory, '业务系统');
		assert.equal(diagram, '业务系统/统一认证架构.drawio');
		const content = await fs.readFile(path.join(root, diagram), 'utf8');
		assert.match(content, /^<mxfile[\s\S]+<mxGraphModel[\s\S]+<mxCell id="1" parent="0"\/>/);
		assert.match(content, /<mxGraphModel[^>]+grid="0"[^>]+page="0"/);
	});

	test('creates new diagrams from the configured workspace template', async (t) =>
	{
		const root = await createTempWorkspace(t);
		const sourceRoot = await createTempWorkspace(t);
		const source = path.join(sourceRoot, '团队模板.drawio');
		const template = '<mxfile host="test"><diagram id="template" name="模板页"><mxGraphModel grid="0" page="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="template-marker" value="团队页眉" parent="1"/></root></mxGraphModel></diagram></mxfile>';
		await fs.writeFile(source, template);

		await importWorkspaceTemplate(root, source);
		const diagram = await createWorkspaceDiagram(root, '', '来自模板');
		const state = await readWorkspace(root);

		assert.equal(await fs.readFile(path.join(root, diagram), 'utf8'), template);
		assert.deepEqual(state.template.configured, true);
		assert.equal(state.template.source.status, 'current');
		assert.equal(state.template.source.portable, false);
		assert.deepEqual(state.tree.map(node => node.name), ['来自模板.drawio']);
	});

	test('tracks a workspace template source and updates the hidden template', async (t) =>
	{
		const root = await createTempWorkspace(t);
		const sourceDirectory = await createWorkspaceDirectory(root, '', '公共模板');
		const source = path.join(root, sourceDirectory, '团队模板.drawio');
		const first = '<mxfile host="test"><diagram id="v1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="marker" value="第一版" parent="1"/></root></mxGraphModel></diagram></mxfile>';
		const second = first.replace('第一版', '第二版');
		await fs.writeFile(source, first);

		await importWorkspaceTemplate(root, source);
		let template = await getWorkspaceTemplate(root, {forceSourceRead: true});
		assert.equal(template.source.status, 'current');
		assert.equal(template.source.portable, true);
		assert.equal(template.source.displayPath, '公共模板/团队模板.drawio');

		await fs.writeFile(source, second);
		template = await getWorkspaceTemplate(root, {forceSourceRead: true});
		assert.equal(template.source.status, 'source-updated');
		assert.equal(template.source.canUpdate, true);

		const updated = await updateWorkspaceTemplateFromSource(root);
		assert.equal(updated.source.status, 'current');
		assert.equal(await fs.readFile(updated.absolutePath, 'utf8'), second);
		const diagram = await createWorkspaceDiagram(root, '', '使用新版模板');
		assert.equal(await fs.readFile(path.join(root, diagram), 'utf8'), second);
	});

	test('detects local template edits and requires confirmation for conflicts', async (t) =>
	{
		const root = await createTempWorkspace(t);
		const source = path.join(root, '公共模板.drawio');
		const first = '<mxfile><diagram id="v1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>';
		const sourceUpdate = first.replace('id="v1"', 'id="source-v2"');
		const localUpdate = first.replace('id="v1"', 'id="local-v2"');
		await fs.writeFile(source, first);

		const imported = await importWorkspaceTemplate(root, source);
		await fs.writeFile(imported.absolutePath, localUpdate);
		let template = await getWorkspaceTemplate(root, {forceSourceRead: true});
		assert.equal(template.source.status, 'template-modified');
		await assert.rejects(updateWorkspaceTemplateFromSource(root), /单独修改/);

		await fs.writeFile(source, sourceUpdate);
		template = await getWorkspaceTemplate(root, {forceSourceRead: true});
		assert.equal(template.source.status, 'conflict');
		await assert.rejects(updateWorkspaceTemplateFromSource(root), /确认后/);

		const updated = await updateWorkspaceTemplateFromSource(root, true);
		assert.equal(updated.source.status, 'current');
		assert.equal(await fs.readFile(updated.absolutePath, 'utf8'), sourceUpdate);
	});

	test('reports an unavailable imported template source without disabling the hidden template', async (t) =>
	{
		const root = await createTempWorkspace(t);
		const sourceRoot = await createTempWorkspace(t);
		const source = path.join(sourceRoot, '临时模板.drawio');
		await fs.writeFile(source, '<mxfile><diagram id="source"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>');
		await importWorkspaceTemplate(root, source);
		await fs.rm(source);

		const template = await getWorkspaceTemplate(root, {forceSourceRead: true});
		assert.equal(template.configured, true);
		assert.equal(template.invalid, false);
		assert.equal(template.source.status, 'unavailable');
		assert.match(template.source.error, /不存在/);
		await assert.rejects(updateWorkspaceTemplateFromSource(root), /不存在/);
	});

	test('creates an editable blank template and keeps it out of the file tree', async (t) =>
	{
		const root = await createTempWorkspace(t);
		const template = await ensureWorkspaceTemplate(root);
		const state = await readWorkspace(root);

		assert.equal(template.configured, true);
		assert.match(await fs.readFile(template.absolutePath, 'utf8'), /grid="0"[\s\S]+page="0"/);
		assert.equal(state.template.source.status, 'untracked');
		assert.deepEqual(state.tree, []);
		assert.deepEqual(state.counts, {directories: 0, files: 0});
	});

	test('rejects invalid and symbolic-link templates', async (t) =>
	{
		const root = await createTempWorkspace(t);
		const sourceRoot = await createTempWorkspace(t);
		const invalid = path.join(sourceRoot, 'invalid.drawio');
		await fs.writeFile(invalid, 'not draw.io xml');

		await assert.rejects(importWorkspaceTemplate(root, invalid), /有效的 draw.io/);
		const template = await ensureWorkspaceTemplate(root);
		await fs.rm(template.absolutePath);
		await fs.symlink(invalid, template.absolutePath);
		assert.deepEqual((await getWorkspaceTemplate(root)).invalid, true);
		await assert.rejects(getWorkspaceTemplateItem(root), /模板文件无效/);
	});

	test('scans supported files, sorts folders first and hides drafts', async (t) =>
	{
		const root = await createTempWorkspace(t);
		await fs.mkdir(path.join(root, 'B folder'));
		await fs.mkdir(path.join(root, 'A folder'));
		await fs.writeFile(path.join(root, 'diagram.drawio'), '<mxfile/>');
		await fs.writeFile(path.join(root, 'notes.txt'), 'ignore');
		await fs.writeFile(path.join(root, '.$diagram.drawio.bkp'), 'ignore');

		const state = await readWorkspace(root);

		assert.deepEqual(state.tree.map(node => node.name), ['A folder', 'B folder', 'diagram.drawio']);
		assert.deepEqual(state.counts, {directories: 2, files: 1});
	});

	test('rejects paths outside the workspace', async (t) =>
	{
		const root = await createTempWorkspace(t);

		await assert.rejects(createWorkspaceDirectory(root, '..', 'escape'), /工作区/);
		await assert.rejects(getWorkspaceItem(root, '../outside.drawio'), /工作区/);
	});

	test('skips symbolic links during scanning', async (t) =>
	{
		const root = await createTempWorkspace(t);
		const outside = await createTempWorkspace(t);
		await fs.writeFile(path.join(outside, 'secret.drawio'), '<mxfile/>');
		await fs.symlink(outside, path.join(root, 'linked'));

		const state = await readWorkspace(root);
		assert.deepEqual(state.tree, []);
	});

	test('renames files while preserving their extension', async (t) =>
	{
		const root = await createTempWorkspace(t);
		const diagram = await createWorkspaceDiagram(root, '', '旧名称');
		const renamed = await renameWorkspaceItem(root, diagram, '新名称');

		assert.equal(renamed, '新名称.drawio');
		await assert.rejects(renameWorkspaceItem(root, renamed, '错误.xml'), /扩展名/);
	});

	test('moves a diagram to another workspace directory without overwriting', async (t) =>
	{
		const root = await createTempWorkspace(t);
		const sourceDirectory = await createWorkspaceDirectory(root, '', '待整理');
		const destinationDirectory = await createWorkspaceDirectory(root, '', '已归档');
		const source = await createWorkspaceDiagram(root, sourceDirectory, '系统架构');
		const moved = await moveWorkspaceFile(root, source, destinationDirectory);

		assert.equal(moved, '已归档/系统架构.drawio');
		await assert.rejects(fs.access(path.join(root, source)));
		await fs.writeFile(path.join(root, sourceDirectory, '系统架构.drawio'), 'conflict');
		await assert.rejects(moveWorkspaceFile(root, moved, sourceDirectory), /同名文件/);
		assert.match(await fs.readFile(path.join(root, moved), 'utf8'), /^<mxfile/);
		await assert.rejects(moveWorkspaceFile(root, moved, destinationDirectory), /已经在所选目录/);
	});

	test('copies diagrams and creates predictable duplicate names', async (t) =>
	{
		const root = await createTempWorkspace(t);
		const destinationDirectory = await createWorkspaceDirectory(root, '', '副本');
		const source = await createWorkspaceDiagram(root, '', '系统架构');
		const first = await copyWorkspaceFile(root, source, destinationDirectory);
		const second = await copyWorkspaceFile(root, source, destinationDirectory);
		const localCopy = await copyWorkspaceFile(root, source, '');
		const sourceContent = await fs.readFile(path.join(root, source), 'utf8');

		assert.equal(first, '副本/系统架构.drawio');
		assert.equal(second, '副本/系统架构 - 副本.drawio');
		assert.equal(localCopy, '系统架构 - 副本.drawio');
		assert.equal(await fs.readFile(path.join(root, first), 'utf8'), sourceContent);
		assert.equal(await fs.readFile(path.join(root, second), 'utf8'), sourceContent);
	});

	test('limits move and copy to visible supported workspace files', async (t) =>
	{
		const root = await createTempWorkspace(t);
		await createWorkspaceDirectory(root, '', '目录');
		await fs.writeFile(path.join(root, '说明.txt'), 'hidden from workspace');
		const template = await ensureWorkspaceTemplate(root);

		await assert.rejects(copyWorkspaceFile(root, '目录', ''), /图文件/);
		await assert.rejects(copyWorkspaceFile(root, '说明.txt', ''), /图文件/);
		await assert.rejects(moveWorkspaceFile(root,
			path.relative(await fs.realpath(root), template.absolutePath), ''), /图文件/);
	});

	test('imports without overwriting an existing file', async (t) =>
	{
		const root = await createTempWorkspace(t);
		const sourceRoot = await createTempWorkspace(t);
		const source = path.join(sourceRoot, '架构.drawio');
		await fs.writeFile(source, '<mxfile id="source"/>');
		await fs.writeFile(path.join(root, '架构.drawio'), '<mxfile id="existing"/>');

		const imported = await importWorkspaceFiles(root, '', [source]);

		assert.deepEqual(imported, ['架构 (2).drawio']);
		assert.equal(await fs.readFile(path.join(root, '架构.drawio'), 'utf8'), '<mxfile id="existing"/>');
	});

	test('does not allow root-level item operations', async (t) =>
	{
		const root = await createTempWorkspace(t);
		await assert.rejects(getWorkspaceItem(root, ''), /根目录/);
	});
});
