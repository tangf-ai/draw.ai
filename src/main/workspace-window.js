import {watch as watchFileSystem, promises as fs} from 'fs';
import path from 'path';
import url from 'url';
import {
	copyWorkspaceFile,
	createWorkspaceDiagram,
	createWorkspaceDirectory,
	ensureWorkspaceTemplate,
	getWorkspaceItem,
	getWorkspaceTemplatePath,
	importWorkspaceTemplate,
	importWorkspaceFiles,
	readWorkspace,
	removeWorkspaceTemplateSource,
	renameWorkspaceItem,
	moveWorkspaceFile,
	updateWorkspaceTemplateFromSource,
	WORKSPACE_FILE_EXTENSIONS
} from './workspace-files.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

export const workspaceCodeDir = path.join(__dirname, '../workspace');
export const workspaceCodeUrl = url.pathToFileURL(workspaceCodeDir + path.sep).href
	.replace(/\/.\:\//, value => value.toUpperCase());

const WORKSPACE_ROOT_KEY = 'workspaceRoot';

function emptyState(unavailableRoot = null)
{
	return {
		root: null,
		name: null,
		tree: [],
		counts: {directories: 0, files: 0},
		template: {configured: false, invalid: false, modifiedAt: null, size: 0},
		unavailableRoot: unavailableRoot
	};
}

function errorMessage(error)
{
	if (error?.code === 'ENOENT') return '文件或目录已经不存在';
	if (error?.code === 'EACCES' || error?.code === 'EPERM') return '没有权限执行此操作';
	return error?.message || '操作失败';
}

export function createWorkspaceController(dependencies)
{
	const {
		app,
		BrowserWindow,
		dialog,
		ipcMain,
		shell,
		store,
		openDiagram,
		registerWindow,
		onWorkspaceReady,
		isEditorSender,
		authorizePath,
		isDev
	} = dependencies;

	let workspaceWindow = null;
	let watcher = null;
	let watcherTimer = null;

	function isWorkspaceSender(frame)
	{
		if (frame == null) return false;
		return frame.url.replace(/\/.\:\//, value => value.toUpperCase()).startsWith(workspaceCodeUrl);
	}

	function isAllowedSender(frame)
	{
		return isWorkspaceSender(frame) ||
			(typeof isEditorSender === 'function' && isEditorSender(frame));
	}

	async function getState(options = {})
	{
		const root = store?.get(WORKSPACE_ROOT_KEY);

		if (!root)
		{
			return emptyState();
		}

		try
		{
			return await readWorkspace(root, options);
		}
		catch (error)
		{
			if (error.code === 'ENOENT' || error.code === 'ENOTDIR')
			{
				return emptyState(root);
			}

			throw error;
		}
	}

	function notifyChanged()
	{
		const windows = typeof BrowserWindow.getAllWindows === 'function' ?
			BrowserWindow.getAllWindows() : (workspaceWindow != null ? [workspaceWindow] : []);

		for (const window of windows)
		{
			if (window != null && !window.isDestroyed())
			{
				window.webContents.send('workspace:changed');
			}
		}
	}

	function stopWatcher()
	{
		if (watcherTimer != null)
		{
			clearTimeout(watcherTimer);
			watcherTimer = null;
		}

		if (watcher != null)
		{
			watcher.close();
			watcher = null;
		}
	}

	function startWatcher(root)
	{
		stopWatcher();

		try
		{
			watcher = watchFileSystem(root, {recursive: true}, () =>
			{
				if (watcherTimer != null) clearTimeout(watcherTimer);
				watcherTimer = setTimeout(notifyChanged, 180);
			});

			watcher.on('error', () => stopWatcher());
		}
		catch (error)
		{
			// Manual refresh and refresh-after-action remain available on filesystems
			// that do not support recursive watching.
		}
	}

	async function setRoot(root)
	{
		const state = await readWorkspace(root);
		store?.set(WORKSPACE_ROOT_KEY, state.root);
		startWatcher(state.root);
		notifyChanged();
		return state;
	}

	async function actionResult(action)
	{
		try
		{
			return {ok: true, data: await action()};
		}
		catch (error)
		{
			return {ok: false, error: errorMessage(error), code: error?.code || null};
		}
	}

	function handle(channel, action)
	{
		ipcMain.handle(channel, async (event, ...args) =>
		{
			if (!isAllowedSender(event.senderFrame))
			{
				return {ok: false, error: '请求来源无效', code: 'INVALID_SENDER'};
			}

			return actionResult(() => action(event, ...args));
		});
	}

	handle('workspace:get-state', () => getState());
	handle('workspace:check-template', () => getState({forceSourceRead: true}));

	handle('workspace:choose-root', async (event) =>
	{
		const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
			title: '选择图纸工作区',
			properties: ['openDirectory', 'createDirectory']
		});

		if (result.canceled || !result.filePaths[0])
		{
			return null;
		}

		return setRoot(result.filePaths[0]);
	});

	handle('workspace:use-default-root', async () =>
	{
		const defaultRoot = path.join(app.getPath('documents'), 'draw.ai Workspace');
		await fs.mkdir(defaultRoot, {recursive: true});
		return setRoot(defaultRoot);
	});

	handle('workspace:create-directory', async (event, parentRelativePath, name) =>
	{
		const root = store?.get(WORKSPACE_ROOT_KEY);
		const createdRelativePath = await createWorkspaceDirectory(root, parentRelativePath, name);
		return {state: await getState(), createdRelativePath: createdRelativePath};
	});

	handle('workspace:create-diagram', async (event, parentRelativePath, name) =>
	{
		const root = store?.get(WORKSPACE_ROOT_KEY);
		const createdRelativePath = await createWorkspaceDiagram(root, parentRelativePath, name);
		return {state: await getState(), createdRelativePath: createdRelativePath};
	});

	handle('workspace:rename-item', async (event, relativePath, name) =>
	{
		const root = store?.get(WORKSPACE_ROOT_KEY);
		const renamedRelativePath = await renameWorkspaceItem(root, relativePath, name);
		return {state: await getState(), renamedRelativePath: renamedRelativePath};
	});

	handle('workspace:move-file', async (event, relativePath, destinationRelativePath) =>
	{
		const root = store?.get(WORKSPACE_ROOT_KEY);
		const movedRelativePath = await moveWorkspaceFile(root, relativePath, destinationRelativePath);
		return {state: await getState(), movedRelativePath: movedRelativePath};
	});

	handle('workspace:copy-file', async (event, relativePath, destinationRelativePath) =>
	{
		const root = store?.get(WORKSPACE_ROOT_KEY);
		const copiedRelativePath = await copyWorkspaceFile(root, relativePath, destinationRelativePath);
		return {state: await getState(), copiedRelativePath: copiedRelativePath};
	});

	handle('workspace:trash-item', async (event, relativePath) =>
	{
		const root = store?.get(WORKSPACE_ROOT_KEY);
		const item = await getWorkspaceItem(root, relativePath);
		await shell.trashItem(item.absolutePath);
		return getState();
	});

	handle('workspace:open-item', async (event, relativePath) =>
	{
		const root = store?.get(WORKSPACE_ROOT_KEY);
		const item = await getWorkspaceItem(root, relativePath);

		if (item.type !== 'file' || !WORKSPACE_FILE_EXTENSIONS.has(path.extname(item.absolutePath).toLowerCase()))
		{
			throw new Error('只能打开工作区中的图文件');
		}

		openDiagram(item.absolutePath);
		return true;
	});

	handle('workspace:resolve-item', async (event, relativePath) =>
	{
		const root = store?.get(WORKSPACE_ROOT_KEY);
		const item = await getWorkspaceItem(root, relativePath);

		if (item.type !== 'file' || !WORKSPACE_FILE_EXTENSIONS.has(path.extname(item.absolutePath).toLowerCase()))
		{
			throw new Error('只能打开工作区中的图文件');
		}

		authorizePath?.(item.absolutePath);
		return {absolutePath: item.absolutePath, relativePath: item.relativePath, name: item.name};
	});

	handle('workspace:show-manager', () =>
	{
		createWindow();
		return true;
	});

	handle('workspace:reveal-item', async (event, relativePath) =>
	{
		const root = store?.get(WORKSPACE_ROOT_KEY);
		const item = await getWorkspaceItem(root, relativePath);
		shell.showItemInFolder(item.absolutePath);
		return true;
	});

	handle('workspace:import-files', async (event, parentRelativePath) =>
	{
		const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
			title: '导入图文件',
			properties: ['openFile', 'multiSelections'],
			filters: [{
				name: '图文件',
				extensions: [...WORKSPACE_FILE_EXTENSIONS].map(extension => extension.slice(1))
			}]
		});

		if (result.canceled || result.filePaths.length === 0)
		{
			return null;
		}

		const root = store?.get(WORKSPACE_ROOT_KEY);
		const importedRelativePaths = await importWorkspaceFiles(root, parentRelativePath, result.filePaths);
		return {state: await getState(), importedRelativePaths: importedRelativePaths};
	});

	handle('workspace:edit-template', async () =>
	{
		const root = store?.get(WORKSPACE_ROOT_KEY);
		const template = await ensureWorkspaceTemplate(root);
		openDiagram(template.absolutePath);
		return getState();
	});

	handle('workspace:import-template', async (event) =>
	{
		const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
			title: '导入默认模板',
			properties: ['openFile'],
			filters: [{name: 'draw.ai 模板', extensions: ['drawio']}]
		});

		if (result.canceled || !result.filePaths[0])
		{
			return null;
		}

		const root = store?.get(WORKSPACE_ROOT_KEY);
		await importWorkspaceTemplate(root, result.filePaths[0]);
		return getState({forceSourceRead: true});
	});

	handle('workspace:update-template', async (event, force) =>
	{
		const root = store?.get(WORKSPACE_ROOT_KEY);
		await updateWorkspaceTemplateFromSource(root, force === true);
		return getState({forceSourceRead: true});
	});

	handle('workspace:remove-template', async () =>
	{
		const root = store?.get(WORKSPACE_ROOT_KEY);
		const templatePath = await getWorkspaceTemplatePath(root);

		if (templatePath != null)
		{
			await shell.trashItem(templatePath);
		}

		await removeWorkspaceTemplateSource(root);

		return getState();
	});

	function createWindow()
	{
		if (workspaceWindow != null && !workspaceWindow.isDestroyed())
		{
			if (workspaceWindow.isMinimized()) workspaceWindow.restore();
			workspaceWindow.show();
			workspaceWindow.focus();
			return workspaceWindow;
		}

		workspaceWindow = new BrowserWindow({
			title: 'draw.ai 图纸工作区',
			backgroundColor: '#f6f7f9',
			width: 1180,
			height: 760,
			minWidth: 760,
			minHeight: 560,
			show: false,
			webPreferences: {
				preload: path.join(workspaceCodeDir, 'preload.js'),
				contextIsolation: true,
				nodeIntegration: false,
				sandbox: true
			}
		});

		registerWindow(workspaceWindow);
		workspaceWindow.loadFile(path.join(workspaceCodeDir, 'index.html'));

		workspaceWindow.once('ready-to-show', () => workspaceWindow?.show());
		workspaceWindow.webContents.once('did-finish-load', () => onWorkspaceReady?.());

		if (isDev)
		{
			workspaceWindow.webContents.openDevTools({mode: 'detach'});
		}

		workspaceWindow.on('closed', () =>
		{
			workspaceWindow = null;
		});

		const root = store?.get(WORKSPACE_ROOT_KEY);
		if (root) startWatcher(root);

		return workspaceWindow;
	}

	return {
		createWindow: createWindow,
		isWorkspaceSender: isWorkspaceSender,
		notifyChanged: notifyChanged,
		stop: stopWatcher
	};
}
