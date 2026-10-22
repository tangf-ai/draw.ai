import {describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile, mkdtemp, mkdir, writeFile, rename, rm, access, symlink, realpath} from 'fs/promises';
import os from 'os';
import path from 'path';
import {fileURLToPath} from 'url';
import {createWorkspaceController} from '../main/workspace-window.js';
import {runInNewContext} from 'node:vm';

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

		assert.match(manager, /addDragSource\(row, node\)/);
		assert.match(manager, /target\.draggable = true/);
		assert.match(manager, /application\/x-draw-ai-workspace-file/);
		assert.match(manager, /button\.addEventListener\('dragover'/);
		assert.match(manager, /button\.addEventListener\('drop'/);
		assert.match(manager, /api\.moveFile\(item\.relativePath, destinationRelativePath, workspaceState\.root\)/);
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
	const notifications = [];
	const controller = createWorkspaceController({
		app: {}, BrowserWindow: {getAllWindows: () => [{isDestroyed: () => false,
			webContents: {send: (channel, data) => notifications.push({channel, data})}}]}, dialog: {},
		ipcMain: {handle: (channel, action) => handlers.set(channel, action)},
		store: {get: () => root},
		isEditorSender: frame => frame?.url === 'test://editor',
		authorizePath: absolutePath => authorized.push(absolutePath),
		shell: {trashItem: file => rename(file, path.join(root, '.trash', path.basename(file)))}
	});
	t.after(() => controller.stop());
	return {root, authorized, notifications, call: (channel, ...args) =>
		handlers.get(channel)({senderFrame: {url: 'test://editor'}}, ...args), handlers};
}

describe('editor workspace file actions', () =>
{
	test('directory moves validate the sender and root, then notify open editors with both paths', async t =>
	{
		const f = await workspaceControllerFixture(t);
		await mkdir(path.join(f.root, '源目录/子目录'), {recursive: true});
		await writeFile(path.join(f.root, '源目录/子目录/图纸.drawio'), 'saved');
		const denied = await f.handlers.get('workspace:move-directory')(
			{senderFrame: {url: 'https://example.com'}}, '源目录', '目标', f.root);
		assert.equal(denied.code, 'INVALID_SENDER');
		assert.equal((await f.call('workspace:move-directory', '源目录', '目标', '/stale')).ok, false);
		assert.equal((await f.call('workspace:move-directory', '源目录', '源目录/子目录', f.root)).ok, false);
		assert.equal(f.notifications.length, 0);
		const result = await f.call('workspace:move-directory', '源目录', '目标', f.root);
		assert.equal(result.ok, true);
		assert.equal(result.data.movedRelativePath, '目标/源目录');
		assert.equal(result.data.absolutePath, path.join(f.root, '目标/源目录'));
		assert.deepEqual(f.notifications, [{channel: 'workspace:moved', data: {
			root: f.root, oldRelativePath: '源目录', movedRelativePath: '目标/源目录',
			oldAbsolutePath: path.join(f.root, '源目录'), absolutePath: path.join(f.root, '目标/源目录')
		}}]);
		assert.equal(await readFile(path.join(f.root, '目标/源目录/子目录/图纸.drawio'), 'utf8'), 'saved');
	});

	test('open diagrams follow moved ancestor directories without replacing their model or undo history', async () =>
	{
		const plugin = await source('drawio/src/main/webapp/plugins/workspace-explorer.js');
		const start = plugin.indexOf('\tfunction handleMovedDirectory(');
		const end = plugin.indexOf('\n\tfunction matchesSearch(', start);
		const file = {fileObject: {path: '/workspace/源/子/图.drawio', draftFileName: '/workspace/源/子/.draft'},
			descriptorChanged() { this.descriptorUpdates = (this.descriptorUpdates || 0) + 1; }};
		const undoHistory = ['unsaved edit'];
		let enabled = true;
		let watched = null;
		let authorized = null;
		const context = {
			state: {root: '/workspace'}, currentDirectory: '源/子',
			ui: {getCurrentFile: () => file, editor: {graph: {undoHistory,
				isEnabled: () => enabled, setEnabled: value => { enabled = value; }, stopEditing() {}}},
				watchFile: value => { watched = value; }},
			currentFilePath: () => file.fileObject.path,
			normalizedPath: value => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase(),
			api: {resolveItem: async value => { authorized = value; return {absolutePath: '/workspace/' + value}; }}
		};
		runInNewContext(plugin.slice(start, end) + '\nthis.moved = handleMovedDirectory;', context);
		await context.moved({root: '/workspace', oldRelativePath: '源', movedRelativePath: '目标/源',
			oldAbsolutePath: '/workspace/源', absolutePath: '/workspace/目标/源'});
		assert.equal(file.fileObject.path, '/workspace/目标/源/子/图.drawio');
		assert.equal(file.fileObject.draftFileName, '/workspace/目标/源/子/.draft');
		assert.equal(context.currentDirectory, '目标/源/子');
		assert.equal(authorized, '目标/源/子/图.drawio');
		assert.equal(watched, file);
		assert.equal(enabled, true);
		assert.deepEqual(undoHistory, ['unsaved edit']);
		await context.moved({root: '/other', oldAbsolutePath: '/workspace/目标', oldRelativePath: '目标'});
		assert.equal(file.descriptorUpdates, 1);
	});
	test('guards content search by sender and current workspace root', async t =>
	{
		const f = await workspaceControllerFixture(t);
		const denied = await f.handlers.get('workspace:search')({senderFrame: {url: 'https://example.com'}}, '测试');
		assert.equal(denied.code, 'INVALID_SENDER');
		const stale = await f.call('workspace:search', '测试', '/stale/workspace');
		assert.equal(stale.ok, false);
		assert.match(stale.error, /工作区已切换/);
		const result = await f.call('workspace:search', '测试', f.root);
		assert.equal(result.ok, true);
		assert.equal(result.data.root, f.root);
		assert.equal(result.data.results[0].relativePath, '测试.drawio');
	});

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
