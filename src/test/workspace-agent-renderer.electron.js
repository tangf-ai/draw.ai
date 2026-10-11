// Run with: npm run test:agent-renderer
import {app, BrowserWindow} from 'electron';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

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
