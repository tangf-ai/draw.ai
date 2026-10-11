const {
    contextBridge,
    ipcRenderer
} = require("electron");

// One-shot migration: when the main process determines this is the first
// launch with the new defaultAdaptiveColors behaviour, it passes the chosen
// mode here via webPreferences.additionalArguments. We seed it into the
// drawio Configuration JSON in localStorage (key '.configuration') so that
// Editor.configure() picks it up during App.js boot. We never overwrite an
// explicit value the user may have already set via Extras > Configuration.
try
{
	const flagPrefix = '--initial-adaptive-colors=';
	const flagArg = process.argv.find(a => a.startsWith(flagPrefix));

	if (flagArg)
	{
		const mode = flagArg.slice(flagPrefix.length);

		if (mode === 'auto' || mode === 'simple' || mode === 'none')
		{
			const raw = window.localStorage.getItem('.configuration');
			const cfg = raw ? JSON.parse(raw) : {};

			if (cfg.defaultAdaptiveColors == null)
			{
				cfg.defaultAdaptiveColors = mode;
				window.localStorage.setItem('.configuration', JSON.stringify(cfg));
			}
		}
	}
}
catch (e)
{
	// Don't block app startup if the migration fails for any reason.
	console.error('Failed to seed defaultAdaptiveColors:', e);
}

let reqId = 1;
let reqInfo = {};
let fileChangedListeners = {};

ipcRenderer.on('mainResp', (event, resp) => 
{
	var callbacks = reqInfo[resp.reqId];

	if (callbacks == null) return;

	if (resp.progress)
	{
		if (typeof callbacks.progress === 'function') callbacks.progress(resp.data);
		return;
	}

	if (resp.error)
	{
		callbacks.error(resp.msg, {code: resp.code});
	}
	else
	{
		callbacks.callback(resp.data);
	}
	
	delete reqInfo[resp.reqId];
});

ipcRenderer.on('fileChanged', (event, resp) => 
{
	var listener = fileChangedListeners[resp.path];
	
	if (listener)
	{
		listener(resp.curr, resp.prev);
	}
});

contextBridge.exposeInMainWorld(
    'electron', {
	        request: (msg, callback, error, progress) =>
			{
				msg.reqId = reqId++;
				reqInfo[msg.reqId] = {callback: callback, error: error, progress: progress};

			//TODO Maybe a special function for this better than this hack?
			//File watch special case where the callback is called multiple times
			if (msg.action == 'watchFile')
			{
				fileChangedListeners[msg.path] = msg.listener;
				delete msg.listener;
			}

			ipcRenderer.send('rendererReq', msg);
        },
		registerMsgListener: function(action, callback)
		{
			ipcRenderer.on(action, function(event, args)
			{
				callback(args);
			});
		},
		sendMessage: function(action, args)
		{
			ipcRenderer.send(action, args);
		},
		listenOnce: function(action, callback)
		{
			ipcRenderer.once(action, function(event, args)
			{
				callback(args);
			});
		}
    }
);

contextBridge.exposeInMainWorld(
    'process', {
		type: process.type,
		versions: process.versions
    }
);

async function invokeWorkspace(channel, ...args)
{
	const result = await ipcRenderer.invoke(channel, ...args);

	if (!result?.ok)
	{
		const error = new Error(result?.error || '操作失败');
		error.code = result?.code;
		throw error;
	}

	return result.data;
}

contextBridge.exposeInMainWorld('workspaceAPI', {
	getState: () => invokeWorkspace('workspace:get-state'),
	chooseRoot: () => invokeWorkspace('workspace:choose-root'),
	useDefaultRoot: () => invokeWorkspace('workspace:use-default-root'),
	createDirectory: (parentRelativePath, name) =>
		invokeWorkspace('workspace:create-directory', parentRelativePath, name),
	createDiagram: (parentRelativePath, name) =>
		invokeWorkspace('workspace:create-diagram', parentRelativePath, name),
	moveFile: (relativePath, destinationRelativePath, expectedRoot) =>
		invokeWorkspace('workspace:move-file', relativePath, destinationRelativePath, expectedRoot),
	renameFile: (relativePath, name, expectedRoot) =>
		invokeWorkspace('workspace:rename-file', relativePath, name, expectedRoot),
	copyFile: (relativePath, destinationRelativePath, expectedRoot) =>
		invokeWorkspace('workspace:copy-file', relativePath, destinationRelativePath, expectedRoot),
	trashFile: (relativePath, expectedRoot) => invokeWorkspace('workspace:trash-file', relativePath, expectedRoot),
	resolveItem: relativePath => invokeWorkspace('workspace:resolve-item', relativePath),
	showManager: () => invokeWorkspace('workspace:show-manager'),
	onChanged: callback =>
	{
		const listener = () => callback();
		ipcRenderer.on('workspace:changed', listener);
		return () => ipcRenderer.removeListener('workspace:changed', listener);
	}
});
