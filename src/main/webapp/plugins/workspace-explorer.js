Draw.loadPlugin(function(ui)
{
	if (window.workspaceAPI == null || ui.sidebarContainer == null || ui.sidebar == null ||
		ui.__drawAiWorkspaceExplorerInstalled)
	{
		return;
	}

	ui.__drawAiWorkspaceExplorerInstalled = true;
	var api = window.workspaceAPI;
	var container = ui.sidebarContainer;
	var state = null;
	var currentDirectory = '';
	var searchQuery = '';
	var expanded = {};
	var draggedRelativePath = null;
	var graphModelListener = null;
	var removeWorkspaceChangedListener = null;
	var operationInProgress = false;
	var fileMenu = null;
	var fileMenuTrigger = null;

	function element(tag, className, text)
	{
		var node = document.createElement(tag);
		if (className) node.className = className;
		if (text != null) node.textContent = text;
		return node;
	}

	function icon(name)
	{
		var paths = {
			folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9L9.6 3.9A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
			file: '<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5Z"/><polyline points="14 2 14 8 20 8"/><path d="M8 13h8M8 17h5"/>',
			refresh: '<path d="M20 11a8.1 8.1 0 0 0-15.5-2M4 4v5h5M4 13a8.1 8.1 0 0 0 15.5 2M20 20v-5h-5"/>',
			search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
			settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.51a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z"/><circle cx="12" cy="12" r="3"/>',
			plus: '<path d="M12 5v14M5 12h14"/>',
			chevron: '<path d="m9 18 6-6-6-6"/>'
		};
		var svg = element('span', 'geWorkspaceIcon');
		svg.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' + paths[name] + '</svg>';
		return svg;
	}

	var css = document.createElement('style');
	css.textContent = [
		'.geWorkspaceSidebar{overflow:hidden!important;background:light-dark(#fff,#202124)!important}',
		'.geWorkspaceModeTabs{height:36px;display:flex;border-bottom:1px solid light-dark(#d6d9de,#454950);box-sizing:border-box;background:light-dark(#f7f8fa,#292b30)}',
		'.geWorkspaceModeTab{flex:1;border:0;border-right:1px solid light-dark(#d6d9de,#454950);border-radius:0;background:transparent;color:inherit;font:500 13px Arial,sans-serif;cursor:pointer;padding:0 8px;letter-spacing:0}',
		'.geWorkspaceModeTab:last-child{border-right:0}',
		'.geWorkspaceModeTab.geWorkspaceActive{background:light-dark(#fff,#1f2024);box-shadow:inset 0 -2px #1a73e8;color:light-dark(#185abc,#8ab4f8)}',
		'.geWorkspaceShapeView,.geWorkspaceView{height:calc(100% - 36px);box-sizing:border-box}',
		'.geWorkspaceShapeView{overflow:auto}',
		'.geWorkspaceView{display:flex;min-height:280px;flex-direction:column;color:light-dark(#202124,#e8eaed);font:12px Arial,sans-serif;background:light-dark(#fff,#202124)}',
		'.geWorkspaceHidden{display:none!important}',
		'.geWorkspaceHeader{display:flex;align-items:center;gap:6px;padding:10px 9px 8px;border-bottom:1px solid light-dark(#e5e8ec,#383b40)}',
		'.geWorkspaceIdentity{min-width:0;flex:1}',
		'.geWorkspaceName,.geWorkspacePath{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;letter-spacing:0}',
		'.geWorkspaceName{font-weight:600;font-size:12px}',
		'.geWorkspacePath{margin-top:2px;color:light-dark(#70757a,#9aa0a6);font-size:10px}',
		'.geWorkspaceIconButton{display:grid;place-items:center;width:28px;height:28px;min-width:28px;border:0;border-radius:4px;background:transparent;color:light-dark(#5f6368,#bdc1c6);cursor:pointer;padding:0}',
		'.geWorkspaceIconButton:hover{background:light-dark(#eef1f4,#35363a);color:inherit}',
		'.geWorkspaceIcon{display:inline-flex;width:16px;height:16px;flex:0 0 16px}',
		'.geWorkspaceIcon svg{width:100%;height:100%;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}',
		'.geWorkspaceSearch{display:flex;align-items:center;height:32px;gap:6px;margin:8px 9px;padding:0 8px;border:1px solid light-dark(#d0d5db,#5f6368);border-radius:5px;color:light-dark(#70757a,#9aa0a6);box-sizing:border-box}',
		'.geWorkspaceSearch:focus-within{border-color:#1a73e8;box-shadow:0 0 0 1px #1a73e8}',
		'.geWorkspaceSearch input{min-width:0;width:100%;border:0;outline:0;background:transparent;color:inherit;font:12px Arial,sans-serif;letter-spacing:0}',
		'.geWorkspaceTree{min-height:0;flex:1;overflow:auto;padding:0 6px 8px}',
		'.geWorkspaceRow{display:flex;align-items:center;width:100%;height:30px;gap:5px;padding:0 7px;border:0;border-radius:4px;background:transparent;color:inherit;font:12px Arial,sans-serif;text-align:left;cursor:pointer;box-sizing:border-box;letter-spacing:0}',
		'.geWorkspaceRow:hover{background:light-dark(#f1f3f4,#303134)}',
		'.geWorkspaceRow[draggable="true"]{cursor:grab}',
		'.geWorkspaceRow[draggable="true"]:active{cursor:grabbing}',
		'.geWorkspaceRow.geWorkspaceDragging{opacity:.45}',
		'.geWorkspaceRow.geWorkspaceDropTarget{background:light-dark(#e8f0fe,#26354d);box-shadow:inset 0 0 0 1px #1a73e8}',
		'.geWorkspaceIdentity.geWorkspaceDropTarget{border-radius:4px;box-shadow:inset 0 0 0 1px #1a73e8;background:light-dark(#e8f0fe,#26354d)}',
		'.geWorkspaceTree.geWorkspaceDropTarget{background:light-dark(#f4f8ff,#252b35);box-shadow:inset 0 0 0 2px #1a73e8}',
		'.geWorkspaceRow.geWorkspaceCurrent{background:light-dark(#e8f0fe,#26354d);color:light-dark(#174ea6,#8ab4f8);font-weight:600}',
		'.geWorkspaceRow.geWorkspaceSelected{background:light-dark(#fef3e2,#413323)}',
		'.geWorkspaceRow .geWorkspaceFolder{color:light-dark(#c77c18,#f0b45b)}',
		'.geWorkspaceRowLabel{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
		'.geWorkspaceEntry{position:relative;display:flex;align-items:center}',
		'.geWorkspaceEntry .geWorkspaceRow{padding-right:32px}',
		'.geWorkspaceMore{position:absolute;right:2px;top:1px;opacity:0;font-size:21px}',
		'.geWorkspaceEntry:hover .geWorkspaceMore,.geWorkspaceEntry:focus-within .geWorkspaceMore{opacity:1}',
		'.geWorkspaceBusy{pointer-events:none;opacity:.65}',
		'.geWorkspaceFileMenu{position:fixed;z-index:10005;min-width:160px;padding:4px;border:1px solid light-dark(#d6d9de,#454950);border-radius:6px;background:light-dark(#fff,#292b30);box-shadow:0 4px 16px #0003;color:light-dark(#202124,#e8eaed);font:12px Arial,sans-serif}',
		'.geWorkspaceFileMenu button{display:block;width:100%;padding:8px 12px;border:0;border-radius:3px;text-align:left;background:transparent;color:inherit;font:inherit;cursor:pointer}',
		'.geWorkspaceFileMenu button:hover,.geWorkspaceFileMenu button:focus{background:light-dark(#e8f0fe,#26354d);outline:none}',
		'.geWorkspaceFileMenu button:last-child{color:light-dark(#c5221f,#f28b82)}',
		'.geWorkspaceChevron{transition:transform .14s ease}',
		'.geWorkspaceChevron.geWorkspaceExpanded{transform:rotate(90deg)}',
		'.geWorkspaceFooter{display:flex;align-items:center;gap:5px;padding:7px 9px;border-top:1px solid light-dark(#e5e8ec,#383b40)}',
		'.geWorkspaceFooterButton{display:inline-flex;align-items:center;justify-content:center;height:30px;gap:5px;padding:0 8px;border:1px solid light-dark(#d0d5db,#5f6368);border-radius:4px;background:transparent;color:inherit;font:11px Arial,sans-serif;cursor:pointer;letter-spacing:0}',
		'.geWorkspaceFooterButton:hover{background:light-dark(#f1f3f4,#35363a)}',
		'.geWorkspaceFooterStatus{min-width:0;margin-left:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:light-dark(#70757a,#9aa0a6);font-size:10px}',
		'.geWorkspaceSetup,.geWorkspaceEmpty{display:flex;min-height:0;flex:1;align-items:center;justify-content:center;flex-direction:column;padding:18px;text-align:center;color:light-dark(#5f6368,#bdc1c6);box-sizing:border-box}',
		'.geWorkspaceSetup strong{color:inherit;font-size:13px}',
		'.geWorkspaceSetupActions{display:flex;gap:6px;margin-top:12px}',
		'.geWorkspacePrimary{border-color:#1a73e8!important;background:#1a73e8!important;color:#fff!important}',
		'.geWorkspaceDialog{padding:16px;font:13px Arial,sans-serif;color:light-dark(#202124,#e8eaed)}',
		'.geWorkspaceDialogTitle{margin:0 0 14px;font-weight:600;font-size:15px;letter-spacing:0}',
		'.geWorkspaceDialog input,.geWorkspaceDialog select{width:100%;height:34px;padding:0 9px;border:1px solid light-dark(#c8ccd2,#5f6368);border-radius:4px;background:light-dark(#fff,#292a2e);color:inherit;font:13px Arial,sans-serif;box-sizing:border-box;outline:none;letter-spacing:0}',
		'.geWorkspaceDialogError{min-height:16px;margin-top:8px;color:light-dark(#c5221f,#f28b82);font-size:12px;overflow-wrap:anywhere}',
		'.geWorkspaceDialog p{line-height:1.5;overflow-wrap:anywhere}',
		'.geWorkspaceDialog input:focus{border-color:#1a73e8;box-shadow:0 0 0 1px #1a73e8}',
		'.geWorkspaceDialogActions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}'
	].join('');
	document.head.appendChild(css);

	var shapeView = element('div', 'geWorkspaceShapeView');
	while (container.firstChild != null) shapeView.appendChild(container.firstChild);
	var tabs = element('div', 'geWorkspaceModeTabs');
	var workspaceTab = element('button', 'geWorkspaceModeTab', '工作区');
	var shapesTab = element('button', 'geWorkspaceModeTab', '图形');
	workspaceTab.type = 'button';
	shapesTab.type = 'button';
	tabs.appendChild(workspaceTab);
	tabs.appendChild(shapesTab);
	var workspaceView = element('div', 'geWorkspaceView');
	container.appendChild(tabs);
	container.appendChild(shapeView);
	container.appendChild(workspaceView);
	container.classList.add('geWorkspaceSidebar');

	if (ui.sidebar.container === container) ui.sidebar.container = shapeView;

	var header = element('div', 'geWorkspaceHeader');
	var identity = element('div', 'geWorkspaceIdentity');
	var workspaceName = element('span', 'geWorkspaceName', '图纸工作区');
	var workspacePath = element('span', 'geWorkspacePath', '尚未设置');
	identity.appendChild(workspaceName);
	identity.appendChild(workspacePath);
	var refreshButton = element('button', 'geWorkspaceIconButton');
	refreshButton.type = 'button';
	refreshButton.title = '刷新工作区';
	refreshButton.appendChild(icon('refresh'));
	var managerButton = element('button', 'geWorkspaceIconButton');
	managerButton.type = 'button';
	managerButton.title = '打开工作区管理';
	managerButton.appendChild(icon('settings'));
	header.appendChild(identity);
	header.appendChild(refreshButton);
	header.appendChild(managerButton);

	var search = element('label', 'geWorkspaceSearch');
	search.appendChild(icon('search'));
	var searchInput = element('input');
	searchInput.type = 'search';
	searchInput.placeholder = '搜索图纸';
	searchInput.autocomplete = 'off';
	search.appendChild(searchInput);
	var tree = element('div', 'geWorkspaceTree');
	var footer = element('div', 'geWorkspaceFooter');
	var newFolderButton = element('button', 'geWorkspaceFooterButton');
	newFolderButton.type = 'button';
	newFolderButton.title = '新建目录';
	newFolderButton.appendChild(icon('folder'));
	newFolderButton.appendChild(document.createTextNode('目录'));
	var newFileButton = element('button', 'geWorkspaceFooterButton geWorkspacePrimary');
	newFileButton.type = 'button';
	newFileButton.title = '新建图文件';
	newFileButton.appendChild(icon('plus'));
	newFileButton.appendChild(document.createTextNode('图文件'));
	var footerStatus = element('span', 'geWorkspaceFooterStatus');
	footer.appendChild(newFolderButton);
	footer.appendChild(newFileButton);
	footer.appendChild(footerStatus);
	workspaceView.appendChild(header);
	workspaceView.appendChild(search);
	workspaceView.appendChild(tree);
	workspaceView.appendChild(footer);

	function currentFilePath()
	{
		var file = ui.getCurrentFile();
		return file != null && file.fileObject != null ? String(file.fileObject.path || '') : '';
	}

	function normalizedPath(value)
	{
		return String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
	}

	function isCurrentFile(item)
	{
		return state != null && normalizedPath(state.root + '/' + item.relativePath) ===
			normalizedPath(currentFilePath());
	}

	function matchesSearch(item)
	{
		if (searchQuery === '') return true;
		if (item.name.toLowerCase().indexOf(searchQuery) >= 0) return true;
		return item.type === 'directory' && item.children.some(matchesSearch);
	}

	function parentPath(relativePath)
	{
		var index = relativePath.lastIndexOf('/');
		return index < 0 ? '' : relativePath.substring(0, index);
	}

	function canDropIn(destinationRelativePath)
	{
		return draggedRelativePath != null &&
			normalizedPath(parentPath(draggedRelativePath)) !== normalizedPath(destinationRelativePath);
	}

	function clearDropTargets()
	{
		var targets = workspaceView.querySelectorAll('.geWorkspaceDropTarget');

		for (var i = 0; i < targets.length; i++)
		{
			targets[i].classList.remove('geWorkspaceDropTarget');
		}
	}

	function clearDragFeedback()
	{
		clearDropTargets();
		var sources = workspaceView.querySelectorAll('.geWorkspaceDragging');

		for (var i = 0; i < sources.length; i++)
		{
			sources[i].classList.remove('geWorkspaceDragging');
		}
	}

	function setDropTarget(event, destinationRelativePath, target)
	{
		if (draggedRelativePath == null) return false;
		event.stopPropagation();

		if (!canDropIn(destinationRelativePath))
		{
			event.dataTransfer.dropEffect = 'none';
			clearDropTargets();
			return false;
		}

		event.preventDefault();
		event.dataTransfer.dropEffect = 'move';
		clearDropTargets();
		target.classList.add('geWorkspaceDropTarget');
		return true;
	}

	function clearDropTarget(event, target)
	{
		if (event.relatedTarget == null || !target.contains(event.relatedTarget))
		{
			target.classList.remove('geWorkspaceDropTarget');
		}
	}

	function moveDiagram(relativePath, destinationRelativePath)
	{
		return runFileOperation({relativePath: relativePath}, 'move', function(root)
		{
			return api.moveFile(relativePath, destinationRelativePath, root);
		}).then(function()
		{
			currentDirectory = destinationRelativePath;
			if (destinationRelativePath) expanded[destinationRelativePath] = true;
			render();
		}).catch(showError);
	}

	function runFileOperation(item, kind, action)
	{
		if (operationInProgress) return Promise.reject(new Error('文件操作进行中，请稍候'));
		var file = ui.getCurrentFile();
		var current = isCurrentFile(item);
		var root = state?.root;
		var originalPath = currentFilePath();
		var graph = ui.editor.graph;
		var enabled = graph.isEnabled();
		operationInProgress = true;
		workspaceView.classList.add('geWorkspaceBusy');

		return Promise.resolve().then(function()
		{
			if (current)
			{
				if (file.savingFile) throw new Error('当前图纸正在保存，请稍后重试');
				graph.stopEditing(false);
				graph.setEnabled(false);
				file.clearAutosave?.();
				return saveCurrentFile();
			}
		}).then(function()
		{
			if (state?.root !== root || (current && (ui.getCurrentFile() !== file ||
				currentFilePath() !== originalPath))) throw new Error('当前图纸或工作区已切换，请重试');

			if (current && kind !== 'copy' && typeof ui.unwatchPath === 'function')
			{
				return ui.unwatchPath(originalPath);
			}
		}).then(function() { return action(root); }).then(function(result)
		{
			if (current && (kind === 'rename' || kind === 'move'))
			{
				// Rebind the existing document, preserving its graph, view and undo history.
				file.fileObject.path = result.absolutePath;
				file.fileObject.name = result.absolutePath.split(/[\\/]/).pop();
				file.title = file.fileObject.name;
				file.addToRecent?.();
				file.descriptorChanged();
			}
			else if (current && kind === 'trash' && ui.getCurrentFile() === file)
			{
				// Leave no document bound to the removed path, so Save cannot recreate it.
				ui.fileLoaded(new LocalFile(ui, ui.emptyDiagramXml, '未命名图纸.drawio'));
			}

			state = result.state;
			return result;
		}).finally(function()
		{
			operationInProgress = false;
			workspaceView.classList.remove('geWorkspaceBusy');
			if (current && ui.getCurrentFile() === file)
			{
				graph.setEnabled(enabled);
				ui.watchFile?.(file);
			}
			render();
		});
	}

	function closeFileMenu(restoreFocus)
	{
		if (fileMenu?.parentNode) fileMenu.parentNode.removeChild(fileMenu);
		fileMenu = null;
		if (restoreFocus && fileMenuTrigger?.isConnected) fileMenuTrigger.focus();
		fileMenuTrigger = null;
	}

	function showActionDialog(title, content, label, action)
	{
		var dialog = element('form', 'geWorkspaceDialog');
		dialog.appendChild(element('div', 'geWorkspaceDialogTitle', title));
		dialog.appendChild(content);
		var errorLabel = element('div', 'geWorkspaceDialogError');
		errorLabel.setAttribute('role', 'alert');
		dialog.appendChild(errorLabel);
		var actions = element('div', 'geWorkspaceDialogActions');
		var cancel = element('button', 'geWorkspaceFooterButton', '取消');
		var submit = element('button', 'geWorkspaceFooterButton geWorkspacePrimary', label);
		cancel.type = 'button';
		submit.type = 'submit';
		cancel.addEventListener('click', function() { ui.hideDialog(); });
		dialog.addEventListener('submit', function(event)
		{
			event.preventDefault();
			if (submit.disabled) return;
			submit.disabled = cancel.disabled = true;
			errorLabel.textContent = '';
			Promise.resolve().then(action).then(function() { ui.hideDialog(); }).catch(function(error)
			{
				errorLabel.textContent = error?.message || '操作失败';
			}).finally(function() { submit.disabled = cancel.disabled = false; });
		});
		dialog.addEventListener('keydown', function(event)
		{
			// Do not let graph shortcuts consume Enter while editing a file name.
			event.stopPropagation();
			if (event.key === 'Enter' && event.isComposing) event.preventDefault();
			else if (event.key === 'Enter' && event.target.tagName === 'INPUT')
			{
				event.preventDefault();
				dialog.requestSubmit(submit);
			}
			if (event.key === 'Escape' && !submit.disabled) { event.preventDefault(); ui.hideDialog(); }
		});
		actions.appendChild(cancel);
		actions.appendChild(submit);
		dialog.appendChild(actions);
		ui.showDialog(dialog, 340, 210, true, true);
		window.setTimeout(function() { (content.querySelector('input,select') || cancel).focus(); }, 0);
	}

	function renameDiagram(item)
	{
		var content = element('div');
		var input = element('input');
		input.value = item.name;
		input.setAttribute('aria-label', '文件名称');
		content.appendChild(input);
		showActionDialog('重命名图文件', content, '保存', function()
		{
			if (!input.value.trim()) throw new Error('请输入文件名称');
			return runFileOperation(item, 'rename', function(root)
			{
				return api.renameFile(item.relativePath, input.value.trim(), root);
			});
		});
		input.setSelectionRange(0, Math.max(0, item.name.lastIndexOf('.')) || item.name.length);
	}

	function moveDiagramDialog(item)
	{
		var content = element('div');
		content.appendChild(element('p', '', item.name));
		var select = element('select');
		select.setAttribute('aria-label', '目标目录');
		function addDirectory(relativePath, name, children)
		{
			var option = element('option', '', name);
			option.value = relativePath;
			option.disabled = relativePath === parentPath(item.relativePath);
			select.appendChild(option);
			(children || []).forEach(function(child)
			{
				if (child.type === 'directory') addDirectory(child.relativePath, child.relativePath, child.children);
			});
		}
		addDirectory('', '工作区根目录', state?.tree);
		var available = Array.from(select.options).find(function(option) { return !option.disabled; });
		if (!available) return showError(new Error('请先创建其他目录，或直接拖拽到目标目录'));
		select.value = available.value;
		content.appendChild(select);
		showActionDialog('移动图文件', content, '移动', function()
		{
			return runFileOperation(item, 'move', function(root)
			{
				return api.moveFile(item.relativePath, select.value, root);
			}).then(function()
			{
				currentDirectory = select.value;
				expanded[currentDirectory] = true;
				render();
			});
		});
	}

	function trashDiagram(item)
	{
		var content = element('div');
		content.appendChild(element('p', '', '“' + item.name + '”将移到系统废纸篓，可从废纸篓恢复。'));
		if (isCurrentFile(item)) content.appendChild(element('p', '', '当前图纸的未保存修改会先保存。'));
		showActionDialog('删除图文件', content, '移到废纸篓', function()
		{
			return runFileOperation(item, 'trash', function(root) { return api.trashFile(item.relativePath, root); });
		});
	}

	function showFileMenu(item, trigger, x, y)
	{
		if (operationInProgress) return;
		closeFileMenu();
		fileMenuTrigger = trigger;
		fileMenu = element('div', 'geWorkspaceFileMenu');
		fileMenu.setAttribute('role', 'menu');
		fileMenu.setAttribute('aria-label', item.name + ' 文件操作');
		[
			['重命名', function() { renameDiagram(item); }],
			['复制', function()
			{
				return runFileOperation(item, 'copy', function(root)
				{
					return api.copyFile(item.relativePath, parentPath(item.relativePath), root);
				}).catch(showError);
			}],
			['移动到…', function() { moveDiagramDialog(item); }],
			['删除', function() { trashDiagram(item); }]
		].forEach(function(entry)
		{
			var button = element('button', '', entry[0]);
			button.type = 'button';
			button.setAttribute('role', 'menuitem');
			button.addEventListener('click', function() { closeFileMenu(); entry[1](); });
			fileMenu.appendChild(button);
		});
		fileMenu.addEventListener('keydown', function(event)
		{
			event.stopPropagation();
			if (event.key === 'Escape') { event.preventDefault(); closeFileMenu(true); }
			else if (event.key === 'Tab') closeFileMenu();
			else if (event.key === 'ArrowDown' || event.key === 'ArrowUp')
			{
				event.preventDefault();
				var items = Array.from(fileMenu.children);
				var index = items.indexOf(document.activeElement);
				items[(index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
			}
		});
		document.body.appendChild(fileMenu);
		fileMenu.style.left = Math.max(4, Math.min(x, window.innerWidth - fileMenu.offsetWidth - 4)) + 'px';
		fileMenu.style.top = Math.max(4, Math.min(y, window.innerHeight - fileMenu.offsetHeight - 4)) + 'px';
		fileMenu.firstChild.focus();
	}

	function dismissFileMenu(event)
	{
		if (fileMenu && !fileMenu.contains(event.target)) closeFileMenu();
	}
	document.addEventListener('pointerdown', dismissFileMenu, true);

	function dropFile(event, destinationRelativePath, target)
	{
		if (!setDropTarget(event, destinationRelativePath, target)) return;
		var relativePath = draggedRelativePath;
		draggedRelativePath = null;
		clearDragFeedback();
		moveDiagram(relativePath, destinationRelativePath);
	}

	function renderNode(item, depth)
	{
		if (!matchesSearch(item)) return;
		var row = element('button', 'geWorkspaceRow');
		row.type = 'button';
		row.style.paddingLeft = (7 + depth * 13) + 'px';
		row.title = item.relativePath;
		row.setAttribute('data-workspace-path', item.relativePath);

		if (item.type === 'directory')
		{
			var isExpanded = searchQuery !== '' || expanded[item.relativePath] === true;
			var chevron = icon('chevron');
			chevron.classList.add('geWorkspaceChevron');
			if (isExpanded) chevron.classList.add('geWorkspaceExpanded');
			row.appendChild(chevron);
			var folderIcon = icon('folder');
			folderIcon.classList.add('geWorkspaceFolder');
			row.appendChild(folderIcon);
			if (currentDirectory === item.relativePath) row.classList.add('geWorkspaceSelected');
			row.addEventListener('click', function()
			{
				currentDirectory = item.relativePath;
				expanded[item.relativePath] = !isExpanded;
				render();
			});
			row.addEventListener('dragover', function(event)
			{
				setDropTarget(event, item.relativePath, row);
			});
			row.addEventListener('dragleave', function(event)
			{
				clearDropTarget(event, row);
			});
			row.addEventListener('drop', function(event)
			{
				dropFile(event, item.relativePath, row);
			});
		}
		else
		{
			row.appendChild(element('span', 'geWorkspaceIcon'));
			row.appendChild(icon('file'));
			if (isCurrentFile(item)) row.classList.add('geWorkspaceCurrent');
			row.addEventListener('click', function() { openDiagram(item.relativePath); });
			row.draggable = true;
			row.addEventListener('dragstart', function(event)
			{
				if (operationInProgress) { event.preventDefault(); return; }
				closeFileMenu();
				event.stopPropagation();
				draggedRelativePath = item.relativePath;
				event.dataTransfer.effectAllowed = 'move';
				event.dataTransfer.setData('application/x-draw-ai-workspace-file', item.relativePath);
				window.setTimeout(function() { row.classList.add('geWorkspaceDragging'); }, 0);
			});
			row.addEventListener('dragend', function()
			{
				draggedRelativePath = null;
				clearDragFeedback();
			});
		}

		row.appendChild(element('span', 'geWorkspaceRowLabel', item.name));
		if (item.type === 'file')
		{
			var entry = element('div', 'geWorkspaceEntry');
			var more = element('button', 'geWorkspaceIconButton geWorkspaceMore', '⋯');
			more.type = 'button';
			more.title = '文件操作 ' + item.name;
			more.setAttribute('aria-label', more.title);
			more.setAttribute('aria-haspopup', 'menu');
			more.addEventListener('click', function(event)
			{
				event.stopPropagation();
				var bounds = more.getBoundingClientRect();
				showFileMenu(item, more, bounds.left, bounds.bottom);
			});
			row.addEventListener('contextmenu', function(event)
			{
				event.preventDefault();
				event.stopPropagation();
				showFileMenu(item, more, event.clientX, event.clientY);
			});
			entry.appendChild(row);
			entry.appendChild(more);
			tree.appendChild(entry);
		}
		else tree.appendChild(row);

		if (item.type === 'directory' && (searchQuery !== '' || expanded[item.relativePath] === true))
		{
			for (var i = 0; i < item.children.length; i++) renderNode(item.children[i], depth + 1);
		}
	}

	function render()
	{
		tree.textContent = '';

		if (state == null || state.root == null)
		{
			workspaceName.textContent = '图纸工作区';
			workspacePath.textContent = '尚未设置';
			search.classList.add('geWorkspaceHidden');
			footer.classList.add('geWorkspaceHidden');
			var setup = element('div', 'geWorkspaceSetup');
			setup.appendChild(element('strong', '', '设置图纸工作区'));
			var actions = element('div', 'geWorkspaceSetupActions');
			var defaultButton = element('button', 'geWorkspaceFooterButton geWorkspacePrimary', '默认目录');
			var chooseButton = element('button', 'geWorkspaceFooterButton', '选择目录');
			defaultButton.type = chooseButton.type = 'button';
			defaultButton.addEventListener('click', function()
			{
				api.useDefaultRoot().then(function(next) { state = next; render(); }).catch(showError);
			});
			chooseButton.addEventListener('click', chooseWorkspace);
			actions.appendChild(defaultButton);
			actions.appendChild(chooseButton);
			setup.appendChild(actions);
			tree.appendChild(setup);
			return;
		}

		search.classList.remove('geWorkspaceHidden');
		footer.classList.remove('geWorkspaceHidden');
		workspaceName.textContent = state.name || '图纸工作区';
		workspacePath.textContent = state.root;
		workspacePath.title = state.root;
		var items = state.tree || [];
		for (var i = 0; i < items.length; i++) renderNode(items[i], 0);

		if (tree.childNodes.length === 0)
		{
			tree.appendChild(element('div', 'geWorkspaceEmpty', searchQuery ? '没有匹配的图纸' : '工作区暂无图纸'));
		}

		footerStatus.textContent = (state.counts?.files || 0) + ' 个图文件';
	}

	function showError(error)
	{
		ui.handleError({message: error?.message || String(error || '操作失败')});
	}

	function loadState()
	{
		return api.getState().then(function(next)
		{
			state = next;
			if (currentDirectory && !findDirectory(state.tree || [], currentDirectory)) currentDirectory = '';
			render();
			return next;
		}).catch(showError);
	}

	function findDirectory(items, relativePath)
	{
		for (var i = 0; i < items.length; i++)
		{
			if (items[i].type !== 'directory') continue;
			if (items[i].relativePath === relativePath) return items[i];
			var found = findDirectory(items[i].children || [], relativePath);
			if (found) return found;
		}
		return null;
	}

	function chooseWorkspace()
	{
		if (operationInProgress) return;
		api.chooseRoot().then(function(next)
		{
			if (next != null)
			{
				state = next;
				currentDirectory = '';
				render();
			}
		}).catch(showError);
	}

	function saveCurrentFile()
	{
		return new Promise(function(resolve, reject)
		{
			var file = ui.getCurrentFile();

			if (file == null || !file.isModified())
			{
				resolve();
				return;
			}

			file.save(false, resolve, function(error)
			{
				reject(new Error(error?.message || '当前图纸保存失败'));
			}, false, false);
		});
	}

	function loadResolvedDiagram(resolved)
	{
		saveCurrentFile().then(function()
		{
			ui.loadArgs({args: [resolved.absolutePath]});
		}).catch(showError);
	}

	function openDiagram(relativePath)
	{
		if (operationInProgress) return;
		api.resolveItem(relativePath).then(function(resolved)
		{
			var current = ui.getCurrentFile();

			if (current != null && current.isModified())
			{
				ui.confirm('当前图纸有未保存修改，保存后打开其他图纸？', null,
					function() { loadResolvedDiagram(resolved); }, '取消', '保存并打开');
			}
			else loadResolvedDiagram(resolved);
		}).catch(showError);
	}

	function showNameDialog(kind)
	{
		var dialog = element('div', 'geWorkspaceDialog');
		dialog.appendChild(element('div', 'geWorkspaceDialogTitle',
			kind === 'directory' ? '新建目录' : '新建图文件'));
		var input = element('input');
		input.placeholder = kind === 'directory' ? '目录名称' : '图文件名称';
		input.maxLength = 120;
		dialog.appendChild(input);
		var actions = element('div', 'geWorkspaceDialogActions');
		var cancel = element('button', 'geWorkspaceFooterButton', '取消');
		var submit = element('button', 'geWorkspaceFooterButton geWorkspacePrimary', '创建');
		cancel.type = submit.type = 'button';
		cancel.addEventListener('click', function() { ui.hideDialog(); });

		function create()
		{
			var name = input.value.trim();
			if (!name) return;
			var action = kind === 'directory' ? api.createDirectory(currentDirectory, name) :
				api.createDiagram(currentDirectory, name);
			action.then(function(result)
			{
				state = result.state;
				ui.hideDialog();
				render();
				if (kind === 'diagram') openDiagram(result.createdRelativePath);
			}).catch(showError);
		}

		submit.addEventListener('click', create);
		input.addEventListener('keydown', function(event)
		{
			if (event.key === 'Enter') create();
		});
		actions.appendChild(cancel);
		actions.appendChild(submit);
		dialog.appendChild(actions);
		ui.showDialog(dialog, 320, 150, true, true);
		window.setTimeout(function() { input.focus(); }, 0);
	}

	function showMode(mode)
	{
		var workspaceMode = mode === 'workspace';
		workspaceView.classList.toggle('geWorkspaceHidden', !workspaceMode);
		shapeView.classList.toggle('geWorkspaceHidden', workspaceMode);
		workspaceTab.classList.toggle('geWorkspaceActive', workspaceMode);
		shapesTab.classList.toggle('geWorkspaceActive', !workspaceMode);
		try { localStorage.setItem('.drawAiLeftPanelMode', mode); } catch (error) {}
		if (workspaceMode) loadState();
	}

	workspaceTab.addEventListener('click', function() { showMode('workspace'); });
	shapesTab.addEventListener('click', function() { showMode('shapes'); });
	identity.addEventListener('click', chooseWorkspace);
	identity.title = '切换工作区；可将文件拖到这里移动到根目录';
	identity.addEventListener('dragover', function(event)
	{
		setDropTarget(event, '', identity);
	});
	identity.addEventListener('dragleave', function(event)
	{
		clearDropTarget(event, identity);
	});
	identity.addEventListener('drop', function(event)
	{
		dropFile(event, '', identity);
	});
	refreshButton.addEventListener('click', loadState);
	managerButton.addEventListener('click', function() { api.showManager().catch(showError); });
	newFolderButton.addEventListener('click', function() { showNameDialog('directory'); });
	newFileButton.addEventListener('click', function() { showNameDialog('diagram'); });
	searchInput.addEventListener('input', function()
	{
		searchQuery = searchInput.value.trim().toLowerCase();
		render();
	});
	tree.addEventListener('dragover', function(event)
	{
		if (event.target !== tree) return;
		setDropTarget(event, '', tree);
	});
	tree.addEventListener('dragleave', function(event)
	{
		clearDropTarget(event, tree);
	});
	tree.addEventListener('drop', function(event)
	{
		if (event.target !== tree) return;
		dropFile(event, '', tree);
	});
	graphModelListener = function() { render(); };
	ui.editor.graph.getModel().addListener(mxEvent.CHANGE, graphModelListener);
	removeWorkspaceChangedListener = api.onChanged(loadState);

	var initialMode = 'workspace';
	try { initialMode = localStorage.getItem('.drawAiLeftPanelMode') || 'workspace'; } catch (error) {}
	showMode(initialMode === 'shapes' ? 'shapes' : 'workspace');

	ui.destroyFunctions.push(function()
	{
		closeFileMenu();
		document.removeEventListener('pointerdown', dismissFileMenu, true);
		if (graphModelListener != null)
		{
			ui.editor.graph.getModel().removeListener(graphModelListener);
		}

		if (typeof removeWorkspaceChangedListener === 'function')
		{
			removeWorkspaceChangedListener();
		}

		delete ui.__drawAiWorkspaceExplorerInstalled;
		if (css.parentNode != null) css.parentNode.removeChild(css);
	});
});
