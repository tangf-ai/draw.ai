import {createHash} from 'node:crypto';
import {readFile} from 'fs/promises';
import assert from 'node:assert/strict';
import path from 'path';
import {fileURLToPath} from 'url';
import {test} from 'node:test';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function text(relativePath)
{
	return readFile(path.join(projectRoot, relativePath), 'utf8');
}

test('editor canvas defaults hide grid and page view', async () =>
{
	const graph = await text('drawio/src/main/webapp/js/grapheditor/Graph.js');
	const editor = await text('drawio/src/main/webapp/js/diagramly/Editor.js');
	const pages = await text('drawio/src/main/webapp/js/diagramly/Pages.js');
	const bundle = await text('drawio/src/main/webapp/js/app.min.js');

	assert.match(graph, /Graph\.prototype\.defaultPageVisible = false;/);
	assert.match(graph,
		/Graph\.prototype\.defaultGridEnabled = urlParams\['grid'\] != null \? urlParams\['grid'\] != '0' : false;/);
	assert.match(editor,
		/Graph\.prototype\.defaultPageVisible = urlParams\['pv'\] != null \? urlParams\['pv'\] != '0' : false;/);
	assert.match(pages,
		/gridEnabled: \(grid != null\) \? grid != '0' : this\.defaultGridEnabled,/);

	// The desktop app loads the generated bundle rather than the source files.
	assert.match(bundle,
		/Graph\.prototype\.defaultPageVisible=!1;Graph\.prototype\.defaultGridEnabled=null!=urlParams\.grid\?"0"!=urlParams\.grid:!1;/);
	assert.match(bundle,
		/Graph\.prototype\.defaultPageVisible=null!=urlParams\.pv\?"0"!=urlParams\.pv:!1;/);
	assert.match(bundle,
		/gridEnabled:null!=b\.getAttribute\("grid"\)\?"0"!=b\.getAttribute\("grid"\):this\.defaultGridEnabled,/);
});

test('service worker cache revision matches the editor bundle', async () =>
{
	const bundle = await text('drawio/src/main/webapp/js/app.min.js');
	const serviceWorker = await text('drawio/src/main/webapp/service-worker.js');
	const match = serviceWorker.match(/\{"url":"js\/app\.min\.js","revision":"([^"]+)"\}/);
	const revision = createHash('md5').update(bundle).digest('hex');

	assert.ok(match, 'app.min.js must have a service worker revision');
	assert.equal(match[1], revision);
});
