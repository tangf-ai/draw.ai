// Run with: npm run test:search-renderer
import {app, BrowserWindow, ipcMain} from 'electron';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm, realpath} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createWorkspaceController} from '../main/workspace-window.js';

async function runRendererChecks()
{
	app.on('window-all-closed', () => {});
	let window;
	let directory;
	let controller;
	let exitCode = 0;
	try
	{
		await app.whenReady();
		directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'draw-ai-search-renderer-')));
		await mkdir(path.join(directory, '归档'));
		const file = path.join(directory, '归档/系统.drawio');
		await writeFile(file, '<mxfile><diagram name="架构"><mxGraphModel><root><mxCell value="企业知识库 &amp;lt;img src=x onerror=alert(1)&amp;gt;"/></root></mxGraphModel></diagram></mxfile>');
		await writeFile(path.join(directory, '知识库清单.drawio'), '<mxGraphModel><root/></mxGraphModel>');
		await writeFile(path.join(directory, 'test.html'), '<html><head><meta charset="utf-8"></head><body><div id="sidebar" style="width:340px;height:600px"></div></body></html>');
		let currentRoot = directory;
		const delayed = new Map();
		let delayedQuery = null;
		let failQuery = null;
		controller = createWorkspaceController({
			app, BrowserWindow, dialog: {},
			ipcMain: {handle(channel, handler)
			{
				ipcMain.handle(channel, async (...args) =>
				{
					if (channel === 'workspace:search' && args[1] === failQuery) return {ok: false, error: '模拟读取失败'};
					const result = await handler(...args);
					if (channel === 'workspace:search' && args[1] === delayedQuery)
					{
						await new Promise(resolve => delayed.set(args[1], resolve));
					}
					return result;
				});
			}},
			store: {get: () => currentRoot}, isEditorSender: () => true
		});
		window = new BrowserWindow({show: false, width: 356, height: 640, webPreferences: {
			preload: fileURLToPath(new URL('../main/electron-preload.js', import.meta.url)), contextIsolation: true, sandbox: true
		}});
		await window.loadFile(path.join(directory, 'test.html'));
		const evaluate = code => window.webContents.executeJavaScript(code);
		const waitFor = async condition =>
		{
			await evaluate(`new Promise((resolve, reject) => {
				const deadline = Date.now() + 4000;
				const poll = () => { if (${condition}) resolve(); else if (Date.now() > deadline) reject(new Error('Renderer wait timed out')); else setTimeout(poll, 20); }; poll();
			})`);
		};
		const input = value => evaluate(`(() => { const input = document.querySelector('input[type=search]'); input.value = ${JSON.stringify(value)}; input.dispatchEvent(new Event('input')); })()`);
		const waitForDelay = async query =>
		{
			const deadline = Date.now() + 4000;
			while (!delayed.has(query))
			{
				if (Date.now() > deadline) throw new Error('Search IPC did not arrive');
				await new Promise(resolve => setTimeout(resolve, 20));
			}
		};
		const idle = () => waitFor(`document.querySelector('.geWorkspaceTree').getAttribute('aria-busy') === 'false'`);
		const rows = () => evaluate(`Array.from(document.querySelectorAll('.geWorkspaceEntry [data-workspace-path]')).map(row => row.getAttribute('data-workspace-path'))`);
		await evaluate(`(() => {
			localStorage.clear();
			window.errors = [];
			window.testUi = {sidebarContainer: document.getElementById('sidebar'), sidebar: {}, destroyFunctions: [],
				editor: {graph: {getModel: () => ({addListener() {}, removeListener() {}})}},
				getCurrentFile: () => null, handleError: error => errors.push(error.message),
				loadArgs: args => { window.openedArgs = args; }};
			window.mxEvent = {CHANGE: 'change'};
			window.Draw = {loadPlugin: install => install(testUi)};
		})()`);
		const plugin = await readFile(new URL('../../drawio/src/main/webapp/plugins/workspace-explorer.js', import.meta.url), 'utf8');
		await evaluate(plugin + '\nvoid 0;');
		await waitFor(`document.querySelector('.geWorkspaceName').textContent !== '图纸工作区'`);
		await input('知识库');
		await idle();
		assert.deepEqual((await rows()).sort(), ['归档/系统.drawio', '知识库清单.drawio']);
		assert.equal(await evaluate(`document.querySelector('.geWorkspaceSnippet mark').textContent`), '知识库');
		assert.equal(await evaluate(`document.querySelectorAll('.geWorkspaceSnippet img, .geWorkspaceSnippet script').length`), 0);
		assert.equal(await evaluate(`document.querySelector('.geWorkspaceFooterStatus').textContent`), '2 个匹配');
		await evaluate(`document.querySelector('[data-workspace-path="归档/系统.drawio"]').click()`);
		await waitFor('window.openedArgs != null');
		assert.deepEqual(await evaluate('openedArgs.args'), [file]);
		if (process.env.DRAW_AI_SEARCH_SCREENSHOT)
		{
			window.showInactive();
			await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
			await writeFile(process.env.DRAW_AI_SEARCH_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
			window.hide();
		}
		// Real IPC responses deliberately arrive out of order.
		delayedQuery = '知识库';
		await input('知识库');
		await waitFor(`document.querySelector('.geWorkspaceTree').getAttribute('aria-busy') === 'true'`);
		await waitForDelay('知识库');
		await input('清单');
		await idle();
		assert.deepEqual(await rows(), ['知识库清单.drawio']);
		delayed.get('知识库')();
		delayed.clear();
		delayedQuery = null;
		await evaluate('new Promise(resolve => setTimeout(resolve, 30))');
		assert.deepEqual(await rows(), ['知识库清单.drawio']);
		await input('');
		await idle();
		assert.equal(await evaluate(`document.querySelectorAll('.geWorkspaceSnippet').length`), 0);
		await input('不存在的内容');
		await idle();
		assert.equal(await evaluate(`document.querySelector('.geWorkspaceEmpty').textContent`), '没有匹配的图纸');
		failQuery = '失败';
		await input('失败');
		await idle();
		assert.equal(await evaluate(`document.querySelector('.geWorkspaceFooterStatus').textContent`), '内容搜索失败');
		failQuery = null;
		await writeFile(file, '<mxGraphModel><root><mxCell value="保存后的新内容"/></root></mxGraphModel>');
		await input('新内容');
		await idle();
		assert.deepEqual(await rows(), ['归档/系统.drawio']);
		// Changing the workspace invalidates an outstanding result even for the same query.
		delayedQuery = '知识库';
		await input('知识库');
		await waitForDelay('知识库');
		const otherRoot = path.join(directory, '新工作区');
		await mkdir(otherRoot);
		await writeFile(path.join(otherRoot, '新图.drawio'), '<mxGraphModel><root><mxCell value="知识库迁移"/></root></mxGraphModel>');
		currentRoot = otherRoot;
		delayedQuery = null;
		controller.notifyChanged();
		await waitFor(`document.querySelector('.geWorkspaceName').textContent === '新工作区'`);
		await idle();
		assert.deepEqual(await rows(), ['新图.drawio']);
		delayed.get('知识库')();
		delayed.clear();
		await evaluate('new Promise(resolve => setTimeout(resolve, 30))');
		assert.deepEqual(await rows(), ['新图.drawio']);
		await evaluate(`testUi.destroyFunctions.forEach(destroy => destroy())`);
		assert.deepEqual(await evaluate('errors'), []);
		console.log('Workspace search renderer: real preload/IPC, content snippets, safe text, open file, stale responses, clear, empty, error, edits and root switch passed');
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
		if (directory) await rm(directory, {recursive: true, force: true});
		app.exit(exitCode);
	}
}

runRendererChecks();
