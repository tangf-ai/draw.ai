Draw.loadPlugin(function(ui)
{
	var sidebar = ui.sidebar;
	var paletteId = 'draw-ai-common';

	if (sidebar == null || ui.__drawAiCommonShapesInstalled) return;
	ui.__drawAiCommonShapesInstalled = true;
	sidebar.configuration = sidebar.configuration.concat([{id: paletteId}]);

	var css = document.createElement('style');
	css.textContent = [
		'.geCommonShapes{padding:4px 8px 10px!important;box-sizing:border-box}',
		'.geCommonShapesHeading{padding:10px 2px 6px;font:11px Arial,sans-serif;color:light-dark(#70757a,#bdc1c6)}',
		'.geCommonShapesGrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(88px,1fr));gap:4px}',
		'.geCommonShapes .geItem{position:relative;display:block;width:100%!important;height:64px!important;margin:0!important;box-sizing:border-box;border:1px solid transparent;border-radius:6px}',
		'.geCommonShapes .geItem:hover{background:light-dark(#f1f5fb,#303744);border-color:light-dark(#d5dfed,#596779)}',
		'.geCommonShapes .geItem:focus-visible{outline:2px solid #1a73e8;outline-offset:-2px}',
		'.geCommonShapes .geItem>svg{display:block;margin:2px auto 0}',
		'.geCommonShapesLabel{position:absolute;left:2px;right:2px;bottom:5px;text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:11px Arial,sans-serif;color:inherit;pointer-events:none}'
	].join('');
	document.head.appendChild(css);

	var base = 'whiteSpace=wrap;html=1;align=center;verticalAlign=middle;fontSize=16;spacing=10;shadow=0;';
	var rounded = base + 'rounded=1;arcSize=20;';
	var rootStyle = rounded + 'fillColor=#3157D5;strokeColor=#3157D5;fontColor=#FFFFFF;fontStyle=1;';
	var blueStyle = rounded + 'fillColor=#EAF0FF;strokeColor=#9BB2F0;fontColor=#274690;';
	var greenStyle = rounded + 'fillColor=#E7F5EF;strokeColor=#91CBB3;fontColor=#23674D;';
	var orangeStyle = rounded + 'fillColor=#FFF1E3;strokeColor=#E8BC8D;fontColor=#92571F;';
	var lineStyle = 'edgeStyle=orthogonalEdgeStyle;rounded=1;curved=1;html=1;endArrow=none;startArrow=none;strokeWidth=2;strokeColor=#8EA5DE;';
	var flowLineStyle = 'edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;endArrow=block;endFill=1;strokeWidth=2;strokeColor=#64748B;fontSize=13;fontColor=#475569;labelBackgroundColor=#FFFFFF;';
	var startStyle = base + 'rounded=1;arcSize=100;fillColor=#E7F5EF;strokeColor=#91CBB3;fontColor=#23674D;';
	var endStyle = base + 'rounded=1;arcSize=100;fillColor=#FCEBEC;strokeColor=#E0A3AA;fontColor=#96444F;';
	var processStyle = base + 'shape=rectangle;rounded=0;fillColor=#EAF0FF;strokeColor=#9BB2F0;fontColor=#274690;';
	var decisionStyle = base + 'rhombus;fillColor=#FFF1E3;strokeColor=#E8BC8D;fontColor=#92571F;';

	function vertex(value, style, x, y, width, height)
	{
		var cell = new mxCell(value, new mxGeometry(x, y, width, height), style);
		cell.vertex = true;
		return cell;
	}

	function edge(source, target, style)
	{
		var cell = new mxCell('', new mxGeometry(), style);
		cell.geometry.relative = true;
		cell.edge = true;
		cell.setTerminal(source, true);
		cell.setTerminal(target, false);
		return cell;
	}

	function node(title, value, style, width, height, tags)
	{
		return entry(title, [vertex(value, style, 0, 0, width, height)], width, height, tags);
	}

	function entry(title, cells, width, height, tags)
	{
		var create = sidebar.addEntry('常用 节点 ' + tags + ' ' + title, function()
		{
			var item = sidebar.createVertexTemplateFromCells(cells, width, height, title,
				true, false, null, true, null, 78, 36);
			item.setAttribute('aria-label', title);
			var label = document.createElement('span');
			label.className = 'geCommonShapesLabel';
			label.textContent = title;
			item.appendChild(label);
			return item;
		});
		create.parentLibraries = [{id: paletteId}];
		return create;
	}

	function connector(title, style, tags)
	{
		var cell = new mxCell('', new mxGeometry(0, 0, 160, 60), style);
		cell.geometry.relative = true;
		cell.geometry.setTerminalPoint(new mxPoint(0, 60), true);
		cell.geometry.setTerminalPoint(new mxPoint(160, 0), false);
		cell.edge = true;
		return entry(title, [cell], 160, 60, tags);
	}

	function mindmap(title, bilateral)
	{
		var center = vertex('中心主题', rootStyle, bilateral ? 210 : 0, 65, 160, 64);
		var cells = [center];
		var colors = [blueStyle, greenStyle, orangeStyle];
		var count = bilateral ? 4 : 3;

		for (var i = 0; i < count; i++)
		{
			var left = bilateral && i < 2;
			var branch = vertex('分支主题 ' + (i + 1), colors[i % colors.length],
				left ? 0 : (bilateral ? 420 : 230), bilateral ? (i % 2) * 130 : i * 72, 150, 48);
			cells.push(branch);
			cells.push(edge(center, branch, lineStyle));
		}

		return entry(title, cells, bilateral ? 570 : 380, 192, '脑图 思维导图 mindmap mind map 骨架 模板 template');
	}

	function flowchart()
	{
		var start = vertex('开始', startStyle, 200, 0, 140, 52);
		var process = vertex('处理步骤', processStyle, 190, 104, 160, 60);
		var decision = vertex('是否满足条件？', decisionStyle, 200, 216, 140, 88);
		var yes = vertex('执行操作', processStyle, 0, 360, 160, 60);
		var no = vertex('其他处理', processStyle, 380, 360, 160, 60);
		var end = vertex('结束', endStyle, 200, 490, 140, 52);
		var yesEdge = edge(decision, yes, flowLineStyle + 'exitX=0;exitY=0.5;entryX=0.5;entryY=0;');
		var noEdge = edge(decision, no, flowLineStyle + 'exitX=1;exitY=0.5;entryX=0.5;entryY=0;');
		yesEdge.value = '是';
		noEdge.value = '否';
		var vertical = flowLineStyle + 'exitX=0.5;exitY=1;entryX=0.5;entryY=0;';

		return entry('分支流程图', [start, process, decision, yes, no, end,
			edge(start, process, vertical), edge(process, decision, vertical), yesEdge, noEdge,
			edge(yes, end, vertical), edge(no, end, vertical)], 540, 542,
			'流程图 flowchart flow chart 分支 判断 骨架 模板 template');
	}

	var sections = [
		{title: '脑图节点', entries: [
			node('中心主题', '中心主题', rootStyle, 180, 68, '脑图 思维导图 mindmap mind map 中心 root'),
			node('蓝色分支', '分支主题', blueStyle, 160, 52, '脑图 思维导图 mindmap mind map 分支 branch 蓝色'),
			node('绿色分支', '分支主题', greenStyle, 160, 52, '脑图 思维导图 mindmap mind map 分支 branch 绿色'),
			node('橙色分支', '分支主题', orangeStyle, 160, 52, '脑图 思维导图 mindmap mind map 分支 branch 橙色'),
			node('子主题', '子主题', rounded + 'fillColor=#F7F8FC;strokeColor=#CDD4E0;fontColor=#475569;fontSize=14;', 140, 44, '脑图 思维导图 mindmap mind map 子主题 child'),
			node('下划线主题', '子主题', base + 'shape=partialRectangle;top=0;left=0;right=0;bottom=1;fillColor=none;strokeColor=#7C96D8;fontColor=#33466E;strokeWidth=2;', 140, 44, '脑图 思维导图 mindmap mind map 下划线 underline')
		]},
		{title: '流程图节点', entries: [
			node('开始', '开始', startStyle, 140, 52, '流程图 flowchart flow chart 起点 start terminator'),
			node('结束', '结束', endStyle, 140, 52, '流程图 flowchart flow chart 终点 end terminator'),
			node('处理步骤', '处理步骤', processStyle, 160, 60, '流程图 flowchart flow chart 矩形 处理 process step'),
			node('判断节点', '判断条件', decisionStyle, 140, 88, '流程图 flowchart flow chart 菱形 判断 decision diamond'),
			node('输入／输出', '输入／输出', base + 'shape=parallelogram;perimeter=parallelogramPerimeter;fixedSize=1;fillColor=#E3F5F7;strokeColor=#88C8D0;fontColor=#216672;', 160, 60, '流程图 flowchart flow chart 输入 输出 input output data'),
			node('子流程', '子流程', base + 'shape=process;fillColor=#F0EBFC;strokeColor=#B5A0E3;fontColor=#66459A;', 160, 60, '流程图 flowchart flow chart 子流程 预定义 subprocess predefined process'),
			node('文档', '文档', base + 'shape=document;boundedLbl=1;fillColor=#FFF8D6;strokeColor=#DFCE87;fontColor=#7B692F;', 150, 88, '流程图 flowchart flow chart 文档 document'),
			node('数据库', '数据', base + 'shape=cylinder3;boundedLbl=1;size=15;fillColor=#E7F5EF;strokeColor=#91CBB3;fontColor=#23674D;', 100, 100, '流程图 flowchart flow chart 数据库 存储 database storage')
		]},
		{title: '常用节点', entries: [
			node('圆角卡片', '节点内容', rounded + 'fillColor=#FFFFFF;strokeColor=#CBD5E1;fontColor=#334155;', 180, 80, '卡片 card'),
			node('重点节点', '重点', rounded + 'fillColor=#F0EBFC;strokeColor=#B5A0E3;fontColor=#66459A;fontStyle=1;', 160, 60, '重点 highlight'),
			node('胶囊标签', '标签', base + 'rounded=1;arcSize=50;absoluteArcSize=1;fillColor=#E3F5F7;strokeColor=#88C8D0;fontColor=#216672;', 120, 40, '标签 capsule tag'),
			node('圆形节点', '主题', base + 'ellipse;aspect=fixed;fillColor=#EAF0FF;strokeColor=#9BB2F0;fontColor=#274690;', 88, 88, '圆形 circle'),
			node('便签', '记录灵感', base + 'shape=note;size=16;fillColor=#FFF8D6;strokeColor=#DFCE87;fontColor=#7B692F;', 150, 100, '便签 note')
		]},
		{title: '连线与骨架', entries: [
			connector('脑图曲线', lineStyle, '脑图 思维导图 mindmap 连线 曲线 curve connector'),
			connector('圆角箭头', flowLineStyle, '流程图 flowchart 连线 箭头 arrow connector'),
			mindmap('单向脑图', false),
			mindmap('双向脑图', true),
			flowchart()
		]}
	];

	sidebar.addPalette(paletteId, '常用', true, function(content)
	{
		content.classList.add('geCommonShapes');
		sections.forEach(function(section)
		{
			var heading = document.createElement('div');
			heading.className = 'geCommonShapesHeading';
			heading.textContent = section.title;
			content.appendChild(heading);
			var grid = document.createElement('div');
			grid.className = 'geCommonShapesGrid';
			section.entries.forEach(function(create) { grid.appendChild(create()); });
			content.appendChild(grid);
		});
	}, true);

	// Keep search and scratchpad intact, and put quick shapes before General.
	var palette = sidebar.palettes[paletteId];
	var general = sidebar.palettes.general;
	var wrapper = sidebar.getEntryContainer();
	var anchor = general != null ? general[0] : wrapper.firstChild;
	if (anchor != null)
	{
		wrapper.insertBefore(palette[0], anchor);
		wrapper.insertBefore(palette[1], anchor);
	}

	sidebar.defaultPaletteOrder = sidebar.getCurrentPaletteOrder();
});
