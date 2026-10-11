import {describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile, mkdtemp, mkdir, writeFile, rename, rm, access, symlink, realpath} from 'fs/promises';
import os from 'os';
import path from 'path';
import {fileURLToPath} from 'url';
import {createWorkspaceController} from '../main/workspace-window.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function source(relativePath)
{
	return readFile(path.join(projectRoot, relativePath), 'utf8');
}

describe('editor workspace explorer', () =>
{
	test('exposes guarded file management channels to the editor', async () =>
	{
		const preload = await source('src/main/electron-preload.js');
		const main = await source('src/main/workspace-window.js');

		assert.match(preload,
			/moveFile: \(relativePath, destinationRelativePath, expectedRoot\) =>\s*invokeWorkspace\('workspace:move-file'/);
		assert.match(main,
			/handle\('workspace:move-file',[\s\S]*moveWorkspaceFile\(root, relativePath, destinationRelativePath\)/);
		assert.match(preload, /invokeWorkspace\('workspace:rename-file'/);
		assert.match(preload, /invokeWorkspace\('workspace:copy-file'/);
		assert.match(preload, /invokeWorkspace\('workspace:trash-file'/);
	});

	test('wires diagram rows to directory and root drop targets', async () =>
	{
		const plugin = await source('drawio/src/main/webapp/plugins/workspace-explorer.js');

		assert.match(plugin, /row\.draggable = true/);
		assert.match(plugin, /application\/x-draw-ai-workspace-file/);
		assert.match(plugin, /dropFile\(event, item\.relativePath, row\)/);
		assert.match(plugin, /dropFile\(event, '', identity\)/);
		assert.match(plugin, /return api\.moveFile\(relativePath, destinationRelativePath, root\)/);
	});

	test('rebinds a moved current diagram while preserving its undo history', async () =>
	{
		const plugin = await source('drawio/src/main/webapp/plugins/workspace-explorer.js');

		assert.match(plugin, /return saveCurrentFile\(\)/);
		assert.match(plugin, /file\.fileObject\.path = result\.absolutePath/);
		assert.match(plugin, /file\.descriptorChanged\(\)/);
	});

	test('wires manager file rows to directory drag-and-drop targets', async () =>
	{
		const manager = await source('src/workspace/workspace.js');

		assert.match(manager, /row\.draggable = true/);
		assert.match(manager, /application\/x-draw-ai-workspace-file/);
		assert.match(manager, /button\.addEventListener\('dragover'/);
		assert.match(manager, /button\.addEventListener\('drop'/);
		assert.match(manager, /api\.moveFile\(relativePath, destinationRelativePath\)/);
	});

	test('wires manager directory rows to main-list drop targets', async () =>
	{
		const manager = await source('src/workspace/workspace.js');

		assert.match(manager,
			/else if \(node\.type === 'directory'\)[\s\S]*row\.addEventListener\('dragover'/);
		assert.match(manager,
			/else if \(node\.type === 'directory'\)[\s\S]*row\.addEventListener\('drop'/);
		assert.match(manager, /elements\.fileList\.querySelectorAll\('\.is-drop-target'\)/);
	});

	test('pressing Enter in the name dialog submits the save button', async () =>
	{
		const manager = await source('src/workspace/workspace.js');

		assert.match(manager, /elements\.nameForm\.addEventListener\('keydown'/);
		assert.match(manager, /event\.key !== 'Enter'/);
		assert.match(manager, /elements\.nameForm\.requestSubmit\(elements\.nameSubmit\)/);
	});
});

async function workspaceControllerFixture(t)
{
	const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'draw-ai-explorer-')));
	t.after(() => rm(root, {recursive: true, force: true}));
	await mkdir(path.join(root, '目标'));
	await mkdir(path.join(root, '.trash'));
	await writeFile(path.join(root, '测试.drawio'), '<mxfile>latest saved contents</mxfile>');
	const handlers = new Map();
	const authorized = [];
	const controller = createWorkspaceController({
		app: {}, BrowserWindow: {}, dialog: {},
		ipcMain: {handle: (channel, action) => handlers.set(channel, action)},
		store: {get: () => root},
		isEditorSender: frame => frame?.url === 'test://editor',
		authorizePath: absolutePath => authorized.push(absolutePath),
		shell: {trashItem: file => rename(file, path.join(root, '.trash', path.basename(file)))}
	});
	t.after(() => controller.stop());
	return {root, authorized, call: (channel, ...args) =>
		handlers.get(channel)({senderFrame: {url: 'test://editor'}}, ...args), handlers};
}

describe('editor workspace file actions', () =>
{
	test('rejects actions carrying a stale workspace root', async t =>
	{
		const f = await workspaceControllerFixture(t);
		for (const [channel, args] of [
			['workspace:rename-file', ['测试.drawio', '新名称', '/stale/workspace']],
			['workspace:move-file', ['测试.drawio', '目标', '/stale/workspace']],
			['workspace:copy-file', ['测试.drawio', '', '/stale/workspace']],
			['workspace:trash-file', ['测试.drawio', '/stale/workspace']]
		])
		{
			const result = await f.call(channel, ...args);
			assert.equal(result.ok, false);
			assert.match(result.error, /工作区已切换/);
		}
		await access(path.join(f.root, '测试.drawio'));
	});

	test('rejects untrusted renderer requests before mutating files', async t =>
	{
		const f = await workspaceControllerFixture(t);
		for (const channel of ['workspace:rename-file', 'workspace:copy-file', 'workspace:move-file', 'workspace:trash-file'])
		{
			const result = await f.handlers.get(channel)({senderFrame: {url: 'https://example.com'}}, '测试.drawio', '目标');
			assert.equal(result.code, 'INVALID_SENDER');
		}
		await access(path.join(f.root, '测试.drawio'));
	});

	test('returns and authorizes new paths after rename and move', async t =>
	{
		const f = await workspaceControllerFixture(t);
		const renamed = await f.call('workspace:rename-file', '测试.drawio', '新名称');
		assert.equal(renamed.ok, true);
		assert.equal(renamed.data.renamedRelativePath, '新名称.drawio');
		assert.equal(renamed.data.absolutePath, path.join(f.root, '新名称.drawio'));
		const moved = await f.call('workspace:move-file', '新名称.drawio', '目标');
		assert.equal(moved.ok, true);
		assert.equal(moved.data.movedRelativePath, '目标/新名称.drawio');
		assert.equal(moved.data.absolutePath, path.join(f.root, '目标/新名称.drawio'));
		assert.deepEqual(f.authorized, [renamed.data.absolutePath, moved.data.absolutePath]);
		assert.equal(await readFile(moved.data.absolutePath, 'utf8'), '<mxfile>latest saved contents</mxfile>');
	});

	test('rejects directories, unsupported files, hidden paths and symbolic links', async t =>
	{
		const f = await workspaceControllerFixture(t);
		await writeFile(path.join(f.root, '.hidden.drawio'), 'hidden');
		await writeFile(path.join(f.root, '~$draft.drawio'), 'draft');
		await writeFile(path.join(f.root, '说明.txt'), 'unsupported');
		await symlink(path.join(f.root, '测试.drawio'), path.join(f.root, '链接.drawio'));
		for (const relativePath of ['目标', '.hidden.drawio', '~$draft.drawio', '说明.txt', '链接.drawio', '../escape.drawio'])
		{
			for (const channel of ['workspace:rename-file', 'workspace:trash-file'])
			{
				const result = await f.call(channel, relativePath, '新名称');
				assert.equal(result.ok, false, `${channel} ${relativePath}`);
			}
		}
		await access(path.join(f.root, '测试.drawio'));
	});

	test('invalid and colliding names leave the source intact', async t =>
	{
		const f = await workspaceControllerFixture(t);
		await writeFile(path.join(f.root, '存在.drawio'), 'existing');
		for (const name of ['.hidden.drawio', '~$draft.drawio', '../escape.drawio', '错误.xml', '存在.drawio'])
		{
			const result = await f.call('workspace:rename-file', '测试.drawio', name);
			assert.equal(result.ok, false, name);
			assert.equal(await readFile(path.join(f.root, '测试.drawio'), 'utf8'), '<mxfile>latest saved contents</mxfile>');
		}
		assert.equal(await readFile(path.join(f.root, '存在.drawio'), 'utf8'), 'existing');
	});

	test('copies with a unique name and trashes through the system trash dependency', async t =>
	{
		const f = await workspaceControllerFixture(t);
		const first = await f.call('workspace:copy-file', '测试.drawio', '');
		const second = await f.call('workspace:copy-file', '测试.drawio', '');
		assert.equal(first.data.copiedRelativePath, '测试 - 副本.drawio');
		assert.equal(second.data.copiedRelativePath, '测试 - 副本 (2).drawio');
		const trashed = await f.call('workspace:trash-file', '测试.drawio');
		assert.equal(trashed.ok, true);
		assert.equal(trashed.data.state.counts.files, 2);
		await assert.rejects(access(path.join(f.root, '测试.drawio')));
		assert.equal(await readFile(path.join(f.root, '.trash/测试.drawio'), 'utf8'),
			await readFile(path.join(f.root, first.data.copiedRelativePath), 'utf8'));
	});
});
