/**
 * Built-in AI diagram assistant for draw.ai Desktop.
 */
Draw.loadPlugin(function installAiAssistant(ui)
{
	if (!EditorUi.isElectronApp || ui == null || ui.editor == null ||
		window.electron == null)
	{
		return;
	}

	if (ui.__drawioAiAssistantInstalled)
	{
		return;
	}

	if (!ui.__drawioAiAssistantDeferred)
	{
		ui.__drawioAiAssistantDeferred = true;
		var installed = false;
		var deferredInstall = function()
		{
			if (installed) return;
			installed = true;
			ui.removeListener(deferredInstall);
			installAiAssistant(ui);
		};

		ui.addListener('themeInitialized', deferredInstall);
		window.setTimeout(deferredInstall, 1000);
		return;
	}

	if (!ui.__drawioAiCreateFormatPatched)
	{
		ui.__drawioAiCreateFormatPatched = true;
		ui.__drawioAiOriginalCreateFormat = ui.createFormat;

		ui.createFormat = function()
		{
			var format = ui.__drawioAiOriginalCreateFormat.apply(this, arguments);

			// Minimal creates its Format window only when the user first opens it.
			window.setTimeout(function()
			{
				if (typeof ui.__drawioAiReattach === 'function')
				{
					ui.__drawioAiReattach();
				}
				else
				{
					installAiAssistant(ui);
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
			if (containers[i].offsetParent != null)
			{
				return containers[i];
			}
		}

		return ui.formatContainer;
	}

	var graph = ui.editor.graph;
	var container = getActiveFormatContainer();

	if (container == null)
	{
		return;
	}

	ui.__drawioAiAssistantInstalled = true;

	var originalChildren = Array.prototype.slice.call(container.children);
	var originalDisplays = originalChildren.map(function(child) { return child.style.display; });
	var currentMode = 'format';
	var pendingPlan = null;
	var chatHistory = [];
	var config = null;
	var requestPending = false;
	var activeProgress = null;
	var graphWasEnabled = null;
	var lastAiChange = null;
	var attachedImage = null;
	var imageLoadToken = 0;
	var imageProcessing = false;
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

	var formatView = createElement('div', 'geAiFormatView');

	for (var existingIndex = 0; existingIndex < originalChildren.length; existingIndex++)
	{
		formatView.appendChild(originalChildren[existingIndex]);
	}

	container.appendChild(formatView);
	container.__drawioAiFormatView = formatView;
	originalChildren = [formatView];
	originalDisplays = [''];

	if (ui.format != null && ui.format.container === container)
	{
		ui.format.container = formatView;
	}

	// Sketch and Minimal themes create a separate Format instance for their
	// floating window without storing it on EditorUi. Redirect that instance on
	// its next refresh so it updates only the wrapped format view, preserving the
	// AI tabs around it.
	if (typeof Format !== 'undefined' && !window.__drawioAiFormatRefreshPatched)
	{
		window.__drawioAiFormatRefreshPatched = true;
		var formatRefresh = Format.prototype.refresh;

		Format.prototype.refresh = function()
		{
			if (this.container != null && this.container.__drawioAiFormatView != null)
			{
				this.container = this.container.__drawioAiFormatView;
			}

			return formatRefresh.apply(this, arguments);
		};
	}

	function request(action, payload, onProgress)
	{
		return new Promise(function(resolve, reject)
		{
			var message = payload || {};
			message.action = action;
			window.electron.request(message, resolve, function(error)
			{
				reject(new Error(error || '请求失败'));
			}, onProgress);
		});
	}

	var css = document.createElement('style');
	css.textContent = [
		'.geAiPanelOpen:not(.mxWindowPane *){width:340px!important}',
		'.geAiPanelOpen{overflow:hidden!important;scrollbar-gutter:auto!important}',
		'.geAiFormatView{height:calc(100% - 36px);overflow-y:auto;scrollbar-gutter:stable;box-sizing:border-box}',
		'.geAiModeTabs{height:36px;display:flex;border-bottom:1px solid light-dark(#d6d9de,#454950);box-sizing:border-box;background:light-dark(#f7f8fa,#292b30)}',
		'.geAiModeTab{flex:1;border:0;border-right:1px solid light-dark(#d6d9de,#454950);border-radius:0;background:transparent;color:inherit;font:500 13px Arial,sans-serif;cursor:pointer;padding:0 8px}',
		'.geAiModeTab:last-child{border-right:0}',
		'.geAiModeTab.geAiActive{background:light-dark(#fff,#1f2024);box-shadow:inset 0 -2px #1a73e8;color:light-dark(#185abc,#8ab4f8)}',
		'.geAiView{height:calc(100% - 36px);min-height:320px;display:flex;flex-direction:column;white-space:normal;background:light-dark(#fff,#202124);color:light-dark(#202124,#e8eaed);font:13px Arial,sans-serif}',
		'.geAiToolbar{height:44px;min-height:44px;display:flex;align-items:center;gap:6px;padding:0 10px;border-bottom:1px solid light-dark(#e1e4e8,#3c4043);box-sizing:border-box}',
		'.geAiContext{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:light-dark(#5f6368,#bdc1c6);font-size:12px}',
		'.geAiIconBtn{width:30px;height:30px;border:0;border-radius:4px;background:transparent;color:inherit;font-size:17px;cursor:pointer;padding:0}',
		'.geAiIconBtn:hover{background:light-dark(#eef1f4,#35363a)}',
		'.geAiIconBtn:disabled{opacity:.35;cursor:default}',
		'.geAiMessages{flex:1;overflow-y:auto;padding:12px 12px 6px;box-sizing:border-box}',
		'.geAiMessage{margin:0 0 12px;line-height:1.55;word-break:break-word;letter-spacing:0}',
		'.geAiMessageUser{margin-left:28px;padding:8px 10px;border-radius:6px;background:light-dark(#eef4ff,#2b3b55)}',
		'.geAiMessageAssistant{padding-left:10px;border-left:3px solid light-dark(#1a73e8,#8ab4f8)}',
		'.geAiMessageError{color:light-dark(#b3261e,#f28b82);border-left-color:light-dark(#b3261e,#f28b82)}',
		'.geAiMessageActions{display:flex;align-items:center;gap:8px;margin-top:8px}',
		'.geAiButton.geAiRollbackButton{min-height:28px;padding:4px 9px}',
		'.geAiProgress{margin:0 0 12px;padding:10px;border:1px solid light-dark(#d8dce2,#4a4d52);border-radius:6px;background:light-dark(#fafbfc,#292a2e)}',
		'.geAiProgressTitle{font-weight:600;margin-bottom:8px}',
		'.geAiProgressStep{position:relative;padding:3px 0 3px 20px;color:light-dark(#5f6368,#bdc1c6);font-size:12px;line-height:1.45}',
		'.geAiProgressStep:before{content:"";position:absolute;left:2px;top:7px;width:8px;height:8px;border:2px solid light-dark(#b5bac1,#6b7076);border-radius:50%;box-sizing:border-box}',
		'.geAiProgressStep.geAiProgressActive:before{border-color:#1a73e8;border-top-color:transparent;animation:geAiSpin .8s linear infinite}',
		'.geAiProgressStep.geAiProgressDone:before{content:"✓";width:12px;height:12px;top:3px;border:0;color:#188038;font-size:12px;line-height:12px}',
		'.geAiProgressStep.geAiProgressError:before{content:"!";width:12px;height:12px;top:3px;border:0;color:#b3261e;font-weight:700;line-height:12px;text-align:center}',
		'.geAiProgressDetail{display:block;margin-top:2px;color:light-dark(#80868b,#9aa0a6);white-space:pre-wrap}',
		'.geAiProgressPreview{display:block;margin-top:5px;padding:6px 8px;border-left:2px solid #1a73e8;background:light-dark(#eef4ff,#26354d);color:inherit}',
		'.geAiProgressComplete .geAiProgressTitle{color:light-dark(#137333,#81c995)}',
		'.geAiProgressFailed .geAiProgressTitle{color:light-dark(#b3261e,#f28b82)}',
		'@keyframes geAiSpin{to{transform:rotate(360deg)}}',
		'.geAiEmpty{height:100%;display:flex;align-items:center;justify-content:center;color:light-dark(#80868b,#9aa0a6);font-size:12px}',
		'.geAiPlan{margin:0 10px 10px;border:1px solid light-dark(#d8dce2,#4a4d52);border-radius:6px;overflow:hidden;background:light-dark(#fafbfc,#292a2e)}',
		'.geAiPlanTitle{padding:9px 10px;font-weight:600;border-bottom:1px solid light-dark(#e2e5e9,#45484d)}',
		'.geAiPlanList{max-height:155px;overflow:auto;padding:6px 10px;margin:0;list-style:none}',
		'.geAiPlanList li{padding:3px 0;color:light-dark(#4f5358,#c8cbd0);font-size:12px}',
		'.geAiPlanActions{display:flex;justify-content:flex-end;gap:8px;padding:8px 10px;border-top:1px solid light-dark(#e2e5e9,#45484d)}',
		'.geAiButton{min-height:30px;border:1px solid light-dark(#c8ccd2,#5f6368);border-radius:4px;background:light-dark(#fff,#303134);color:inherit;padding:5px 12px;cursor:pointer;font-size:12px}',
		'.geAiButton:hover{background:light-dark(#f1f3f4,#3c4043)}',
		'.geAiButtonPrimary{border-color:#1a73e8;background:#1a73e8;color:#fff}',
		'.geAiButtonPrimary:hover{background:#185abc}',
		'.geAiButton:disabled{opacity:.45;cursor:default}',
		'.geAiComposer{display:flex;flex-direction:column;gap:8px;padding:10px;border-top:1px solid light-dark(#e1e4e8,#3c4043);box-sizing:border-box;transition:background-color .14s,border-color .14s}',
		'.geAiComposer.geAiDropActive{background:light-dark(#eef4ff,#26354d);border-top-color:#1a73e8}',
		'.geAiComposerRow{display:flex;align-items:flex-end;gap:8px;min-width:0}',
		'.geAiAttach{width:34px;height:34px;min-width:34px;border:1px solid light-dark(#c8ccd2,#5f6368);border-radius:4px;background:transparent;color:inherit;font:20px/1 Arial,sans-serif;cursor:pointer;padding:0}',
		'.geAiAttach:hover{background:light-dark(#eef1f4,#35363a)}',
		'.geAiAttach:disabled{opacity:.35;cursor:default}',
		'.geAiAttachment{display:flex;align-items:center;gap:8px;min-height:52px;padding:6px;border:1px solid light-dark(#d8dce2,#4a4d52);border-radius:6px;background:light-dark(#fafbfc,#292a2e);box-sizing:border-box}',
		'.geAiAttachment img{width:48px;height:40px;object-fit:cover;border-radius:4px;background:light-dark(#e8eaed,#3c4043)}',
		'.geAiAttachmentInfo{min-width:0;flex:1}',
		'.geAiAttachmentName{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}',
		'.geAiAttachmentMeta{margin-top:3px;color:light-dark(#80868b,#9aa0a6);font-size:11px}',
		'.geAiAttachmentRemove{width:28px;height:28px;border:0;border-radius:4px;background:transparent;color:inherit;font-size:18px;cursor:pointer;padding:0}',
		'.geAiAttachmentRemove:hover{background:light-dark(#e8eaed,#3c4043)}',
		'.geAiAttachmentRemove:disabled{opacity:.35;cursor:default}',
		'.geAiInput{min-width:0;flex:1;resize:none;box-sizing:border-box;min-height:56px;max-height:130px;border:1px solid light-dark(#c8ccd2,#5f6368);border-radius:6px;background:light-dark(#fff,#292a2e);color:inherit;padding:8px;font:13px/1.45 Arial,sans-serif;letter-spacing:0;outline:none}',
		'.geAiInput:focus{border-color:#1a73e8;box-shadow:0 0 0 1px #1a73e8}',
		'.geAiSend{width:34px;height:34px;border:0;border-radius:4px;background:#1a73e8;color:#fff;font-size:18px;cursor:pointer;padding:0}',
		'.geAiSend:disabled{opacity:.45;cursor:default}',
		'.geAiSettings{display:none;flex:1;overflow:auto;padding:14px 12px;box-sizing:border-box}',
		'.geAiSettings.geAiVisible{display:block}',
		'.geAiField{display:block;margin:0 0 14px}',
		'.geAiField span{display:block;margin-bottom:6px;font-size:12px;color:light-dark(#4f5358,#c8cbd0)}',
		'.geAiField input,.geAiField textarea{width:100%;box-sizing:border-box;border:1px solid light-dark(#c8ccd2,#5f6368);border-radius:4px;background:light-dark(#fff,#292a2e);color:inherit;padding:6px 8px;font:12px/1.45 Arial,sans-serif;letter-spacing:0}',
		'.geAiField input{height:34px}',
		'.geAiField textarea{min-height:76px;resize:vertical}',
		'.geAiSettingsActions{display:flex;justify-content:flex-end;gap:8px}',
		'.geAiConfigStatus{margin:0 0 14px;padding:8px;border-radius:4px;background:light-dark(#f1f3f4,#303134);font-size:12px;color:light-dark(#5f6368,#bdc1c6)}',
		'.geAiConfigStatus.geAiConfigSuccess{background:light-dark(#e6f4ea,#203b2a);color:light-dark(#137333,#81c995)}',
		'.geAiConfigStatus.geAiConfigError{background:light-dark(#fce8e6,#442624);color:light-dark(#b3261e,#f28b82)}',
		'.geAiWorkspaceBusy{pointer-events:none!important;filter:saturate(.55);cursor:progress!important}',
		'.geAiHidden{display:none!important}'
	].join('');
	document.head.appendChild(css);

	var modeTabs = createElement('div', 'geAiModeTabs');
	var formatTab = createButton('geAiModeTab geAiActive', '格式');
	var aiTab = createButton('geAiModeTab', 'AI 助手');
	modeTabs.appendChild(formatTab);
	modeTabs.appendChild(aiTab);
	container.insertBefore(modeTabs, container.firstChild);

	var aiView = createElement('div', 'geAiView geAiHidden');
	var toolbar = createElement('div', 'geAiToolbar');
	var contextLabel = createElement('div', 'geAiContext', '当前页');
	var undoButton = createButton('geAiIconBtn', '↶', '回撤本次 AI 修改');
	var settingsButton = createButton('geAiIconBtn', '⚙', 'AI 设置');
	undoButton.disabled = true;
	toolbar.appendChild(contextLabel);
	toolbar.appendChild(undoButton);
	toolbar.appendChild(settingsButton);
	aiView.appendChild(toolbar);

	var conversation = createElement('div', 'geAiView');
	conversation.style.height = 'auto';
	conversation.style.minHeight = '0';
	conversation.style.flex = '1';
	var messages = createElement('div', 'geAiMessages');
	var emptyState = createElement('div', 'geAiEmpty', 'AI 助手');
	messages.appendChild(emptyState);
	conversation.appendChild(messages);

	var planPanel = createElement('div', 'geAiPlan geAiHidden');
	var planTitle = createElement('div', 'geAiPlanTitle', '待应用修改');
	var planList = createElement('ul', 'geAiPlanList');
	var planActions = createElement('div', 'geAiPlanActions');
	var cancelPlanButton = createButton('geAiButton', '取消');
	var applyPlanButton = createButton('geAiButton geAiButtonPrimary', '应用修改');
	planActions.appendChild(cancelPlanButton);
	planActions.appendChild(applyPlanButton);
	planPanel.appendChild(planTitle);
	planPanel.appendChild(planList);
	planPanel.appendChild(planActions);
	conversation.appendChild(planPanel);

	var composer = createElement('div', 'geAiComposer');
	var attachmentPreview = createElement('div', 'geAiAttachment geAiHidden');
	var attachmentImage = createElement('img');
	attachmentImage.setAttribute('alt', '');
	var attachmentInfo = createElement('div', 'geAiAttachmentInfo');
	var attachmentName = createElement('div', 'geAiAttachmentName');
	var attachmentMeta = createElement('div', 'geAiAttachmentMeta');
	var removeAttachmentButton = createButton('geAiAttachmentRemove', '×', '移除图片');
	attachmentInfo.appendChild(attachmentName);
	attachmentInfo.appendChild(attachmentMeta);
	attachmentPreview.appendChild(attachmentImage);
	attachmentPreview.appendChild(attachmentInfo);
	attachmentPreview.appendChild(removeAttachmentButton);
	var composerRow = createElement('div', 'geAiComposerRow');
	var attachButton = createButton('geAiAttach', '+', '上传图片');
	var imageInput = createElement('input', 'geAiHidden');
	imageInput.setAttribute('type', 'file');
	imageInput.setAttribute('accept', 'image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp');
	var promptInput = createElement('textarea', 'geAiInput');
	promptInput.setAttribute('placeholder', '输入要求，或粘贴手绘草稿');
	promptInput.setAttribute('rows', '2');
	var sendButton = createButton('geAiSend', '↑', '发送');
	composerRow.appendChild(attachButton);
	composerRow.appendChild(promptInput);
	composerRow.appendChild(sendButton);
	composer.appendChild(attachmentPreview);
	composer.appendChild(composerRow);
	composer.appendChild(imageInput);
	conversation.appendChild(composer);
	aiView.appendChild(conversation);

	var settings = createElement('div', 'geAiSettings');
	var configStatus = createElement('div', 'geAiConfigStatus', '未配置');
	var baseUrlField = createElement('label', 'geAiField');
	var baseUrlLabel = createElement('span', null, 'OpenAI 兼容接口地址');
	var baseUrlInput = createElement('input');
	baseUrlInput.setAttribute('type', 'url');
	baseUrlInput.setAttribute('placeholder', 'https://api.openai.com/v1');
	baseUrlField.appendChild(baseUrlLabel);
	baseUrlField.appendChild(baseUrlInput);
	var modelField = createElement('label', 'geAiField');
	var modelLabel = createElement('span', null, '模型');
	var modelInput = createElement('input');
	modelInput.setAttribute('type', 'text');
	modelInput.setAttribute('placeholder', '测试连接后选择，或手动填写');
	modelInput.setAttribute('list', 'geAiModelOptions');
	var modelOptions = createElement('datalist');
	modelOptions.setAttribute('id', 'geAiModelOptions');
	modelField.appendChild(modelLabel);
	modelField.appendChild(modelInput);
	modelField.appendChild(modelOptions);
	var apiKeyField = createElement('label', 'geAiField');
	var apiKeyLabel = createElement('span', null, 'API Key');
	var apiKeyInput = createElement('input');
	apiKeyInput.setAttribute('type', 'password');
	apiKeyInput.setAttribute('autocomplete', 'off');
	apiKeyField.appendChild(apiKeyLabel);
	apiKeyField.appendChild(apiKeyInput);
	var customPromptField = createElement('label', 'geAiField');
	var customPromptLabel = createElement('span', null, '自定义提示词');
	var customPromptInput = createElement('textarea');
	customPromptInput.setAttribute('placeholder', '例如：使用煤矿行业术语，节点说明保持简洁');
	customPromptInput.setAttribute('maxlength', '12000');
	customPromptField.appendChild(customPromptLabel);
	customPromptField.appendChild(customPromptInput);
	var optimizationFocusField = createElement('label', 'geAiField');
	var optimizationFocusLabel = createElement('span', null, '重点优化内容');
	var optimizationFocusInput = createElement('textarea');
	optimizationFocusInput.setAttribute('placeholder', '例如：布局、连线、层级、命名、配色');
	optimizationFocusInput.setAttribute('maxlength', '4000');
	optimizationFocusField.appendChild(optimizationFocusLabel);
	optimizationFocusField.appendChild(optimizationFocusInput);
	var settingsActions = createElement('div', 'geAiSettingsActions');
	var testConnectionButton = createButton('geAiButton', '测试连接');
	var cancelSettingsButton = createButton('geAiButton', '返回');
	var saveSettingsButton = createButton('geAiButton geAiButtonPrimary', '保存');
	settingsActions.appendChild(testConnectionButton);
	settingsActions.appendChild(cancelSettingsButton);
	settingsActions.appendChild(saveSettingsButton);
	settings.appendChild(configStatus);
	settings.appendChild(baseUrlField);
	settings.appendChild(modelField);
	settings.appendChild(apiKeyField);
	settings.appendChild(customPromptField);
	settings.appendChild(optimizationFocusField);
	settings.appendChild(settingsActions);
	aiView.appendChild(settings);
	container.appendChild(aiView);

	function resizePanel(aiMode)
	{
		container.classList.toggle('geAiPanelOpen', aiMode);

		if (ui.formatWindow != null && ui.formatWindow.window != null)
		{
			var windowObject = ui.formatWindow.window;
			var height = parseInt(windowObject.div.style.height, 10) || 600;
			var width = aiMode ? Math.max(340, normalWindowWidth) : normalWindowWidth;
			windowObject.setSize(width, height);
			windowObject.fit();
		}
		else
		{
			ui.formatWidth = aiMode ? 340 : normalDockedWidth;
			ui.refresh(true);
		}
	}

	function showMode(mode)
	{
		currentMode = mode;
		var aiMode = mode === 'ai';

		for (var i = 0; i < originalChildren.length; i++)
		{
			originalChildren[i].style.display = aiMode ? 'none' : originalDisplays[i];
		}

		aiView.classList.toggle('geAiHidden', !aiMode);
		formatTab.classList.toggle('geAiActive', !aiMode);
		aiTab.classList.toggle('geAiActive', aiMode);
		resizePanel(aiMode);

		if (aiMode)
		{
			updateContextLabel();
			window.setTimeout(function() { promptInput.focus(); }, 0);
		}
		else if (ui.format != null)
		{
			ui.format.refresh();
		}
	}

	function reattachPanel()
	{
		var nextContainer = getActiveFormatContainer();

		if (nextContainer == null || (nextContainer === container &&
			modeTabs.parentNode === nextContainer))
		{
			return;
		}

		container.classList.remove('geAiPanelOpen');

		if (container.__drawioAiFormatView === formatView)
		{
			delete container.__drawioAiFormatView;
		}

		if (modeTabs.parentNode != null) modeTabs.parentNode.removeChild(modeTabs);
		if (aiView.parentNode != null) aiView.parentNode.removeChild(aiView);

		container = nextContainer;
		var nextChildren = Array.prototype.slice.call(container.children);
		formatView = createElement('div', 'geAiFormatView');

		for (var i = 0; i < nextChildren.length; i++)
		{
			if (nextChildren[i] !== modeTabs && nextChildren[i] !== aiView)
			{
				formatView.appendChild(nextChildren[i]);
			}
		}

		container.appendChild(formatView);
		container.__drawioAiFormatView = formatView;
		originalChildren = [formatView];
		originalDisplays = [''];

		if (ui.format != null && ui.format.container === container)
		{
			ui.format.container = formatView;
		}

		container.insertBefore(modeTabs, container.firstChild);
		container.appendChild(aiView);
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

	function snapshotDiagram()
	{
		var model = graph.getModel();
		var selected = graph.getSelectionCells();
		var scope = selected.length > 0 ? 'selection' : 'page';
		var candidates = selected.length > 0 ? selected : model.getDescendants(model.getRoot());
		var cells = [];
		var styleKeys = ['fillColor', 'strokeColor', 'fontColor', 'rounded', 'dashed',
			'shadow', 'fontStyle', 'shape', 'align', 'verticalAlign', 'endArrow',
			'edgeStyle', 'opacity', 'strokeWidth'];

		for (var i = 0; i < candidates.length && cells.length < 300; i++)
		{
			var cell = candidates[i];

			if (!model.isVertex(cell) && !model.isEdge(cell)) continue;

			var geometry = model.getGeometry(cell);
			var style = graph.getCellStyle(cell);
			var itemStyle = {};

			for (var j = 0; j < styleKeys.length; j++)
			{
				if (style[styleKeys[j]] != null) itemStyle[styleKeys[j]] = String(style[styleKeys[j]]);
			}

			var item = {
				id: String(cell.getId()),
				type: model.isEdge(cell) ? 'edge' : 'vertex',
				label: plainLabel(cell),
				style: itemStyle
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
			scope: scope,
			pageName: ui.currentPage != null ? ui.currentPage.getName() : '',
			cells: cells,
			truncated: candidates.length > cells.length && cells.length === 300
		};
	}

	function updateContextLabel()
	{
		var count = graph.getSelectionCount();
		contextLabel.textContent = count > 0 ? '已选中 ' + count + ' 个图形' :
			'当前页 ' + snapshotDiagram().cells.length + ' 个图形';
	}

	function addMessage(role, text, error)
	{
		if (emptyState.parentNode != null) emptyState.parentNode.removeChild(emptyState);
		var message = createElement('div', 'geAiMessage ' +
			(role === 'user' ? 'geAiMessageUser' : 'geAiMessageAssistant') +
			(error ? ' geAiMessageError' : ''), text);
		messages.appendChild(message);
		messages.scrollTop = messages.scrollHeight;
		return message;
	}

	function updateRollbackState()
	{
		if (lastAiChange == null)
		{
			undoButton.disabled = true;
			return;
		}

		var undoManager = ui.editor.undoManager;
		var editIndex = undoManager.history.indexOf(lastAiChange.edit);
		var canRollback = editIndex >= 0 &&
			undoManager.indexOfNextAdd === editIndex + 1;

		if (canRollback)
		{
			lastAiChange.button.textContent = '↶ 回撤本次修改';
			lastAiChange.button.title = '回撤本次 AI 修改';
		}
		else if (editIndex >= undoManager.indexOfNextAdd && editIndex >= 0)
		{
			lastAiChange.button.textContent = '已回撤';
			lastAiChange.button.title = '本次 AI 修改已回撤';
		}
		else
		{
			lastAiChange.button.textContent = '已有后续修改';
			lastAiChange.button.title = '为避免误撤后续操作，本次修改已不可直接回撤';
		}

		lastAiChange.button.disabled = requestPending || !canRollback;
		undoButton.disabled = requestPending || !canRollback;
	}

	function rollbackLastAiChange()
	{
		if (requestPending || lastAiChange == null) return;

		var undoManager = ui.editor.undoManager;

		if (undoManager.indexOfNextAdd === 0 ||
			undoManager.history[undoManager.indexOfNextAdd - 1] !== lastAiChange.edit)
		{
			updateRollbackState();
			return;
		}

		undoManager.undo();
		updateRollbackState();
		addMessage('assistant', '已回撤本次 AI 修改。');
		updateContextLabel();
	}

	function addAppliedMessage(count, edit)
	{
		if (lastAiChange != null)
		{
			lastAiChange.button.disabled = true;
			lastAiChange.button.textContent = '已被后续修改替代';
			lastAiChange.button.title = '仅支持直接回撤最近一次 AI 修改';
		}

		var message = addMessage('assistant', '已应用 ' + count + ' 项修改。');
		var actions = createElement('div', 'geAiMessageActions');
		var rollbackButton = createButton('geAiButton geAiRollbackButton',
			'↶ 回撤本次修改', '回撤本次 AI 修改');
		actions.appendChild(rollbackButton);
		message.appendChild(actions);
		rollbackButton.addEventListener('click', rollbackLastAiChange);
		lastAiChange = {edit: edit, button: rollbackButton};
		updateRollbackState();
		messages.scrollTop = messages.scrollHeight;
	}

	function progressLabel(stage)
	{
		return {
			preparing: '读取当前图页',
			connecting: '连接 AI 服务',
			receiving: '模型开始响应',
			streaming: '实时接收结果',
			validating: '校验绘图方案',
			ready: '方案已生成'
		}[stage] || '处理中';
	}

	function beginProgress(context)
	{
		if (emptyState.parentNode != null) emptyState.parentNode.removeChild(emptyState);
		var card = createElement('div', 'geAiProgress');
		var title = createElement('div', 'geAiProgressTitle', 'AI 正在工作');
		var steps = createElement('div');
		card.appendChild(title);
		card.appendChild(steps);
		messages.appendChild(card);
		activeProgress = {card: card, title: title, steps: steps, current: null, stage: null};
		updateProgress({stage: 'preparing', cellCount: context.cells.length});
	}

	function updateProgress(progress)
	{
		if (activeProgress == null || progress == null) return;
		var stage = progress.stage || 'working';

		if (activeProgress.stage !== stage)
		{
			if (activeProgress.current != null)
			{
				activeProgress.current.classList.remove('geAiProgressActive');
				activeProgress.current.classList.add('geAiProgressDone');
			}

			var row = createElement('div', 'geAiProgressStep geAiProgressActive', progressLabel(stage));
			var detail = createElement('span', 'geAiProgressDetail');
			row.appendChild(detail);
			activeProgress.steps.appendChild(row);
			activeProgress.current = row;
			activeProgress.detail = detail;
			activeProgress.stage = stage;
		}

		var detailText = '';

		if (stage === 'preparing') detailText = '已读取 ' + (progress.cellCount || 0) + ' 个图形';
		else if (stage === 'connecting') detailText = (progress.model || '') +
			(progress.host ? ' · ' + progress.host : '');
		else if (stage === 'streaming') detailText = '已接收 ' +
			(progress.receivedCharacters || 0) + ' 个字符';
		else if (stage === 'ready')
		{
			detailText = (progress.operationCount || 0) + ' 项修改';
			if (progress.repairCount > 0) detailText += ' · 已修复 ' + progress.repairCount + ' 个临时引用';
		}

		if (detailText !== '') activeProgress.detail.textContent = detailText;

		if (progress.preview != null && progress.preview !== '')
		{
			var preview = activeProgress.current.querySelector('.geAiProgressPreview');

			if (preview == null)
			{
				preview = createElement('span', 'geAiProgressPreview');
				activeProgress.current.appendChild(preview);
			}

			preview.textContent = progress.preview;
		}

		messages.scrollTop = messages.scrollHeight;
	}

	function finishProgress(success)
	{
		if (activeProgress == null) return;

		if (activeProgress.current != null)
		{
			activeProgress.current.classList.remove('geAiProgressActive');
			activeProgress.current.classList.add(success ? 'geAiProgressDone' : 'geAiProgressError');
		}

		activeProgress.card.classList.add(success ? 'geAiProgressComplete' : 'geAiProgressFailed');
		activeProgress.title.textContent = success ? '处理完成' : '处理失败';
		activeProgress = null;
	}

	function describeOperation(operation)
	{
		switch (operation.type)
		{
		case 'addNode': return '新增节点：“' + operation.label + '”';
		case 'updateLabel': return '修改文字：' + operation.id;
		case 'moveResize': return '调整位置或大小：' + operation.id;
		case 'connect': return '连接 ' + operation.sourceId + ' → ' + operation.targetId;
		case 'setStyle': return '修改样式：' + operation.id;
		case 'deleteCells': return '删除 ' + operation.ids.length + ' 个图形';
		case 'applyLayout': return '应用' + operation.layout + '布局';
		default: return operation.type;
		}
	}

	function showPlan(plan)
	{
		pendingPlan = plan;
		planList.textContent = '';

		for (var i = 0; i < plan.operations.length; i++)
		{
			planList.appendChild(createElement('li', null,
				(i + 1) + '. ' + describeOperation(plan.operations[i])));
		}

		applyPlanButton.disabled = plan.operations.length === 0;
		planPanel.classList.toggle('geAiHidden', plan.operations.length === 0);
		messages.scrollTop = messages.scrollHeight;
	}

	function formatImageSize(size)
	{
		return size >= 1024 * 1024 ? (size / (1024 * 1024)).toFixed(1) + ' MB' :
			Math.max(1, Math.round(size / 1024)) + ' KB';
	}

	function updateAttachmentPreview()
	{
		attachmentPreview.classList.toggle('geAiHidden', attachedImage == null);

		if (attachedImage != null)
		{
			attachmentImage.src = attachedImage.dataUrl;
			attachmentName.textContent = attachedImage.name;
			attachmentMeta.textContent = attachedImage.width + ' × ' + attachedImage.height +
				' · ' + formatImageSize(attachedImage.size);
		}
		else
		{
			attachmentImage.removeAttribute('src');
			attachmentName.textContent = '';
			attachmentMeta.textContent = '';
		}
	}

	function clearAttachment()
	{
		imageLoadToken++;
		imageProcessing = false;
		attachedImage = null;
		imageInput.value = '';
		attachButton.disabled = requestPending;
		imageInput.disabled = requestPending;
		attachButton.setAttribute('title', '上传图片');
		updateAttachmentPreview();
	}

	function attachmentMimeType(file)
	{
		var mimeType = file != null && typeof file.type === 'string' ? file.type.toLowerCase() : '';

		if (mimeType === 'image/png' || mimeType === 'image/jpeg' || mimeType === 'image/webp')
		{
			return mimeType;
		}

		var name = file != null && typeof file.name === 'string' ? file.name.toLowerCase() : '';

		if (/\.png$/.test(name)) return 'image/png';
		if (/\.jpe?g$/.test(name)) return 'image/jpeg';
		if (/\.webp$/.test(name)) return 'image/webp';
		return '';
	}

	function readImageDataUrl(blob)
	{
		return new Promise(function(resolve, reject)
		{
			var reader = new FileReader();
			reader.onload = function() { resolve(reader.result); };
			reader.onerror = function() { reject(new Error('无法读取图片')); };
			reader.readAsDataURL(blob);
		});
	}

	function loadImageElement(file, mimeType)
	{
		return readImageDataUrl(file.slice(0, file.size, mimeType)).then(function(dataUrl)
		{
			return new Promise(function(resolve, reject)
			{
				var image = new Image();

				image.onload = function() { resolve(image); };
				image.onerror = function() { reject(new Error('图片已损坏或无法识别')); };
				image.src = dataUrl;
			});
		});
	}

	function resizeImageBlob(image, file, mimeType)
	{
		var longestEdge = Math.max(image.naturalWidth, image.naturalHeight);
		var scale = Math.min(1, 2048 / longestEdge);

		if (scale === 1)
		{
			return Promise.resolve({blob: file.slice(0, file.size, mimeType),
				width: image.naturalWidth, height: image.naturalHeight});
		}

		return new Promise(function(resolve, reject)
		{
			var canvas = document.createElement('canvas');
			canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
			canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
			var context = canvas.getContext('2d');

			if (context == null)
			{
				reject(new Error('无法处理图片'));
				return;
			}

			if (mimeType === 'image/jpeg')
			{
				context.fillStyle = '#ffffff';
				context.fillRect(0, 0, canvas.width, canvas.height);
			}

			context.drawImage(image, 0, 0, canvas.width, canvas.height);
			canvas.toBlob(function(blob)
			{
				if (blob != null) resolve({blob: blob, width: canvas.width, height: canvas.height});
				else reject(new Error('无法处理图片'));
			}, mimeType, 0.9);
		});
	}

	function attachImageFile(file)
	{
		if (requestPending || file == null) return;
		var mimeType = attachmentMimeType(file);

		if (mimeType === '')
		{
			addMessage('assistant', '仅支持 PNG、JPEG 或 WebP 图片。', true);
			return;
		}

		if (file.size === 0 || file.size > 10 * 1024 * 1024)
		{
			addMessage('assistant', '图片不能超过 10MB。', true);
			return;
		}

		var token = ++imageLoadToken;
		imageProcessing = true;
		attachButton.disabled = true;
		attachButton.setAttribute('title', '正在处理图片');

		loadImageElement(file, mimeType).then(function(image)
		{
			if (image.naturalWidth <= 0 || image.naturalHeight <= 0 ||
				image.naturalWidth > 20000 || image.naturalHeight > 20000 ||
				image.naturalWidth * image.naturalHeight > 80000000)
			{
				throw new Error('图片尺寸过大');
			}

			return resizeImageBlob(image, file, mimeType).then(function(result)
			{
				if (result.blob.size > 10 * 1024 * 1024) throw new Error('处理后的图片仍超过 10MB');

				return readImageDataUrl(result.blob).then(function(dataUrl)
				{
					return {blob: result.blob, dataUrl: dataUrl, width: result.width,
						height: result.height};
				});
			});
		}).then(function(result)
		{
			if (token !== imageLoadToken) return;
			attachedImage = {
				name: file.name || '粘贴的图片',
				mimeType: mimeType,
				dataUrl: result.dataUrl,
				size: result.blob.size,
				width: result.width,
				height: result.height
			};
			updateAttachmentPreview();
		}).catch(function(error)
		{
			if (token === imageLoadToken)
			{
				imageInput.value = '';
				addMessage('assistant', error.message, true);
			}
		}).finally(function()
		{
			if (token === imageLoadToken)
			{
				imageProcessing = false;
				attachButton.disabled = requestPending;
				attachButton.setAttribute('title', '上传图片');
			}
		});
	}

	function setRequestPending(pending)
	{
		requestPending = pending;
		sendButton.disabled = pending;
		promptInput.disabled = pending;
		attachButton.disabled = pending || imageProcessing;
		imageInput.disabled = pending || imageProcessing;
		removeAttachmentButton.disabled = pending;
		sendButton.textContent = pending ? '…' : '↑';
		settingsButton.disabled = pending;
		cancelPlanButton.disabled = pending;
		applyPlanButton.disabled = pending || pendingPlan == null || pendingPlan.operations.length === 0;

		if (pending)
		{
			graphWasEnabled = graph.isEnabled();
			undoButton.disabled = true;
			graph.stopEditing(false);
			graph.setEnabled(false);
			ui.diagramContainer.classList.add('geAiWorkspaceBusy');
			ui.diagramContainer.setAttribute('aria-busy', 'true');
		}
		else
		{
			if (graphWasEnabled) graph.setEnabled(true);
			graphWasEnabled = null;
			updateRollbackState();
			ui.diagramContainer.classList.remove('geAiWorkspaceBusy');
			ui.diagramContainer.removeAttribute('aria-busy');
		}
	}

	function setConfigStatus(text, state)
	{
		configStatus.textContent = text;
		configStatus.classList.toggle('geAiConfigSuccess', state === 'success');
		configStatus.classList.toggle('geAiConfigError', state === 'error');
	}

	function populateModels(models)
	{
		modelOptions.textContent = '';

		for (var i = 0; i < models.length; i++)
		{
			var option = createElement('option');
			option.value = models[i];
			modelOptions.appendChild(option);
		}

		if (modelInput.value.trim() === '' && models.length > 0) modelInput.value = models[0];
	}

	function testConnection()
	{
		testConnectionButton.disabled = true;
		saveSettingsButton.disabled = true;
		setConfigStatus('正在连接并读取模型…');

		request('aiTestConfig', {config: {
			baseUrl: baseUrlInput.value,
			model: modelInput.value,
			apiKey: apiKeyInput.value
		}}).then(function(result)
		{
			populateModels(result.models || []);
			var text = '连接成功 · ' + result.latencyMs + ' ms';
			text += result.models.length > 0 ? ' · 可选 ' + result.models.length + ' 个模型' : ' · 接口未返回模型列表';

			if (!result.selectedModelAvailable) text += ' · 当前模型不在列表中';
			setConfigStatus(text, 'success');
		}).catch(function(error)
		{
			setConfigStatus(error.message, 'error');
		}).finally(function()
		{
			testConnectionButton.disabled = false;
			saveSettingsButton.disabled = false;
		});
	}

	function showSettings(show)
	{
		conversation.classList.toggle('geAiHidden', show);
		settings.classList.toggle('geAiVisible', show);

		if (show)
		{
			baseUrlInput.value = config != null ? config.baseUrl : 'https://api.openai.com/v1';
			modelInput.value = config != null ? config.model : '';
			apiKeyInput.value = '';
			customPromptInput.value = config != null ? config.customPrompt || '' : '';
			optimizationFocusInput.value = config != null ? config.optimizationFocus || '' : '';
			apiKeyInput.setAttribute('placeholder', config != null && config.hasApiKey ?
				'已安全保存，留空表示不修改' : '可选，本地模型可留空');
			setConfigStatus(config != null && config.model ?
				'已配置：' + config.model : '未配置模型');
			window.setTimeout(function() { modelInput.focus(); }, 0);
		}
		else
		{
			promptInput.focus();
		}
	}

	function loadConfig()
	{
		return request('aiGetConfig').then(function(result)
		{
			config = result;
			return result;
		}).catch(function(error)
		{
			addMessage('assistant', error.message, true);
		});
	}

	function saveSettings()
	{
		saveSettingsButton.disabled = true;
		request('aiSaveConfig', {config: {
			baseUrl: baseUrlInput.value,
			model: modelInput.value,
			apiKey: apiKeyInput.value,
			customPrompt: customPromptInput.value,
			optimizationFocus: optimizationFocusInput.value
		}}).then(function(result)
		{
			config = result;
			showSettings(false);
			addMessage('assistant', 'AI 配置已保存。');
		}).catch(function(error)
		{
			setConfigStatus(error.message, 'error');
		}).finally(function()
		{
			saveSettingsButton.disabled = false;
		});
	}

	function sendPrompt()
	{
		var prompt = promptInput.value.trim();

		if (requestPending || imageProcessing || (prompt === '' && attachedImage == null)) return;

		if (prompt === '')
		{
			prompt = '请根据这张图片还原为可编辑的图，识别节点、文字、层级和连线。';
		}

		if (config == null || config.model == null || config.model === '')
		{
			showSettings(true);
			return;
		}

		var context = snapshotDiagram();
		var imageForRequest = attachedImage;
		promptInput.value = '';
		addMessage('user', imageForRequest != null ? prompt + '\n已附图片：' + imageForRequest.name : prompt);
		chatHistory.push({role: 'user', content: prompt});
		pendingPlan = null;
		planPanel.classList.add('geAiHidden');
		beginProgress(context);
		setRequestPending(true);

		request('aiChat', {input: {
			messages: chatHistory.slice(-12),
			context: context,
			image: imageForRequest
		}}, updateProgress).then(function(plan)
		{
			finishProgress(true);
			if (attachedImage === imageForRequest) clearAttachment();
			chatHistory.push({role: 'assistant', content: plan.reply});
			addMessage('assistant', plan.reply);
			showPlan(plan);
		}).catch(function(error)
		{
			finishProgress(false);
			addMessage('assistant', error.message, true);
		}).finally(function()
		{
			setRequestPending(false);
			promptInput.focus();
		});
	}

	function htmlLabel(value)
	{
		return mxUtils.htmlEntities(String(value)).replace(/\n/g, '<br>');
	}

	function baseStyle(shape)
	{
		switch (shape)
		{
		case 'ellipse': return 'ellipse;whiteSpace=wrap;html=1;';
		case 'diamond': return 'rhombus;whiteSpace=wrap;html=1;';
		case 'note': return 'shape=note;whiteSpace=wrap;html=1;';
		case 'rectangle': return 'rounded=0;whiteSpace=wrap;html=1;';
		default: return 'rounded=1;whiteSpace=wrap;html=1;';
		}
	}

	function applyStyle(cell, style)
	{
		for (var key in style)
		{
			if (Object.prototype.hasOwnProperty.call(style, key))
			{
				mxUtils.setCellStyles(graph.getModel(), [cell], key, style[key]);
			}
		}
	}

	function findCell(id, refs)
	{
		var cell = refs[id] || graph.getModel().getCell(id);

		if (cell == null) throw new Error('找不到图形：' + id);

		return cell;
	}

	function applyLayout(operation, refs)
	{
		var parent = graph.getDefaultParent();
		var cells = operation.ids.map(function(id) { return findCell(id, refs); });

		if (operation.layout === 'circle')
		{
			new mxCircleLayout(graph).execute(parent);
		}
		else if (operation.layout === 'tree')
		{
			var root = cells.length > 0 ? cells[0] : graph.findTreeRoots(parent)[0];

			if (root != null)
			{
				var tree = new mxCompactTreeLayout(graph, false);
				tree.edgeRouting = false;
				tree.execute(parent, root);
			}
		}
		else
		{
			var direction = operation.layout === 'horizontal' ?
				mxConstants.DIRECTION_WEST : mxConstants.DIRECTION_NORTH;
			new mxHierarchicalLayout(graph, direction).execute(parent,
				cells.length > 0 ? cells : null);
		}
	}

	function applyPlan()
	{
		if (pendingPlan == null || pendingPlan.operations.length === 0) return;

		var model = graph.getModel();
		var undoManager = ui.editor.undoManager;
		var previousTopEdit = undoManager.indexOfNextAdd > 0 ?
			undoManager.history[undoManager.indexOfNextAdd - 1] : null;
		var refs = {};
		var deleteCells = [];
		var changed = false;
		var failure = null;
		graph.stopEditing(false);
		model.beginUpdate();

		try
		{
			for (var i = 0; i < pendingPlan.operations.length; i++)
			{
				var operation = pendingPlan.operations[i];
				var cell;

				switch (operation.type)
				{
				case 'addNode':
					cell = graph.insertVertex(graph.getDefaultParent(), null,
						htmlLabel(operation.label), operation.x, operation.y,
						operation.width, operation.height, baseStyle(operation.shape));
					refs[operation.ref] = cell;
					applyStyle(cell, operation.style);
					break;
				case 'updateLabel':
					cell = findCell(operation.id, refs);
					graph.cellLabelChanged(cell, graph.isHtmlLabel(cell) ?
						htmlLabel(operation.label) : operation.label);
					break;
				case 'moveResize':
					cell = findCell(operation.id, refs);
					var geometry = model.getGeometry(cell);

					if (geometry == null) throw new Error('图形没有位置信息：' + operation.id);
					geometry = geometry.clone();
					if (operation.x != null) geometry.x = operation.x;
					if (operation.y != null) geometry.y = operation.y;
					if (operation.width != null) geometry.width = operation.width;
					if (operation.height != null) geometry.height = operation.height;
					model.setGeometry(cell, geometry);
					break;
				case 'connect':
					cell = graph.insertEdge(graph.getDefaultParent(), null,
						htmlLabel(operation.label || ''), findCell(operation.sourceId, refs),
						findCell(operation.targetId, refs),
						'rounded=0;orthogonalLoop=1;jettySize=auto;html=1;edgeStyle=orthogonalEdgeStyle;');
					applyStyle(cell, operation.style);
					break;
				case 'setStyle':
					applyStyle(findCell(operation.id, refs), operation.style);
					break;
				case 'deleteCells':
					deleteCells = deleteCells.concat(operation.ids.map(function(id)
					{
						return findCell(id, refs);
					}));
					break;
				case 'applyLayout':
					applyLayout(operation, refs);
					break;
				default:
					throw new Error('不支持的修改操作：' + operation.type);
				}

				changed = true;
			}

			if (deleteCells.length > 0) graph.removeCells(deleteCells, true);
		}
		catch (error)
		{
			failure = error;
		}
		finally
		{
			model.endUpdate();
		}

		if (failure != null)
		{
			var failedEdit = undoManager.indexOfNextAdd > 0 ?
				undoManager.history[undoManager.indexOfNextAdd - 1] : null;

			if (changed && failedEdit != null && failedEdit !== previousTopEdit)
			{
				undoManager.undo();
			}

			addMessage('assistant', failure.message, true);
			return;
		}

		var count = pendingPlan.operations.length;
		var aiEdit = undoManager.indexOfNextAdd > 0 ?
			undoManager.history[undoManager.indexOfNextAdd - 1] : null;
		pendingPlan = null;
		planPanel.classList.add('geAiHidden');
		addAppliedMessage(count, aiEdit !== previousTopEdit ? aiEdit : null);
		graph.setSelectionCells(Object.keys(refs).map(function(ref) { return refs[ref]; }));
		graph.scrollCellToVisible(graph.getSelectionCell());
		updateContextLabel();
	}

	formatTab.addEventListener('click', function() { showMode('format'); });
	aiTab.addEventListener('click', function() { showMode('ai'); });
	settingsButton.addEventListener('click', function() { showSettings(true); });
	cancelSettingsButton.addEventListener('click', function() { showSettings(false); });
	testConnectionButton.addEventListener('click', testConnection);
	saveSettingsButton.addEventListener('click', saveSettings);
	sendButton.addEventListener('click', sendPrompt);
	attachButton.addEventListener('click', function()
	{
		imageInput.value = '';
		imageInput.click();
	});
	imageInput.addEventListener('change', function()
	{
		if (imageInput.files != null && imageInput.files.length > 0)
		{
			attachImageFile(imageInput.files[0]);
		}
	});
	removeAttachmentButton.addEventListener('click', clearAttachment);
	promptInput.addEventListener('paste', function(event)
	{
		var items = event.clipboardData != null ? event.clipboardData.items : null;

		if (items == null) return;

		for (var i = 0; i < items.length; i++)
		{
			if (items[i].kind === 'file' && /^image\//i.test(items[i].type))
			{
				var file = items[i].getAsFile();

				if (file != null)
				{
					event.preventDefault();
					event.stopPropagation();
					attachImageFile(file);
				}

				break;
			}
		}
	});
	composer.addEventListener('dragover', function(event)
	{
		event.preventDefault();
		event.stopPropagation();
		if (!requestPending) composer.classList.add('geAiDropActive');
	});
	composer.addEventListener('dragleave', function(event)
	{
		if (!composer.contains(event.relatedTarget)) composer.classList.remove('geAiDropActive');
	});
	composer.addEventListener('drop', function(event)
	{
		composer.classList.remove('geAiDropActive');
		event.preventDefault();
		event.stopPropagation();
		if (requestPending) return;

		if (event.dataTransfer != null && event.dataTransfer.files.length > 0)
		{
			attachImageFile(event.dataTransfer.files[0]);
		}
	});
	promptInput.addEventListener('keydown', function(event)
	{
		if (event.key === 'Enter' && !event.shiftKey)
		{
			event.preventDefault();
			sendPrompt();
		}
	});
	cancelPlanButton.addEventListener('click', function()
	{
		pendingPlan = null;
		planPanel.classList.add('geAiHidden');
	});
	applyPlanButton.addEventListener('click', applyPlan);
	undoButton.addEventListener('click', rollbackLastAiChange);
	ui.editor.undoManager.addListener(mxEvent.ADD, updateRollbackState);
	ui.editor.undoManager.addListener(mxEvent.UNDO, updateRollbackState);
	ui.editor.undoManager.addListener(mxEvent.REDO, updateRollbackState);
	ui.editor.undoManager.addListener(mxEvent.CLEAR, updateRollbackState);

	graph.getSelectionModel().addListener(mxEvent.CHANGE, updateContextLabel);
	ui.editor.addListener('fileLoaded', function()
	{
		reattachPanel();
		updateContextLabel();
	});
	ui.addListener('themeInitialized', reattachPanel);
	ui.addListener('currentPageChanged', updateContextLabel);
	ui.__drawioAiReattach = reattachPanel;
	loadConfig();

	var attachChecks = 0;
	var attachTimer = window.setInterval(function()
	{
		attachChecks++;
		reattachPanel();

		if (attachChecks >= 50)
		{
			window.clearInterval(attachTimer);
		}
	}, 100);

	ui.destroyFunctions.push(function()
	{
		if (requestPending) setRequestPending(false);
		window.clearInterval(attachTimer);
		ui.createFormat = ui.__drawioAiOriginalCreateFormat;
		delete ui.__drawioAiReattach;
		delete ui.__drawioAiAssistantInstalled;
		delete ui.__drawioAiCreateFormatPatched;
		delete ui.__drawioAiOriginalCreateFormat;
		if (css.parentNode != null) css.parentNode.removeChild(css);
	});
});
