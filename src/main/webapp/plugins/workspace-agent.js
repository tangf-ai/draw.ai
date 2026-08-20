/**
 * Built-in Codex workspace agent for draw.ai Desktop.
 */
Draw.loadPlugin(function installWorkspaceAgent(ui)
{
	if (!EditorUi.isElectronApp || ui == null || ui.editor == null ||
		window.electron == null)
	{
		return;
	}

	if (ui.__drawioWorkspaceAgentInstalled)
	{
		return;
	}

	if (!ui.__drawioWorkspaceAgentDeferred)
	{
		ui.__drawioWorkspaceAgentDeferred = true;
		var installed = false;
		var deferredInstall = function()
		{
			if (installed) return;
			installed = true;
			ui.removeListener(deferredInstall);
			installWorkspaceAgent(ui);
		};

		ui.addListener('themeInitialized', deferredInstall);
		window.setTimeout(deferredInstall, 1000);
		return;
	}

	if (!ui.__drawioWorkspaceAgentCreateFormatPatched)
	{
		ui.__drawioWorkspaceAgentCreateFormatPatched = true;
		ui.__drawioWorkspaceAgentOriginalCreateFormat = ui.createFormat;

		ui.createFormat = function()
		{
			var format = ui.__drawioWorkspaceAgentOriginalCreateFormat.apply(this, arguments);

			window.setTimeout(function()
			{
				if (typeof ui.__drawioWorkspaceAgentReattach === 'function')
				{
					ui.__drawioWorkspaceAgentReattach();
				}
				else
				{
					installWorkspaceAgent(ui);
				}
			}, 0);

			return format;
		};
	}

	function getActiveFormatContainer()
	{
		var formatWindow = ui.formatWindow != null ? ui.formatWindow.window : null;

		if (formatWindow != null && formatWindow.content != null &&
			formatWindow.content.classList != null &&
			formatWindow.content.classList.contains('geFormatContainer'))
		{
			return formatWindow.content;
		}

		if (ui.formatElt != null && ui.formatElt.classList != null &&
			ui.formatElt.classList.contains('geFormatContainer'))
		{
			return ui.formatElt;
		}

		var containers = document.querySelectorAll('.geFormatContainer');

		for (var i = 0; i < containers.length; i++)
		{
			if (containers[i].offsetParent != null) return containers[i];
		}

		return ui.formatContainer;
	}

	var graph = ui.editor.graph;
	var container = getActiveFormatContainer();

	if (container == null)
	{
		return;
	}

	ui.__drawioWorkspaceAgentInstalled = true;

	var maxContextCells = 300;
	var maxContextPages = 12;
	var originalChildren = Array.prototype.slice.call(container.children);
	var originalDisplays = originalChildren.map(function(child) { return child.style.display; });
	var currentMode = 'format';
	var pageScopeMode = 'current';
	var customPageIds = [];
	var agentState = null;
	var agentBusy = false;
	var agentLoading = false;
	var agentRun = null;
	var agentActivities = {};
	var agentApprovals = {};
	var agentGraphWasEnabled = null;
	var agentPreparedPath = null;
	var agentDisposed = false;
	var normalDockedWidth = ui.formatWidth > 0 ? ui.formatWidth : 240;
	var normalWindowWidth = ui.formatWindow != null ?
		(parseInt(ui.formatWindow.window.div.style.width, 10) || 240) : 240;

	function createElement(tag, className, text)
	{
		var element = document.createElement(tag);
		if (className) element.className = className;
		if (text != null) element.textContent = text;
		return element;
	}

	function createButton(className, text, title)
	{
		var button = createElement('button', className, text);
		button.setAttribute('type', 'button');
		if (title) button.setAttribute('title', title);
		return button;
	}

	function request(action, payload, onProgress)
	{
		return new Promise(function(resolve, reject)
		{
			var message = payload || {};
			message.action = action;
			window.electron.request(message, resolve, function(error, details)
			{
				var requestError = new Error(error || '请求失败');
				if (details != null && typeof details.code === 'string') requestError.code = details.code;
				reject(requestError);
			}, onProgress);
		});
	}

	var formatView = createElement('div', 'geAgentFormatView');

	for (var existingIndex = 0; existingIndex < originalChildren.length; existingIndex++)
	{
		formatView.appendChild(originalChildren[existingIndex]);
	}

	container.appendChild(formatView);
	container.__drawioWorkspaceAgentFormatView = formatView;
	originalChildren = [formatView];
	originalDisplays = [''];

	if (ui.format != null && ui.format.container === container)
	{
		ui.format.container = formatView;
	}

	if (typeof Format !== 'undefined' && !window.__drawioWorkspaceAgentFormatRefreshPatched)
	{
		window.__drawioWorkspaceAgentFormatRefreshPatched = true;
		var formatRefresh = Format.prototype.refresh;

		Format.prototype.refresh = function()
		{
			if (this.container != null && this.container.__drawioWorkspaceAgentFormatView != null)
			{
				this.container = this.container.__drawioWorkspaceAgentFormatView;
			}

			return formatRefresh.apply(this, arguments);
		};
	}

	var css = document.createElement('style');
	css.textContent = [
		'.geAgentPanelOpen:not(.mxWindowPane *){width:380px!important}',
		'.geAgentPanelOpen{overflow:hidden!important;scrollbar-gutter:auto!important}',
		'.geAgentFormatView{height:calc(100% - 36px);overflow-y:auto;scrollbar-gutter:stable;box-sizing:border-box}',
		'.geAgentModeTabs{height:36px;display:flex;border-bottom:1px solid light-dark(#d6d9de,#454950);box-sizing:border-box;background:light-dark(#f7f8fa,#292b30)}',
		'.geAgentModeTab{flex:1;border:0;border-right:1px solid light-dark(#d6d9de,#454950);border-radius:0;background:transparent;color:inherit;font:500 13px Arial,sans-serif;cursor:pointer;padding:0 8px}',
		'.geAgentModeTab:last-child{border-right:0}',
		'.geAgentModeTab.geAgentActive{background:light-dark(#fff,#1f2024);box-shadow:inset 0 -2px #1a73e8;color:light-dark(#185abc,#8ab4f8)}',
		'.geAgentView{height:calc(100% - 36px);min-height:320px;min-width:0;display:flex;flex-direction:column;white-space:normal;background:light-dark(#fff,#202124);color:light-dark(#202124,#e8eaed);font:13px Arial,sans-serif}',
		'.geAgentToolbar{height:44px;min-height:44px;display:flex;align-items:center;gap:4px;padding:0 8px;border-bottom:1px solid light-dark(#e1e4e8,#3c4043);box-sizing:border-box}',
		'.geAgentContext{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:light-dark(#5f6368,#bdc1c6);font-size:12px}',
		'.geAgentScope{width:86px;min-width:86px;height:28px;border:1px solid light-dark(#c8ccd2,#5f6368);border-radius:4px;background:light-dark(#fff,#303134);color:inherit;font:12px Arial,sans-serif;padding:0 4px;cursor:pointer}',
		'.geAgentScope:disabled{opacity:.55;cursor:default}',
		'.geAgentIconBtn{width:30px;height:30px;border:0;border-radius:4px;background:transparent;color:inherit;font-size:17px;cursor:pointer;padding:0}',
		'.geAgentIconBtn:hover{background:light-dark(#eef1f4,#35363a)}',
		'.geAgentIconBtn:disabled{opacity:.35;cursor:default}',
		'.geAgentMessages{min-height:0;flex:1;overflow-y:auto;padding:12px 12px 8px;box-sizing:border-box}',
		'.geAgentEmpty{height:100%;display:flex;align-items:center;justify-content:center;color:light-dark(#80868b,#9aa0a6);font-size:12px}',
		'.geAgentMessage{margin:0 0 14px;line-height:1.55;word-break:break-word;letter-spacing:0}',
		'.geAgentMessageText{white-space:pre-wrap}',
		'.geAgentMessageUser{position:relative;margin-left:34px;padding:8px 10px;border-radius:6px;background:light-dark(#eef4ff,#2b3b55)}',
		'.geAgentMessageAssistant{padding-left:10px;border-left:3px solid light-dark(#188038,#81c995)}',
		'.geAgentMessageError{border-left-color:light-dark(#b3261e,#f28b82);color:light-dark(#b3261e,#f28b82)}',
		'.geAgentMessageMeta{margin-top:5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:light-dark(#80868b,#9aa0a6);font-size:10px}',
		'.geAgentChanges{display:flex;flex-direction:column;gap:3px;margin-top:8px;padding-top:7px;border-top:1px solid light-dark(#e5e8ec,#3c4043)}',
		'.geAgentChange{display:flex;align-items:center;gap:6px;min-width:0;color:light-dark(#5f6368,#bdc1c6);font-size:11px}',
		'.geAgentChangeKind{flex:none;color:light-dark(#188038,#81c995)}',
		'.geAgentChangePath{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
		'.geAgentRun{margin:0 0 14px;padding:9px 10px;border-left:3px solid light-dark(#1a73e8,#8ab4f8);background:light-dark(#f8f9fa,#292a2e)}',
		'.geAgentRunHeader{display:flex;align-items:center;gap:8px;min-height:20px;font-weight:600}',
		'.geAgentSpinner{width:12px;height:12px;flex:none;border:2px solid light-dark(#b5bac1,#6b7076);border-top-color:#1a73e8;border-radius:50%;box-sizing:border-box;animation:geAgentSpin .8s linear infinite}',
		'.geAgentReasoning{margin:6px 0 0 20px;color:light-dark(#70757a,#9aa0a6);font-size:11px;line-height:1.45;white-space:pre-wrap}',
		'.geAgentStream{margin:8px 0 0 20px;line-height:1.5;white-space:pre-wrap}',
		'.geAgentActivities{display:flex;flex-direction:column;gap:4px;margin:8px 0 0 20px}',
		'.geAgentActivity{position:relative;padding-left:16px;color:light-dark(#5f6368,#bdc1c6);font-size:11px;line-height:1.4;word-break:break-word}',
		'.geAgentActivity:before{content:"";position:absolute;left:1px;top:4px;width:7px;height:7px;border:2px solid light-dark(#b5bac1,#6b7076);border-radius:50%;box-sizing:border-box}',
		'.geAgentActivity.geAgentActivityRunning:before{border-color:#1a73e8;border-top-color:transparent;animation:geAgentSpin .8s linear infinite}',
		'.geAgentActivity.geAgentActivityDone:before{content:"✓";top:0;width:11px;height:11px;border:0;color:light-dark(#188038,#81c995);font-size:11px}',
		'.geAgentActivity.geAgentActivityFailed:before{content:"!";top:0;width:11px;height:11px;border:0;color:light-dark(#b3261e,#f28b82);font-weight:700}',
		'.geAgentApproval{margin:9px 0 0 20px;padding:8px;border:1px solid light-dark(#f0c36d,#8a6534);border-radius:5px;background:light-dark(#fff8e7,#3b3122)}',
		'.geAgentApprovalTitle{font-weight:600;font-size:11px}',
		'.geAgentApprovalDetail{max-height:90px;overflow:auto;margin-top:5px;color:light-dark(#5f6368,#bdc1c6);font:11px/1.4 monospace;white-space:pre-wrap;word-break:break-word}',
		'.geAgentApprovalActions{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px}',
		'.geAgentApprovalActions button{min-height:26px;padding:3px 8px}',
		'.geAgentButton{min-height:30px;border:1px solid light-dark(#c8ccd2,#5f6368);border-radius:4px;background:light-dark(#fff,#303134);color:inherit;padding:5px 12px;cursor:pointer;font-size:12px}',
		'.geAgentButton:hover{background:light-dark(#f1f3f4,#3c4043)}',
		'.geAgentButtonPrimary{border-color:#1a73e8;background:#1a73e8;color:#fff}',
		'.geAgentButtonPrimary:hover{background:#185abc}',
		'.geAgentButton:disabled{opacity:.45;cursor:default}',
		'.geAgentPageScopeDialog{display:flex;min-width:300px;max-width:420px;max-height:430px;flex-direction:column;font:13px Arial,sans-serif;color:light-dark(#202124,#e8eaed)}',
		'.geAgentPageScopeTitle{font-weight:600;margin:0 0 8px}',
		'.geAgentPageScopeHint{margin:0 0 10px;color:light-dark(#5f6368,#bdc1c6);font-size:12px;line-height:1.45}',
		'.geAgentPageScopeList{overflow:auto;max-height:260px;border:1px solid light-dark(#e1e4e8,#45484d);border-radius:4px}',
		'.geAgentPageScopeItem{display:flex;align-items:center;gap:8px;min-height:34px;padding:5px 8px;border-bottom:1px solid light-dark(#eef0f2,#383b40);box-sizing:border-box;cursor:pointer}',
		'.geAgentPageScopeItem:last-child{border-bottom:0}',
		'.geAgentPageScopeItem input{margin:0;flex:none}',
		'.geAgentPageScopeItem span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
		'.geAgentPageScopeCount{margin-top:9px;color:light-dark(#5f6368,#bdc1c6);font-size:12px}',
		'.geAgentPageScopeActions{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}',
		'.geAgentProfileDialog{display:flex;min-width:320px;max-width:440px;flex-direction:column;font:13px Arial,sans-serif;color:light-dark(#202124,#e8eaed)}',
		'.geAgentProfileTitle{font-weight:600;margin:0 0 8px}',
		'.geAgentProfileHint{margin:0 0 14px;color:light-dark(#5f6368,#bdc1c6);font-size:12px;line-height:1.45}',
		'.geAgentProfileField{display:flex;flex-direction:column;gap:5px;margin-bottom:12px}',
		'.geAgentProfileField label{font-size:12px;color:light-dark(#5f6368,#bdc1c6)}',
		'.geAgentProfileInput{height:32px;box-sizing:border-box;border:1px solid light-dark(#c8ccd2,#5f6368);border-radius:4px;background:light-dark(#fff,#292a2e);color:inherit;padding:6px 8px;font:13px Arial,sans-serif;outline:none}',
		'.geAgentProfileInput:focus{border-color:#1a73e8;box-shadow:0 0 0 1px #1a73e8}',
		'.geAgentProfileError{min-height:17px;margin:-2px 0 8px;color:light-dark(#b3261e,#f28b82);font-size:12px}',
		'.geAgentProfileActions{display:flex;justify-content:flex-end;gap:8px;margin-top:2px}',
		'.geAgentComposer{display:flex;flex-direction:column;gap:6px;padding:9px 10px 10px;border-top:1px solid light-dark(#e1e4e8,#3c4043);box-sizing:border-box}',
		'.geAgentComposerRow{display:flex;align-items:flex-end;gap:7px;min-width:0}',
		'.geAgentInput{min-width:0;flex:1;resize:none;box-sizing:border-box;min-height:62px;max-height:150px;border:1px solid light-dark(#c8ccd2,#5f6368);border-radius:6px;background:light-dark(#fff,#292a2e);color:inherit;padding:8px;font:13px/1.45 Arial,sans-serif;letter-spacing:0;outline:none}',
		'.geAgentInput:focus{border-color:#1a73e8;box-shadow:0 0 0 1px #1a73e8}',
		'.geAgentSend{width:34px;height:34px;flex:none;border:0;border-radius:4px;background:#188038;color:#fff;font-size:18px;cursor:pointer;padding:0}',
		'.geAgentSend:hover{background:#137333}',
		'.geAgentSend:disabled{opacity:.45;cursor:default}',
		'.geAgentComposerStatus{min-height:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:light-dark(#70757a,#9aa0a6);font-size:10px}',
		'.geAgentWorkspaceBusy{pointer-events:none!important;filter:saturate(.55);cursor:progress!important}',
		'.geAgentHidden{display:none!important}',
		'@keyframes geAgentSpin{to{transform:rotate(360deg)}}'
	].join('');
	document.head.appendChild(css);

	var modeTabs = createElement('div', 'geAgentModeTabs');
	var formatTab = createButton('geAgentModeTab geAgentActive', '格式');
	var agentTab = createButton('geAgentModeTab', 'Agent');
	modeTabs.appendChild(formatTab);
	modeTabs.appendChild(agentTab);
	container.insertBefore(modeTabs, container.firstChild);

	var agentView = createElement('div', 'geAgentView geAgentHidden');
	var agentToolbar = createElement('div', 'geAgentToolbar');
	var agentContextLabel = createElement('div', 'geAgentContext', '当前页');
	var agentPageScopeSelect = createElement('select', 'geAgentScope');
	var agentPageScopeCurrentOption = createElement('option', null, '当前页');
	var agentPageScopeAllOption = createElement('option', null, '全部页面');
	var agentPageScopeCustomOption = createElement('option', null, '指定页面…');
	agentPageScopeCurrentOption.value = 'current';
	agentPageScopeAllOption.value = 'all';
	agentPageScopeCustomOption.value = 'custom';
	agentPageScopeSelect.setAttribute('aria-label', 'Agent 操作页面范围');
	agentPageScopeSelect.setAttribute('title', '选择 Agent 操作页面范围');
	agentPageScopeSelect.appendChild(agentPageScopeCurrentOption);
	agentPageScopeSelect.appendChild(agentPageScopeAllOption);
	agentPageScopeSelect.appendChild(agentPageScopeCustomOption);
	var agentNewThreadButton = createButton('geAgentIconBtn', '+', '新建 Agent 对话');
	var agentProfileButton = createButton('geAgentIconBtn', '⚙', '配置 Agent 模型');
	var agentRollbackButton = createButton('geAgentIconBtn', '↶', '撤回上一轮 Agent 文件修改');
	var agentStopButton = createButton('geAgentIconBtn', '■', '停止 Agent');
	agentRollbackButton.disabled = true;
	agentStopButton.disabled = true;
	agentToolbar.appendChild(agentContextLabel);
	agentToolbar.appendChild(agentPageScopeSelect);
	agentToolbar.appendChild(agentNewThreadButton);
	agentToolbar.appendChild(agentProfileButton);
	agentToolbar.appendChild(agentRollbackButton);
	agentToolbar.appendChild(agentStopButton);
	agentView.appendChild(agentToolbar);

	var agentMessages = createElement('div', 'geAgentMessages');
	var agentEmptyState = createElement('div', 'geAgentEmpty', '新对话');
	agentMessages.appendChild(agentEmptyState);
	agentView.appendChild(agentMessages);
	var agentComposer = createElement('div', 'geAgentComposer');
	var agentComposerRow = createElement('div', 'geAgentComposerRow');
	var agentInput = createElement('textarea', 'geAgentInput');
	agentInput.setAttribute('placeholder', '向 Agent 提交修改要求');
	agentInput.setAttribute('rows', '3');
	var agentSendButton = createButton('geAgentSend', '↑', '发送');
	agentComposerRow.appendChild(agentInput);
	agentComposerRow.appendChild(agentSendButton);
	var agentComposerStatus = createElement('div', 'geAgentComposerStatus', '正在读取 Agent 状态…');
	agentComposer.appendChild(agentComposerRow);
	agentComposer.appendChild(agentComposerStatus);
	agentView.appendChild(agentComposer);
	container.appendChild(agentView);

	function resizePanel(agentMode)
	{
		container.classList.toggle('geAgentPanelOpen', agentMode);

		if (ui.formatWindow != null && ui.formatWindow.window != null)
		{
			var windowObject = ui.formatWindow.window;
			var height = parseInt(windowObject.div.style.height, 10) || 600;
			var width = agentMode ? Math.max(380, normalWindowWidth) : normalWindowWidth;
			windowObject.setSize(width, height);
			windowObject.fit();
		}
		else
		{
			ui.formatWidth = agentMode ? 380 : normalDockedWidth;
			ui.refresh(true);
		}
	}

	function showMode(mode)
	{
		currentMode = mode === 'agent' ? 'agent' : 'format';
		var formatMode = currentMode === 'format';

		for (var i = 0; i < originalChildren.length; i++)
		{
			originalChildren[i].style.display = formatMode ? originalDisplays[i] : 'none';
		}

		agentView.classList.toggle('geAgentHidden', formatMode);
		formatTab.classList.toggle('geAgentActive', formatMode);
		agentTab.classList.toggle('geAgentActive', !formatMode);
		resizePanel(!formatMode);

		if (!formatMode)
		{
			updateContextLabel();
			loadAgentState();
			window.setTimeout(function() { agentInput.focus(); }, 0);
		}
		else if (ui.format != null)
		{
			ui.format.refresh();
		}
	}

	function reattachPanel()
	{
		var nextContainer = getActiveFormatContainer();

		if (nextContainer == null || (nextContainer === container && modeTabs.parentNode === nextContainer))
		{
			return;
		}

		container.classList.remove('geAgentPanelOpen');

		if (container.__drawioWorkspaceAgentFormatView === formatView)
		{
			delete container.__drawioWorkspaceAgentFormatView;
		}

		if (modeTabs.parentNode != null) modeTabs.parentNode.removeChild(modeTabs);
		if (agentView.parentNode != null) agentView.parentNode.removeChild(agentView);

		container = nextContainer;
		var nextChildren = Array.prototype.slice.call(container.children);
		formatView = createElement('div', 'geAgentFormatView');

		for (var i = 0; i < nextChildren.length; i++)
		{
			if (nextChildren[i] !== modeTabs && nextChildren[i] !== agentView)
			{
				formatView.appendChild(nextChildren[i]);
			}
		}

		container.appendChild(formatView);
		container.__drawioWorkspaceAgentFormatView = formatView;
		originalChildren = [formatView];
		originalDisplays = [''];

		if (ui.format != null && ui.format.container === container)
		{
			ui.format.container = formatView;
		}

		container.insertBefore(modeTabs, container.firstChild);
		container.appendChild(agentView);
		showMode(currentMode);
	}

	function plainLabel(cell)
	{
		var value = graph.convertValueToString(cell) || '';

		if (graph.isHtmlLabel(cell))
		{
			var holder = document.createElement('div');
			holder.innerHTML = Graph.sanitizeHtml(value);
			value = mxUtils.extractTextWithWhitespace([holder]);
		}

		return String(value).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 500);
	}

	function getPageId(page)
	{
		return page != null && typeof page.getId === 'function' && page.getId() != null ?
			String(page.getId()) : '';
	}

	function getAvailablePages()
	{
		var pages = [];
		var source = Array.isArray(ui.pages) ? ui.pages : [];

		for (var i = 0; i < source.length; i++)
		{
			if (getPageId(source[i]) !== '') pages.push(source[i]);
		}

		return pages;
	}

	function pageName(page, index)
	{
		var name = page != null && typeof page.getName === 'function' ? page.getName() : '';
		return name != null && String(name).trim() !== '' ? String(name) : 'Page ' + (index + 1);
	}

	function snapshotAvailablePages()
	{
		var pages = getAvailablePages();
		var result = [];

		for (var i = 0; i < pages.length; i++)
		{
			ui.updatePageRoot(pages[i]);
			var model = pages[i] === ui.currentPage ? graph.getModel() : new mxGraphModel(pages[i].root);
			var descendants = model.getDescendants(model.getRoot());
			var cellCount = 0;

			for (var j = 0; j < descendants.length; j++)
			{
				if (model.isVertex(descendants[j]) || model.isEdge(descendants[j])) cellCount++;
			}

			result.push({pageId: getPageId(pages[i]), pageName: pageName(pages[i], i),
				cellCount: cellCount});
		}

		return result;
	}

	function normalizeCustomPageIds(pages)
	{
		var valid = {};
		var result = [];
		var i;

		for (i = 0; i < pages.length; i++) valid[getPageId(pages[i])] = true;

		for (i = 0; i < customPageIds.length; i++)
		{
			var pageId = customPageIds[i];
			if (valid[pageId] && result.indexOf(pageId) < 0) result.push(pageId);
		}

		customPageIds = result;
		return result;
	}

	function getScopedPages()
	{
		var pages = getAvailablePages();
		var scoped = [];

		if (pageScopeMode === 'all')
		{
			scoped = pages;
		}
		else if (pageScopeMode === 'custom')
		{
			var selectedIds = normalizeCustomPageIds(pages);

			for (var i = 0; i < pages.length; i++)
			{
				if (selectedIds.indexOf(getPageId(pages[i])) >= 0) scoped.push(pages[i]);
			}
		}
		else if (ui.currentPage != null)
		{
			scoped = [ui.currentPage];
		}

		return scoped;
	}

	function updatePageScopeOptions()
	{
		var pages = getAvailablePages();
		var customIds = normalizeCustomPageIds(pages);
		var canUseMultiPage = pages.length >= 2;

		if (!canUseMultiPage || (pageScopeMode === 'custom' && customIds.length < 2))
		{
			pageScopeMode = 'current';
		}

		agentPageScopeAllOption.disabled = !canUseMultiPage;
		agentPageScopeCustomOption.disabled = !canUseMultiPage;
		agentPageScopeCustomOption.textContent = customIds.length >= 2 ?
			'指定 ' + customIds.length + ' 页' : '指定页面…';
		agentPageScopeSelect.value = pageScopeMode;
		agentPageScopeSelect.disabled = agentBusy || graph.getSelectionCount() > 0 || !canUseMultiPage;
		agentPageScopeSelect.title = graph.getSelectionCount() > 0 ?
			'已选中图形，本次 Agent 只处理选中图形' : '选择 Agent 操作页面范围';
	}

	function snapshotPage(page, selectedCells, maxCells)
	{
		if (page == null) throw new Error('当前没有可用的 Page 页面');
		if (page !== ui.currentPage) ui.updatePageRoot(page);
		var model = page === ui.currentPage ? graph.getModel() : new mxGraphModel(page.root);
		var candidates = selectedCells != null ? selectedCells : model.getDescendants(model.getRoot());
		var cells = [];
		var candidateCount = 0;

		for (var i = 0; i < candidates.length; i++)
		{
			var cell = candidates[i];
			if (!model.isVertex(cell) && !model.isEdge(cell)) continue;
			candidateCount++;
			if (cells.length >= maxCells) continue;

			var geometry = model.getGeometry(cell);
			var item = {
				id: String(cell.getId()),
				type: model.isEdge(cell) ? 'edge' : 'vertex',
				label: plainLabel(cell)
			};

			if (geometry != null)
			{
				item.geometry = {x: geometry.x, y: geometry.y,
					width: geometry.width, height: geometry.height};
			}

			if (model.isEdge(cell))
			{
				var source = model.getTerminal(cell, true);
				var target = model.getTerminal(cell, false);
				item.sourceId = source != null ? String(source.getId()) : null;
				item.targetId = target != null ? String(target.getId()) : null;
			}

			cells.push(item);
		}

		return {
			pageId: getPageId(page),
			pageName: pageName(page, Math.max(0, getAvailablePages().indexOf(page))),
			cells: cells,
			truncated: candidateCount > cells.length
		};
	}

	function snapshotCurrentPage(forcePage)
	{
		var selected = graph.getSelectionCells();
		var useSelection = forcePage !== true && selected.length > 0;
		var snapshot = snapshotPage(ui.currentPage, useSelection ? selected : null, maxContextCells);
		snapshot.scope = useSelection ? 'selection' : 'page';
		return snapshot;
	}

	function snapshotMultiPage(pages)
	{
		if (pages.length > maxContextPages)
		{
			throw new Error('Agent 一次最多处理 ' + maxContextPages + ' 个页面，请改用“指定页面”。');
		}

		var perPageLimit = Math.max(1, Math.floor(maxContextCells / pages.length));
		var snapshots = [];
		var truncated = false;

		for (var i = 0; i < pages.length; i++)
		{
			var snapshot = snapshotPage(pages[i], null, perPageLimit);
			if (snapshot.pageId === '') throw new Error('Page 页面缺少标识，无法执行跨页 Agent 操作');
			truncated = truncated || snapshot.truncated;
			snapshots.push(snapshot);
		}

		return {scope: 'pages', pages: snapshots, truncated: truncated};
	}

	function snapshotRequestContext()
	{
		var context;

		if (graph.getSelectionCount() > 0)
		{
			context = snapshotCurrentPage();
		}
		else
		{
			var pages = getScopedPages();
			context = pages.length > 1 ? snapshotMultiPage(pages) : snapshotCurrentPage(true);
		}

		context.availablePages = snapshotAvailablePages();
		return context;
	}

	function updateContextLabel()
	{
		var count = graph.getSelectionCount();
		updatePageScopeOptions();

		if (count > 0)
		{
			agentContextLabel.textContent = '已选中 ' + count + ' 个图形（局部）';
			agentContextLabel.title = 'Agent 只会处理当前选中的图形';
		}
		else
		{
			var pages = getScopedPages();

			if (pages.length > 1)
			{
				var prefix = pageScopeMode === 'all' ? '全部' : '已选';
				agentContextLabel.textContent = prefix + ' ' + pages.length + ' 个页面（跨页）';
				agentContextLabel.title = 'Agent 会处理指定的 Page 页面';
			}
			else
			{
				agentContextLabel.textContent = '当前页 ' + snapshotCurrentPage(true).cells.length + ' 个图形（全局）';
				agentContextLabel.title = 'Agent 会处理当前图页';
			}
		}
	}

	function showPageScopeDialog()
	{
		var pages = getAvailablePages();

		if (pages.length < 2)
		{
			pageScopeMode = 'current';
			updateContextLabel();
			return;
		}

		var selectedIds = pageScopeMode === 'custom' ? normalizeCustomPageIds(pages) : [];

		if (selectedIds.length < 2)
		{
			for (var i = 0; i < pages.length && selectedIds.length < maxContextPages; i++)
			{
				selectedIds.push(getPageId(pages[i]));
			}
		}

		var dialog = createElement('div', 'geAgentPageScopeDialog');
		var title = createElement('div', 'geAgentPageScopeTitle', '选择 Page 页面');
		var hint = createElement('div', 'geAgentPageScopeHint', '最多选择 ' + maxContextPages + ' 个页面');
		var list = createElement('div', 'geAgentPageScopeList');
		var count = createElement('div', 'geAgentPageScopeCount');
		var actions = createElement('div', 'geAgentPageScopeActions');
		var cancelButton = createButton('geAgentButton', '取消');
		var applyButton = createButton('geAgentButton geAgentButtonPrimary', '应用');
		var checkboxes = [];

		function updateDialogState()
		{
			var checked = 0;

			for (var i = 0; i < checkboxes.length; i++)
			{
				if (checkboxes[i].checked) checked++;
			}

			count.textContent = '已选择 ' + checked + ' 个页面';
			applyButton.disabled = checked < 2;

			for (var j = 0; j < checkboxes.length; j++)
			{
				checkboxes[j].disabled = !checkboxes[j].checked && checked >= maxContextPages;
			}
		}

		for (var index = 0; index < pages.length; index++)
		{
			var page = pages[index];
			var pageId = getPageId(page);
			var item = createElement('label', 'geAgentPageScopeItem');
			var checkbox = createElement('input');
			checkbox.type = 'checkbox';
			checkbox.value = pageId;
			checkbox.checked = selectedIds.indexOf(pageId) >= 0;
			var label = createElement('span', null, pageName(page, index));
			label.title = pageName(page, index);
			checkbox.addEventListener('change', updateDialogState);
			checkboxes.push(checkbox);
			item.appendChild(checkbox);
			item.appendChild(label);
			list.appendChild(item);
		}

		cancelButton.addEventListener('click', function()
		{
			ui.hideDialog();
			agentPageScopeSelect.value = pageScopeMode;
		});
		applyButton.addEventListener('click', function()
		{
			var nextIds = [];

			for (var i = 0; i < checkboxes.length; i++)
			{
				if (checkboxes[i].checked) nextIds.push(checkboxes[i].value);
			}

			if (nextIds.length < 2) return;
			customPageIds = nextIds;
			pageScopeMode = 'custom';
			ui.hideDialog();
			updateContextLabel();
		});
		actions.appendChild(cancelButton);
		actions.appendChild(applyButton);
		dialog.appendChild(title);
		dialog.appendChild(hint);
		dialog.appendChild(list);
		dialog.appendChild(count);
		dialog.appendChild(actions);
		updateDialogState();
		ui.showDialog(dialog, 380, 410, true, true);
	}

	function normalizedAgentPath(value)
	{
		return String(value || '').replace(/\\/g, '/').toLowerCase();
	}

	function currentAgentFile()
	{
		var file = ui.getCurrentFile();
		var filePath = file != null && file.fileObject != null ? file.fileObject.path : null;
		return file != null && typeof filePath === 'string' && filePath !== '' ?
			{file: file, path: filePath} : null;
	}

	function agentStatusText()
	{
		if (agentLoading) return '正在读取 Agent 状态…';
		if (agentState == null || agentState.configured !== true) return '请先设置图纸工作区';
		if (agentBusy) return 'Codex 正在执行 · 可继续补充要求';
		var runtime = agentState.model || agentState.command || 'codex';
		return 'Codex · ' + runtime;
	}

	function updateAgentControls()
	{
		agentComposerStatus.textContent = agentStatusText();
		agentSendButton.disabled = agentLoading ||
			(agentState != null && agentState.configured === false);
		agentInput.disabled = agentLoading ||
			(agentState != null && agentState.configured === false);
		agentSendButton.textContent = agentBusy ? '↗' : '↑';
		agentSendButton.title = agentBusy ? '补充要求' : '发送';
		agentInput.setAttribute('placeholder', agentBusy ? '补充当前任务的要求' : '向 Agent 提交修改要求');
		agentNewThreadButton.disabled = agentBusy || agentLoading;
		agentProfileButton.disabled = agentBusy || agentLoading;
		agentRollbackButton.disabled = agentBusy || agentLoading ||
			agentState == null || agentState.canRollback !== true;
		agentStopButton.disabled = !agentBusy;
		updatePageScopeOptions();
	}

	function showAgentProfileDialog()
	{
		if (agentBusy || agentLoading) return;
		var dialog = createElement('div', 'geAgentProfileDialog');
		var title = createElement('div', 'geAgentProfileTitle', 'Agent 模型配置');
		var hint = createElement('div', 'geAgentProfileHint',
			'配置 Codex 命令和模型名称。模型留空时使用 Codex 默认模型，保存后对下一轮任务生效。');
		var commandField = createElement('div', 'geAgentProfileField');
		var commandLabel = createElement('label', null, 'Codex 命令');
		var commandInput = createElement('input', 'geAgentProfileInput');
		commandInput.type = 'text';
		commandInput.autocomplete = 'off';
		commandInput.spellcheck = false;
		commandInput.value = agentState != null && agentState.command ? agentState.command : 'codex';
		commandLabel.htmlFor = 'geAgentCodexCommand';
		commandInput.id = 'geAgentCodexCommand';
		commandField.appendChild(commandLabel);
		commandField.appendChild(commandInput);
		var modelField = createElement('div', 'geAgentProfileField');
		var modelLabel = createElement('label', null, '模型名称');
		var modelInput = createElement('input', 'geAgentProfileInput');
		modelInput.type = 'text';
		modelInput.autocomplete = 'off';
		modelInput.spellcheck = false;
		modelInput.placeholder = '例如 gpt-5.6-sol';
		modelInput.value = agentState != null && agentState.model ? agentState.model : '';
		modelLabel.htmlFor = 'geAgentCodexModel';
		modelInput.id = 'geAgentCodexModel';
		modelField.appendChild(modelLabel);
		modelField.appendChild(modelInput);
		var error = createElement('div', 'geAgentProfileError');
		var actions = createElement('div', 'geAgentProfileActions');
		var cancelButton = createButton('geAgentButton', '取消');
		var saveButton = createButton('geAgentButton geAgentButtonPrimary', '保存');

		cancelButton.addEventListener('click', function() { ui.hideDialog(); });
		saveButton.addEventListener('click', function()
		{
			error.textContent = '';
			saveButton.disabled = true;
			request('workspaceAgentSetProfile', {profile: {
				command: commandInput.value,
				model: modelInput.value
			}}).then(function(profile)
			{
				agentState = Object.assign({}, agentState || {}, profile);
				ui.hideDialog();
				updateAgentControls();
				agentInput.focus();
			}).catch(function(saveError)
			{
				error.textContent = saveError.message || '模型配置保存失败';
				saveButton.disabled = false;
			});
		});
		actions.appendChild(cancelButton);
		actions.appendChild(saveButton);
		dialog.appendChild(title);
		dialog.appendChild(hint);
		dialog.appendChild(commandField);
		dialog.appendChild(modelField);
		dialog.appendChild(error);
		dialog.appendChild(actions);
		ui.showDialog(dialog, 400, 300, true, true);
		request('workspaceAgentGetProfile').then(function(profile)
		{
			agentState = Object.assign({}, agentState || {}, profile);
			commandInput.value = profile.command || 'codex';
			modelInput.value = profile.model || '';
		}).catch(function() {});
		window.setTimeout(function() { commandInput.focus(); commandInput.select(); }, 0);
	}

	function setAgentBusy(busy)
	{
		busy = busy === true;

		if (busy !== agentBusy)
		{
			agentBusy = busy;

			if (busy)
			{
				agentGraphWasEnabled = graph.isEnabled();
				graph.stopEditing(false);
				graph.setEnabled(false);
				ui.diagramContainer.classList.add('geAgentWorkspaceBusy');
				ui.diagramContainer.setAttribute('aria-busy', 'true');
				if (ui.sidebarContainer != null)
				{
					ui.sidebarContainer.classList.add('geAgentWorkspaceBusy');
					ui.sidebarContainer.setAttribute('aria-busy', 'true');
				}
			}
			else
			{
				if (agentGraphWasEnabled) graph.setEnabled(true);
				agentGraphWasEnabled = null;
				ui.diagramContainer.classList.remove('geAgentWorkspaceBusy');
				ui.diagramContainer.removeAttribute('aria-busy');
				if (ui.sidebarContainer != null)
				{
					ui.sidebarContainer.classList.remove('geAgentWorkspaceBusy');
					ui.sidebarContainer.removeAttribute('aria-busy');
				}
				updateContextLabel();
			}
		}

		updateAgentControls();
	}

	function scrollAgentMessages()
	{
		agentMessages.scrollTop = agentMessages.scrollHeight;
	}

	function agentChangeKind(kind)
	{
		return {created: '新建', modified: '修改', deleted: '删除'}[kind] || '更新';
	}

	function addAgentMessage(message, error)
	{
		if (agentEmptyState.parentNode != null) agentEmptyState.parentNode.removeChild(agentEmptyState);
		message = message != null && typeof message === 'object' ? message : {text: String(message || '')};
		var role = message.role === 'user' ? 'user' : 'assistant';
		var node = createElement('div', 'geAgentMessage ' +
			(role === 'user' ? 'geAgentMessageUser' : 'geAgentMessageAssistant') +
			(error ? ' geAgentMessageError' : ''));
		node.appendChild(createElement('div', 'geAgentMessageText', message.text || ''));
		var metaParts = [];

		if (message.steered === true) metaParts.push('补充要求');
		if (message.filePath) metaParts.push(message.filePath);
		if (message.status === 'rolled-back') metaParts.push('已撤回');

		if (metaParts.length > 0)
		{
			var meta = createElement('div', 'geAgentMessageMeta', metaParts.join(' · '));
			meta.title = metaParts.join(' · ');
			node.appendChild(meta);
		}

		if (Array.isArray(message.changes) && message.changes.length > 0)
		{
			var changes = createElement('div', 'geAgentChanges');

			for (var i = 0; i < message.changes.length; i++)
			{
				var change = message.changes[i];
				var row = createElement('div', 'geAgentChange');
				row.appendChild(createElement('span', 'geAgentChangeKind', agentChangeKind(change.kind)));
				var changePath = createElement('span', 'geAgentChangePath', change.path || '图文件');
				changePath.title = change.path || '';
				row.appendChild(changePath);
				changes.appendChild(row);
			}

			node.appendChild(changes);
		}

		agentMessages.appendChild(node);
		scrollAgentMessages();
		return node;
	}

	function renderAgentHistory(items)
	{
		agentMessages.textContent = '';
		agentRun = null;
		agentActivities = {};
		agentApprovals = {};
		items = Array.isArray(items) ? items : [];

		for (var i = 0; i < items.length; i++) addAgentMessage(items[i]);

		if (items.length === 0)
		{
			agentEmptyState.textContent = agentState != null && agentState.configured === false ?
				'未设置工作区' : '新对话';
			agentMessages.appendChild(agentEmptyState);
		}
	}

	function beginAgentRun(label)
	{
		if (agentEmptyState.parentNode != null) agentEmptyState.parentNode.removeChild(agentEmptyState);
		var card = createElement('div', 'geAgentRun');
		var header = createElement('div', 'geAgentRunHeader');
		var spinner = createElement('span', 'geAgentSpinner');
		var status = createElement('span', null, label || '正在准备');
		var reasoning = createElement('div', 'geAgentReasoning geAgentHidden');
		var stream = createElement('div', 'geAgentStream geAgentHidden');
		var activities = createElement('div', 'geAgentActivities geAgentHidden');
		var approvals = createElement('div');
		header.appendChild(spinner);
		header.appendChild(status);
		card.appendChild(header);
		card.appendChild(reasoning);
		card.appendChild(stream);
		card.appendChild(activities);
		card.appendChild(approvals);
		agentMessages.appendChild(card);
		agentRun = {card: card, spinner: spinner, status: status, reasoning: reasoning,
			stream: stream, activities: activities, approvals: approvals};
		agentActivities = {};
		agentApprovals = {};
		scrollAgentMessages();
		return agentRun;
	}

	function ensureAgentRun()
	{
		return agentRun || beginAgentRun('Codex 正在处理图纸');
	}

	function setAgentActivity(event)
	{
		var run = ensureAgentRun();
		var id = String(event.id || 'activity-' + Object.keys(agentActivities).length);
		var activity = agentActivities[id];

		if (activity == null)
		{
			activity = createElement('div', 'geAgentActivity');
			agentActivities[id] = activity;
			run.activities.appendChild(activity);
		}

		activity.textContent = event.label || (event.kind === 'file' ? '正在修改图文件' : '正在执行命令');
		activity.className = 'geAgentActivity geAgentActivity' +
			(event.status === 'failed' ? 'Failed' : (event.status === 'done' ? 'Done' : 'Running'));
		run.activities.classList.remove('geAgentHidden');
	}

	function resolveAgentApproval(id, decision, approvalNode)
	{
		var buttons = approvalNode.querySelectorAll('button');
		for (var i = 0; i < buttons.length; i++) buttons[i].disabled = true;

		request('workspaceAgentApprove', {input: {id: id, decision: decision}}).catch(function(error)
		{
			for (var i = 0; i < buttons.length; i++) buttons[i].disabled = false;
			var detail = approvalNode.querySelector('.geAgentApprovalDetail');
			if (detail != null) detail.textContent = error.message;
		});
	}

	function addAgentApproval(approval)
	{
		if (approval == null || approval.id == null || agentApprovals[approval.id] != null) return;
		var run = ensureAgentRun();
		var node = createElement('div', 'geAgentApproval');
		var typeName = {command: '命令审批', file: '文件审批', permissions: '权限审批'}[approval.type] || '操作审批';
		node.appendChild(createElement('div', 'geAgentApprovalTitle', typeName));
		node.appendChild(createElement('div', 'geAgentApprovalDetail', approval.detail || 'Codex 请求继续执行'));
		var actions = createElement('div', 'geAgentApprovalActions');
		var decline = createButton('geAgentButton', '拒绝');
		var accept = createButton('geAgentButton geAgentButtonPrimary', '允许');
		decline.addEventListener('click', function()
		{
			resolveAgentApproval(approval.id, 'decline', node);
		});
		accept.addEventListener('click', function()
		{
			resolveAgentApproval(approval.id, 'accept', node);
		});
		actions.appendChild(decline);

		if (approval.allowSession === true)
		{
			var acceptSession = createButton('geAgentButton', '本轮会话允许');
			acceptSession.addEventListener('click', function()
			{
				resolveAgentApproval(approval.id, 'acceptForSession', node);
			});
			actions.appendChild(acceptSession);
		}

		actions.appendChild(accept);
		node.appendChild(actions);
		run.approvals.appendChild(node);
		agentApprovals[approval.id] = node;
		scrollAgentMessages();
	}

	function updateAgentProgress(event)
	{
		if (agentDisposed || event == null || typeof event !== 'object') return;
		var run = ensureAgentRun();

		if (event.type === 'status')
		{
			run.status.textContent = event.label || 'Codex 正在执行';
		}
		else if (event.type === 'message-delta')
		{
			run.stream.textContent += event.delta || '';
			run.stream.classList.remove('geAgentHidden');
		}
		else if (event.type === 'reasoning')
		{
			run.reasoning.textContent = (run.reasoning.textContent + (event.delta || '')).slice(-4000);
			run.reasoning.classList.remove('geAgentHidden');
		}
		else if (event.type === 'activity')
		{
			setAgentActivity(event);
		}
		else if (event.type === 'approval')
		{
			addAgentApproval(event.approval);
		}
		else if (event.type === 'approval-resolved')
		{
			var approvalNode = agentApprovals[event.id];
			if (approvalNode != null && approvalNode.parentNode != null)
			{
				approvalNode.parentNode.removeChild(approvalNode);
			}
			delete agentApprovals[event.id];
		}

		scrollAgentMessages();
	}

	function saveCurrentFileForAgent(requireFile)
	{
		return new Promise(function(resolve, reject)
		{
			var current = currentAgentFile();

			if (current == null)
			{
				if (requireFile) reject(new Error('请先从工作区打开一个 .drawio 图文件'));
				else resolve(null);
				return;
			}

			if (graph.isEditing()) graph.stopEditing(false);

			function finish()
			{
				Promise.resolve(ui.unwatchPath(current.path)).then(function()
				{
					agentPreparedPath = current.path;
					resolve(current);
				}, reject);
			}

			if (!current.file.isModified()) finish();
			else
			{
				current.file.save(false, finish, function(error)
				{
					reject(new Error(error != null && error.message ? error.message : '当前图纸保存失败'));
				}, false, false);
			}
		});
	}

	function restoreCurrentFileAfterAgent(filePath, reload)
	{
		if (filePath == null) return Promise.resolve();
		var current = currentAgentFile();
		var reloadPromise = Promise.resolve();

		if (reload && current != null && normalizedAgentPath(current.path) === normalizedAgentPath(filePath))
		{
			if (typeof ui.reloadExternalFile === 'function')
			{
				reloadPromise = new Promise(function(resolve, reject)
				{
					ui.reloadExternalFile(resolve, function(error)
					{
						reject(new Error(error != null && error.message ? error.message : '图纸重新载入失败'));
					});
				});
			}
			else
			{
				ui.synchronizeCurrentFile(true);
			}
		}

		return reloadPromise.catch(function(error)
		{
			if (!agentDisposed) addAgentMessage({role: 'assistant', text: error.message}, true);
		}).then(function()
		{
			return ui.watchPath(filePath);
		}).catch(function(error)
		{
			if (!agentDisposed) addAgentMessage({role: 'assistant',
				text: error.message || '文件监听恢复失败'}, true);
		}).finally(function()
		{
			if (agentPreparedPath === filePath) agentPreparedPath = null;
		});
	}

	function loadAgentState(force)
	{
		if ((agentLoading || agentBusy) && force !== true) return Promise.resolve(agentState);
		agentLoading = true;
		updateAgentControls();

		return request('workspaceAgentGetState').then(function(next)
		{
			if (agentDisposed) return next;
			agentState = next;
			renderAgentHistory(next.messages);
			setAgentBusy(next.busy === true);

			if (next.busy === true && agentRun == null)
			{
				beginAgentRun('Codex 正在其他窗口执行');
			}

			return next;
		}).catch(function(error)
		{
			if (!agentDisposed)
			{
				agentState = {configured: false, busy: false, messages: [], canRollback: false};
				renderAgentHistory([]);
				addAgentMessage({role: 'assistant', text: error.message}, true);
			}
		}).finally(function()
		{
			agentLoading = false;
			if (!agentDisposed) updateAgentControls();
		});
	}

	async function sendAgentSteer(text)
	{
		agentInput.value = '';
		addAgentMessage({role: 'user', text: text, steered: true});
		agentSendButton.disabled = true;

		try
		{
			await request('workspaceAgentSteer', {text: text});
		}
		catch (error)
		{
			addAgentMessage({role: 'assistant', text: error.message}, true);
		}
		finally
		{
			if (!agentDisposed)
			{
				updateAgentControls();
				agentInput.focus();
			}
		}
	}

	async function sendAgentPrompt()
	{
		var prompt = agentInput.value.trim();
		if (prompt === '' || agentLoading) return;

		if (agentBusy)
		{
			sendAgentSteer(prompt);
			return;
		}

		var context;

		try
		{
			if (graph.isEditing()) graph.stopEditing(false);
			context = snapshotRequestContext();
		}
		catch (error)
		{
			addAgentMessage({role: 'assistant', text: error.message}, true);
			return;
		}

		agentInput.value = '';
		addAgentMessage({role: 'user', text: prompt});
		beginAgentRun('正在保存当前图纸');
		setAgentBusy(true);
		var prepared = null;

		try
		{
			prepared = await saveCurrentFileForAgent(true);
			await request('workspaceAgentChat', {input: {
				prompt: prompt,
				filePath: prepared.path,
				context: context
			}}, updateAgentProgress);
			await restoreCurrentFileAfterAgent(prepared.path, true);
			prepared = null;
			setAgentBusy(false);
			await loadAgentState(true);
		}
		catch (error)
		{
			if (prepared != null) await restoreCurrentFileAfterAgent(prepared.path, true);
			setAgentBusy(false);
			await loadAgentState(true);
			if (!agentDisposed && error.code !== 'WORKSPACE_AGENT_INTERRUPTED')
			{
				addAgentMessage({role: 'assistant', text: error.message}, true);
			}
		}
		finally
		{
			if (!agentDisposed) agentInput.focus();
		}
	}

	function newAgentThread()
	{
		if (agentBusy || agentLoading) return;

		function reset()
		{
			agentLoading = true;
			updateAgentControls();
			request('workspaceAgentNewThread').then(function(next)
			{
				agentState = Object.assign({}, agentState || {}, next, {configured: true, busy: false});
				renderAgentHistory([]);
			}).catch(function(error)
			{
				addAgentMessage({role: 'assistant', text: error.message}, true);
			}).finally(function()
			{
				agentLoading = false;
				updateAgentControls();
				if (!agentDisposed && !agentInput.disabled)
				{
					window.setTimeout(function() { agentInput.focus(); }, 0);
				}
			});
		}

		if (agentState != null && Array.isArray(agentState.messages) && agentState.messages.length > 0)
		{
			ui.confirm('开始新对话？当前 Agent 对话记录将被清空。', null, reset,
				'取消', '开始新对话');
		}
		else reset();
	}

	async function rollbackAgentChange()
	{
		if (agentBusy || agentLoading || agentState == null || agentState.canRollback !== true) return;
		agentLoading = true;
		updateAgentControls();
		var prepared = null;

		try
		{
			prepared = await saveCurrentFileForAgent(false);
			await request('workspaceAgentRollback');
			if (prepared != null) await restoreCurrentFileAfterAgent(prepared.path, true);
			prepared = null;
			await loadAgentState(true);
		}
		catch (error)
		{
			if (prepared != null) await restoreCurrentFileAfterAgent(prepared.path, false);
			addAgentMessage({role: 'assistant', text: error.message}, true);
		}
		finally
		{
			agentLoading = false;
			if (!agentDisposed) updateAgentControls();
		}
	}

	function stopAgent()
	{
		if (!agentBusy) return;
		agentStopButton.disabled = true;
		ensureAgentRun().status.textContent = '正在停止 Codex';
		request('workspaceAgentInterrupt').catch(function(error)
		{
			addAgentMessage({role: 'assistant', text: error.message}, true);
			updateAgentControls();
		});
	}

	function handlePageScopeChange()
	{
		if (agentBusy || graph.getSelectionCount() > 0)
		{
			updateContextLabel();
			return;
		}

		if (agentPageScopeSelect.value === 'custom')
		{
			agentPageScopeSelect.value = pageScopeMode;
			showPageScopeDialog();
		}
		else
		{
			pageScopeMode = agentPageScopeSelect.value === 'all' ? 'all' : 'current';
			updateContextLabel();
		}
	}

	formatTab.addEventListener('click', function() { showMode('format'); });
	agentTab.addEventListener('click', function() { showMode('agent'); });
	agentPageScopeSelect.addEventListener('change', handlePageScopeChange);
	agentSendButton.addEventListener('click', sendAgentPrompt);
	agentNewThreadButton.addEventListener('click', newAgentThread);
	agentProfileButton.addEventListener('click', showAgentProfileDialog);
	agentStopButton.addEventListener('click', stopAgent);
	agentRollbackButton.addEventListener('click', function()
	{
		ui.confirm('撤回上一轮 Agent 对图文件的修改？', null, rollbackAgentChange,
			'取消', '撤回修改');
	});
	agentInput.addEventListener('keydown', function(event)
	{
		if (event.key === 'Enter' && !event.shiftKey)
		{
			event.preventDefault();
			sendAgentPrompt();
		}
	});

	graph.getSelectionModel().addListener(mxEvent.CHANGE, updateContextLabel);
	ui.editor.addListener('pageSelected', updateContextLabel);
	ui.editor.addListener('pageRenamed', updateContextLabel);
	ui.editor.addListener('pageMoved', updateContextLabel);
	ui.editor.addListener('pagesPatched', updateContextLabel);
	ui.editor.addListener('fileLoaded', function()
	{
		reattachPanel();
		updateContextLabel();
	});
	ui.addListener('themeInitialized', reattachPanel);
	ui.addListener('currentPageChanged', updateContextLabel);
	ui.__drawioWorkspaceAgentReattach = reattachPanel;
	loadAgentState();

	var attachChecks = 0;
	var attachTimer = window.setInterval(function()
	{
		attachChecks++;
		reattachPanel();
		if (attachChecks >= 50) window.clearInterval(attachTimer);
	}, 100);

	ui.destroyFunctions.push(function()
	{
		agentDisposed = true;
		if (agentBusy && agentGraphWasEnabled) graph.setEnabled(true);
		window.clearInterval(attachTimer);
		ui.createFormat = ui.__drawioWorkspaceAgentOriginalCreateFormat;
		delete ui.__drawioWorkspaceAgentReattach;
		delete ui.__drawioWorkspaceAgentInstalled;
		delete ui.__drawioWorkspaceAgentCreateFormatPatched;
		delete ui.__drawioWorkspaceAgentOriginalCreateFormat;
		if (css.parentNode != null) css.parentNode.removeChild(css);
	});
});
