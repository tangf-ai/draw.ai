import {readFile, writeFile} from 'fs/promises';
import path from 'path';
import {fileURLToPath} from 'url';

const buildDirectory = path.dirname(fileURLToPath(import.meta.url));

const icnsEntries = [
	['icp4', 16],
	['icp5', 32],
	['icp6', 64],
	['ic07', 128],
	['ic08', 256],
	['ic09', 512],
	['ic10', 1024]
];

const icoSizes = [16, 32, 48, 64, 128, 256];

async function readPng(size)
{
	const file = path.join(buildDirectory, `${size}x${size}.png`);
	const data = await readFile(file);

	if (data.length < 24 || data.toString('ascii', 1, 4) !== 'PNG')
	{
		throw new Error(`${file} is not a PNG image`);
	}

	if (data.readUInt32BE(16) !== size || data.readUInt32BE(20) !== size)
	{
		throw new Error(`${file} must be ${size}x${size}`);
	}

	return data;
}

async function generateIcns()
{
	const chunks = [];

	for (const [type, size] of icnsEntries)
	{
		const png = await readPng(size);
		const chunk = Buffer.alloc(8 + png.length);
		chunk.write(type, 0, 4, 'ascii');
		chunk.writeUInt32BE(chunk.length, 4);
		png.copy(chunk, 8);
		chunks.push(chunk);
	}

	const header = Buffer.alloc(8);
	header.write('icns', 0, 4, 'ascii');
	header.writeUInt32BE(8 + chunks.reduce((total, chunk) => total + chunk.length, 0), 4);
	await writeFile(path.join(buildDirectory, 'icon.icns'), Buffer.concat([header, ...chunks]));
}

async function generateIco()
{
	const images = await Promise.all(icoSizes.map(readPng));
	const headerSize = 6 + images.length * 16;
	const header = Buffer.alloc(headerSize);
	header.writeUInt16LE(0, 0);
	header.writeUInt16LE(1, 2);
	header.writeUInt16LE(images.length, 4);

	let imageOffset = headerSize;

	for (let index = 0; index < images.length; index++)
	{
		const size = icoSizes[index];
		const image = images[index];
		const offset = 6 + index * 16;
		header.writeUInt8(size === 256 ? 0 : size, offset);
		header.writeUInt8(size === 256 ? 0 : size, offset + 1);
		header.writeUInt8(0, offset + 2);
		header.writeUInt8(0, offset + 3);
		header.writeUInt16LE(1, offset + 4);
		header.writeUInt16LE(32, offset + 6);
		header.writeUInt32LE(image.length, offset + 8);
		header.writeUInt32LE(imageOffset, offset + 12);
		imageOffset += image.length;
	}

	await writeFile(path.join(buildDirectory, 'icon.ico'), Buffer.concat([header, ...images]));
}

await Promise.all([generateIcns(), generateIco()]);
console.log('Generated build/icon.icns and build/icon.ico');
