// Run with: npm run test:theme-renderer
import {app, BrowserWindow, ipcMain} from 'electron';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm, realpath} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createWorkspaceController} from '../main/workspace-window.js';

app.on('window-all-closed', () => {});

async function checkWorkspaceTheme()
{
	let window;
	let directory;
	let profile;
	let controller;
	let exitCode = 0;
	try
	{
		profile = await mkdtemp(path.join(os.tmpdir(), 'draw-ai-theme-profile-'));
		app.setPath('userData', profile);
		await app.whenReady();
		directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'draw-ai-theme-workspace-')));
		await mkdir(path.join(directory, '公司'));
		await mkdir(path.join(directory, '归档'));
		await writeFile(path.join(directory, '企业知识库.drawio'), '<mxfile/>');
		controller = createWorkspaceController({app, BrowserWindow, ipcMain,
			dialog: {}, store: {get: () => directory}});
		window = new BrowserWindow({show: false, width: 1180, height: 760,
			webPreferences: {preload: fileURLToPath(new URL('../workspace/preload.js', import.meta.url)),
				contextIsolation: true, sandbox: true}});
		const errors = [];
		window.webContents.on('console-message', (_event, level, message) =>
		{
			if (level === 3) errors.push(message);
		});
		await window.loadFile(fileURLToPath(new URL('../workspace/index.html', import.meta.url)));
		const evaluate = script => window.webContents.executeJavaScript(script);
		const waitFor = condition => evaluate(`new Promise((resolve, reject) => {
			const deadline = Date.now() + 5000;
			const poll = () => { if (${condition}) resolve(); else if (Date.now() > deadline)
				reject(new Error('Theme renderer wait timed out: ' + ${JSON.stringify(condition)}));
				else setTimeout(poll, 20); }; poll();
		})`);
		await waitFor(`document.querySelector('[data-testid="file-row-企业知识库.drawio"]') != null`);
		assert.deepEqual(await evaluate(`({
			topbar: getComputedStyle(document.querySelector('.topbar')).backgroundColor,
			sidebar: getComputedStyle(document.querySelector('.sidebar')).backgroundColor,
			button: getComputedStyle(document.getElementById('new-diagram-button')).backgroundColor,
			brand: document.querySelector('.brand-name').textContent,
			caption: document.querySelector('.brand-caption').textContent,
			current: document.querySelector('[data-testid="tree-root"]').getAttribute('aria-current'),
			rootIcon: document.querySelector('[data-testid="tree-root"] .folder-icon use').getAttribute('href'),
			fileIcon: document.querySelector('.file-type-icon use').getAttribute('href')
		})`), {topbar: 'rgb(255, 255, 255)', sidebar: 'rgb(247, 249, 248)',
			button: 'rgb(21, 122, 107)', brand: 'draw.ai', caption: '图纸工作区',
			current: 'page', rootIcon: '#icon-grid', fileIcon: '#icon-diagram'});
		assert.equal(await evaluate(`document.querySelectorAll('.workspace-avatar use, .local-status > span').length`), 2);
		for (const [width, height] of [[1180, 760], [800, 600]])
		{
			window.setContentSize(width, height);
			await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
			assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), true);
			assert.equal(await evaluate(`(() => {
				const button = document.getElementById('new-diagram-button').getBoundingClientRect();
				const search = document.querySelector('.search-field').getBoundingClientRect();
				return button.right <= innerWidth && search.right <= innerWidth && search.left >= 244;
			})()`), true);
		}
		await evaluate(`document.querySelector('[data-testid="tree-公司"]').click()`);
		assert.equal(await evaluate(`document.getElementById('directory-title').textContent`), '公司');
		assert.equal(await evaluate(`document.querySelector('[data-testid="tree-公司"]').getAttribute('aria-current')`), 'page');
		await evaluate(`document.getElementById('new-folder-button').click()`);
		assert.equal(await evaluate(`document.getElementById('name-dialog').open`), true);
		await evaluate(`document.getElementById('name-input').value = '测试目录';
			document.getElementById('name-submit').click()`);
		await waitFor(`document.querySelector('[data-testid="file-row-公司/测试目录"]') != null`);
		await evaluate(`(() => { document.querySelector('[data-testid="tree-root"]').click();
			const input = document.getElementById('search-input'); input.value = '知识库';
			input.dispatchEvent(new Event('input')); })()`);
		await waitFor(`document.querySelectorAll('.file-row').length === 1`);
		assert.equal(await evaluate(`document.querySelector('.file-row').dataset.path`), '企业知识库.drawio');
		await evaluate(`(() => { const input = document.getElementById('search-input'); input.value = '';
			input.dispatchEvent(new Event('input')); })()`);
		await waitFor(`document.querySelectorAll('.file-row').length === 3`);
		if (process.env.DRAW_AI_THEME_SCREENSHOT)
		{
			window.setContentSize(1180, 730);
			window.showInactive();
			await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
			await writeFile(process.env.DRAW_AI_THEME_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
		}
		assert.deepEqual(errors, []);
		console.log('Workspace theme renderer passed: light/green colors, branding, icons, active navigation, two window sizes, create directory and search via real preload/IPC');
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

checkWorkspaceTheme().catch(error => { console.error(error); app.exit(1); });
