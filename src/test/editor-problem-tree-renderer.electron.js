// Run with: npm run test:problem-tree-renderer
import {app, BrowserWindow} from 'electron';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

// Keep Electron alive until cleanup finishes and the test exit code is set.
app.on('window-all-closed', () => {});

async function runRendererChecks()
{
	const profile = await mkdtemp(join(tmpdir(), 'draw-ai-problem-tree-'));
	app.setPath('userData', profile);
	let window;
	let exitCode = 0;
	try
	{
		await app.whenReady();
		window = new BrowserWindow({show: false, width: 1400, height: 1000,
			webPreferences: {contextIsolation: true}});
		const webapp = new URL('../../drawio/src/main/webapp/', import.meta.url);
		await window.loadFile(fileURLToPath(new URL('index.html', webapp)),
			{query: {offline: '1', local: '1', splash: '0', ui: 'kennedy', lang: 'zh'}});
		await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
			const deadline = Date.now() + 15000;
			function ready() {
				if (window.App && window.Editor && window.LocalFile) {
					window.problemTreeUi = new App(new Editor(false));
					problemTreeUi.fileLoaded(new LocalFile(problemTreeUi, problemTreeUi.emptyDiagramXml, 'test.drawio'));
					window.Draw = {loadPlugin: callback => callback(problemTreeUi)};
					resolve();
				} else if (Date.now() > deadline) reject(new Error('Editor did not initialize'));
				else setTimeout(ready, 50);
			}
			ready();
		})`);
		const plugin = await readFile(new URL('plugins/common-shapes.js', webapp), 'utf8');
		await window.webContents.executeJavaScript(plugin);
		const result = await window.webContents.executeJavaScript(`(() => {
			const ui = problemTreeUi;
			const graph = ui.editor.graph;
			const select = document.querySelector('select[aria-label="绘图模式"]');
			if (!select) throw new Error('Drawing mode selector is missing');
			select.value = 'problemTree';
			select.dispatchEvent(new Event('change'));
			const enabled = EditorUi.isProblemTree(graph);
			const button = [...document.querySelectorAll('button')].find(b => b.textContent === '新建目标节点');
			button.click();
			const root = graph.getSelectionCell();
			graph.cellEditor.textarea.innerHTML = '目标：处理能力提升 30%';
			graph.cellEditor.textarea.dispatchEvent(new KeyboardEvent('keydown',
				{key: 'Tab', keyCode: 9, bubbles: true, cancelable: true}));
			let cells = graph.getChildVertices(graph.getDefaultParent());
			const committed = graph.convertValueToString(root).includes('30%');
			const child = cells.find(c => c !== root);
			graph.setSelectionCell(root);
			ui.onKeyDown(new KeyboardEvent('keydown', {key: 'Tab', keyCode: 9}));
			cells = graph.getChildVertices(graph.getDefaultParent());
			const sibling = cells.find(c => c !== root && c !== child);
			const down = child.geometry.y > root.geometry.y + root.geometry.height;
			const across = sibling.geometry.y === child.geometry.y && sibling.geometry.x > child.geometry.x;
			const edges = graph.getChildEdges(graph.getDefaultParent());
			const arrow = graph.getCellStyle(edges[0]).endArrow === 'block';
			ui.editor.undoManager.undo();
			const undo = graph.getChildVertices(graph.getDefaultParent()).length === 2;
			ui.editor.undoManager.redo();
			const redo = graph.getChildVertices(graph.getDefaultParent()).length === 3;
			graph.startEditingAtCell(child);
			graph.cellEditor.textarea.innerHTML = '子问题';
			graph.cellEditor.textarea.dispatchEvent(new KeyboardEvent('keydown',
				{key: 'Enter', keyCode: 13, bubbles: true, cancelable: true}));
			const enteredSibling = graph.cellEditor.getEditingCell();
			const enter = enteredSibling !== child && enteredSibling.geometry.y === child.geometry.y &&
				enteredSibling.geometry.x > sibling.geometry.x && graph.getIncomingEdges(enteredSibling)[0].source === root;
			graph.stopEditing(false);
			const xml = mxUtils.getXml(ui.editor.getGraphXml());
			ui.editor.setGraphXml(mxUtils.parseXml('<mxGraphModel><root><mxCell id="0"/>' +
				'<mxCell id="1" parent="0"/></root></mxGraphModel>').documentElement);
			ui.editor.fireEvent(new mxEventObject('pageSelected'));
			const blankMode = !EditorUi.isProblemTree(graph) && select.value === 'mindmap';
			ui.editor.setGraphXml(mxUtils.parseXml(xml).documentElement);
			ui.editor.fireEvent(new mxEventObject('fileLoaded'));
			const restored = EditorUi.isProblemTree(graph) && select.value === 'problemTree';
			// A mode change must be undoable and leave existing geometry untouched.
			const before = graph.getChildVertices(graph.getDefaultParent()).map(c => ({...c.geometry}));
			select.value = 'mindmap';
			select.dispatchEvent(new Event('change'));
			ui.editor.undoManager.undo();
			const modeUndo = EditorUi.isProblemTree(graph) && select.value === 'problemTree';
			const stableGeometry = JSON.stringify(before) === JSON.stringify(
				graph.getChildVertices(graph.getDefaultParent()).map(c => ({...c.geometry})));
			graph.setEnabled(false);
			const readOnly = select.disabled && button.disabled;
			return {enabled, committed, down, across, arrow, undo, redo, enter, blankMode, restored, modeUndo, stableGeometry, readOnly};
		})()`);
		for (const [check, passed] of Object.entries(result)) assert.equal(passed, true, check);
		console.log('Problem-tree renderer: mode selector, real Tab, arrows, undo/redo, XML reload, page state and read-only checks passed');
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

runRendererChecks().catch(error => { console.error(error); app.exit(1); });
