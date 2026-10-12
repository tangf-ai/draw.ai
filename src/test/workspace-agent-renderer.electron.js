// Run with: npm run test:agent-renderer
import {app, BrowserWindow} from 'electron';
import assert from 'node:assert/strict';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

async function runRendererChecks()
{
	let window;
	let exitCode = 0;
	try
	{
		await app.whenReady();
		window = new BrowserWindow({show: false, webPreferences: {contextIsolation: true}});
		await window.loadURL('data:text/html;charset=utf-8,<html><body></body></html>');
		const webapp = new URL('../../drawio/src/main/webapp/', import.meta.url);
		const [purify, marked, plugin] = await Promise.all([
			readFile(new URL('js/sanitizer/purify.min.js', webapp), 'utf8'),
			readFile(new URL('js/marked/marked.umd.js', webapp), 'utf8'),
			readFile(new URL('plugins/workspace-agent.js', webapp), 'utf8')
		]);
		const start = plugin.indexOf('\tfunction renderAgentMarkdown(');
		const end = plugin.indexOf('\n\tif (window.__drawAiMarkdownReady', start);
		assert.ok(start >= 0 && end > start);
		await window.webContents.executeJavaScript(`${purify}\n${marked}\n${plugin.slice(start, end)}\nvoid 0;`);
		const result = await window.webContents.executeJavaScript(`(() => {
			const body = document.createElement('div');
			document.body.appendChild(body);
			renderAgentMarkdown(body, '## Summary\\n\\n**Bold** and *italic* with \\u0060code\\u0060.\\n\\n- One\\n- Two\\n\\n| Key | Value |\\n| --- | --- |\\n| A | B |\\n\\n\\u0060\\u0060\\u0060js\\nconst ok = true;\\n\\u0060\\u0060\\u0060\\n');
			const formatting = ['h2', 'strong', 'em', 'ul li', 'table td', 'pre code'].every(selector => body.querySelector(selector));
			renderAgentMarkdown(body, '**Streaming');
			renderAgentMarkdown(body, '**Streaming completed**');
			const streaming = body.querySelector('strong')?.textContent === 'Streaming completed';
			window.markdownExecuted = false;
			renderAgentMarkdown(body, '<script>window.markdownExecuted=true<\\/script><img src="https://example.com/track" onerror="window.markdownExecuted=true"><svg onload="window.markdownExecuted=true"></svg><iframe src="https://example.com"></iframe><form><input autofocus></form><style>body{display:none}</style><p onclick="window.markdownExecuted=true">Safe text</p>\\n\\n[unsafe](javascript:alert(1)) [file](file:///etc/passwd) [data](data:text/html,hello) [relative](../secret) [safe](https://example.com)');
			const unsafeElements = body.querySelectorAll('script,img,svg,iframe,form,input,style').length;
			const eventAttributes = Array.from(body.querySelectorAll('*')).some(el => Array.from(el.attributes).some(attr => /^on/i.test(attr.name)));
			const urls = Array.from(body.querySelectorAll('a[href]')).map(link => link.getAttribute('href'));
			const safeText = body.textContent.includes('Safe text');
			const executed = window.markdownExecuted;
			const parser = window.marked;
			window.marked = null;
			renderAgentMarkdown(body, '<img src=x onerror=alert(1)>');
			const fallback = body.querySelector('img') == null && body.textContent === '<img src=x onerror=alert(1)>';
			window.marked = parser;
			return {formatting, streaming, unsafeElements, eventAttributes, urls, safeText, executed, fallback};
		})()`);
		assert.equal(result.formatting, true);
		assert.equal(result.streaming, true);
		assert.equal(result.unsafeElements, 0);
		assert.equal(result.eventAttributes, false);
		assert.deepEqual(result.urls, ['https://example.com']);
		assert.equal(result.safeText, true);
		assert.equal(result.executed, false);
		assert.equal(result.fallback, true);
		console.log('Agent Markdown renderer: formatting, streaming, HTML sanitization, URL filtering and fallback passed');

		await window.setContentSize(1000, 900);
		await window.webContents.executeJavaScript(`(() => {
			window.agentTimers = new Map();
			let timerId = 0;
			window.setInterval = callback => { agentTimers.set(++timerId, callback); return timerId; };
			window.clearInterval = id => agentTimers.delete(id);
			window.agentTestState = {configured: true, busy: false, messages: [], command: 'pi'};
			window.agentRequests = [];
			window.electron = {request(message, resolve, reject, progress) {
				agentRequests.push(message.action);
				if (message.action === 'workspaceAgentChat') {
					window.agentProgress = progress;
					window.agentFinish = () => {
						agentTestState.messages = [{role: 'user', text: '整理图纸'}, {role: 'assistant', text: '已完成'}];
						resolve({});
					};
				} else resolve(agentTestState);
			}};
			const diagram = document.createElement('div');
			document.body.replaceChildren(diagram);
			document.documentElement.style.colorScheme = 'light';
			const page = {getId: () => 'page-1', getName: () => 'Page 1'};
			const graph = {getSelectionCount: () => 0, getSelectionCells: () => [],
				getSelectionModel: () => ({addListener() {}}), isEnabled: () => true,
				setEnabled() {}, stopEditing() {}, isEditing: () => false,
				getModel: () => ({getDescendants: () => [], getRoot: () => ({})})};
			window.agentTestUi = {__drawioWorkspaceAgentDeferred: true,
				editor: {graph, addListener() {}}, pages: [page], currentPage: page,
				diagramContainer: diagram, addListener() {}, updatePageRoot() {}, destroyFunctions: [],
				getCurrentFile: () => ({fileObject: {path: '/fixture/test.drawio'}, isModified: () => false}),
				unwatchPath: () => Promise.resolve(), watchPath: () => Promise.resolve(),
				reloadExternalFile: resolve => resolve(), confirm: (message, cancel, accept) => accept()};
			window.Draw = {loadPlugin: install => install(agentTestUi)};
			window.EditorUi = {isElectronApp: true};
			window.mxEvent = {CHANGE: 'change'};
		})()`);
		await window.webContents.executeJavaScript(`${plugin}\nvoid 0;`);
		const checkCompanion = async code => window.webContents.executeJavaScript(`(async () => {
			const flush = () => new Promise(resolve => setTimeout(resolve, 0));
			const visible = () => {
				const companion = document.querySelector('.geAgentCompanion');
				return companion != null && companion.checkVisibility();
			};
			${code}
		})()`);
		const captureCompanion = async name =>
		{
			const directory = process.env.DRAW_AI_AGENT_SCREENSHOT_DIR;
			if (!directory) return;
			await mkdir(directory, {recursive: true});
			const bounds = await checkCompanion(`
				await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
				await Promise.all(document.querySelector('.geAgentView').getAnimations({subtree: true})
					.filter(animation => Number.isFinite(animation.effect.getTiming().iterations))
					.map(animation => animation.finished));
				const rect = document.querySelector('.geAgentView').getBoundingClientRect();
				return {x: Math.round(rect.x), y: Math.round(rect.y),
					width: Math.round(rect.width), height: Math.round(rect.height)};
			`);
			await writeFile(join(directory, name + '.png'), (await window.webContents.capturePage(bounds)).toPNG());
		};
		assert.equal(await checkCompanion('await flush(); return agentTimers.size;'), 0);
		assert.equal(await checkCompanion(`
			document.querySelector('.geAgentLauncher').click();
			await flush();
			const quote = document.querySelector('.geAgentQuote');
			const first = quote.textContent;
			const requests = agentRequests.length;
			for (let i = 0; i < 30; i++) {
				const previous = quote.textContent;
				[...agentTimers.values()][0]();
				if (quote.textContent === previous) return false;
			}
			return visible() && agentTimers.size === 1 && first.length > 0 &&
				quote.getAttribute('aria-live') === 'off' && agentRequests.length === requests &&
				document.querySelectorAll('.geAgentSketchNode').length === 3;
		`), true, 'empty state rotates distinct local quotes without model calls');
		await captureCompanion('assistant-empty-light');
		await checkCompanion("document.documentElement.style.colorScheme = 'dark';");
		await captureCompanion('assistant-empty-dark');
		await checkCompanion("document.documentElement.style.colorScheme = 'light';");
		assert.equal(await checkCompanion(`
			document.querySelector('[aria-label="收起 AI 助手"]').click();
			return agentTimers.size;
		`), 0, 'closing the panel clears its timer');
		assert.equal(await checkCompanion(`
			document.querySelector('.geAgentLauncher').click();
			await flush();
			let hidden = true;
			Object.defineProperty(document, 'hidden', {configurable: true, get: () => hidden});
			document.dispatchEvent(new Event('visibilitychange'));
			const paused = agentTimers.size === 0 &&
				getComputedStyle(document.querySelector('.geAgentSketchNode')).animationPlayState === 'paused';
			hidden = false;
			document.dispatchEvent(new Event('visibilitychange'));
			delete document.hidden;
			return paused && agentTimers.size === 1;
		`), true, 'background visibility pauses animation and quote rotation');
		window.webContents.debugger.attach('1.3');
		await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
			features: [{name: 'prefers-reduced-motion', value: 'reduce'}]
		});
		assert.equal(await checkCompanion(`
			await new Promise(resolve => setTimeout(resolve, 50));
			return agentTimers.size === 0 &&
				getComputedStyle(document.querySelector('.geAgentSketchNode')).animationName === 'none';
		`), true, 'reduced motion disables animation and automatic rotation');
		await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {features: []});
		window.webContents.debugger.detach();
		assert.equal(await checkCompanion(`
			document.querySelector('.geAgentInput').value = '整理图纸';
			document.querySelector('.geAgentSend').click();
			await flush(); await flush();
			agentProgress({type: 'reasoning', delta: '正在分析布局'});
			return visible() && document.querySelector('.geAgentRun .geAgentCompanion') != null &&
				document.querySelector('.geAgentReasoning').textContent === '正在分析布局';
		`), true, 'waiting animation coexists with real task progress');
		await captureCompanion('assistant-working');
		assert.equal(await checkCompanion(`
			agentProgress({type: 'approval', approval: {id: 'approve-1', type: 'confirm', detail: '继续？'}});
			const hiddenForApproval = !visible() && agentTimers.size === 0;
			agentProgress({type: 'approval-resolved', id: 'approve-1'});
			return hiddenForApproval && visible();
		`), true, 'approval takes priority over decoration');
		assert.equal(await checkCompanion(`
			agentProgress({type: 'message-delta', delta: '**开始输出**'});
			const hiddenForReply = !visible() && agentTimers.size === 0;
			agentFinish();
			await flush(); await flush();
			return hiddenForReply && !visible() && agentTimers.size === 0 &&
				document.querySelector('.geAgentMessageAssistant').textContent.includes('已完成');
		`), true, 'streaming and final results replace decoration');
		assert.equal(await checkCompanion(`
			document.querySelector('.geAgentInput').value = '再整理一次';
			document.querySelector('.geAgentSend').click();
			await flush(); await flush();
			const waiting = visible();
			agentProgress({type: 'status', phase: 'connecting', label: '正在连接 Pi'});
			document.querySelector('[aria-label="停止 Agent"]').click();
			const stopped = !visible() && agentTimers.size === 0;
			agentFinish();
			await flush(); await flush();
			return waiting && stopped;
		`), true, 'stopping a task hides the companion immediately');
		assert.equal(await checkCompanion(`
			document.querySelector('[aria-label="新建独立对话（清空当前上下文）"]').click();
			await flush();
			const reset = visible() && agentTimers.size === 1;
			agentTestUi.destroyFunctions.forEach(destroy => destroy());
			return reset && agentTimers.size === 0 && !document.querySelector('.geAgentView');
		`), true, 'new conversations restore the companion and teardown clears timers');
		console.log('Agent companion: empty, rotation, close, background, reduced motion, progress, approval, streaming, completion and teardown passed');
	}
	catch (error)
	{
		console.error(error);
		exitCode = 1;
	}
	finally
	{
		window?.destroy();
		app.exit(exitCode);
	}
}

runRendererChecks();
