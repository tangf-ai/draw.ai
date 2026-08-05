import {afterEach, describe, test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {migrateLegacyUserData} from '../main/user-data-migration.js';

const temporaryDirectories = [];

afterEach(() =>
{
	for (const directory of temporaryDirectories.splice(0))
	{
		fs.rmSync(directory, {recursive: true, force: true});
	}
});

function createFixture()
{
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'draw-ai-migration-'));
	temporaryDirectories.push(root);
	const legacy = path.join(root, 'draw.io');
	const current = path.join(root, 'draw.ai');
	fs.mkdirSync(path.join(legacy, 'Local Storage'), {recursive: true});
	fs.writeFileSync(path.join(legacy, 'config.json'), JSON.stringify({workspaceRoot: '/iCloud/Drawings'}));
	fs.writeFileSync(path.join(legacy, 'Local Storage', 'state'), 'editor preferences');
	return {legacy, current};
}

describe('migrateLegacyUserData', () =>
{
	test('copies workspace and editor state without modifying the legacy profile', () =>
	{
		const {legacy, current} = createFixture();
		const copied = migrateLegacyUserData(current);

		assert.deepEqual(copied, ['config.json', 'Local Storage']);
		assert.equal(fs.readFileSync(path.join(current, 'config.json'), 'utf8'),
			JSON.stringify({workspaceRoot: '/iCloud/Drawings'}));
		assert.equal(fs.readFileSync(path.join(legacy, 'config.json'), 'utf8'),
			JSON.stringify({workspaceRoot: '/iCloud/Drawings'}));
	});

	test('never overwrites state already created by draw.ai', () =>
	{
		const {current} = createFixture();
		fs.mkdirSync(current, {recursive: true});
		fs.writeFileSync(path.join(current, 'config.json'), '{"workspaceRoot":"/new"}');

		migrateLegacyUserData(current);
		assert.equal(fs.readFileSync(path.join(current, 'config.json'), 'utf8'),
			'{"workspaceRoot":"/new"}');
	});

	test('does nothing when no legacy profile exists', () =>
	{
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'draw-ai-migration-'));
		temporaryDirectories.push(root);
		assert.deepEqual(migrateLegacyUserData(path.join(root, 'draw.ai')), []);
	});
});
