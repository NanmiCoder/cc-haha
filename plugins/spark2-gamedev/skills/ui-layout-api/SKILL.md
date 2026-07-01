---
name: ui-layout-api
description: WasiCore 流式布局 UI API 参考。尺寸、间距、对齐、Flexbox、响应式布局的链式 API。当创建 UI 界面、设置布局、使用 Panel/Label/Button 等控件时使用。
whenToUse: 当创建 UI 界面、设置布局、使用 Panel/Label/Button 等控件、或调试 UI 定位问题时使用。
allowedTools: Bash, Read, Glob, Grep, Edit, Write
---

# 流式布局 UI API 参考

所有扩展方法返回控件本身，支持链式调用。

核心类：`LayoutExtensions`（布局）、`BuilderExtensions`（控件属性）、`UI`（静态构建器）。

> **对齐默认值警告**：所有控件的 `HorizontalContentAlignment` 和 `VerticalContentAlignment` 默认为 **Center**。
> 当子控件未显式设置 `HorizontalAlignment` / `VerticalAlignment` 时，会继承父控件的 Center 对齐，
> 导致 Margin 从中心偏移而非从左上角偏移，产生文字偏右下的视觉问题。
> **多个子控件更危险**：若容器内有多个子控件都未设对齐，它们全部被居中到同一区域后完全重叠。
>
> **必须遵守**：
> - 用 Margin 定位子控件时，务必同时设置 `HorizontalAlignment = Left`、`VerticalAlignment = Top`
>   （或使用 `.AlignLeft().AlignTop()`），否则 Margin 的 left/top 值会叠加在居中位置上。
> - 容器内有 2 个以上子控件时，优先使用 `FlowOrientation = Vertical`（或 `.FlowVertical()`）让子控件自动排列，
>   避免手动计算 Margin 导致的重叠风险。
>
> **推荐优先使用流式扩展方法**（`.AlignLeft()`, `.Size()`, `.Margin()` 等），而非对象初始化器直接赋值属性。
> 流式风格鼓励显式设定每个布局属性，漏写对齐时更容易察觉"缺了什么"，且能避免 Margin 定位陷阱。
> 对象初始化器在样例代码中常见，但容易遗漏对齐设置。

## 运行时排版验证

当编辑器 MCP 提供 `runtime_call_tool`，并且用户已经启动普通调试、调试不编译或纯客户端调试时，AI 助手应优先使用 Runtime MCP 获取实时画面和 UI 控件数据，再决定如何调整布局。

推荐闭环：

1. 调用 `debug.capture_screenshot` 保存当前客户端截图，确认真实视觉状态。一般布局检查可传 `maxWidth: 1920, maxHeight: 1080` 或 `maxWidth: 1280, maxHeight: 720` 限制图片尺寸；需要辨认细小文字或像素细节时保留原始分辨率。
2. 调用 `ui.snapshot` 获取 GameUI 控件树、文本、可见性和 `rect_px`。
3. 用 `ui.find` 查找目标按钮、标签、面板或输入框。
4. 用 `ui.get_rect` 获取目标控件的屏幕像素坐标和尺寸。
5. 根据截图与坐标调整 `.Size()`、`.Margin()`、`.Padding()`、`.Align*()`、`.Flow*()`、`.WidthGrow()` 等布局代码。
6. 重新启动调试或刷新客户端后再次截图和查询，确认排版已符合预期。

不要只靠猜测坐标或用户口述来修 UI。若截图和 `ui.snapshot` 不一致，优先相信截图中的最终视觉结果，再用控件树定位可能的布局来源。Canvas 直接绘制的内容不一定出现在 `ui.snapshot` 中，此时用截图判断视觉问题，用 UI inspector 检查外围 GameUI 容器。

## 尺寸

```csharp
control.Size(200, 100)       // 宽高
control.Size(150)            // 正方形
control.Width(200)
control.Height(100)
control.AutoWidth()          // 自动宽度
control.AutoHeight()         // 自动高度
control.AutoSize()           // 自动宽高
```

## 位置

```csharp
control.Position(100, 50)    // 绝对定位
control.Offset(10, 20)       // 相对偏移
```

## 对齐

```csharp
control.AlignLeft() / .AlignRight() / .AlignTop() / .AlignMiddle() / .AlignBottom()
control.Center()
control.StretchHorizontal() / .StretchVertical() / .Stretch()
```

## 边距

```csharp
control.Margin(10)           // 四边均匀
control.Margin(20, 10)       // 水平, 垂直
control.Margin(10, 5, 10, 5) // 左, 上, 右, 下
control.Padding(15)          // 同上模式
```

## 流式布局

```csharp
control.FlowHorizontal() / .FlowVertical()
control.ContentAlignHorizontal(HorizontalContentAlignment.Left)
control.ContentAlignVertical(VerticalContentAlignment.Top)
control.ContentCenter()

// Flexbox 风格（基于 FlowOrientation 智能选择轴向）
control.JustifySpaceBetween()    // 主轴 space-between
control.JustifySpaceAround()     // 主轴 space-around
control.AlignSpaceBetween()      // 交叉轴 space-between
control.AlignSpaceAround()       // 交叉轴 space-around
control.JustifyStretch()         // 主轴拉伸
control.AlignStretch()           // 交叉轴拉伸

// 组合
control.HorizontalSpread()       // = FlowHorizontal + JustifySpaceBetween
control.VerticalSpread()         // = FlowVertical + JustifySpaceBetween

// Flex 增长/收缩
control.WidthGrow(1.0f) / .HeightGrow(0.5f) / .GrowRatio(1, 2)
control.WidthShrink(0.5f) / .HeightShrink(0.3f) / .ShrinkRatio(0.5, 0.5)
control.FlexBasis(100, 50) / .FlexBasisWidth(100) / .FlexBasisHeight(50)
```

## 快速堆叠

```csharp
control.VStack(spacing: 10)  // 垂直堆叠
control.HStack(spacing: 15)  // 水平堆叠
```

## 控件属性

```csharp
control.Visible(true) / .Hidden()
control.Enabled(false) / .Disabled()
control.DataContext(data)
control.Background(Color.Blue) / .Background(brush)
control.Opacity(0.8f)
```

## 文本控件

```csharp
label.Text("Hello").TextColor(Color.Red).FontSize(16).Bold().Italic()
button.Text("按钮").TextColor(Color.White).FontSize(16).Bold()
```

## 容器

```csharp
container.AddChild(child).AddChildren(child1, child2, child3)
```

## 事件

```csharp
button.OnClick((sender, e) => { /* 逻辑 */ })
button.OnClick(() => { /* 简化 */ })
```

## 外观样式

```csharp
control.CornerRadius(8)
control.ZIndex(10)
control.Opacity(0.8f)
control.ClipContent()        // 裁剪超出内容
control.NoClip()             // 允许内容溢出
control.MinWidth(100).MaxWidth(300).MinHeight(50).MaxHeight(200)
```

## 响应式设计

```csharp
control.ResponsiveWidth(100, 300)           // min, max
control.ResponsiveHeight(50, 150)
control.ResponsiveSize(100, 300, 50, 150)   // wMin, wMax, hMin, hMax
label.ResponsiveFontSize(12, 24, 1.2f)     // min, max, multiplier
control.ResponsiveSpacing(8, 24)
control.ResponsivePadding(12, 32)
control.ResponsiveContainer(ResponsiveContainerSize.Standard)
button.ResponsiveButton(ResponsiveButtonSize.Medium)
container.ResponsiveOrientation(Orientation.Horizontal, Orientation.Vertical)
control.ResponsiveVisibility(ResponsiveVisibility.MediumAndUp)
```

## 高级布局

```csharp
// 网格
var grid = TrueGrid(3, rowSpacing: 8, columnSpacing: 12, child1, child2, ...);
var autoGrid = SimpleGrid(10, item1, item2, ...);

// 语义化组件
control.Card(padding: 20, radius: 8, elevation: 2)
button.Button(height: 44, padding: 16, radius: 4)
input.Input(height: 40, width: 280, padding: 12)
item.ListItem(height: 48, padding: 16)

// 文本样式
label.Title(fontSize: 24, margin: 16)
label.Subtitle(fontSize: 18, margin: 12)
label.Body(fontSize: 16, margin: 8)
label.Caption(fontSize: 12, margin: 4)
```

## 静态构建器

```csharp
var panel = UI.Panel();
var button = UI.Button();
var label = UI.Label("Hello");

var vstack = UI.VStack(spacing: 10,
    UI.Label("标题"),
    UI.Button(),
    UI.Label("底部")
);

var hstack = UI.HStack(spacing: 15, UI.Button(), UI.Label("说明"));
var centered = CenterContainer(UI.Label("居中文本"));

// 预定义样式
UI.Title("标题", fontSize: 24)
UI.Subtitle("副标题", fontSize: 18)
UI.PrimaryButton("主要按钮")
UI.SecondaryButton("次要按钮")
UI.Button("按钮")
```

## 内置颜色

```csharp
UI.Colors.Primary / .Secondary / .Success / .Warning / .Error
UI.Colors.Background / .Surface
UI.Colors.OnPrimary / .OnSurface / .OnBackground
```

## 使用示例

### 登录界面

```csharp
var loginScreen = VStack(20,
    Label("欢迎登录")
        .FontSize(32).Bold().Center().Margin(0, 50, 0, 30),
    VStack(15,
        Label("用户名").Background(Colors.Surface).Padding(15, 10).StretchHorizontal().Height(40),
        Label("密码").Background(Colors.Surface).Padding(15, 10).StretchHorizontal().Height(40)
    ).Margin(40, 0),
    HStack(20,
        Button().Size(120, 40).Background(Colors.Secondary),
        Button().Size(120, 40).Background(Colors.Primary)
    ).Center().Margin(0, 30, 0, 0)
).FillParent().Background(Colors.Background);
```

### 工具栏

```csharp
var toolbar = Panel().Size(400, 50)
    .HorizontalSpread()
    .Add(Button("新建"), Button("编辑"), Button("删除"), Button("设置"));
```

## 更多详细信息

完整文档（含仪表板示例、传统 vs 流式对比、性能说明）见 [reference.md](reference.md)。
