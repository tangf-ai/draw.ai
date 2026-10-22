// Real editor/plugin rendering with fictional, offline Agent responses. No model is called.
import {app, BrowserWindow} from 'electron';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

app.on('window-all-closed', () => {});
async function capturePreviews()
{
	const profile = await mkdtemp(join(tmpdir(), 'draw-ai-preview-'));
	app.setPath('userData', profile);
	let window;
	let exitCode = 0;
	try
	{
		await app.whenReady();
		window = new BrowserWindow({show: false, width: 1540, height: 960,
			webPreferences: {contextIsolation: true}});
		window.webContents.session.webRequest.onBeforeRequest({urls: ['http://*/*', 'https://*/*']},
			(_details, callback) => callback({cancel: true}));
		const webapp = new URL('../drawio/src/main/webapp/', import.meta.url);
		const output = fileURLToPath(new URL('../docs/images/', import.meta.url));
		await mkdir(output, {recursive: true});
		await window.loadFile(fileURLToPath(new URL('index.html', webapp)),
			{query: {local: '1', stealth: '1', db: '0', od: '0', splash: '0', ui: 'kennedy', lang: 'zh'}});
		const evaluate = async code =>
		{
			const result = await window.webContents.executeJavaScript(`(async () => {
				try { return await eval(${JSON.stringify(code)}); }
				catch (error) { return {previewError: error.stack}; }
			})()`);
			if (result?.previewError) throw new Error(result.previewError);
			return result;
		};
		await evaluate(`new Promise((resolve, reject) => {
			const deadline = Date.now() + 20000;
			const ready = () => {
				if (window.Draw && Draw.loadPlugin && window.LocalFile) resolve();
				else if (Date.now() > deadline) reject(new Error('Editor did not initialize'));
				else setTimeout(ready, 50);
			}; ready();
		})`);
		await evaluate(`new Promise(resolve => Draw.loadPlugin(ui => { window.demoUi = ui; resolve(); }))`);
		await evaluate(`(() => {
			demoUi.fileLoaded(new LocalFile(demoUi, demoUi.emptyDiagramXml, 'AI 辅助绘图.drawio'));
			EditorUi.isElectronApp = true;
			demoUi.__drawioWorkspaceAgentDeferred = true;
			demoUi.getCurrentFile().fileObject = {path: '/demo/AI 辅助绘图.drawio'};
			window.demoState = {configured: true, busy: false, command: 'pi', model: 'Pi · 演示会话',
				sessionId: 'fictional-demo', canRollback: true, messages: [
					{role: 'user', text: '把当前流程整理成四个阶段，补上校验和人工确认。保持现有业务含义。',
						filePath: 'AI 辅助绘图.drawio'},
					{role: 'assistant', text: '### 当前页已整理（演示）\\n\\n- 统一节点样式与连线方向\\n- 补充 XML 校验与人工确认\\n- 输出仍是可编辑的 .drawio 文件\\n\\n可继续补充要求，或用上方 ↶ 撤回本轮修改。',
						changes: [{kind: 'modified', path: 'AI 辅助绘图.drawio'}]}
				]};
			window.electron = {request(message, resolve, reject) {
				if (message.action === 'workspaceAgentGetState') resolve(demoState);
				else if (message.action === 'workspaceAgentGetProfile') resolve({command: 'pi', model: 'Pi · 演示会话'});
				else reject('Offline screenshot fixture: action not supported');
			}};
			window.workspaceAPI = {
				getState: async () => ({root: '/demo', name: 'AI 绘图演示', counts: {files: 3}, tree:
					['AI 辅助绘图.drawio', '产品规划.drawio', '系统架构.drawio'].map(name =>
						({name, relativePath: name, type: 'file'}))}),
				onChanged: () => () => {}, onMoved: () => () => {}
			};
			window.Draw = {loadPlugin: install => install(demoUi)};
			Editor.prototype.appName = 'draw.ai';
			Editor.logoImage = 'images/draw-ai-logo.svg';
			if (demoUi.appIcon) {
				demoUi.appIcon.style.backgroundColor = '#15262d';
				const image = demoUi.appIcon.querySelector('img');
				if (image) image.src = Editor.logoImage;
			}
			const graph = demoUi.editor.graph;
			graph.setGridEnabled(false);
			demoUi.setPageVisible(false);
			demoUi.toggleFormatPanel(false);
			const parent = graph.getDefaultParent();
			const label = (value, x, y, w, h, extra = '') => graph.insertVertex(parent, null, value,
				x, y, w, h, 'text;html=1;strokeColor=none;fillColor=none;align=left;verticalAlign=middle;fontColor=#183d35;fontSize=16;' + extra);
			const box = (value, x, y, fill, stroke) => graph.insertVertex(parent, null, value,
				x, y, 138, 84, 'rounded=1;whiteSpace=wrap;html=1;arcSize=12;fillColor=' + fill +
				';strokeColor=' + stroke + ';fontColor=#183d35;fontSize=15;fontStyle=1;spacing=10;');
			graph.getModel().beginUpdate();
			try {
				label('从想法到图纸，与 AI 一起完成', 40, 50, 690, 50, 'fontSize=30;fontStyle=1;');
				label('描述需求 · 粘贴参考图 · 持续迭代', 40, 109, 650, 30, 'fontSize=17;fontColor=#64776f;');
				label('自然语言改图', 40, 200, 650, 32, 'fontSize=21;fontStyle=1;');
				const nodes = [box('需求 / 参考图', 40, 260, '#eef6ff', '#78a6dc'),
					box('Pi Agent\\n分析与编辑', 220, 260, '#e7f6f0', '#58a891'),
					box('XML 校验\\n失败自动恢复', 400, 260, '#fff5df', '#d5ac58'),
					box('人工确认\\n可继续 / 可撤回', 580, 260, '#eaf4e9', '#81ab79')];
				for (let i = 1; i < nodes.length; i++) graph.insertEdge(parent, null, '', nodes[i-1], nodes[i],
					'edgeStyle=orthogonalEdgeStyle;rounded=0;strokeColor=#799087;strokeWidth=2;endArrow=block;');
				label('你决定修改范围', 40, 410, 650, 32, 'fontSize=21;fontStyle=1;');
				label('选区优先 / 当前页 / 全部页 / 指定页', 40, 456, 650, 30, 'fontSize=17;fontColor=#64776f;');
				label('交付的是图纸，不是一张截图', 40, 540, 650, 32, 'fontSize=21;fontStyle=1;');
				label('标准 .drawio 文件，继续手工编辑、复用与分享。', 40, 586, 690, 30, 'fontSize=17;fontColor=#64776f;');
				label('演示数据 · 对话与布局预置 · 非真实模型效果评测', 40, 690, 710, 24,
					'fontSize=13;fontColor=#8b9792;');
			} finally { graph.getModel().endUpdate(); }
			graph.clearSelection();
			demoUi.editor.setModified(false);
			graph.view.scaleAndTranslate(1, 0, 0);
			demoUi.diagramContainer.scrollLeft = 0;
			demoUi.diagramContainer.scrollTop = 0;
		})()`);
		await evaluate(await readFile(new URL('plugins/workspace-explorer.js', webapp), 'utf8'));
		await evaluate(await readFile(new URL('plugins/workspace-agent.js', webapp), 'utf8'));
		await evaluate(`document.querySelector('.geAgentLauncher').click()`);
		const capture = async name =>
		{
			window.showInactive();
			await evaluate(`(() => {
				const graph = demoUi.editor.graph;
				graph.container.scrollLeft = graph.view.translate.x * graph.view.scale;
				graph.container.scrollTop = graph.view.translate.y * graph.view.scale;
				demoUi.getCurrentFile().setModified(false);
			})()`);
			await evaluate(`new Promise(resolve => setTimeout(() => requestAnimationFrame(() =>
				requestAnimationFrame(resolve)), 350))`);
			assert.equal(await evaluate(`document.querySelector('.geAgentView').checkVisibility()`), true);

			assert.equal(await evaluate(`(() => {
				const graph = demoUi.editor.graph;
				const cell = graph.getChildVertices(graph.getDefaultParent())[0];
				const rect = graph.view.getState(cell).shape.node.getBoundingClientRect();
				return rect.top > 100 && rect.bottom < innerHeight && rect.left > 200 && rect.right < 1100;
			})()`), true, 'demo diagram must be visible next to the assistant');
			await writeFile(join(output, name), (await window.webContents.capturePage()).toPNG());
		};
		await capture('ai-conversation.png');
		// Use a real PNG attachment and the actual picker/change handler, never a painted mockup.
		const reference = await window.webContents.capturePage({x: 270, y: 300, width: 740, height: 180});
		await evaluate(`(async () => {
			const bytes = Uint8Array.from(atob(${JSON.stringify(reference.toPNG().toString('base64'))}), c => c.charCodeAt(0));
			const transfer = new DataTransfer();
			transfer.items.add(new File([bytes], '流程参考图.png', {type: 'image/png'}));
			const picker = document.querySelector('input[aria-label="选择图片"]');
			picker.files = transfer.files;
			picker.dispatchEvent(new Event('change'));
			document.querySelector('.geAgentInput').value = '参考这张流程图，帮我补全异常分支，并保持当前配色。';
			const deadline = Date.now() + 3000;
			while (document.querySelector('.geAgentAttachments').getAttribute('aria-busy') === 'true') {
				if (Date.now() > deadline) throw new Error('Image did not load');
				await new Promise(resolve => setTimeout(resolve, 20));
			}
		})()`);
		assert.equal(await evaluate(`document.querySelector('.geAgentAttachment img').naturalWidth > 0`), true);
		await capture('ai-image-input.png');
		await evaluate(`(() => {
			const graph = demoUi.editor.graph;
			const cells = graph.getChildVertices(graph.getDefaultParent());
			graph.setSelectionCells(cells.filter(cell => cell.geometry.width === 138).slice(1, 3));
			document.querySelector('.geAgentInput').value = '只调整选中的两个节点，其他内容保持不变。';
			document.querySelector('.geAgentAttachmentRemove').click();
		})()`);
		assert.equal(await evaluate(`document.querySelector('.geAgentScope').disabled`), true);
		await capture('ai-selection-scope.png');
		console.log('Captured three real-editor AI previews using isolated fictional data; no Pi/model request was made.');
	}
	catch (error)
	{
		console.error(error);
		exitCode = 1;
	}
	finally
	{
		window?.destroy();
		await rm(profile, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});
		app.exit(exitCode);
	}
}

capturePreviews().catch(error => { console.error(error); app.exit(1); });
