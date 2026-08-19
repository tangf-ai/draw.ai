import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'fs/promises';
import path from 'path';
import {fileURLToPath} from 'url';

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
	assert.match(editorUi, /graph\.setSelectionCell\(vertex\)/);
	assert.match(appBundle, /draw\.ai Tab creates a linked vertex/);
	assert.match(appBundle, /function createTabVertex\(graph\)/);
});
