import assert from 'node:assert/strict';
import {readFile, readdir, stat} from 'node:fs/promises';
import path from 'node:path';
import {extractFile, listPackage} from '@electron/asar';

async function archivesIn(directory)
{
	const archives = [];
	for (const entry of await readdir(directory, {withFileTypes: true}))
	{
		const file = path.join(directory, entry.name);
		if (entry.isDirectory()) archives.push(...await archivesIn(file));
		else if (entry.isFile() && entry.name === 'app.asar') archives.push(file);
	}
	return archives;
}

const archives = await archivesIn('dist');
assert.ok(archives.length > 0, 'No packaged app.asar found');
const version = JSON.parse(await readFile('package.json', 'utf8')).version;
for (const archive of archives)
{
	assert.ok((await stat(archive)).size < 524288000, `Oversized ASAR: ${archive}`);
	assert.equal(listPackage(archive).some(file => /^[/\\]dist([/\\]|$)/.test(file)), false,
		`Nested build output in ${archive}`);
	for (const file of ['src/workspace/index.html', 'src/workspace/workspace.css', 'src/workspace/workspace.js',
		'src/main/workspace-agent.js', 'src/main/electron.js', 'src/main/electron-preload.js',
		'src/main/workspace-files.js', 'src/main/workspace-window.js', 'src/workspace/preload.js',
		'drawio/src/main/webapp/plugins/workspace-agent.js',
		'drawio/src/main/webapp/plugins/workspace-explorer.js'])
	{
		// ASAR's directory lookup uses the host platform's path separator.
		assert.deepEqual(extractFile(archive, path.normalize(file)), await readFile(file), `${archive}: ${file}`);
	}
	assert.equal(JSON.parse(extractFile(archive, 'package.json').toString()).version, version);
	console.log(`Verified workspace theme, AI assistant, directory moves and version ${version}: ${archive}`);
}
