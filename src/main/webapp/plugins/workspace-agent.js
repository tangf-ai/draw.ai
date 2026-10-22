/**
 * Built-in Pi workspace agent for draw.ai Desktop.
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

	var graph = ui.editor.graph;
	ui.__drawioWorkspaceAgentInstalled = true;

	var maxContextCells = 300;
	var maxContextPages = 12;
	var assistantOpen = false;
	var pageScopeMode = 'current';
	var customPageIds = [];
	var agentState = null;
	var agentBusy = false;
	var agentStopping = false;
	var agentInterruptReady = false;
	var agentLoading = false;
	var agentRun = null;
	var agentActivities = {};
	var agentApprovals = {};
	var agentGraphWasEnabled = null;
	var agentPreparedPath = null;
	var agentDisposed = false;
	var agentImages = [];
	var agentImageLoading = 0;
	var agentImageGeneration = 0;
	var maxAgentImages = 4;
	var maxAgentImageBytes = 5 * 1024 * 1024;
	var markdownFrame = null;
	var quoteTimer = null;
	var quoteIndex = -1;
	var agentCompanionStopping = false;
	var reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
	var agentQuotes = [
		'每一个清晰的想法，都从第一笔开始。',
		'把复杂拆成小步，答案就会慢慢清晰。',
		'不必一次完美，每次改进都有意义。',
		'今天多理清一条思路，就是向前一步。',
		'给灵感一点时间，也给自己一点耐心。',
		'从一个节点开始，让想法慢慢连接。',
		'认真走过的小步，也会通向远方。',
		'你正在把脑海中的可能，变成看得见的图景。',
		'先让想法落地，再让细节发光。',
		'每一次尝试，都在让下一次更从容。',
		'思路偶尔绕路，也可能遇见新的风景。',
		'保持好奇，下一条连线也许就是新发现。'
	];

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
		if (title)
		{
			button.setAttribute('title', title);
			button.setAttribute('aria-label', title);
		}
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

	var css = document.createElement('style');
	css.textContent = [
		'.geAgentLauncher{position:fixed;right:18px;bottom:50px;z-index:40;display:flex;align-items:center;gap:8px;height:44px;padding:0 16px;border:0;border-radius:22px;background:#1a73e8;color:#fff;box-shadow:0 3px 14px #0002;cursor:pointer;font:600 13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;transition:background .15s,transform .15s}',
		'.geAgentLauncher:hover{background:#185abc;transform:translateY(-2px)}',
		'.geAgentLauncher:focus-visible{outline:2px solid #1a73e8;outline-offset:3px}',
		'.geAgentLauncher.geAgentWorking:before{content:"";width:10px;height:10px;border:2px solid #ffffff70;border-top-color:#fff;border-radius:50%;animation:geAgentSpin .8s linear infinite}',
		'.geAgentView{position:fixed;z-index:40;right:18px;bottom:104px;width:min(420px,calc(100vw - 32px));height:min(620px,calc(100vh - 124px));min-height:0;display:flex;flex-direction:column;overflow:hidden;box-sizing:border-box;border:1px solid light-dark(#dce1e8,#454950);border-radius:14px;box-shadow:0 12px 44px #0003;background:light-dark(#fff,#202124);color:light-dark(#202124,#e8eaed);font:13px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;white-space:normal;animation:geAgentReveal .16s ease-out}',
		'.geAgentView.geAgentExpanded{width:min(760px,calc(100vw - 32px));height:min(780px,calc(100vh - 124px))}',
		'.geAgentHeader{display:flex;align-items:center;gap:8px;padding:8px 12px;min-height:44px;box-sizing:border-box;border-bottom:1px solid light-dark(#e8ebf0,#3c4043);background:light-dark(#fafbfd,#25272a)}',
		'.geAgentHeaderTitle{flex:1;font-size:14px;font-weight:600}',
		'.geAgentHeaderMark{color:light-dark(#1a73e8,#8ab4f8);font-size:19px}',
		'.geAgentView:focus{outline:none}',
		'@keyframes geAgentReveal{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}',
		'@media(prefers-reduced-motion:reduce){.geAgentView,.geAgentLauncher{animation:none;transition:none}}',
		'.geAgentToolbar{height:44px;min-height:44px;display:flex;align-items:center;gap:4px;padding:0 8px;border-bottom:1px solid light-dark(#e1e4e8,#3c4043);box-sizing:border-box}',
		'.geAgentContext{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:light-dark(#5f6368,#bdc1c6);font-size:12px}',
		'.geAgentScope{width:86px;min-width:86px;height:28px;border:1px solid light-dark(#c8ccd2,#5f6368);border-radius:4px;background:light-dark(#fff,#303134);color:inherit;font:12px Arial,sans-serif;padding:0 4px;cursor:pointer}',
		'.geAgentScope:disabled{opacity:.55;cursor:default}',
		'.geAgentIconBtn{width:30px;height:30px;border:0;border-radius:4px;background:transparent;color:inherit;font-size:17px;cursor:pointer;padding:0}',
		'.geAgentIconBtn:hover{background:light-dark(#eef1f4,#35363a)}',
		'.geAgentIconBtn:disabled{opacity:.35;cursor:default}',
		'.geAgentMessages{min-height:0;flex:1;overflow-y:auto;padding:12px 12px 8px;box-sizing:border-box}',
		'.geAgentEmpty{min-height:240px;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;box-sizing:border-box;padding:20px 8px;text-align:center}',
		'.geAgentEmptyTitle{margin:18px 0 6px;font-size:16px;font-weight:600;color:inherit}',
		'.geAgentEmptyHint{max-width:260px;color:light-dark(#70757a,#bdc1c6);font-size:12px;line-height:1.7}',
		'.geAgentCompanion{width:100%;max-width:290px;align-self:center;text-align:center;padding:12px 0;box-sizing:border-box}',
		'.geAgentSketch{position:relative;width:144px;height:68px;margin:0 auto 16px;color:light-dark(#1a73e8,#8ab4f8)}',
		'.geAgentSketch:before,.geAgentSketch:after{content:"";position:absolute;top:33px;width:32px;border-top:1px dashed currentColor;opacity:.5}',
		'.geAgentSketch:before{left:32px}.geAgentSketch:after{left:80px}',
		'.geAgentSketchNode{position:absolute;top:20px;width:28px;height:28px;border:1px solid currentColor;border-radius:8px;background:light-dark(#f4f8ff,#29384d);box-sizing:border-box;animation:geAgentNodeBreathe 3.6s ease-in-out infinite}',
		'.geAgentSketchNode:nth-child(1){left:4px;animation-delay:-2.4s}.geAgentSketchNode:nth-child(2){left:58px;transform:rotate(45deg);border-radius:6px;animation-delay:-1.2s}.geAgentSketchNode:nth-child(3){left:112px}',
		'.geAgentQuote{margin:0;min-height:42px;padding:0 10px;color:light-dark(#5f6368,#bdc1c6);font-size:12px;line-height:1.8;overflow-wrap:anywhere}',
		'.geAgentQuoteText{display:block;animation:geAgentQuoteReveal .6s ease-out}',
		'.geAgentRun .geAgentCompanion{max-width:none;margin-top:8px;padding:6px 0}.geAgentRun .geAgentSketch{height:48px;margin-bottom:8px}.geAgentRun .geAgentQuote{min-height:0;font-size:11px}',
		'@keyframes geAgentNodeBreathe{0%,100%{opacity:.45;box-shadow:0 0 0 0 transparent}50%{opacity:1;box-shadow:0 0 0 5px light-dark(#1a73e80c,#8ab4f812)}}',
		'@keyframes geAgentQuoteReveal{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}',
		'.geAgentView.geAgentHidden *,.geAgentCompanion.geAgentHidden *,.geAgentMotionPaused *{animation-play-state:paused!important}',
		'@media(prefers-reduced-motion:reduce){.geAgentView *,.geAgentView *:before,.geAgentView *:after,.geAgentLauncher:before{animation:none!important;transition:none!important}}',
		'.geAgentMessage{margin:0 0 14px;line-height:1.55;word-break:break-word;letter-spacing:0}',
		'.geAgentMessageText{white-space:pre-wrap}',
		'.geAgentMarkdown{white-space:normal;line-height:1.65;overflow-wrap:anywhere}',
		'.geAgentMarkdown>:first-child{margin-top:0}.geAgentMarkdown>:last-child{margin-bottom:0}',
		'.geAgentMarkdown p{margin:0 0 10px}.geAgentMarkdown strong{font-weight:650}',
		'.geAgentMarkdown h1,.geAgentMarkdown h2,.geAgentMarkdown h3,.geAgentMarkdown h4,.geAgentMarkdown h5,.geAgentMarkdown h6{margin:16px 0 8px;font-size:14px;line-height:1.45;font-weight:650}.geAgentMarkdown h1{font-size:18px}.geAgentMarkdown h2{font-size:16px}',
		'.geAgentMarkdown ul,.geAgentMarkdown ol{margin:7px 0 12px;padding-left:22px}.geAgentMarkdown li{margin:4px 0}.geAgentMarkdown li p{margin:4px 0}',
		'.geAgentMarkdown code{padding:2px 4px;border-radius:4px;background:light-dark(#f0f3f7,#31353b);font:12px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace}',
		'.geAgentMarkdown pre{overflow:auto;max-width:100%;padding:12px;border-radius:7px;background:light-dark(#f5f7fa,#282c32)}.geAgentMarkdown pre code{padding:0;background:transparent;white-space:pre}',
		'.geAgentMarkdown blockquote{margin:10px 0;padding:2px 12px;border-left:3px solid light-dark(#b8c9e3,#566987);color:light-dark(#5f6368,#bdc1c6)}',
		'.geAgentMarkdown table{display:block;max-width:100%;overflow:auto;border-collapse:collapse;margin:10px 0;font-size:12px}.geAgentMarkdown th,.geAgentMarkdown td{padding:7px 10px;border:1px solid light-dark(#dfe3e8,#454950);text-align:left}.geAgentMarkdown th{background:light-dark(#f5f7fa,#282c32);font-weight:600}',
		'.geAgentMarkdown a{color:light-dark(#1a73e8,#8ab4f8);text-decoration:underline;text-underline-offset:2px;cursor:pointer}.geAgentMarkdown hr{border:0;border-top:1px solid light-dark(#e1e4e8,#454950);margin:14px 0}',
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
		'.geAgentStream{margin:8px 0 0 20px;line-height:1.6}',
		'.geAgentActivities{display:flex;flex-direction:column;gap:4px;margin:8px 0 0 20px}',
		'.geAgentActivity{position:relative;padding-left:16px;color:light-dark(#5f6368,#bdc1c6);font-size:11px;line-height:1.4;word-break:break-word}',
		'.geAgentActivity:before{content:"";position:absolute;left:1px;top:4px;width:7px;height:7px;border:2px solid light-dark(#b5bac1,#6b7076);border-radius:50%;box-sizing:border-box}',
		'.geAgentActivity.geAgentActivityRunning:before{border-color:#1a73e8;border-top-color:transparent;animation:geAgentSpin .8s linear infinite}',
		'.geAgentActivity.geAgentActivityDone:before{content:"✓";top:0;width:11px;height:11px;border:0;color:light-dark(#188038,#81c995);font-size:11px}',
		'.geAgentActivity.geAgentActivityFailed:before{content:"!";top:0;width:11px;height:11px;border:0;color:light-dark(#b3261e,#f28b82);font-weight:700}',
		'.geAgentApproval{margin:9px 0 0 20px;padding:8px;border:1px solid light-dark(#f0c36d,#8a6534);border-radius:5px;background:light-dark(#fff8e7,#3b3122)}',
		'.geAgentApprovalTitle{font-weight:600;font-size:11px}',
		'.geAgentApprovalDetail{max-height:90px;overflow:auto;margin-top:5px;color:light-dark(#5f6368,#bdc1c6);font:11px/1.4 monospace;white-space:pre-wrap;word-break:break-word}',
		'.geAgentApprovalInput{box-sizing:border-box;width:100%;margin-top:6px;padding:5px;border:1px solid light-dark(#c8ccd2,#5f6368);border-radius:4px;background:light-dark(#fff,#202124);color:inherit;font:11px/1.4 monospace;resize:vertical}',
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
		'.geAgentAttachments{display:flex;gap:8px;overflow-x:auto;max-height:90px;padding:2px}',
		'.geAgentAttachment{position:relative;flex:none;width:68px;min-width:0}',
		'.geAgentAttachment img{display:block;width:68px;height:52px;object-fit:contain;border:1px solid light-dark(#dce1e8,#454950);border-radius:6px;box-sizing:border-box;background:light-dark(#f8f9fa,#292a2e)}',
		'.geAgentAttachmentName{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px;color:light-dark(#70757a,#bdc1c6)}',
		'.geAgentAttachmentRemove{position:absolute;right:-2px;top:-2px;width:18px;height:18px;border:0;border-radius:50%;background:light-dark(#e8eaed,#5f6368);color:inherit;cursor:pointer;line-height:16px;padding:0}',
		'.geAgentImageError{color:light-dark(#b3261e,#f28b82);font-size:11px}',
		'.geAgentAttach{flex:none;font-size:19px}',
		'.geAgentInput{min-width:0;flex:1;resize:none;box-sizing:border-box;min-height:62px;max-height:150px;border:1px solid light-dark(#c8ccd2,#5f6368);border-radius:6px;background:light-dark(#fff,#292a2e);color:inherit;padding:8px;font:13px/1.45 Arial,sans-serif;letter-spacing:0;outline:none}',
		'.geAgentInput:focus{border-color:#1a73e8;box-shadow:0 0 0 1px #1a73e8}',
		'.geAgentSend{width:34px;height:34px;flex:none;border:0;border-radius:4px;background:#188038;color:#fff;font-size:18px;cursor:pointer;padding:0}',
		'.geAgentSend:hover{background:#137333}',
		'.geAgentSend.geAgentSendStop{background:#b3261e}.geAgentSend.geAgentSendStop:hover{background:#8c1d18}',
		'.geAgentSend:disabled{opacity:.45;cursor:default}',
		'.geAgentComposerStatus{min-height:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:light-dark(#70757a,#9aa0a6);font-size:10px}',
		'.geAgentWorkspaceBusy{pointer-events:none!important;filter:saturate(.55);cursor:progress!important}',
		'.geAgentHidden{display:none!important}',
		'@keyframes geAgentSpin{to{transform:rotate(360deg)}}'
	].join('');
	document.head.appendChild(css);

	var agentLauncher = createButton('geAgentLauncher', '✦ AI 助手', '打开 AI 助手');
	agentLauncher.setAttribute('aria-expanded', 'false');
	agentLauncher.setAttribute('aria-controls', 'geAgentFloatingAssistant');
	var agentView = createElement('section', 'geAgentView geAgentHidden');
	agentView.id = 'geAgentFloatingAssistant';
	agentView.setAttribute('aria-label', 'AI 助手');
	var agentHeader = createElement('div', 'geAgentHeader');
	agentHeader.appendChild(createElement('span', 'geAgentHeaderMark', '✦'));
	agentHeader.appendChild(createElement('div', 'geAgentHeaderTitle', 'AI 助手'));
	var agentExpandButton = createButton('geAgentIconBtn', '↗', '放大 AI 助手');
	var agentCloseButton = createButton('geAgentIconBtn', '×', '收起 AI 助手');
	agentHeader.appendChild(agentExpandButton);
	agentHeader.appendChild(agentCloseButton);
	agentView.appendChild(agentHeader);
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
	var agentNewThreadButton = createButton('geAgentIconBtn', '+', '新建独立对话（清空当前上下文）');
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
	var agentEmptyState = createElement('div', 'geAgentEmpty');
	var agentCompanion = createElement('div', 'geAgentCompanion');
	var agentSketch = createElement('div', 'geAgentSketch');
	agentSketch.setAttribute('aria-hidden', 'true');
	for (var sketchIndex = 0; sketchIndex < 3; sketchIndex++)
	{
		agentSketch.appendChild(createElement('span', 'geAgentSketchNode'));
	}
	var agentQuote = createElement('p', 'geAgentQuote');
	agentQuote.setAttribute('aria-live', 'off');
	agentCompanion.appendChild(agentSketch);
	agentCompanion.appendChild(agentQuote);
	var agentEmptyTitle = createElement('div', 'geAgentEmptyTitle', '从一个想法开始');
	var agentEmptyHint = createElement('div', 'geAgentEmptyHint', '描述你想画的内容，或让我帮你整理当前图纸。');
	agentEmptyState.appendChild(agentCompanion);
	agentEmptyState.appendChild(agentEmptyTitle);
	agentEmptyState.appendChild(agentEmptyHint);
	advanceAgentQuote();
	agentMessages.appendChild(agentEmptyState);
	agentView.appendChild(agentMessages);
	var agentComposer = createElement('div', 'geAgentComposer');
	var agentAttachments = createElement('div', 'geAgentAttachments geAgentHidden');
	agentAttachments.setAttribute('aria-label', '待发送图片');
	var agentImageError = createElement('div', 'geAgentImageError geAgentHidden');
	agentImageError.setAttribute('role', 'status');
	var agentImagePicker = createElement('input', 'geAgentHidden');
	agentImagePicker.type = 'file';
	agentImagePicker.accept = 'image/png,image/jpeg,image/webp,image/gif';
	agentImagePicker.multiple = true;
	agentImagePicker.setAttribute('aria-label', '选择图片');
	var agentAttachButton = createButton('geAgentIconBtn geAgentAttach', '＋', '添加图片（也可直接粘贴）');
	var agentComposerRow = createElement('div', 'geAgentComposerRow');
	var agentInput = createElement('textarea', 'geAgentInput');
	agentInput.setAttribute('placeholder', '向 Agent 提交修改要求');
	agentInput.setAttribute('rows', '3');
	var agentSendButton = createButton('geAgentSend', '↑', '发送');
	agentComposerRow.appendChild(agentAttachButton);
	agentComposerRow.appendChild(agentInput);
	agentComposerRow.appendChild(agentSendButton);
	var agentComposerStatus = createElement('div', 'geAgentComposerStatus', '正在读取 Agent 状态…');
	agentComposer.appendChild(agentImagePicker);
	agentComposer.appendChild(agentAttachments);
	agentComposer.appendChild(agentImageError);
	agentComposer.appendChild(agentComposerRow);
	agentComposer.appendChild(agentComposerStatus);
	agentView.appendChild(agentComposer);
	document.body.appendChild(agentView);
	document.body.appendChild(agentLauncher);

	function showAgentImageError(text)
	{
		agentImageError.textContent = text || '';
		agentImageError.classList.toggle('geAgentHidden', !text);
	}

	function renderAgentAttachments()
	{
		agentAttachments.textContent = '';
		agentAttachments.classList.toggle('geAgentHidden', agentImages.length === 0);
		agentImages.forEach(function(image)
		{
			var item = createElement('div', 'geAgentAttachment');
			var preview = createElement('img');
			preview.src = 'data:' + image.mimeType + ';base64,' + image.data;
			preview.alt = image.name;
			var name = createElement('span', 'geAgentAttachmentName', image.name);
			name.title = image.name;
			var remove = createButton('geAgentAttachmentRemove', '×', '移除 ' + image.name);
			remove.addEventListener('click', function()
			{
				agentImages = agentImages.filter(function(value) { return value !== image; });
				showAgentImageError('');
				renderAgentAttachments();
			});
			item.appendChild(preview);
			item.appendChild(name);
			item.appendChild(remove);
			agentAttachments.appendChild(item);
		});
	}

	async function addAgentImages(files)
	{
		if (agentInput.disabled || agentStopping || agentDisposed) return;
		var generation = agentImageGeneration;
		agentImageLoading++;
		updateAgentControls();
		showAgentImageError('');
		try
		{
			for (var i = 0; i < files.length; i++)
			{
				if (generation !== agentImageGeneration || agentDisposed) break;
				var file = files[i];
				if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type))
				{
					showAgentImageError('支持 PNG、JPEG、WebP 和 GIF 图片');
					continue;
				}
				if (file.size === 0 || file.size > maxAgentImageBytes)
				{
					showAgentImageError('每张图片需大于 0 且不超过 5 MB');
					continue;
				}
				if (agentImages.length >= maxAgentImages)
				{
					showAgentImageError('每条消息最多添加 4 张图片');
					break;
				}
				var dataUrl = await new Promise(function(resolve, reject)
				{
					var reader = new FileReader();
					reader.onload = function() { resolve(reader.result); };
					reader.onerror = function() { reject(new Error('图片读取失败，请重试')); };
					reader.readAsDataURL(file);
				});
				// Reject corrupt files before showing a broken preview.
				await new Promise(function(resolve, reject)
				{
					var preview = new Image();
					preview.onload = resolve;
					preview.onerror = function() { reject(new Error('图片无法读取，请选择有效图片')); };
					preview.src = dataUrl;
				});
				if (generation !== agentImageGeneration || agentDisposed) break;
				if (agentImages.length >= maxAgentImages)
				{
					showAgentImageError('每条消息最多添加 4 张图片');
					break;
				}
				agentImages.push({name: file.name || '剪贴板图片.png', mimeType: file.type,
					data: dataUrl.slice(dataUrl.indexOf(',') + 1)});
				renderAgentAttachments();
			}
		}
		catch (error)
		{
			if (generation === agentImageGeneration && !agentDisposed) showAgentImageError(error.message);
		}
		finally
		{
			agentImageLoading--;
			if (!agentDisposed) updateAgentControls();
		}
	}

	function restoreAgentDraft(text, images)
	{
		if (!agentDisposed && !agentInput.value && agentImages.length === 0 && !agentImageLoading)
		{
			agentInput.value = text;
			agentImages = images;
			renderAgentAttachments();
		}
	}

	function advanceAgentQuote()
	{
		// Pick a different local quote; no model request or conversation entry.
		quoteIndex = quoteIndex < 0 ? Math.floor(Math.random() * agentQuotes.length) :
			(quoteIndex + 1 + Math.floor(Math.random() * (agentQuotes.length - 1))) % agentQuotes.length;
		agentQuote.replaceChildren(createElement('span', 'geAgentQuoteText', agentQuotes[quoteIndex]));
	}

	function updateAgentCompanion()
	{
		var target = null;
		if (agentEmptyState.parentNode === agentMessages &&
			(agentState == null || agentState.configured !== false)) target = agentEmptyState;
		else if (agentBusy && !agentCompanionStopping && agentRun != null &&
			!(agentRun.stream.__agentMarkdownSource || '') &&
			Object.keys(agentApprovals).length === 0) target = agentRun.card;

		if (target != null && agentCompanion.parentNode !== target)
		{
			if (target === agentEmptyState) target.insertBefore(agentCompanion, agentEmptyTitle);
			else target.appendChild(agentCompanion);
			advanceAgentQuote();
		}
		agentCompanion.classList.toggle('geAgentHidden', target == null);
		agentView.classList.toggle('geAgentMotionPaused', document.hidden);
		var rotate = target != null && assistantOpen && !document.hidden &&
			!reducedMotion.matches && !agentDisposed;
		if (!rotate && quoteTimer != null)
		{
			window.clearInterval(quoteTimer);
			quoteTimer = null;
		}
		else if (rotate && quoteTimer == null)
		{
			quoteTimer = window.setInterval(advanceAgentQuote, 12000);
		}
	}

	document.addEventListener('visibilitychange', updateAgentCompanion);
	reducedMotion.addEventListener('change', updateAgentCompanion);

	function renderAgentMarkdown(element, text)
	{
		element.__agentMarkdownSource = String(text || '');
		element.classList.add('geAgentMarkdown');
		if (window.marked == null || window.DOMPurify == null)
		{
			element.textContent = element.__agentMarkdownSource;
			return;
		}

		try
		{
			var html = window.marked.parse(element.__agentMarkdownSource,
				{gfm: true, breaks: true, async: false});
			element.innerHTML = window.DOMPurify.sanitize(html, {
				ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'del', 's', 'h1', 'h2', 'h3', 'h4', 'h5',
					'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'hr', 'table', 'thead',
					'tbody', 'tr', 'th', 'td', 'a'],
				ALLOWED_ATTR: ['href', 'title', 'start'], ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false
			});
			Array.prototype.forEach.call(element.querySelectorAll('a'), function(link)
			{
				if (!/^(https?:\/\/|mailto:)/i.test(link.getAttribute('href') || ''))
				{
					link.removeAttribute('href');
				}
			});
		}
		catch (error)
		{
			element.textContent = element.__agentMarkdownSource;
		}
	}

	if (window.__drawAiMarkdownReady == null)
	{
		window.__drawAiMarkdownReady = new Promise(function(resolve)
		{
			if (window.marked != null) { resolve(); return; }
			var script = document.createElement('script');
			script.src = './js/marked/marked.umd.js';
			script.onload = resolve;
			script.onerror = resolve;
			document.head.appendChild(script);
		});
	}
	window.__drawAiMarkdownReady.then(function()
	{
		if (agentDisposed) return;
		Array.prototype.forEach.call(agentView.querySelectorAll('.geAgentMarkdown'), function(element)
		{
			renderAgentMarkdown(element, element.__agentMarkdownSource);
		});
	});
	agentView.addEventListener('click', function(event)
	{
		var link = event.target.closest != null ? event.target.closest('a') : null;
		if (link == null || !agentView.contains(link)) return;
		event.preventDefault();
		var href = link.getAttribute('href') || '';
		if (/^(https?:\/\/|mailto:)/i.test(href))
		{
			request('openExternal', {url: href}).catch(function(error)
			{
				addAgentMessage({role: 'assistant', text: error.message || '链接打开失败'}, true);
			});
		}
	});

	function setAssistantOpen(open)
	{
		assistantOpen = open === true;
		agentView.classList.toggle('geAgentHidden', !assistantOpen);
		agentLauncher.setAttribute('aria-expanded', String(assistantOpen));
		agentLauncher.title = assistantOpen ? '收起 AI 助手' : '打开 AI 助手';
		updateAgentCompanion();
		if (assistantOpen)
		{
			updateContextLabel();
			loadAgentState().then(function()
			{
				if (assistantOpen && !agentDisposed && !agentInput.disabled) agentInput.focus();
			});
		}
		else agentLauncher.focus();
	}

	function ensureFloatingPanel()
	{
		if (agentView.parentNode !== document.body) document.body.appendChild(agentView);
		if (agentLauncher.parentNode !== document.body) document.body.appendChild(agentLauncher);
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
		if (agentStopping) return '正在停止任务…';
		if (agentBusy) return '任务执行中 · Enter 补充要求';
		var runtime = agentState.model || agentState.command || 'pi';
		return (agentState.sessionId ? '当前对话 · ' : '新对话 · ') + runtime;
	}

	function updateAgentControls()
	{
		agentLauncher.classList.toggle('geAgentWorking', agentBusy);
		agentComposerStatus.textContent = agentImageLoading > 0 ? '正在读取图片…' : agentStatusText();
		agentAttachments.setAttribute('aria-busy', agentImageLoading > 0 ? 'true' : 'false');
		agentSendButton.disabled = agentLoading || agentStopping || (!agentBusy && agentImageLoading > 0) ||
			(agentState != null && agentState.configured === false);
		agentInput.disabled = agentLoading ||
			(agentState != null && agentState.configured === false);
		agentAttachButton.disabled = agentInput.disabled || agentStopping;
		agentSendButton.textContent = agentBusy ? '■' : '↑';
		agentSendButton.title = agentStopping ? '正在停止任务…' : (agentBusy ? '停止任务' : '发送');
		agentSendButton.setAttribute('aria-label', agentSendButton.title);
		agentSendButton.classList.toggle('geAgentSendStop', agentBusy);
		agentInput.setAttribute('placeholder', agentBusy ? '补充要求后按 Enter 发送' :
			(agentState != null && agentState.sessionId ? '继续对话，可粘贴图片' : '描述修改要求，或粘贴图片'));
		agentNewThreadButton.disabled = agentBusy || agentLoading;
		agentProfileButton.disabled = agentBusy || agentLoading;
		agentRollbackButton.disabled = agentBusy || agentLoading ||
			agentState == null || agentState.canRollback !== true;
		agentStopButton.disabled = !agentBusy || agentStopping;
		updatePageScopeOptions();
		updateAgentCompanion();
	}

	function showAgentProfileDialog()
	{
		if (agentBusy || agentLoading) return;
		var dialog = createElement('div', 'geAgentProfileDialog');
		var title = createElement('div', 'geAgentProfileTitle', 'Agent 模型配置');
		var hint = createElement('div', 'geAgentProfileHint',
			'选择 Pi 中可用的模型，或使用默认模型。保存后对下一轮任务生效。');
		var commandField = createElement('div', 'geAgentProfileField');
		var commandLabel = createElement('label', null, 'Pi 命令');
		var commandInput = createElement('input', 'geAgentProfileInput');
		commandInput.type = 'text';
		commandInput.autocomplete = 'off';
		commandInput.spellcheck = false;
		commandInput.value = agentState != null && agentState.command ? agentState.command : 'pi';
		commandLabel.htmlFor = 'geAgentPiCommand';
		commandInput.id = 'geAgentPiCommand';
		commandField.appendChild(commandLabel);
		commandField.appendChild(commandInput);
		var modelField = createElement('div', 'geAgentProfileField');
		var modelLabel = createElement('label', null, '模型');
		var modelSelect = createElement('select', 'geAgentProfileInput');
		var modelInput = createElement('input', 'geAgentProfileInput');
		modelInput.type = 'text';
		modelInput.autocomplete = 'off';
		modelInput.spellcheck = false;
		modelInput.placeholder = '例如 provider/模型，如 m4/gpt-5.6-sol';
		modelInput.value = agentState != null && agentState.model ? agentState.model : '';
		modelLabel.htmlFor = 'geAgentPiModel';
		modelSelect.id = 'geAgentPiModel';
		modelInput.id = 'geAgentPiCustomModel';
		modelInput.setAttribute('aria-label', '自定义模型名称');
		modelField.appendChild(modelLabel);
		modelField.appendChild(modelSelect);
		modelField.appendChild(modelInput);
		var modelStatus = createElement('div', 'geAgentProfileHint');
		modelStatus.setAttribute('role', 'status');
		var refreshButton = createButton('geAgentButton', '刷新模型');
		var models = [];
		var loadVersion = 0;
		var profileEdited = false;

		function selectedModel()
		{
			return modelSelect.value === '__custom__' ? modelInput.value : modelSelect.value;
		}

		function updateCustomInput()
		{
			modelInput.style.display = modelSelect.value === '__custom__' ? '' : 'none';
		}

		function renderModels(value, custom)
		{
			modelSelect.textContent = '';
			var defaultOption = createElement('option', null, '使用 Pi 默认模型');
			defaultOption.value = '';
			modelSelect.appendChild(defaultOption);
			var groups = Object.create(null);
			var found = value === '';

			models.forEach(function(model)
			{
				var group = groups[model.provider];
				if (group == null)
				{
					group = createElement('optgroup');
					group.label = model.provider;
					groups[model.provider] = group;
					modelSelect.appendChild(group);
				}
				var option = createElement('option', null,
					model.name === model.id ? model.id : model.name + ' (' + model.id + ')');
				option.value = model.provider + '/' + model.id;
				if (option.value === value) found = true;
				group.appendChild(option);
			});

			if (!found && !custom)
			{
				var currentOption = createElement('option', null, '当前配置：' + value);
				currentOption.value = value;
				modelSelect.appendChild(currentOption);
			}
			var customOption = createElement('option', null, '手动输入模型…');
			customOption.value = '__custom__';
			modelSelect.appendChild(customOption);
			modelSelect.value = custom ? '__custom__' : value;
			updateCustomInput();
		}

		function loadModels()
		{
			var version = ++loadVersion;
			models = [];
			renderModels(selectedModel(), modelSelect.value === '__custom__');
			modelStatus.textContent = '正在读取可用模型…';
			refreshButton.disabled = true;
			request('workspaceAgentListModels', {command: commandInput.value}).then(function(result)
			{
				if (version !== loadVersion) return;
				models = result.models || [];
				renderModels(selectedModel(), modelSelect.value === '__custom__');
				modelStatus.textContent = models.length > 0 ? '已加载 ' + models.length + ' 个可用模型' :
					'Pi 暂无可用模型，可使用默认模型或手动输入。';
			}).catch(function(loadError)
			{
				if (version !== loadVersion) return;
				modelStatus.textContent = '模型列表读取失败：' + (loadError.message || '请检查 Pi 命令') +
					'。可重试或手动输入。';
			}).then(function()
			{
				if (version === loadVersion) refreshButton.disabled = false;
			});
		}

		renderModels(modelInput.value, false);
		modelSelect.addEventListener('change', function()
		{
			profileEdited = true;
			updateCustomInput();
			if (modelSelect.value === '__custom__') modelInput.focus();
		});
		modelInput.addEventListener('input', function() { profileEdited = true; });
		commandInput.addEventListener('input', function() { profileEdited = true; });
		commandInput.addEventListener('change', loadModels);
		refreshButton.addEventListener('click', loadModels);
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
				model: selectedModel()
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
		actions.insertBefore(refreshButton, cancelButton);
		dialog.appendChild(title);
		dialog.appendChild(hint);
		dialog.appendChild(commandField);
		dialog.appendChild(modelField);
		dialog.appendChild(modelStatus);
		dialog.appendChild(error);
		dialog.appendChild(actions);
		ui.showDialog(dialog, 440, 390, true, true);
		request('workspaceAgentGetProfile').then(function(profile)
		{
			if (profileEdited) return;
			agentState = Object.assign({}, agentState || {}, profile);
			commandInput.value = profile.command || 'pi';
			modelInput.value = profile.model || '';
			renderModels(modelInput.value, false);
		}).catch(function() {}).then(loadModels);
		window.setTimeout(function() { commandInput.focus(); commandInput.select(); }, 0);
	}

	function setAgentBusy(busy)
	{
		busy = busy === true;
		if (!busy)
		{
			agentStopping = false;
			agentInterruptReady = false;
		}

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
		updateAgentCompanion();
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
		var body = createElement('div', 'geAgentMessageText');
		if (role === 'assistant') renderAgentMarkdown(body, message.text);
		else body.textContent = message.text || '';
		node.appendChild(body);
		var metaParts = [];

		if (message.steered === true) metaParts.push('补充要求');
		if (Array.isArray(message.images) && message.images.length)
		{
			metaParts.push('图片 ' + message.images.length + ' 张：' + message.images.map(function(image)
			{
				return image.name || '图片';
			}).join('、'));
		}
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
		if (markdownFrame != null) window.cancelAnimationFrame(markdownFrame);
		markdownFrame = null;
		agentMessages.textContent = '';
		agentRun = null;
		agentActivities = {};
		agentApprovals = {};
		items = Array.isArray(items) ? items : [];

		for (var i = 0; i < items.length; i++) addAgentMessage(items[i]);

		if (items.length === 0)
		{
			var unconfigured = agentState != null && agentState.configured === false;
			agentEmptyTitle.textContent = unconfigured ? '未设置工作区' : '从一个想法开始';
			agentEmptyHint.textContent = unconfigured ? '先打开工作区和图文件，再开始与助手协作。' :
				'描述你想画的内容，或让我帮你整理当前图纸。';
			agentMessages.appendChild(agentEmptyState);
		}
		updateAgentCompanion();
	}

	function beginAgentRun(label)
	{
		agentCompanionStopping = false;
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
		return agentRun || beginAgentRun('Pi 正在处理图纸');
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

	function resolveAgentApproval(id, decision, approvalNode, value)
	{
		var controls = approvalNode.querySelectorAll('button, input, textarea');
		for (var i = 0; i < controls.length; i++) controls[i].disabled = true;

		request('workspaceAgentApprove', {input: {id: id, decision: decision, value: value}}).catch(function(error)
		{
			for (var i = 0; i < controls.length; i++) controls[i].disabled = false;
			var detail = approvalNode.querySelector('.geAgentApprovalDetail');
			if (detail != null) detail.textContent = error.message;
		});
	}

	function addAgentApproval(approval)
	{
		if (approval == null || approval.id == null || agentApprovals[approval.id] != null) return;
		var run = ensureAgentRun();
		var node = createElement('div', 'geAgentApproval');
		var typeName = {confirm: '确认请求', select: '选择请求', input: '输入请求',
			editor: '编辑请求'}[approval.type] || 'Pi 请求';
		node.appendChild(createElement('div', 'geAgentApprovalTitle', typeName));
		node.appendChild(createElement('div', 'geAgentApprovalDetail',
			approval.detail || 'Pi 请求继续执行'));
		var control = null;

		if (approval.type === 'input' || approval.type === 'editor')
		{
			control = createElement('textarea', 'geAgentApprovalInput');
			control.rows = approval.type === 'editor' ? 4 : 2;
			control.spellcheck = false;
			control.value = approval.prefill || '';
			node.appendChild(control);
		}

		var actions = createElement('div', 'geAgentApprovalActions');

		if (Array.isArray(approval.options) && approval.options.length > 0)
		{
			approval.options.forEach(function(option)
			{
				var optionButton = createButton('geAgentButton', option);
				optionButton.title = option;
				optionButton.addEventListener('click', function()
				{
					resolveAgentApproval(approval.id, 'accept', node, option);
				});
				actions.appendChild(optionButton);
			});
		}
		else
		{
			var decline = createButton('geAgentButton', '拒绝');
			decline.addEventListener('click', function()
			{
				resolveAgentApproval(approval.id, 'decline', node);
			});
			var accept = createButton('geAgentButton geAgentButtonPrimary', '允许');
			accept.addEventListener('click', function()
			{
				if (control != null && control.value === '')
				{
					control.focus();
					return;
				}
				resolveAgentApproval(approval.id, 'accept', node,
					control != null ? control.value : undefined);
			});
			actions.appendChild(decline);
			actions.appendChild(accept);
		}

		var cancel = createButton('geAgentButton', '取消');
		cancel.addEventListener('click', function()
		{
			resolveAgentApproval(approval.id, 'cancel', node);
		});
		actions.appendChild(cancel);

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
			run.status.textContent = agentStopping ? '正在停止任务…' : (event.label || 'Pi 正在执行');
			if (event.phase === 'connecting')
			{
				agentInterruptReady = true;
				if (agentStopping) requestAgentStop();
			}
		}
		else if (event.type === 'message-delta')
		{
			run.stream.__agentMarkdownSource = (run.stream.__agentMarkdownSource || '') + (event.delta || '');
			if (markdownFrame == null)
			{
				markdownFrame = window.requestAnimationFrame(function()
				{
					markdownFrame = null;
					if (!agentDisposed) renderAgentMarkdown(run.stream, run.stream.__agentMarkdownSource);
					scrollAgentMessages();
				});
			}
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
			agentInterruptReady = next.busy === true;
			renderAgentHistory(next.messages);
			setAgentBusy(next.busy === true);

			if (next.busy === true && agentRun == null)
			{
				beginAgentRun('Pi 正在其他窗口执行');
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

	async function sendAgentSteer(text, images)
	{
		agentInput.value = '';
		agentImages = [];
		renderAgentAttachments();
		addAgentMessage({role: 'user', text: text, images: images, steered: true});

		try
		{
			await request('workspaceAgentSteer', {text: text, images: images});
		}
		catch (error)
		{
			restoreAgentDraft(text, images);
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
		var images = agentImages.slice();
		if ((prompt === '' && images.length === 0) || agentLoading || agentStopping || agentImageLoading ||
			agentInput.disabled) return;
		if (prompt === '') prompt = '请根据附图帮助我绘制或修改当前图纸。';
		showAgentImageError('');

		if (agentBusy)
		{
			sendAgentSteer(prompt, images);
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
		agentImages = [];
		renderAgentAttachments();
		addAgentMessage({role: 'user', text: prompt, images: images});
		beginAgentRun('正在保存当前图纸');
		setAgentBusy(true);
		var prepared = null;

		try
		{
			prepared = await saveCurrentFileForAgent(true);
			if (agentStopping)
			{
				restoreAgentDraft(prompt, images);
				await restoreCurrentFileAfterAgent(prepared.path, false);
				prepared = null;
				setAgentBusy(false);
				await loadAgentState(true);
				if (!agentDisposed) addAgentMessage({role: 'assistant', text: '任务已停止'});
				return;
			}
			await request('workspaceAgentChat', {input: {
				prompt: prompt,
				images: images,
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
			if (error.code !== 'WORKSPACE_AGENT_INTERRUPTED') restoreAgentDraft(prompt, images);
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
				agentImageGeneration++;
				agentImages = [];
				agentInput.value = '';
				renderAgentAttachments();
				showAgentImageError('');
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

	function requestAgentStop()
	{
		request('workspaceAgentInterrupt').catch(function(error)
		{
			agentStopping = false;
			agentCompanionStopping = false;
			addAgentMessage({role: 'assistant', text: error.message}, true);
			updateAgentControls();
		});
	}

	function stopAgent()
	{
		if (!agentBusy || agentStopping) return;
		agentCompanionStopping = true;
		agentStopping = true;
		ensureAgentRun().status.textContent = '正在停止任务…';
		scrollAgentMessages();
		updateAgentControls();
		// The backend can abort only after its checkpoint and Pi connection are ready.
		if (agentInterruptReady) requestAgentStop();
	}

	function handleAgentSendClick()
	{
		if (agentBusy) stopAgent();
		else sendAgentPrompt();
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

	agentLauncher.addEventListener('click', function() { setAssistantOpen(!assistantOpen); });
	agentCloseButton.addEventListener('click', function() { setAssistantOpen(false); });
	agentExpandButton.addEventListener('click', function()
	{
		var expanded = agentView.classList.toggle('geAgentExpanded');
		agentExpandButton.textContent = expanded ? '↙' : '↗';
		agentExpandButton.title = expanded ? '缩小 AI 助手' : '放大 AI 助手';
		agentExpandButton.setAttribute('aria-label', agentExpandButton.title);
	});
	// Keep assistant input and text selection independent of canvas shortcuts.
	['mousedown', 'pointerdown', 'keydown', 'keyup', 'contextmenu', 'paste'].forEach(function(type)
	{
		agentView.addEventListener(type, function(event) { event.stopPropagation(); });
		agentLauncher.addEventListener(type, function(event) { event.stopPropagation(); });
	});
	agentAttachButton.addEventListener('click', function() { agentImagePicker.click(); });
	agentImagePicker.addEventListener('change', function()
	{
		var files = Array.from(agentImagePicker.files || []);
		agentImagePicker.value = '';
		addAgentImages(files);
	});
	agentInput.addEventListener('paste', function(event)
	{
		var files = Array.from(event.clipboardData != null ? event.clipboardData.items : []).
			filter(function(item) { return item.kind === 'file' && item.type.indexOf('image/') === 0; }).
			map(function(item) { return item.getAsFile(); }).filter(Boolean);
		if (files.length > 0)
		{
			event.preventDefault();
			addAgentImages(files);
		}
	});
	agentPageScopeSelect.addEventListener('change', handlePageScopeChange);
	agentSendButton.addEventListener('click', handleAgentSendClick);
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
		if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229)
		{
			event.preventDefault();
			sendAgentPrompt();
		}
	});
	agentView.addEventListener('keydown', function(event)
	{
		if (event.key === 'Escape' && !event.isComposing && ui.dialog == null)
		{
			event.preventDefault();
			setAssistantOpen(false);
		}
	});

	graph.getSelectionModel().addListener(mxEvent.CHANGE, updateContextLabel);
	ui.editor.addListener('pageSelected', updateContextLabel);
	ui.editor.addListener('pageRenamed', updateContextLabel);
	ui.editor.addListener('pageMoved', updateContextLabel);
	ui.editor.addListener('pagesPatched', updateContextLabel);
	ui.editor.addListener('fileLoaded', function()
	{
		ensureFloatingPanel();
		updateContextLabel();
	});
	ui.addListener('themeInitialized', ensureFloatingPanel);
	ui.addListener('currentPageChanged', updateContextLabel);
	loadAgentState();

	ui.destroyFunctions.push(function()
	{
		agentDisposed = true;
		agentImageGeneration++;
		agentImages = [];
		if (quoteTimer != null) window.clearInterval(quoteTimer);
		document.removeEventListener('visibilitychange', updateAgentCompanion);
		reducedMotion.removeEventListener('change', updateAgentCompanion);
		if (markdownFrame != null) window.cancelAnimationFrame(markdownFrame);
		if (agentBusy && agentGraphWasEnabled) graph.setEnabled(true);
		if (agentView.parentNode != null) agentView.parentNode.removeChild(agentView);
		if (agentLauncher.parentNode != null) agentLauncher.parentNode.removeChild(agentLauncher);
		delete ui.__drawioWorkspaceAgentInstalled;
		if (css.parentNode != null) css.parentNode.removeChild(css);
	});
});
