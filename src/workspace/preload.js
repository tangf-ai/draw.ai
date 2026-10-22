const {contextBridge, ipcRenderer} = require('electron');

async function invoke(channel, ...args)
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
	getState: () => invoke('workspace:get-state'),
	checkTemplate: () => invoke('workspace:check-template'),
	chooseRoot: () => invoke('workspace:choose-root'),
	useDefaultRoot: () => invoke('workspace:use-default-root'),
	createDirectory: (parentRelativePath, name) => invoke('workspace:create-directory', parentRelativePath, name),
	createDiagram: (parentRelativePath, name) => invoke('workspace:create-diagram', parentRelativePath, name),
	renameItem: (relativePath, name) => invoke('workspace:rename-item', relativePath, name),
	moveFile: (relativePath, destinationRelativePath, expectedRoot) => invoke('workspace:move-file', relativePath, destinationRelativePath, expectedRoot),
	moveDirectory: (relativePath, destinationRelativePath, expectedRoot) => invoke('workspace:move-directory', relativePath, destinationRelativePath, expectedRoot),
	copyFile: (relativePath, destinationRelativePath) => invoke('workspace:copy-file', relativePath, destinationRelativePath),
	trashItem: (relativePath) => invoke('workspace:trash-item', relativePath),
	openItem: (relativePath) => invoke('workspace:open-item', relativePath),
	revealItem: (relativePath) => invoke('workspace:reveal-item', relativePath),
	importFiles: (parentRelativePath) => invoke('workspace:import-files', parentRelativePath),
	editTemplate: () => invoke('workspace:edit-template'),
	importTemplate: () => invoke('workspace:import-template'),
	updateTemplate: (force = false) => invoke('workspace:update-template', force === true),
	removeTemplate: () => invoke('workspace:remove-template'),
	onMoved: callback =>
	{
		const listener = (event, move) => callback(move);
		ipcRenderer.on('workspace:moved', listener);
		return () => ipcRenderer.removeListener('workspace:moved', listener);
	},
	onChanged: (callback) =>
	{
		const listener = () => callback();
		ipcRenderer.on('workspace:changed', listener);
		return () => ipcRenderer.removeListener('workspace:changed', listener);
	}
});
