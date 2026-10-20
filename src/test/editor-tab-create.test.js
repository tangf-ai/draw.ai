import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'fs/promises';
import path from 'path';
import {fileURLToPath} from 'url';
import {runInNewContext} from 'node:vm';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('Tab creates a linked, non-overlapping vertex from one selected shape', async () =>
{
	const editorUi = await readFile(path.join(projectRoot,
		'drawio/src/main/webapp/js/diagramly/EditorUi.js'), 'utf8');
	const appBundle = await readFile(path.join(projectRoot,
		'drawio/src/main/webapp/js/app.min.js'), 'utf8');

	assert.match(editorUi, /function editorUiFindTabCreatePosition\(graph, parent, source, width, height\)/);
	assert.match(editorUi, /mxUtils\.intersects\(candidate, geometry\)/);
	assert.match(editorUi, /function editorUiCreateTabVertex\(graph\)/);
	assert.match(editorUi, /selectedCells\.length != 1/);
	assert.match(editorUi, /graph\.model\.isVertex\(source\)/);
	assert.match(editorUi, /graph\.insertVertex\(parent, null, ''/);
	assert.match(editorUi, /graph\.insertEdge\(parent, null, ''/);
	assert.match(editorUi, /evt\.keyCode == 9 && !evt\.shiftKey && !evt\.ctrlKey/);
	assert.match(editorUi, /!evt\.metaKey && !evt\.altKey/);
	assert.match(editorUi, /graph\.setSelectionCell\(source\)/);
	assert.match(appBundle, /draw\.ai Tab creates a linked vertex/);
	assert.match(appBundle, /function createTabVertex\(graph\)/);
});

function intersects(a, b)
{
	return a.x < b.x + b.width && b.x < a.x + a.width &&
		a.y < b.y + b.height && b.y < a.y + a.height;
}

async function loadTabHandler(bundle)
{
	const text = await readFile(path.join(projectRoot, 'drawio/src/main/webapp/js/',
		bundle ? 'app.min.js' : 'diagramly/EditorUi.js'), 'utf8');
	const start = text.indexOf(bundle ? '\tvar gap = 40;' : '\tvar editorUiTabCreateGap = 40;');
	const end = text.indexOf(bundle ? '\n\tvar originalCreateKeyHandler' :
		'\n    var editorUiCreateKeyHandler', start);
	function EditorUi() {}
	EditorUi.prototype.onKeyDown = function() { this.fallbackCalls++; };
	function CellEditor() {}
	CellEditor.prototype.installListeners = function() {};
	EditorUi.CellEditor = CellEditor;
	runInNewContext(text.slice(start, end), {
		EditorUi,
		mxCellEditor: CellEditor,
		mxRectangle: class
		{
			constructor(x, y, width, height) { Object.assign(this, {x, y, width, height}); }
		},
		mxUtils: {intersects},
		mxEvent: {
			consume: (evt, preventDefault = true) => { evt.consumed = true; evt.prevented = preventDefault; },
			isConsumed: (evt) => !!evt.consumed
		}
	});
	return EditorUi;
}

function fixture(EditorUi, {canvasWidth = 2000, scale = 1, translateX = 0,
	parentX = 0, scrollLeft = 0, x = 100, y = 100, width = 120, height = 60,
	problemTree = false} = {})
{
	const root = {style: problemTree ? 'drawAiDrawingMode=problemTree;' : ''};
	const parent = {};
	const source = {vertex: true, parent, style: 'rounded=1;', geometry: {x, y, width, height}};
	const vertices = [source];
	const edges = [];
	let selection = [source];
	let updates = 0;
	let editingCell = null;
	let editingValue = '';
	const graph = {
		container: {clientWidth: canvasWidth, scrollLeft},
		view: {scale, translate: {x: translateX}, getState: () => ({origin: {x: parentX}})},
		model: {
			getRoot: () => root,
			getGeometry: (cell) => cell.geometry,
			getParent: (cell) => cell.parent,
			getTerminal: (edge, sourceTerminal) => sourceTerminal ? edge.from : edge.to,
			isVertex: (cell) => cell.vertex,
			beginUpdate: () => { updates++; },
			endUpdate: () => { updates--; }
		},
		getSelectionCells: () => selection,
		getChildVertices: (p) => vertices.filter((v) => v.parent === p),
		isEditing: () => editingCell != null,
		isEnabled: () => true,
		isCellLocked: (cell) => !!cell.locked,
		setSelectionCell: (cell) => { selection = [cell]; },
		createCurrentEdgeStyle: () => 'edgeStyle=orthogonalEdgeStyle;',
		getIncomingEdges: (cell) => edges.filter(edge => edge.to === cell),
		stopEditing: () =>
		{
			if (editingCell != null) editingCell.value = editingValue;
			editingCell = null;
		},
		startEditingAtCell: (cell) => { editingCell = cell; editingValue = cell.value || ''; },
		scrollCellToVisible: () => {},
		insertVertex: (p, id, value, vx, vy, w, h, style) =>
		{
			const vertex = {vertex: true, parent: p, value, style,
				geometry: {x: vx, y: vy, width: w, height: h}};
			vertices.push(vertex);
			return vertex;
		},
		insertEdge: (p, id, value, from, to, style) => { edges.push({from, to, style}); }
	};
	graph.cellEditor = new EditorUi.CellEditor();
	graph.cellEditor.graph = graph;
	graph.cellEditor.getEditingCell = () => editingCell;
	const listeners = {};
	graph.cellEditor.installListeners({addEventListener: (name, handler) => { listeners[name] = handler; }});
	const ui = new EditorUi();
	ui.editor = {graph};
	ui.fallbackCalls = 0;
	return {graph, ui, source, parent, root, vertices, edges,
		get updates() { return updates; },
		edit: (cell, value) => { graph.startEditingAtCell(cell); editingValue = value; },
		type: (value) => { editingValue = value; },
		compose: (active) => listeners[active ? 'compositionstart' : 'compositionend'](),
		editingTab: (modifiers = {}) =>
		{
			const evt = {keyCode: 9, ...modifiers};
			listeners.keydown(evt);
			return evt;
		},
		enter: (modifiers = {}) =>
		{
			const evt = {keyCode: 13, ...modifiers};
			listeners.keydown(evt);
			return evt;
		},
		tab: (modifiers = {}) =>
		{
			const evt = {keyCode: 9, ...modifiers};
			ui.onKeyDown(evt);
			return evt;
		}};
}

for (const bundle of [false, true])
{
	const variant = bundle ? 'production bundle' : 'editor source';

	test(`${variant}: problem-tree Tab expands down and adds non-overlapping branches across one row`, async () =>
	{
		const f = fixture(await loadTabHandler(bundle), {problemTree: true});
		for (let i = 0; i < 7; i++) assert.equal(f.tab().consumed, true);
		assert.deepEqual(f.vertices.slice(1, 6).map(v => [v.geometry.x, v.geometry.y]),
			[[100, 200], [260, 200], [-60, 200], [420, 200], [-220, 200]]);
		for (const edge of f.edges)
		{
			assert.equal(edge.from, f.source);
			assert.match(edge.style, /curved=0/);
			assert.match(edge.style, /exitX=0.5;exitY=1/);
			assert.match(edge.style, /entryX=0.5;entryY=0/);
			assert.match(edge.style, /endArrow=block;endFill=1/);
		}
		for (const [i, vertex] of f.vertices.entries())
			for (const other of f.vertices.slice(i + 1))
				assert.equal(intersects(vertex.geometry, other.geometry), false);
		const child = f.vertices[1];
		f.graph.setSelectionCell(child);
		f.tab();
		assert.deepEqual(f.vertices.at(-1).geometry, {x: 100, y: 300, width: 120, height: 60});
		assert.equal(f.edges.at(-1).from, child);
		assert.equal(f.updates, 0);
	});

	test(`${variant}: problem-tree Enter adds a sibling to the right and Tab commits the edited label`, async () =>
	{
		const f = fixture(await loadTabHandler(bundle), {problemTree: true});
		f.edit(f.source, '目标');
		assert.equal(f.editingTab().consumed, true);
		assert.equal(f.source.value, '目标');
		const child = f.vertices[1];
		f.edit(child, '子问题');
		f.enter();
		assert.equal(child.value, '子问题');
		const sibling = f.vertices[2];
		assert.deepEqual(sibling.geometry, {x: 260, y: 200, width: 120, height: 60});
		assert.equal(f.edges[1].from, f.source);
		assert.match(f.edges[1].style, /exitX=0.5;exitY=1/);
		assert.equal(f.graph.cellEditor.getEditingCell(), sibling);
		f.type('另一个子问题');
		f.editingTab();
		assert.equal(sibling.value, '另一个子问题');
		assert.deepEqual(f.vertices[3].geometry, {x: 260, y: 300, width: 120, height: 60});
		assert.equal(f.edges[2].from, sibling);
	});

	test(`${variant}: problem-tree mode follows the current root and handles blocked rows and IME`, async () =>
	{
		const f = fixture(await loadTabHandler(bundle), {problemTree: true});
		f.graph.insertVertex(f.parent, null, '', -10000, 200, 20000, 60, '');
		f.tab();
		assert.deepEqual(f.vertices.at(-1).geometry, {x: 10040, y: 200, width: 120, height: 60});
		f.root.style = '';
		f.tab();
		assert.deepEqual(f.vertices.at(-1).geometry, {x: 260, y: 100, width: 120, height: 60});
		f.root.style = 'drawAiDrawingMode=problemTree;';
		f.edit(f.source, '输入中');
		for (const modifier of ['shiftKey', 'ctrlKey', 'metaKey', 'altKey', 'isComposing'])
			assert.equal(f.editingTab({[modifier]: true}).consumed, undefined);
		f.compose(true);
		assert.equal(f.editingTab().consumed, undefined);
		assert.equal(f.vertices.length, 4);
	});

	test(`${variant}: Enter commits a label and edits a sibling linked to the same parent`, async () =>
	{
		const f = fixture(await loadTabHandler(bundle));
		f.tab();
		const child = f.vertices[1];
		f.edit(child, '大模型');
		assert.equal(f.enter().prevented, true);
		assert.equal(child.value, '大模型');
		const sibling = f.vertices[2];
		assert.deepEqual(sibling.geometry, {x: 260, y: 200, width: 120, height: 60});
		assert.equal(sibling.style, child.style);
		assert.equal(f.edges[1].from, f.source);
		assert.equal(f.edges[1].to, sibling);
		assert.equal(f.edges[1].style, f.edges[0].style);
		assert.equal(f.graph.getSelectionCells()[0], sibling);
		assert.equal(f.graph.cellEditor.getEditingCell(), sibling);
		f.type('智能体');
		f.enter();
		assert.equal(sibling.value, '智能体');
		assert.equal(f.edges[2].from, f.source);
		assert.deepEqual(f.vertices[3].geometry, {x: 260, y: 300, width: 120, height: 60});
		assert.equal(f.updates, 0);
	});

	test(`${variant}: a root sibling stays at the same level and skips occupied slots`, async () =>
	{
		const f = fixture(await loadTabHandler(bundle));
		f.graph.insertVertex(f.parent, null, '', 100, 200, 120, 160, '');
		f.edit(f.source, '个人IP');
		f.enter();
		assert.equal(f.source.value, '个人IP');
		assert.equal(f.edges.length, 0);
		assert.deepEqual(f.vertices.at(-1).geometry, {x: 100, y: 400, width: 120, height: 60});
		assert.equal(f.updates, 0);
	});

	test(`${variant}: Shift+Enter allows a line break and IME Enter never creates a sibling`, async () =>
	{
		const f = fixture(await loadTabHandler(bundle));
		f.edit(f.source, '正在输入');
		assert.equal(f.enter({shiftKey: true}).prevented, false);
		assert.equal(f.graph.cellEditor.getEditingCell(), f.source);
		assert.equal(f.enter({isComposing: true}).consumed, undefined);
		assert.equal(f.enter({keyCode: 229}).consumed, undefined);
		f.compose(true);
		assert.equal(f.enter().consumed, undefined);
		f.compose(false);
		assert.equal(f.vertices.length, 1);
		f.enter();
		assert.equal(f.vertices.length, 2);
	});

	test(`${variant}: other modifiers, edge labels, tables and locked shapes keep their editing behavior`, async () =>
	{
		for (const modifier of ['ctrlKey', 'metaKey', 'altKey'])
		{
			const f = fixture(await loadTabHandler(bundle));
			f.edit(f.source, 'label');
			assert.equal(f.enter({[modifier]: true}).consumed, undefined);
			assert.equal(f.vertices.length, 1);
		}
		for (const block of [
			f => { f.graph.isEnabled = () => false; },
			f => { f.source.locked = true; },
			f => { f.parent.locked = true; },
			f => { f.source.geometry.relative = true; },
			f => { f.source.vertex = false; },
			f => { f.graph.isTable = () => true; },
			f => { f.graph.isTableRow = () => true; },
			f => { f.graph.isTableCell = () => true; }
		])
		{
			const f = fixture(await loadTabHandler(bundle));
			f.edit(f.source, 'label');
			block(f);
			assert.equal(f.enter().consumed, undefined);
			assert.equal(f.vertices.length, 1);
		}
	});

	test(`${variant}: repeated Tab adds branches above and below the same parent`, async () =>
	{
		const f = fixture(await loadTabHandler(bundle));
		for (let i = 0; i < 19; i++) assert.equal(f.tab().consumed, true);
		assert.deepEqual(f.vertices.slice(1, 6).map((v) => [v.geometry.x, v.geometry.y]),
			[[260, 100], [260, 200], [260, 0], [260, 300], [260, -100]]);
		assert.equal(f.edges.length, 19);
		assert.equal(f.updates, 0);
		assert.equal(f.graph.getSelectionCells()[0], f.source);
		for (let i = 0; i < f.edges.length; i++)
		{
			assert.equal(f.edges[i].from, f.source);
			assert.equal(f.edges[i].to, f.vertices[i + 1]);
			assert.equal(f.vertices[i + 1].style, f.source.style);
			assert.equal(f.vertices[i + 1].geometry.x, 260);
			assert.match(f.edges[i].style, /curved=1/);
			assert.match(f.edges[i].style, /exitX=1;exitY=0.5/);
			assert.match(f.edges[i].style, /entryX=0;entryY=0.5/);
			assert.match(f.edges[i].style, /startArrow=none;endArrow=none/);
		}
		for (const [i, vertex] of f.vertices.entries())
		{
			for (const other of f.vertices.slice(i + 1))
				assert.equal(intersects(vertex.geometry, other.geometry), false);
		}
	});

	test(`${variant}: branch columns use parent coordinates regardless of viewport`, async () =>
	{
		const EditorUi = await loadTabHandler(bundle);
		for (const options of [
			{canvasWidth: 440},
			{canvasWidth: 880, scale: 2},
			{canvasWidth: 640, translateX: 100, parentX: 100},
			{canvasWidth: 240, scrollLeft: 200}
		])
		{
			const f = fixture(EditorUi, options);
			for (let i = 0; i < 5; i++) f.tab();
			assert.deepEqual(f.vertices.slice(1).map((v) => [v.geometry.x, v.geometry.y]),
				[[260, 100], [260, 200], [260, 0], [260, 300], [260, -100]]);
		}
	});

	test(`${variant}: occupied slots and a full search area stay in the right column`, async () =>
	{
		const EditorUi = await loadTabHandler(bundle);
		const f = fixture(EditorUi);
		const obstacle = f.graph.insertVertex(f.parent, null, '', 260, 100, 120, 60, '');
		f.tab();
		assert.deepEqual(f.vertices.at(-1).geometry, {x: 260, y: 200, width: 120, height: 60});
		assert.equal(intersects(f.vertices.at(-1).geometry, obstacle.geometry), false);
		const full = fixture(EditorUi);
		full.graph.insertVertex(full.parent, null, '', 260, -10000, 120, 20000, '');
		full.tab();
		assert.deepEqual(full.vertices.at(-1).geometry, {x: 260, y: 10040, width: 120, height: 60});
		full.tab();
		assert.deepEqual(full.vertices.at(-1).geometry, {x: 260, y: 10140, width: 120, height: 60});
	});

	test(`${variant}: undo and reload fill the free slot without transient layout state`, async () =>
	{
		const f = fixture(await loadTabHandler(bundle));
		for (let i = 0; i < 4; i++) f.tab();
		const removed = f.vertices.pop();
		f.edges.pop();
		f.tab();
		assert.deepEqual(f.vertices.at(-1).geometry, removed.geometry);
		const ReloadedUi = await loadTabHandler(bundle);
		const reloaded = new ReloadedUi();
		reloaded.editor = {graph: f.graph};
		reloaded.onKeyDown({keyCode: 9});
		assert.deepEqual(f.vertices.at(-1).geometry, {x: 260, y: -100, width: 120, height: 60});
	});

	test(`${variant}: selecting a child starts the next level without moving existing branches`, async () =>
	{
		const f = fixture(await loadTabHandler(bundle));
		for (let i = 0; i < 3; i++) f.tab();
		const original = f.vertices.map((v) => ({...v.geometry}));
		const child = f.vertices[1];
		f.graph.setSelectionCell(child);
		for (let i = 0; i < 3; i++) f.tab();
		assert.deepEqual(f.vertices.slice(4).map((v) => [v.geometry.x, v.geometry.y]),
			[[420, 100], [420, 200], [420, 0]]);
		assert.equal(f.graph.getSelectionCells()[0], child);
		for (const edge of f.edges.slice(3)) assert.equal(edge.from, child);
		assert.deepEqual(f.vertices.slice(0, 4).map((v) => v.geometry), original);
		child.geometry.x = 1000;
		child.geometry.y = 1000;
		f.tab();
		assert.deepEqual(f.vertices.at(-1).geometry, {x: 1160, y: 1000, width: 120, height: 60});
	});

	test(`${variant}: editing, locks and modified Tab preserve existing keyboard behavior`, async () =>
	{
		const EditorUi = await loadTabHandler(bundle);
		for (const modifier of ['shiftKey', 'ctrlKey', 'metaKey', 'altKey'])
		{
			const f = fixture(EditorUi);
			assert.equal(f.tab({[modifier]: true}).consumed, undefined);
			assert.equal(f.vertices.length, 1);
			assert.equal(f.ui.fallbackCalls, 1);
		}
		for (const block of [
			(f) => { f.graph.isEditing = () => true; },
			(f) => { f.graph.isEnabled = () => false; },
			(f) => { f.source.locked = true; },
			(f) => { f.parent.locked = true; },
			(f) => { f.source.geometry.relative = true; },
			(f) => { f.graph.getSelectionCells = () => []; },
			(f) => { f.graph.getSelectionCells = () => [f.source, f.source]; },
			(f) => { f.source.vertex = false; }
		])
		{
			const f = fixture(EditorUi);
			block(f);
			assert.equal(f.tab().consumed, undefined);
			assert.equal(f.vertices.length, 1);
		}
	});
}
