import {describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'fs/promises';
import path from 'path';
import {fileURLToPath} from 'url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function source(relativePath)
{
	return readFile(path.join(projectRoot, relativePath), 'utf8');
}

describe('editor workspace explorer', () =>
{
	test('exposes only the guarded workspace move channel to the editor', async () =>
	{
		const preload = await source('src/main/electron-preload.js');
		const main = await source('src/main/workspace-window.js');

		assert.match(preload,
			/moveFile: \(relativePath, destinationRelativePath\) =>\s*invokeWorkspace\('workspace:move-file'/);
		assert.match(main,
			/handle\('workspace:move-file',[\s\S]*moveWorkspaceFile\(root, relativePath, destinationRelativePath\)/);
	});

	test('wires diagram rows to directory and root drop targets', async () =>
	{
		const plugin = await source('drawio/src/main/webapp/plugins/workspace-explorer.js');

		assert.match(plugin, /row\.draggable = true/);
		assert.match(plugin, /application\/x-draw-ai-workspace-file/);
		assert.match(plugin, /dropFile\(event, item\.relativePath, row\)/);
		assert.match(plugin, /dropFile\(event, '', identity\)/);
		assert.match(plugin, /return api\.moveFile\(relativePath, destinationRelativePath\)/);
	});

	test('saves and reloads a moved current diagram from its new path', async () =>
	{
		const plugin = await source('drawio/src/main/webapp/plugins/workspace-explorer.js');

		assert.match(plugin, /var ready = movingCurrentFile \? saveCurrentFile\(\) : Promise\.resolve\(\)/);
		assert.match(plugin, /api\.resolveItem\(result\.movedRelativePath\)/);
		assert.match(plugin, /ui\.loadArgs\(\{args: \[resolved\.absolutePath\]\}\)/);
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

	test('pressing Enter in the name dialog submits the save button', async () =>
	{
		const manager = await source('src/workspace/workspace.js');

		assert.match(manager, /elements\.nameForm\.addEventListener\('keydown'/);
		assert.match(manager, /event\.key !== 'Enter'/);
		assert.match(manager, /elements\.nameForm\.requestSubmit\(elements\.nameSubmit\)/);
	});
});
