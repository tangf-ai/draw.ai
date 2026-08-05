import fs from 'fs';
import path from 'path';

const MIGRATED_ENTRIES = ['config.json', 'Local Storage', 'Session Storage', 'IndexedDB'];

export function migrateLegacyUserData(currentUserData, legacyProductName = 'draw.io')
{
	if (!path.isAbsolute(currentUserData))
	{
		throw new Error('currentUserData must be an absolute path');
	}

	const legacyUserData = path.join(path.dirname(currentUserData), legacyProductName);

	if (path.resolve(legacyUserData) === path.resolve(currentUserData) ||
		!fs.existsSync(legacyUserData) || !fs.statSync(legacyUserData).isDirectory())
	{
		return [];
	}

	const copied = [];
	fs.mkdirSync(currentUserData, {recursive: true});

	for (const entry of MIGRATED_ENTRIES)
	{
		const source = path.join(legacyUserData, entry);
		const destination = path.join(currentUserData, entry);

		if (!fs.existsSync(source) || fs.existsSync(destination) || fs.lstatSync(source).isSymbolicLink())
		{
			continue;
		}

		fs.cpSync(source, destination, {recursive: true, errorOnExist: true, force: false});
		copied.push(entry);
	}

	return copied;
}
