// Run with: npm run test:directory-renderer
import {app, BrowserWindow, ipcMain} from 'electron';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm, access, realpath} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createWorkspaceController} from '../main/workspace-window.js';

app.on('window-all-closed', () => {});

async function checkDirectoryMoves()
{
	let window;
	let directory;
	let profile;
	let controller;
	let exitCode = 0;
	try
	{
		profile = await mkdtemp(path.join(os.tmpdir(), 'draw-ai-directory-profile-'));
		app.setPath('userData', profile);
		await app.whenReady();
		directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'draw-ai-directory-renderer-')));
		await mkdir(path.join(directory, '公司/部门'), {recursive: true});
		await mkdir(path.join(directory, '归档'));
		await writeFile(path.join(directory, '公司/部门/图纸.drawio'), '<mxfile/>');
		controller = createWorkspaceController({app, BrowserWindow, ipcMain,
			dialog: {}, store: {get: () => directory}});
		window = new BrowserWindow({show: false, width: 1180, height: 760,
			webPreferences: {preload: fileURLToPath(new URL('../workspace/preload.js', import.meta.url)),
				contextIsolation: true, sandbox: true}});
		await window.loadFile(fileURLToPath(new URL('../workspace/index.html', import.meta.url)));
		const evaluate = script => window.webContents.executeJavaScript(script);
		const waitFor = condition => evaluate(`new Promise((resolve, reject) => {
			const deadline = Date.now() + 5000;
			const poll = () => { if (${condition}) resolve(); else if (Date.now() > deadline)
				reject(new Error('Directory renderer wait timed out: ' + ${JSON.stringify(condition)}));
				else setTimeout(poll, 20); }; poll();
		})`);
		await waitFor(`document.querySelector('[data-testid="file-row-公司"]') != null`);
		assert.equal(await evaluate(`document.querySelector('[data-testid="file-row-公司"]').draggable`), true);
		assert.equal(await evaluate(`document.querySelector('[data-testid="tree-公司"]').draggable`), true);
		await evaluate(`document.querySelector('button[aria-label="移动 公司"]').click()`);
		assert.deepEqual(await evaluate(`Array.from(document.getElementById('transfer-destination').options)
			.filter(o => o.disabled).map(o => o.value).sort()`), ['', '公司', '公司/部门']);
		assert.equal(await evaluate(`document.getElementById('transfer-dialog-title').textContent`), '移动目录');
		await evaluate(`document.getElementById('transfer-destination').value = '归档';
			document.getElementById('transfer-submit').click()`);
		await waitFor(`!document.getElementById('transfer-dialog').open &&
			document.querySelector('[data-testid="tree-归档/公司"]') != null`);
		assert.equal(await readFile(path.join(directory, '归档/公司/部门/图纸.drawio'), 'utf8'), '<mxfile/>');
		await assert.rejects(access(path.join(directory, '公司')));

		// Moving an ancestor in the directory tree keeps the selected descendant open.
		await evaluate(`document.querySelector('[data-testid="tree-归档/公司/部门"]').click()`);
		await evaluate(`(() => {
			const source = document.querySelector('[data-testid="tree-归档/公司"]');
			const transfer = new DataTransfer();
			source.dispatchEvent(new DragEvent('dragstart', {bubbles: true, dataTransfer: transfer}));
			const invalid = document.querySelector('[data-testid="tree-归档/公司/部门"]');
			invalid.dispatchEvent(new DragEvent('dragover', {bubbles: true, cancelable: true, dataTransfer: transfer}));
			if (invalid.classList.contains('is-drop-target')) throw new Error('Descendant accepted a folder drop');
			document.querySelector('[data-testid="tree-root"]').dispatchEvent(
				new DragEvent('drop', {bubbles: true, cancelable: true, dataTransfer: transfer}));
		})()`);
		await waitFor(`document.querySelector('[data-testid="file-row-公司/部门/图纸.drawio"]') != null`);
		assert.equal(await readFile(path.join(directory, '公司/部门/图纸.drawio'), 'utf8'), '<mxfile/>');

		// The right-hand list can also move a folder into another folder.
		await evaluate(`document.querySelector('[data-testid="tree-root"]').click()`);
		await evaluate(`(() => {
			const transfer = new DataTransfer();
			document.querySelector('[data-testid="file-row-公司"]').dispatchEvent(
				new DragEvent('dragstart', {bubbles: true, dataTransfer: transfer}));
			document.querySelector('[data-testid="file-row-归档"]').dispatchEvent(
				new DragEvent('drop', {bubbles: true, cancelable: true, dataTransfer: transfer}));
		})()`);
		await waitFor(`document.querySelector('[data-testid="tree-归档/公司"]') != null &&
			document.querySelector('[data-testid="tree-公司"]') == null`);
		assert.equal(await readFile(path.join(directory, '归档/公司/部门/图纸.drawio'), 'utf8'), '<mxfile/>');
		if (process.env.DRAW_AI_DIRECTORY_SCREENSHOT)
		{
			await evaluate(`document.querySelector('[data-testid="tree-归档"]').click()`);
			window.showInactive();
			await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
			await writeFile(process.env.DRAW_AI_DIRECTORY_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
		}
		console.log('Directory renderer passed: real preload/IPC, move dialog, invalid destinations, tree/list drops, nested selection and preserved files');
	}
	catch (error)
	{
		console.error(error);
		exitCode = 1;
	}
	finally
	{
		controller?.stop();
		window?.destroy();
		if (directory) await rm(directory, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});
		if (profile) await rm(profile, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});
		app.exit(exitCode);
	}
}

checkDirectoryMoves().catch(error => { console.error(error); app.exit(1); });
