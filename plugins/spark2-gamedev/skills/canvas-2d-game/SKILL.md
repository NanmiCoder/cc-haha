---
name: canvas-2d-game
description: WasiCore Canvas 2D 游戏开发指南。设计分辨率、Canvas 绘图 API、碰撞检测、游戏循环。当开发 2D 游戏、使用 Canvas 绘图、或处理碰撞检测时使用。
whenToUse: 当开发 2D 游戏、使用 Canvas 绘图 API、处理碰撞检测、或构建游戏主循环时使用。
allowedTools: Bash, Read, Glob, Grep, Edit, Write
---

# Canvas 2D 游戏开发指南

前置知识：先阅读 [wasicore-dev](../wasicore-dev/SKILL.md) 了解编译配置和框架约束。

本指南只覆盖 **Canvas 渲染 / 游戏机制**（与单机/联机无关）。做**联机** Canvas 游戏时，状态如何同步、PropertyObject 与 Node+PropertyHostComponent 怎么选，见 [multiplayer-hybrid-sync](../multiplayer-hybrid-sync/SKILL.md)——两个 skill 各管一摊、配合使用。

Canvas 2D 游戏的客户端代码必须包裹在 `#if CLIENT` 中，使用 `dotnet build *.sln -c Client-Debug` 编译。

## 设计分辨率

| 屏幕方向 | 默认设计分辨率 | 适用场景 |
|---------|--------------|---------|
| 横屏 | 1920 x 1080 | 2D 平台游戏、横版射击 |
| 竖屏 | 1080 x 1920 | 益智、跑酷游戏 |

设计分辨率和缩放策略（`ScaleMode`：Contain/Cover/CoverCentered/MatchWidth/MatchHeight）可通过 `GameDataGameUI` 配置。

```csharp
// 始终从 ScreenViewport 获取，不要硬编码
var designRes = GameUI.Device.ScreenViewport.Primary.DesignResolution;
float gameWidth = designRes.Width;
float gameHeight = designRes.Height;

float groundY = gameHeight * 0.907f;  // 90.7%（底部）
```

### 安全区域（移动设备）

```csharp
var safeZone = GameUI.Device.ScreenViewport.Primary.SafeZonePadding;
// Left/Top/Right/Bottom 四个方向的不安全区域大小
// UI 元素必须在安全区域内，游戏背景可全屏
```

## Canvas 全屏布局

```csharp
#if CLIENT
var canvas = new Canvas();
canvas.FullScreen();  // 必须！使 Canvas 填满屏幕
canvas.AddToVisualTree();
#endif
```

`AutoUpdateResolutionOnResize` 默认为 true，`Resolution` 自动与 `ActualSize` 同步，无需手动处理 `OnSizeChanged`。

## Canvas API

### 绘图函数

| API | 参数模式 |
|-----|---------|
| `FillRectangle` / `StrokeRectangle` | (x, y, width, height) — 左上角 + 尺寸 |
| `FillEllipse` / `StrokeEllipse` | (centerX, centerY, radiusX, radiusY) — **中心 + 半径** |
| `FillCircle` / `StrokeCircle` | (centerX, centerY, radius) — **中心 + 半径** |
| `DrawLine` | (x1, y1, x2, y2) |

```csharp
canvas.FillPaint = Color.FromArgb(255, r, g, b);
canvas.StrokePaint = Color.FromArgb(255, r, g, b);
canvas.StrokeWidth = 2f;
```

椭圆/圆形参数是中心+半径，**不是**左上角+尺寸（常见错误）。

### Canvas vs CanvasAnimated

| 控件 | 渲染事件 | 事件参数 | 适用场景 |
|------|---------|---------|---------|
| `Canvas` | `OnRender` | `EventArgs`（无时间信息） | 静态/简单绘制 |
| `CanvasAnimated` | `OnAnimatedRender` | `CanvasAnimatedEventArgs`（含 DeltaTime） | 动画、游戏循环 |

动态 2D 游戏推荐使用 `CanvasAnimated`，可直接从事件参数获取帧间隔时间：

```csharp
#if CLIENT
var canvas = new CanvasAnimated();
canvas.FullScreen();
canvas.StartTiming();  // 开始计时
canvas.OnAnimatedRender += (sender, e) =>
{
    float dt = e.DeltaTimeInSeconds;          // 帧间隔（秒）
    float total = e.TotalElapsedTimeInSeconds; // 总计时（秒）
    canvas.ResetState();
    UpdateAndDraw(dt);
};
canvas.AddToVisualTree();
#endif
```

### OnRender 事件（Canvas 基类）

```csharp
#if CLIENT
private static void OnRender(object? sender, EventArgs e)
{
    canvas.ResetState();  // 清除画面并重置绘图状态
    DrawBackground();
    DrawGameObjects();
    DrawUI();
}
#endif
```

- Canvas 内容在帧间持久保留。若内容为静态，可以只绘制一次而不清除，无需每帧重绘
- 绘制动态内容时，每帧开头调用 `canvas.ResetState()` 清除画面并重置绘图状态（画笔、字体、变换等）
- 每帧自动调用，无需手动请求重绘
- `Canvas.Invalidate()` 不存在

### 图片资源路径

Canvas `DrawImage` 使用引擎 UI 图片路径。图片文件放在项目 `ui/` 下，代码路径从 `ui/` 下一级开始写：

```text
ui/image/player.png  ->  new Image("image/player.png")
```

```csharp
var playerImage = new Image("image/player.png");
canvas.DrawImage(playerImage, x, y, width, height);
```

不要写 `new Image("ui/image/player.png")`，也不要把图片放到 `user_files`。`user_files` 只用于脚本通过 `File` / `Directory` 直接读写普通文件。

### 鼠标/触摸事件

| 事件 | 说明 |
|------|------|
| `OnPointerPressed` | 按下 |
| `OnPointerClicked` | 点击 |
| `OnPointerCapturedMove` | 捕捉状态移动（需先 `CapturePointer`） |

Canvas **没有** `OnPointerMoved` 事件。悬停效果用全局事件：

```csharp
DeviceInfo.PrimaryInputManager.OnPointerButtonMove += (EventGamePointerButtonMove e) =>
{
    var pos = e.PointerPosition;
    if (pos.HasValue) { _mouseX = pos.Value.X; _mouseY = pos.Value.Y; }
};
```

PointerEventArgs 获取坐标：`e.X` / `e.Y`（推荐）或 `e.Position`。

### 键盘输入

```csharp
using GameCore.Platform.SDL;       // VirtualKey
using GameUI.TriggerEvent;         // EventGameKeyDown, EventGameKeyUp

// 保留触发器引用防止 GC 回收
private Trigger<EventGameKeyDown>? keyDownTrigger;
private Trigger<EventGameKeyUp>? keyUpTrigger;

keyDownTrigger = Game.Subscribe<EventGameKeyDown>(async (s, d) =>
{
    HandleKeyDown(d.Key);
});

keyUpTrigger = Game.Subscribe<EventGameKeyUp>(async (s, d) =>
{
    HandleKeyUp(d.Key);
});
```

`d.Key` 返回 `VirtualKey` 枚举，常用值：

| 按键 | VirtualKey |
|------|-----------|
| WASD | `W` / `A` / `S` / `D` |
| 方向键 | `Up` / `Down` / `Left` / `Right` |
| 空格 | `Space` |
| 回车 | `Return` |
| ESC | `Escape` |
| 字母 | `A`–`Z`（小写值 97–122） |
| 数字 | `Number0`–`Number9` |
| F1–F12 | `F1`–`F12` |

`EventGameKeyDown` 有 `isRepeat` 字段，按住不放时后续事件 `isRepeat = true`。

### 文字渲染

```csharp
using GameUI.Control.Enum;  // TextAlign 枚举

// 1. 加载字体（只需一次，返回 fontId）
int fontId = Canvas.CreateFont("MyFont", "ui/font/regular/RegularBold.otf");

// 2. 渲染时设置字体状态
canvas.FontFaceId(fontId);
canvas.FontSize(28);
canvas.TextAlign(TextAlign.Center | TextAlign.Middle);
canvas.FillPaint = Color.White;
canvas.DrawText(x, y, "Hello World");
```

TextAlign 枚举（水平 + 垂直组合使用）：

| 水平对齐 | 垂直对齐 |
|---------|---------|
| `TextAlign.Left` | `TextAlign.Top` |
| `TextAlign.Center` | `TextAlign.Middle` |
| `TextAlign.Right` | `TextAlign.Bottom` / `TextAlign.Baseline` |

字体路径使用框架内置路径如 `"ui/font/regular/RegularBold.otf"`，可从项目的 `ref/fontref.txt` 查看可用字体。

### CapturePointer（拖拽必需）

```csharp
canvas.OnPointerPressed += (sender, e) =>
{
    canvas.CapturePointer(e.PointerButtons);  // 必须调用！
};
canvas.OnPointerCapturedMove += (sender, e) => { /* 现在才能触发 */ };
canvas.OnPointerReleased += (sender, e) =>
{
    canvas.ReleasePointer(e.PointerButtons);
};
```

## 物理系统

Canvas 2D 游戏有两种物理实现方式：

| 方式 | 适用场景 | 复杂度 |
|------|----------|--------|
| **脚本物理**（手动速度/重力计算） | 简单跳跃、碰撞检测少 | 低 |
| **Physics2D**（Box2D 物理引擎） | 平台跳跃、多碰撞体交互、敌人/物理道具 | 中 |

### 方式一：脚本物理

适合简单场景，直接在 Canvas 坐标系（像素，Y 轴向下为正）中计算：

```csharp
const float GRAVITY = 2000f;
const float JUMP_VELOCITY = -750f;  // 负值向上（Y 轴向下为正）
// 公式：v = sqrt(2 * g * h)

public void Update(float deltaTime)
{
    if (!IsOnGround) velocityY += GRAVITY * deltaTime;
    if (InputJump && IsOnGround) { velocityY = JUMP_VELOCITY; IsOnGround = false; }
    positionY += velocityY * deltaTime;
    if (positionY + height >= groundY)
    {
        positionY = groundY - height;
        velocityY = 0;
        IsOnGround = true;
    }
}
```

碰撞检测使用位置范围 + 容差（~20px），不要假设固定 deltaTime：

```csharp
bool horizontalOverlap =
    player.X + player.Width > platform.X &&
    player.X < platform.X + platform.Width;

if (player.VelocityY >= 0 &&
    playerBottom >= platformTop &&
    player.Y < platformTop &&
    playerBottom <= platformTop + 20f &&
    horizontalOverlap)
{
    player.Y = platformTop - player.Height;
    player.VelocityY = 0;
    player.IsOnGround = true;
}
```

### 方式二：Physics2D + Canvas 架构

适合需要多碰撞体交互的复杂游戏（平台跳跃、敌人踩踏、物理道具等）。核心思路：**SceneGraph 管理物理世界（不渲染），Canvas/CanvasAnimated 负责渲染。**

```
SceneGraph (PhysicsWorld2D)          CanvasAnimated
 ├─ Node (RigidBody2D + CollisionBox2D)  ├─ OnAnimatedRender → 绘制
 ├─ ...                                   └─ 坐标转换：米 → 像素
 └─ 物理模拟（碰撞事件回调）
```

#### 关键组件

1. **`CanvasAnimated`**（推荐替代 `Canvas`）：提供 `OnAnimatedRender` 事件，回调参数 `CanvasAnimatedEventArgs` 包含 `DeltaTimeInSeconds` 和 `TotalElapsedTimeInSeconds`，适合动画和帧率无关的更新
2. **`IThinker`** 接口：实现 `Think(float dt)` 方法作为游戏逻辑循环，与渲染解耦
3. **`DisposableObject`**：Physics2D 使用 SceneGraph，必须继承此类并在 `Game.OnGameEnd` 时调用 `Destroy()` 释放原生资源

#### 坐标转换

Physics2D 坐标系（米，Y 朝上）与 Canvas 坐标系（像素，Y 朝下）需要转换：

```csharp
const float PixelsPerMeter = 64f;

float PhysToScreenX(float px, float cameraX) => px * PixelsPerMeter - cameraX;
float PhysToScreenY(float py) => viewportHeight - py * PixelsPerMeter;
```

#### 碰撞方向判断（重要）

`ContactPoint2D.WorldNormal` 和 `RigidBody2D.LinearVelocity` 在碰撞回调中**不可靠**用于判断碰撞方向。**始终使用 `Node.LocalPosition` 的相对位置比较**：

```csharp
float playerY = playerNode.LocalPosition.Y;
float enemyY = enemyNode.LocalPosition.Y;
if (playerY > enemyY && playerBody.LinearVelocity.Y < 0f)
{
    // 玩家在敌人上方且正在下落 → 踩踏
}
```

#### IsTrigger 用法

| 对象类型 | BodyType | IsTrigger | 说明 |
|---------|----------|-----------|------|
| 地面/平台 | Static | false | 物理阻挡 |
| 玩家 | Dynamic | false | 受物理模拟 |
| 敌人 | Kinematic | **true** | 触发事件但不阻挡 |
| 金币/旗帜 | Static | **true** | 触发拾取事件 |

详细的 Physics2D 碰撞陷阱和推荐做法，参见 [物理系统 - 2D 碰撞事件常见陷阱](../../systems/PhysicsSystem.md#2d-碰撞事件常见陷阱)。

## 渲染要点

- 绘制顺序从后到前：背景 → 远景 → 平台 → 敌人 → 玩家 → 特效 → UI
- 角色各部分坐标必须连续，避免空隙
- 所有部分渲染比例总和 <= 100%，避免脚深入地面
- 尺寸变化时保持底部位置不变

## 游戏模式注册

```csharp
// 在项目命名空间中定义（不要扩展 GameCore.ScopeData）
namespace GameEntry;
public static class MyGameData
{
    public static readonly GameLink<GameDataGameMode, GameDataGameMode> MyGameMode = new("MyGame"u8);
}

// 2D 游戏配置：SceneList = []，不需要 DefaultScene
_ = new GameDataGameMode(MyGameData.MyGameMode)
{
    Name = "My 2D Game",
    Gameplay = Gameplay.Default,
    PlayerSettings = ScopeData.GameDataPlayerSettings.PlayerSettings,
    SceneList = [],
    GameUI = GameUI.ScopeData.GameUI.Default,
};
```

### 启动逻辑

```csharp
#if CLIENT
public class MyGame : IGameClass
{
    public static void OnRegisterGameClass()
    {
        if (GameDataGlobalConfig.TestGameMode != MyGameData.MyGameMode) return;
        Game.OnGameTriggerInitialization += OnGameTriggerInitialization;
    }
    private static void OnGameTriggerInitialization()
    {
        Game.Subscribe<EventGameStart>(async (s, d) =>
        {
            Initialize();
        });
    }
    private static void Initialize() { /* Canvas 和游戏逻辑 */ }
}
#endif
```

资源清理：纯 Canvas 游戏结束时虚拟机自动销毁，无需手动 Dispose。但如果使用了 `SceneGraph`（例如 2D 物理引擎 `PhysicsWorld2D` 背后依赖 SceneGraph），则需要继承 `DisposableObject` 并在 `Game.OnGameEnd` 时调用 `Destroy()`，参见 [GameGraphOverview](../../systems/GameGraphOverview.md#游戏结束与资源清理)。

## 常见错误速查

| 症状 | 原因 | 解决 |
|------|------|------|
| 3000+ 编译错误 | 未用 `-c Client-Debug` | 正确编译配置 |
| 椭圆位置不对 | 混淆中心/左上角 | 用 centerX, centerY, radius |
| 地面在画面中部 | 动态分辨率计算 | 用固定设计分辨率 |
| 画面残影/状态混乱 | OnRender 开头未调用 `ResetState()` | 每帧第一行调用 `canvas.ResetState()` |
| 文字不显示 | 未加载字体或未设置 FontFaceId | 先 `CreateFont()` 再 `FontFaceId(id)` |
| TextAlign 找不到 | 缺 using | `using GameUI.Control.Enum;` |
| 键盘事件不触发 | 未注册触发器或被 GC 回收 | 用字段保存 `Trigger<EventGameKeyDown>` 引用 |
| VirtualKey 找不到 | 缺 using | `using GameCore.Platform.SDL;` |
| Canvas 不响应 PointerMove | Canvas 无此事件 | 用 `DeviceInfo.PrimaryInputManager.OnPointerButtonMove` |
| 拖拽不工作 | 缺少 `CapturePointer()` | 在 OnPointerPressed 中调用 |
| `Canvas.Invalidate()` 不存在 | 无此方法 | OnRender 每帧自动触发 |
| LineCap 找不到 | 缺 using | `using GameUI.Graphics.Enum;` |
| WorldNormal 判断碰撞方向不准 | 2D 碰撞法线受求解顺序影响 | 用 `Node.LocalPosition` 位置比较判断方向 |
| Physics2D 游戏结束后内存泄漏 | 未清理 SceneGraph 原生资源 | 继承 `DisposableObject`，`Game.OnGameEnd` 中调用 `Destroy()` |
| 动态游戏无 deltaTime | 用了 `Canvas` 的 `OnRender`（无时间参数） | 改用 `CanvasAnimated` 的 `OnAnimatedRender` |

## 更多详细信息

完整文档（含安全区域适配、游戏平衡性、详细渲染示例）见 [reference.md](reference.md)。
