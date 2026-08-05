const previewParameters = new URLSearchParams(window.location.search);
const previewMode = previewParameters.get('preview') === '1';
const previewTemplateScenario = previewParameters.get('template');

function previewApi()
{
	let state = {
		root: '/Users/tangf/Documents/draw.ai Workspace',
		name: '我的图纸',
		counts: {directories: 4, files: 3},
		template: ['outdated', 'conflict'].includes(previewTemplateScenario) ? {
			configured: true,
			invalid: false,
			modifiedAt: Date.now() - 7200000,
			size: 4210,
			source: {
				tracked: true,
				status: previewTemplateScenario === 'conflict' ? 'conflict' : 'source-updated',
				name: '团队模板.drawio',
				displayPath: '公共模板/团队模板.drawio',
				portable: true,
				modifiedAt: Date.now() - 600000,
				canUpdate: true,
				error: null
			}
		} : {configured: false, invalid: false, modifiedAt: null, size: 0},
		tree: [
			{type: 'directory', name: '业务系统', relativePath: '业务系统', modifiedAt: Date.now(), children: [
				{type: 'directory', name: '生产环境', relativePath: '业务系统/生产环境', modifiedAt: Date.now() - 3600000, children: []},
				{type: 'file', name: '统一认证架构.drawio', relativePath: '业务系统/统一认证架构.drawio', extension: 'drawio', modifiedAt: Date.now() - 1800000, size: 4210}
			]},
			{type: 'directory', name: '产品方案', relativePath: '产品方案', modifiedAt: Date.now() - 86400000, children: [
				{type: 'file', name: '产品路线图.drawio', relativePath: '产品方案/产品路线图.drawio', extension: 'drawio', modifiedAt: Date.now() - 86400000, size: 3030}
			]},
			{type: 'directory', name: '公共模板', relativePath: '公共模板', modifiedAt: Date.now() - 172800000, children: []},
			{type: 'file', name: '远程监察系统.drawio', relativePath: '远程监察系统.drawio', extension: 'drawio', modifiedAt: Date.now() - 7200000, size: 8290}
		]
	};

	const recalculate = () =>
	{
		const count = (nodes) => nodes.reduce((result, node) =>
		{
			if (node.type === 'directory')
			{
				result.directories++;
				const nested = count(node.children);
				result.directories += nested.directories;
				result.files += nested.files;
			}
			else result.files++;
			return result;
		}, {directories: 0, files: 0});
		state.counts = count(state.tree);
	};

	const childrenAt = (relativePath) =>
	{
		if (!relativePath) return state.tree;
		const parts = relativePath.split('/');
		let nodes = state.tree;
		let found = null;

		for (const part of parts)
		{
			found = nodes.find(node => node.type === 'directory' && node.name === part);
			if (!found) return null;
			nodes = found.children;
		}

		return nodes;
	};

	const findParent = (relativePath) =>
	{
		const parts = relativePath.split('/');
		const name = parts.pop();
		return {nodes: childrenAt(parts.join('/')), name: name};
	};

	const nextCopyName = (nodes, fileName) =>
	{
		const extensionIndex = fileName.lastIndexOf('.');
		const extension = extensionIndex > 0 ? fileName.slice(extensionIndex) : '';
		const base = extension ? fileName.slice(0, extensionIndex) : fileName;
		const candidates = [fileName, `${base} - 副本${extension}`];
		let counter = 2;

		while (true)
		{
			const candidate = candidates.shift() || `${base} - 副本 (${counter++})${extension}`;
			if (!nodes.some(node => node.name === candidate)) return candidate;
		}
	};

	return {
		getState: async () => structuredClone(state),
		checkTemplate: async () => structuredClone(state),
		chooseRoot: async () => structuredClone(state),
		useDefaultRoot: async () => structuredClone(state),
		createDirectory: async (parent, name) =>
		{
			const nodes = childrenAt(parent);
			const relativePath = [parent, name.trim()].filter(Boolean).join('/');
			nodes.push({type: 'directory', name: name.trim(), relativePath: relativePath, modifiedAt: Date.now(), children: []});
			recalculate();
			return {state: structuredClone(state), createdRelativePath: relativePath};
		},
		createDiagram: async (parent, name) =>
		{
			const nodes = childrenAt(parent);
			const fileName = name.toLowerCase().endsWith('.drawio') ? name.trim() : `${name.trim()}.drawio`;
			const relativePath = [parent, fileName].filter(Boolean).join('/');
			nodes.push({type: 'file', name: fileName, relativePath: relativePath, extension: 'drawio', modifiedAt: Date.now(), size: 1220});
			recalculate();
			return {state: structuredClone(state), createdRelativePath: relativePath};
		},
		renameItem: async (relativePath, name) =>
		{
			const parent = findParent(relativePath);
			const item = parent.nodes.find(node => node.name === parent.name);
			const nextName = item.type === 'file' && !name.includes('.') ? `${name}.drawio` : name;
			item.name = nextName;
			item.relativePath = [...relativePath.split('/').slice(0, -1), nextName].join('/');
			return {state: structuredClone(state), renamedRelativePath: item.relativePath};
		},
		moveFile: async (relativePath, destinationRelativePath) =>
		{
			const source = findParent(relativePath);
			const sourceIndex = source.nodes.findIndex(node => node.name === source.name && node.type === 'file');
			const destinationNodes = childrenAt(destinationRelativePath);

			if (source.nodes === destinationNodes) throw new Error('文件已经在所选目录中');
			if (destinationNodes.some(node => node.name === source.name)) throw new Error('目标目录中已有同名文件');

			const [item] = source.nodes.splice(sourceIndex, 1);
			item.relativePath = [destinationRelativePath, item.name].filter(Boolean).join('/');
			item.modifiedAt = Date.now();
			destinationNodes.push(item);
			recalculate();
			return {state: structuredClone(state), movedRelativePath: item.relativePath};
		},
		copyFile: async (relativePath, destinationRelativePath) =>
		{
			const source = findParent(relativePath);
			const item = source.nodes.find(node => node.name === source.name && node.type === 'file');
			const destinationNodes = childrenAt(destinationRelativePath);
			const copy = structuredClone(item);
			copy.name = nextCopyName(destinationNodes, item.name);
			copy.relativePath = [destinationRelativePath, copy.name].filter(Boolean).join('/');
			copy.modifiedAt = Date.now();
			destinationNodes.push(copy);
			recalculate();
			return {state: structuredClone(state), copiedRelativePath: copy.relativePath};
		},
		trashItem: async (relativePath) =>
		{
			const parent = findParent(relativePath);
			parent.nodes.splice(parent.nodes.findIndex(node => node.name === parent.name), 1);
			recalculate();
			return structuredClone(state);
		},
		openItem: async () => true,
		revealItem: async () => true,
		importFiles: async () => null,
		editTemplate: async () =>
		{
			state.template = {
				configured: true,
				invalid: false,
				modifiedAt: Date.now(),
				size: 620,
				source: state.template.source?.tracked ?
					{...state.template.source, status: 'template-modified', canUpdate: false} :
					{tracked: false, status: 'untracked', canUpdate: false}
			};
			return structuredClone(state);
		},
		importTemplate: async () =>
		{
			state.template = {
				configured: true,
				invalid: false,
				modifiedAt: Date.now(),
				size: 4210,
				source: {
					tracked: true,
					status: 'current',
					name: '团队模板.drawio',
					displayPath: '公共模板/团队模板.drawio',
					portable: true,
					modifiedAt: Date.now(),
					canUpdate: false,
					error: null
				}
			};
			return structuredClone(state);
		},
		updateTemplate: async () =>
		{
			state.template.modifiedAt = Date.now();
			state.template.source = {...state.template.source, status: 'current', canUpdate: false};
			return structuredClone(state);
		},
		removeTemplate: async () =>
		{
			state.template = {configured: false, invalid: false, modifiedAt: null, size: 0};
			return structuredClone(state);
		},
		onChanged: () => () => {}
	};
}

const api = window.workspaceAPI || (previewMode ? previewApi() : null);
const elements = {
	setupView: document.getElementById('setup-view'),
	managerView: document.getElementById('manager-view'),
	setupMessage: document.getElementById('setup-message'),
	workspaceName: document.getElementById('workspace-name'),
	workspacePath: document.getElementById('workspace-path'),
	directoryTree: document.getElementById('directory-tree'),
	directoryTitle: document.getElementById('directory-title'),
	breadcrumb: document.getElementById('breadcrumb'),
	fileList: document.getElementById('file-list'),
	emptyState: document.getElementById('empty-state'),
	emptyTitle: document.getElementById('empty-title'),
	itemCount: document.getElementById('item-count'),
	searchInput: document.getElementById('search-input'),
	refreshButton: document.getElementById('refresh-button'),
	workspaceSwitch: document.getElementById('workspace-switch'),
	defaultRootButton: document.getElementById('default-root-button'),
	chooseRootButton: document.getElementById('choose-root-button'),
	newDiagramButton: document.getElementById('new-diagram-button'),
	newFolderButton: document.getElementById('new-folder-button'),
	importButton: document.getElementById('import-button'),
	templateButton: document.getElementById('template-button'),
	templateIndicator: document.getElementById('template-indicator'),
	templateDialog: document.getElementById('template-dialog'),
	templateStatusTitle: document.getElementById('template-status-title'),
	templateStatusDetail: document.getElementById('template-status-detail'),
	templateStatusBadge: document.getElementById('template-status-badge'),
	updateTemplateButton: document.getElementById('update-template-button'),
	editTemplateButton: document.getElementById('edit-template-button'),
	importTemplateButton: document.getElementById('import-template-button'),
	removeTemplateButton: document.getElementById('remove-template-button'),
	transferDialog: document.getElementById('transfer-dialog'),
	transferForm: document.getElementById('transfer-form'),
	transferDialogTitle: document.getElementById('transfer-dialog-title'),
	transferFileName: document.getElementById('transfer-file-name'),
	transferDestination: document.getElementById('transfer-destination'),
	transferError: document.getElementById('transfer-error'),
	transferSubmit: document.getElementById('transfer-submit'),
	nameDialog: document.getElementById('name-dialog'),
	nameForm: document.getElementById('name-form'),
	nameDialogTitle: document.getElementById('name-dialog-title'),
	nameInput: document.getElementById('name-input'),
	nameError: document.getElementById('name-error'),
	nameSubmit: document.getElementById('name-submit'),
	confirmDialog: document.getElementById('confirm-dialog'),
	confirmForm: document.getElementById('confirm-form'),
	confirmTitle: document.getElementById('confirm-title'),
	confirmMessage: document.getElementById('confirm-message'),
	confirmSubmit: document.getElementById('confirm-submit'),
	toast: document.getElementById('toast')
};

let workspaceState = null;
let currentDirectory = '';
let searchQuery = '';
let nameDialogMode = null;
let transferMode = null;
let activeItem = null;
let confirmMode = 'item';
let toastTimer = null;
let refreshTimer = null;
const openingItems = new Set();

function svgIcon(name, className = '')
{
	const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('class', `icon ${className}`.trim());
	svg.setAttribute('aria-hidden', 'true');
	const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
	use.setAttribute('href', `#icon-${name}`);
	svg.appendChild(use);
	return svg;
}

function showToast(message, isError = false)
{
	if (toastTimer != null) clearTimeout(toastTimer);
	elements.toast.textContent = message;
	elements.toast.classList.toggle('is-error', isError);
	elements.toast.hidden = false;
	toastTimer = setTimeout(() => { elements.toast.hidden = true; }, 2600);
}

function setBusy(isBusy)
{
	elements.refreshButton.classList.toggle('is-loading', isBusy);
	for (const button of [elements.workspaceSwitch, elements.defaultRootButton, elements.chooseRootButton,
		elements.newDiagramButton, elements.newFolderButton, elements.importButton, elements.templateButton,
		elements.updateTemplateButton, elements.editTemplateButton, elements.importTemplateButton, elements.removeTemplateButton,
		elements.transferSubmit])
	{
		button.disabled = isBusy;
	}

	elements.refreshButton.disabled = isBusy || !workspaceState?.root;
}

async function runAction(action, successMessage)
{
	setBusy(true);

	try
	{
		const result = await action();
		if (successMessage && result != null) showToast(successMessage);
		return result;
	}
	catch (error)
	{
		showToast(error.message || '操作失败', true);
		return undefined;
	}
	finally
	{
		setBusy(false);
	}
}

function findNode(relativePath, nodes = workspaceState?.tree || [])
{
	for (const node of nodes)
	{
		if (node.relativePath === relativePath) return node;
		if (node.type === 'directory')
		{
			const nested = findNode(relativePath, node.children);
			if (nested) return nested;
		}
	}

	return null;
}

function flattenNodes(nodes, output = [])
{
	for (const node of nodes)
	{
		output.push(node);
		if (node.type === 'directory') flattenNodes(node.children, output);
	}

	return output;
}

function workspaceDirectories()
{
	return [
		{name: '全部图纸', relativePath: ''},
		...flattenNodes(workspaceState?.tree || []).filter(node => node.type === 'directory')
	];
}

function parentDirectory(relativePath)
{
	return relativePath.split('/').slice(0, -1).join('/');
}

function currentNodes()
{
	if (searchQuery)
	{
		const query = searchQuery.toLocaleLowerCase();
		return flattenNodes(workspaceState.tree).filter(node => node.name.toLocaleLowerCase().includes(query));
	}

	if (!currentDirectory) return workspaceState.tree;
	return findNode(currentDirectory)?.children || [];
}

function formatModified(timestamp)
{
	const date = new Date(timestamp);
	const now = new Date();
	const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
	const time = date.toLocaleTimeString('zh-CN', {hour: '2-digit', minute: '2-digit', hour12: false});

	if (startOfDate === startOfToday) return `今天 ${time}`;
	if (startOfDate === startOfToday - 86400000) return `昨天 ${time}`;
	return date.toLocaleDateString('zh-CN', {month: 'short', day: 'numeric'});
}

function itemType(node)
{
	if (node.type === 'directory') return '目录';
	if (node.extension === 'drawio' || node.extension === 'dio') return 'draw.ai 图纸';
	if (node.extension === 'mmd' || node.extension === 'mermaid') return 'Mermaid 图纸';
	return `${node.extension.toUpperCase()} 文件`;
}

function updatePathCopy()
{
	const parts = currentDirectory ? currentDirectory.split('/') : [];
	elements.directoryTitle.textContent = searchQuery ? '搜索结果' : (parts.at(-1) || '全部图纸');
	elements.breadcrumb.textContent = [workspaceState.name, ...(parts.length ? parts : ['全部图纸'])].join(' / ');
}

function selectDirectory(relativePath)
{
	currentDirectory = relativePath;
	searchQuery = '';
	elements.searchInput.value = '';
	render();
}

function createTreeRow(node, depth)
{
	const wrapper = document.createElement('div');
	wrapper.className = 'tree-row-wrap';
	const button = document.createElement('button');
	button.type = 'button';
	button.className = `tree-row${currentDirectory === node.relativePath && !searchQuery ? ' is-active' : ''}`;
	button.style.paddingLeft = `${9 + depth * 18}px`;
	button.dataset.path = node.relativePath;
	button.title = node.name;
	button.setAttribute('data-testid', `tree-${node.relativePath || 'root'}`);

	if (node.relativePath && node.children?.length)
	{
		button.appendChild(svgIcon('chevron-down', 'tree-chevron'));
	}
	else
	{
		const spacer = document.createElement('span');
		spacer.className = 'tree-spacer';
		button.appendChild(spacer);
	}

	button.appendChild(svgIcon('folder', 'folder-icon'));
	const label = document.createElement('span');
	label.className = 'tree-label';
	label.textContent = node.name;
	button.appendChild(label);
	button.addEventListener('click', () => selectDirectory(node.relativePath));
	wrapper.appendChild(button);

	for (const child of node.children || [])
	{
		if (child.type === 'directory') wrapper.appendChild(createTreeRow(child, depth + 1));
	}

	return wrapper;
}

function renderTree()
{
	elements.directoryTree.replaceChildren();
	const rootNode = {name: '全部图纸', relativePath: '', children: []};
	elements.directoryTree.appendChild(createTreeRow(rootNode, 0));

	for (const node of workspaceState.tree)
	{
		if (node.type === 'directory') elements.directoryTree.appendChild(createTreeRow(node, 0));
	}
}

function actionButton(icon, title, action, isDanger = false)
{
	const button = document.createElement('button');
	button.type = 'button';
	button.className = `row-action${isDanger ? ' is-danger' : ''}`;
	button.title = title;
	button.setAttribute('aria-label', title);
	button.appendChild(svgIcon(icon));
	button.addEventListener('click', (event) =>
	{
		event.stopPropagation();
		action();
	});
	return button;
}

function openItem(node)
{
	if (node.type === 'directory')
	{
		selectDirectory(node.relativePath);
		return;
	}

	if (openingItems.has(node.relativePath)) return;
	openingItems.add(node.relativePath);

	runAction(() => api.openItem(node.relativePath)).finally(() =>
	{
		setTimeout(() => openingItems.delete(node.relativePath), 600);
	});
}

function createFileRow(node)
{
	const row = document.createElement('tr');
	row.className = 'file-row';
	row.dataset.path = node.relativePath;
	row.setAttribute('data-testid', `file-row-${node.relativePath}`);

	const nameCell = document.createElement('td');
	const nameButton = document.createElement('button');
	nameButton.type = 'button';
	nameButton.className = 'file-name-button';
	nameButton.title = node.name;
	nameButton.addEventListener('click', () => openItem(node));

	if (node.type === 'directory')
	{
		nameButton.appendChild(svgIcon('folder', 'folder-row-icon'));
	}
	else
	{
		const fileIcon = document.createElement('span');
		fileIcon.className = 'file-type-icon';
		fileIcon.textContent = node.extension === 'drawio' ? 'DRAW' : node.extension.slice(0, 4).toUpperCase();
		nameButton.appendChild(fileIcon);
	}

	const name = document.createElement('span');
	name.textContent = node.name;
	nameButton.appendChild(name);
	nameCell.appendChild(nameButton);

	const typeCell = document.createElement('td');
	typeCell.className = 'muted-cell';
	typeCell.textContent = itemType(node);

	const dateCell = document.createElement('td');
	dateCell.className = 'muted-cell';
	dateCell.textContent = formatModified(node.modifiedAt);

	const actionsCell = document.createElement('td');
	const actions = document.createElement('div');
	actions.className = 'row-actions';
	if (node.type === 'file')
	{
		actions.appendChild(actionButton('move', `移动 ${node.name}`, () => openTransferDialog('move', node)));
		actions.appendChild(actionButton('copy', `复制 ${node.name}`, () => openTransferDialog('copy', node)));
	}
	actions.appendChild(actionButton('pencil', `重命名 ${node.name}`, () => openNameDialog('rename', node)));
	actions.appendChild(actionButton('reveal', `在文件管理器中显示 ${node.name}`, () => runAction(() => api.revealItem(node.relativePath))));
	actions.appendChild(actionButton('trash', `删除 ${node.name}`, () => openTrashDialog(node), true));
	actionsCell.appendChild(actions);

	row.append(nameCell, typeCell, dateCell, actionsCell);
	return row;
}

function renderFileList()
{
	const nodes = currentNodes();
	elements.fileList.replaceChildren(...nodes.map(createFileRow));
	elements.emptyState.hidden = nodes.length !== 0;
	elements.emptyTitle.textContent = searchQuery ? '没有匹配结果' : '当前目录为空';

	const directories = nodes.filter(node => node.type === 'directory').length;
	const files = nodes.length - directories;
	elements.itemCount.textContent = `${directories} 个目录，${files} 个图文件`;
}

function renderTemplateState()
{
	const template = workspaceState?.template || {configured: false, invalid: false};
	const source = template.source;
	const statusClasses = ['is-current', 'is-update', 'is-modified', 'is-conflict'];
	const sourcePath = source?.displayPath ? source.displayPath.split('/').join(' / ') : source?.name;
	const sourceLabel = sourcePath ? `${sourcePath}${source?.portable === false ? '（本机来源）' : ''}` : null;
	let statusClass = null;
	let statusLabel = null;
	let buttonTitle = '模板设置';

	elements.templateIndicator.classList.remove(...statusClasses);
	elements.templateStatusBadge.classList.remove(...statusClasses);
	elements.templateIndicator.hidden = true;
	elements.templateStatusBadge.hidden = true;
	elements.updateTemplateButton.hidden = true;

	if (template.invalid)
	{
		elements.templateStatusTitle.textContent = '模板不可用';
		elements.templateStatusDetail.textContent = template.error || '请重新导入或移除模板';
	}
	else if (template.configured)
	{
		if (source?.status === 'current')
		{
			elements.templateStatusTitle.textContent = '自定义模板';
			elements.templateStatusDetail.textContent = `来源：${sourceLabel}`;
			statusClass = 'is-current';
			statusLabel = '最新';
			buttonTitle = '模板：已是最新';
		}
		else if (source?.status === 'source-updated')
		{
			elements.templateStatusTitle.textContent = '源模板有更新';
			elements.templateStatusDetail.textContent = `来源：${sourceLabel} · ${formatModified(source.modifiedAt)}`;
			statusClass = 'is-update';
			statusLabel = '可更新';
			buttonTitle = '模板：源文件有更新';
			elements.updateTemplateButton.hidden = false;
			elements.updateTemplateButton.querySelector('span').textContent = '更新模板';
		}
		else if (source?.status === 'template-modified')
		{
			elements.templateStatusTitle.textContent = '当前模板已修改';
			elements.templateStatusDetail.textContent = `与来源 ${sourceLabel} 内容不同`;
			statusClass = 'is-modified';
			statusLabel = '已修改';
			buttonTitle = '模板：当前模板已单独修改';
		}
		else if (source?.status === 'conflict')
		{
			elements.templateStatusTitle.textContent = '模板存在冲突';
			elements.templateStatusDetail.textContent = `当前模板和来源 ${sourceLabel} 都有修改`;
			statusClass = 'is-conflict';
			statusLabel = '需确认';
			buttonTitle = '模板：当前模板和源文件都有修改';
			elements.updateTemplateButton.hidden = false;
			elements.updateTemplateButton.querySelector('span').textContent = '使用源文件';
		}
		else if (source?.status === 'unavailable')
		{
			elements.templateStatusTitle.textContent = '模板来源不可用';
			elements.templateStatusDetail.textContent = sourceLabel ?
				`${source.error || '无法检查来源'}：${sourceLabel}` : (source.error || '无法检查导入来源');
			statusLabel = '不可用';
			buttonTitle = '模板：导入来源不可用';
			elements.templateIndicator.hidden = false;
		}
		else
		{
			elements.templateStatusTitle.textContent = '自定义模板';
			elements.templateStatusDetail.textContent = template.modifiedAt ?
				`未关联导入来源 · 更新于 ${formatModified(template.modifiedAt)}` : '未关联导入来源';
		}
	}
	else
	{
		elements.templateStatusTitle.textContent = '空白模板';
		elements.templateStatusDetail.textContent = 'Grid 与 Page View 关闭';
	}

	if (statusClass)
	{
		elements.templateIndicator.hidden = false;
		elements.templateIndicator.classList.add(statusClass);
		elements.templateStatusBadge.classList.add(statusClass);
	}

	if (statusLabel)
	{
		elements.templateStatusBadge.textContent = statusLabel;
		elements.templateStatusBadge.hidden = false;
	}

	elements.templateButton.title = buttonTitle;
	elements.templateButton.setAttribute('aria-label', buttonTitle);
	elements.editTemplateButton.classList.toggle('primary-button', elements.updateTemplateButton.hidden);
	elements.editTemplateButton.classList.toggle('secondary-button', !elements.updateTemplateButton.hidden);
	elements.editTemplateButton.disabled = Boolean(template.invalid);
	elements.editTemplateButton.querySelector('span').textContent = template.configured ? '编辑模板' : '创建模板';
	elements.removeTemplateButton.hidden = !template.configured;
}

function render()
{
	const hasWorkspace = Boolean(workspaceState?.root);
	elements.setupView.hidden = hasWorkspace;
	elements.managerView.hidden = !hasWorkspace;
	elements.workspaceName.textContent = workspaceState?.name || '图纸工作区';
	elements.workspacePath.textContent = workspaceState?.root || workspaceState?.unavailableRoot || '尚未设置';
	elements.refreshButton.disabled = !hasWorkspace;

	if (!hasWorkspace)
	{
		elements.directoryTree.replaceChildren();
		elements.setupMessage.textContent = workspaceState?.unavailableRoot ?
			`原工作区不可用：${workspaceState.unavailableRoot}` : '选择一个目录作为统一的图纸存放位置。';
		return;
	}

	if (currentDirectory && !findNode(currentDirectory)) currentDirectory = '';
	updatePathCopy();
	renderTree();
	renderFileList();
	renderTemplateState();
}

async function refreshState(silent = false)
{
	const nextState = await runAction(() => api.getState());

	if (nextState)
	{
		workspaceState = nextState;
		render();
		if (!silent) showToast('工作区已刷新');
	}
}

function openNameDialog(mode, item = null)
{
	nameDialogMode = mode;
	activeItem = item;
	elements.nameError.textContent = '';
	elements.nameInput.value = mode === 'rename' ? item.name : '';
	elements.nameInput.placeholder = mode === 'diagram' ? '例如：系统架构' : '例如：业务系统';
	elements.nameDialogTitle.textContent = mode === 'folder' ? '新建目录' : (mode === 'diagram' ? '新建图文件' : '重命名');
	elements.nameSubmit.textContent = mode === 'rename' ? '保存' : '创建';
	elements.nameDialog.showModal();
	requestAnimationFrame(() =>
	{
		elements.nameInput.focus();
		elements.nameInput.select();
	});
}

function openTransferDialog(mode, item)
{
	transferMode = mode;
	activeItem = item;
	elements.transferDialogTitle.textContent = mode === 'move' ? '移动图文件' : '复制图文件';
	elements.transferFileName.textContent = item.name;
	elements.transferSubmit.textContent = mode === 'move' ? '移动' : '复制';
	elements.transferError.textContent = '';
	const sourceParent = parentDirectory(item.relativePath);
	const options = workspaceDirectories().map(directory =>
	{
		const option = document.createElement('option');
		option.value = directory.relativePath;
		option.textContent = directory.relativePath ? directory.relativePath.split('/').join(' / ') : '全部图纸';
		option.disabled = mode === 'move' && directory.relativePath === sourceParent;
		return option;
	});
	elements.transferDestination.replaceChildren(...options);

	const preferred = mode === 'copy' ? sourceParent : currentDirectory;
	const selected = options.find(option => option.value === preferred && !option.disabled) ||
		options.find(option => !option.disabled);
	elements.transferSubmit.disabled = selected == null;

	if (selected)
	{
		elements.transferDestination.value = selected.value;
	}
	else
	{
		elements.transferError.textContent = '请先创建其他目录';
	}

	elements.transferDialog.showModal();
	requestAnimationFrame(() => elements.transferDestination.focus());
}

function openTrashDialog(item)
{
	confirmMode = 'item';
	activeItem = item;
	elements.confirmTitle.textContent = '移到废纸篓';
	elements.confirmMessage.textContent = `“${item.name}”将移到系统废纸篓，可以从废纸篓恢复。`;
	elements.confirmSubmit.textContent = '移到废纸篓';
	elements.confirmDialog.showModal();
}

function openTemplateRemoveDialog()
{
	confirmMode = 'template';
	activeItem = null;
	elements.confirmTitle.textContent = '移除默认模板';
	elements.confirmMessage.textContent = '默认模板将移到系统废纸篓，后续新建图文件恢复使用空白模板。';
	elements.confirmSubmit.textContent = '移除模板';
	elements.confirmDialog.showModal();
}

function openTemplateUpdateDialog()
{
	confirmMode = 'template-update';
	activeItem = null;
	elements.confirmTitle.textContent = '使用源文件覆盖模板';
	elements.confirmMessage.textContent = '当前模板和导入来源都已修改。继续后，当前模板的单独修改将被源文件覆盖。';
	elements.confirmSubmit.textContent = '使用源文件';
	elements.confirmDialog.showModal();
}

async function applyTemplateUpdate(force = false)
{
	const state = await runAction(() => api.updateTemplate(force), '模板已更新');

	if (!state) return false;
	workspaceState = state;
	render();
	return true;
}

elements.nameForm.addEventListener('submit', async (event) =>
{
	if (event.submitter?.value === 'cancel') return;
	event.preventDefault();
	const name = elements.nameInput.value.trim();

	if (!name)
	{
		elements.nameError.textContent = '请输入名称';
		return;
	}

	let result;

	if (nameDialogMode === 'folder')
	{
		result = await runAction(() => api.createDirectory(currentDirectory, name), '目录已创建');
	}
	else if (nameDialogMode === 'diagram')
	{
		result = await runAction(() => api.createDiagram(currentDirectory, name), '图文件已创建');
	}
	else
	{
		result = await runAction(() => api.renameItem(activeItem.relativePath, name), '名称已更新');
	}

	if (!result) return;
	workspaceState = result.state;

	if (nameDialogMode === 'folder' || nameDialogMode === 'diagram')
	{
		searchQuery = '';
		elements.searchInput.value = '';
	}

	elements.nameDialog.close();
	render();

	if (nameDialogMode === 'diagram' && result.createdRelativePath)
	{
		await runAction(() => api.openItem(result.createdRelativePath));
	}
});

elements.confirmForm.addEventListener('submit', async (event) =>
{
	if (event.submitter?.value === 'cancel') return;
	event.preventDefault();

	if (confirmMode === 'template')
	{
		const state = await runAction(() => api.removeTemplate(), '模板已移除');

		if (!state) return;
		workspaceState = state;
		elements.confirmDialog.close();
		render();
		return;
	}

	if (confirmMode === 'template-update')
	{
		if (!await applyTemplateUpdate(true)) return;
		elements.confirmDialog.close();
		return;
	}

	const removedPath = activeItem.relativePath;
	const nextState = await runAction(() => api.trashItem(removedPath), '已移到废纸篓');

	if (!nextState) return;
	workspaceState = nextState;
	if (currentDirectory === removedPath || currentDirectory.startsWith(`${removedPath}/`)) currentDirectory = '';
	elements.confirmDialog.close();
	render();
});

elements.transferForm.addEventListener('submit', async (event) =>
{
	if (event.submitter?.value === 'cancel') return;
	event.preventDefault();
	elements.transferError.textContent = '';
	setBusy(true);

	try
	{
		const destination = elements.transferDestination.value;
		const result = transferMode === 'move' ?
			await api.moveFile(activeItem.relativePath, destination) :
			await api.copyFile(activeItem.relativePath, destination);
		workspaceState = result.state;
		elements.transferDialog.close();
		render();
		showToast(transferMode === 'move' ? '文件已移动' : '文件已复制');
	}
	catch (error)
	{
		const message = error.message || '操作失败';
		elements.transferError.textContent = message;
		showToast(message, true);
	}
	finally
	{
		setBusy(false);
	}
});

elements.transferDestination.addEventListener('change', () =>
{
	elements.transferError.textContent = '';
});

elements.workspaceSwitch.addEventListener('click', async () =>
{
	const state = await runAction(() => api.chooseRoot());
	if (state)
	{
		workspaceState = state;
		currentDirectory = '';
		render();
	}
});

elements.chooseRootButton.addEventListener('click', () => elements.workspaceSwitch.click());
elements.defaultRootButton.addEventListener('click', async () =>
{
	const state = await runAction(() => api.useDefaultRoot(), '工作区已创建');
	if (state)
	{
		workspaceState = state;
		currentDirectory = '';
		render();
	}
});

elements.newDiagramButton.addEventListener('click', () => openNameDialog('diagram'));
elements.newFolderButton.addEventListener('click', () => openNameDialog('folder'));
elements.templateButton.addEventListener('click', async () =>
{
	const state = await runAction(() => api.checkTemplate());

	if (state)
	{
		workspaceState = state;
		render();
	}

	elements.templateDialog.showModal();
});
elements.updateTemplateButton.addEventListener('click', async () =>
{
	if (workspaceState?.template?.source?.status === 'conflict')
	{
		openTemplateUpdateDialog();
		return;
	}

	await applyTemplateUpdate();
});
elements.editTemplateButton.addEventListener('click', async () =>
{
	const state = await runAction(() => api.editTemplate(), '模板已打开');

	if (state)
	{
		workspaceState = state;
		elements.templateDialog.close();
		render();
	}
});
elements.importTemplateButton.addEventListener('click', async () =>
{
	const state = await runAction(() => api.importTemplate(), '模板已导入');

	if (state)
	{
		workspaceState = state;
		render();
	}
});
elements.removeTemplateButton.addEventListener('click', openTemplateRemoveDialog);
elements.importButton.addEventListener('click', async () =>
{
	const result = await runAction(() => api.importFiles(currentDirectory), '文件已导入');
	if (result?.state)
	{
		workspaceState = result.state;
		render();
	}
});

elements.refreshButton.addEventListener('click', () => refreshState());
elements.searchInput.addEventListener('input', () =>
{
	searchQuery = elements.searchInput.value.trim();
	updatePathCopy();
	renderTree();
	renderFileList();
});

if (api == null)
{
	workspaceState = {root: null, name: null, tree: [], counts: {directories: 0, files: 0},
		template: {configured: false, invalid: false, modifiedAt: null, size: 0}};
	elements.setupMessage.textContent = '工作区接口加载失败，请重新启动应用。';
	elements.defaultRootButton.hidden = true;
	elements.chooseRootButton.hidden = true;
	render();
}
else
{
	refreshState(true);
	api.onChanged(() =>
	{
		if (refreshTimer != null) clearTimeout(refreshTimer);
		refreshTimer = setTimeout(() => refreshState(true), 220);
	});
}
