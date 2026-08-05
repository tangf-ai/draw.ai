import {describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'fs/promises';
import path from 'path';
import {fileURLToPath} from 'url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const builderFiles = [
	'electron-builder-appx.json',
	'electron-builder-linux-mac.json',
	'electron-builder-snap.json',
	'electron-builder-win.json',
	'electron-builder-win32.json',
	'electron-builder-win-arm64.json'
];

async function text(relativePath)
{
	return readFile(path.join(projectRoot, relativePath), 'utf8');
}

describe('draw.ai branding', () =>
{
	test('package metadata points at the independent project', async () =>
	{
		const metadata = JSON.parse(await text('package.json'));
		assert.equal(metadata.name, 'draw.ai');
		assert.equal(metadata.productName, 'draw.ai');
		assert.equal(metadata.repository.url, 'https://github.com/tangf-ai/draw.ai.git');
		assert.equal(metadata.author, 'draw.ai contributors');
	});

	test('installer metadata uses the draw.ai application identity', async () =>
	{
		for (const file of builderFiles)
		{
			const metadata = JSON.parse(await text(file));
			assert.equal(metadata.appId, 'ai.draw.desktop', file);
			assert.match(metadata.copyright, /draw\.ai contributors/, file);
			assert.doesNotMatch(metadata.copyright, /Copyright 2026 JGraph/, file);
		}

		const macLinux = JSON.parse(await text('electron-builder-linux-mac.json'));
		assert.equal(macLinux.linux.executableName, 'draw-ai');
		assert.equal(macLinux.mac.extendInfo.UTExportedTypeDeclarations[0].UTTypeIdentifier,
			'ai.draw.diagram');
	});

	test('workspace and updater use draw.ai names', async () =>
	{
		const workspace = await text('src/main/workspace-window.js');
		const main = await text('src/main/electron.js');
		const bootstrap = await text('drawio/src/main/webapp/js/bootstrap.js');
		const updateSwitch = await text('src/main/disableUpdate.js');
		assert.match(workspace, /draw\.ai Workspace/);
		assert.match(workspace, /title: 'draw\.ai 图纸工作区'/);
		assert.match(main, /owner: 'tangf-ai'/);
		assert.match(main, /repo: 'draw\.ai'/);
		assert.match(main, /build\/icon\.png/);
		assert.ok(main.indexOf('const shouldShowDialog = manualUpdateCheck;') <
			main.indexOf('if (!shouldShowDialog) return;'),
		'background update failures must be logged without showing a startup dialog');
		assert.match(bootstrap, /navigator\.userAgent\.indexOf\(' draw\.ai\/'\)/);
		assert.match(bootstrap, /Editor\.prototype\.appName = 'draw\.ai'/);
		assert.match(bootstrap, /Editor\.logoImage = 'images\/draw-ai-logo\.svg'/);
		assert.match(updateSwitch, /return false/);
	});

	test('native icon containers were generated from draw.ai assets', async () =>
	{
		const icns = await readFile(path.join(projectRoot, 'build/icon.icns'));
		const ico = await readFile(path.join(projectRoot, 'build/icon.ico'));
		assert.equal(icns.toString('ascii', 0, 4), 'icns');
		assert.equal(icns.readUInt32BE(4), icns.length);
		assert.equal(ico.readUInt16LE(0), 0);
		assert.equal(ico.readUInt16LE(2), 1);
		assert.equal(ico.readUInt16LE(4), 6);
		assert.equal(ico.readUInt8(6 + 5 * 16), 0);
	});
});
