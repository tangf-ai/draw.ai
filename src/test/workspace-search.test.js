import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm, symlink, rename, truncate, realpath} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {deflateRawSync} from 'node:zlib';
import {createWorkspaceSearcher} from '../main/workspace-search.js';

const model = label => `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="2" value="${label}" style="fillColor=hidden-style-token" vertex="1" parent="1"/></root></mxGraphModel>`;
const compressed = xml => deflateRawSync(Buffer.from(encodeURIComponent(xml))).toString('base64');
const paths = result => result.results.map(match => match.relativePath).sort();

async function fixture(t)
{
	const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'draw-ai-search-')));
	t.after(() => rm(root, {recursive: true, force: true}));
	return {root, search: createWorkspaceSearcher(), write: (file, content) => writeFile(path.join(root, file), content)};
}

test('searches names, nested saved labels and page names in plain and compressed diagrams', async t =>
{
	const f = await fixture(t);
	await mkdir(path.join(f.root, '归档'));
	await f.write('归档/系统.drawio', `<mxfile><diagram name="部署页">${model('企业知识库')}</diagram><diagram name="备用页">${compressed(model('智能体 QWEN'))}</diagram></mxfile>`);
	await f.write('知识库说明.drawio', `<mxfile><diagram>${model('其他内容')}</diagram></mxfile>`);
	assert.deepEqual(paths(await f.search(f.root, '知识库')), ['归档/系统.drawio', '知识库说明.drawio']);
	const result = await f.search(f.root, 'qwen');
	assert.equal(result.results[0].match, 'content');
	assert.match(result.results[0].snippet, /QWEN/);
	assert.deepEqual(paths(await f.search(f.root, '部署页')), ['归档/系统.drawio']);
	assert.deepEqual(paths(await f.search(f.root, 'hidden-style-token')), []);
	assert.deepEqual(paths(await f.search(f.root, '归档')), ['归档']);
});

test('decodes rich HTML labels, entities and wrapped object labels without indexing markup', async t =>
{
	const f = await fixture(t);
	await f.write('富文本.dio', `<mxfile><diagram>${model('&lt;b&gt;知识&lt;/b&gt;&lt;br&gt;检索 &amp;amp; API &amp;nbsp; 网关')}</diagram><diagram><mxGraphModel><root><object label="数据服务"><mxCell vertex="1"/></object></root></mxGraphModel></diagram></mxfile>`);
	assert.match((await f.search(f.root, '知识 检索 & api')).results[0].snippet, /知识 检索 & API/);
	assert.deepEqual(paths(await f.search(f.root, '数据服务')), ['富文本.dio']);
	assert.deepEqual(paths(await f.search(f.root, '<b>')), []);
	assert.deepEqual(paths(await f.search(f.root, 'nbsp')), []);
});

test('supports raw model XML, SVG text and embedded diagrams, Mermaid and CSV', async t =>
{
	const f = await fixture(t);
	await f.write('原始.xml', model('文字检索'));
	await f.write('导出.svg', '<svg xmlns="http://www.w3.org/2000/svg"><text>文字检索</text></svg>');
	await f.write('嵌入.svg', `<svg content="${('<mxfile><diagram>' + compressed(model('文字检索')) + '</diagram></mxfile>').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}"></svg>`);
	await f.write('流程.mmd', 'graph TD\n A[文字检索] --> B[结果]');
	await f.write('数据.csv', 'name,description\n条目,文字检索');
	assert.equal((await f.search(f.root, '文字检索')).results.length, 5);
});

test('refreshes cached text after edits, rename, deletion and workspace switches', async t =>
{
	const f = await fixture(t);
	await f.write('系统.drawio', model('旧内容'));
	assert.equal((await f.search(f.root, '旧内容')).results.length, 1);
	await f.write('系统.drawio', model('最新保存的内容'));
	assert.equal((await f.search(f.root, '旧内容')).results.length, 0);
	assert.equal((await f.search(f.root, '最新保存')).results.length, 1);
	await rename(path.join(f.root, '系统.drawio'), path.join(f.root, '新名称.drawio'));
	assert.deepEqual(paths(await f.search(f.root, '最新保存')), ['新名称.drawio']);
	const other = await fixture(t);
	await other.write('新名称.drawio', model('别的工作区'));
	assert.equal((await f.search(other.root, '最新保存')).results.length, 0);
	await rm(path.join(f.root, '新名称.drawio'));
	assert.equal((await f.search(f.root, '最新保存')).results.length, 0);
});

test('isolates broken, oversized and unsupported files while retaining name matches and good pages', async t =>
{
	const f = await fixture(t);
	await f.write('损坏.drawio', '<mxfile><unclosed>');
	await f.write('部分损坏.drawio', `<mxfile><diagram>not-compressed</diagram><diagram>${model('仍可检索')}</diagram></mxfile>`);
	await f.write('超大.drawio', '');
	await truncate(path.join(f.root, '超大.drawio'), 8 * 1024 * 1024 + 1);
	await f.write('图片.png', '仍可检索');
	const result = await f.search(f.root, '仍可检索');
	assert.deepEqual(paths(result), ['部分损坏.drawio']);
	assert.equal(result.skippedFiles, 3);
	assert.deepEqual(paths(await f.search(f.root, '损坏.drawio')), ['损坏.drawio', '部分损坏.drawio']);
	assert.deepEqual(paths(await f.search(f.root, '图片')), ['图片.png']);
});

test('does not read hidden files, symbolic links or files outside the workspace', async t =>
{
	const f = await fixture(t);
	const other = await fixture(t);
	await other.write('外部.drawio', model('外部秘密'));
	await f.write('.隐藏.drawio', model('外部秘密'));
	await f.write('~$草稿.drawio', model('外部秘密'));
	await symlink(path.join(other.root, '外部.drawio'), path.join(f.root, '链接.drawio'));
	await symlink(other.root, path.join(f.root, '链接目录'));
	assert.deepEqual(paths(await f.search(f.root, '外部秘密')), []);
	await assert.rejects(f.search(f.root, null), /256/);
	await assert.rejects(f.search(f.root, 'a'.repeat(257)), /256/);
	assert.deepEqual(paths(await f.search(f.root, '   ')), []);
});
