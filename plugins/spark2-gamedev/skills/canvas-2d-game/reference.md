# AI开发Canvas 2D游戏指南

## 文档说明

本文档专为**使用AI工具开发WasiCore框架下的Canvas 2D游戏**而设计，是 [WasiCore 开发指南](../wasicore-dev/reference.md) 的专项补充。

### 适用场景
- 2D平台游戏（如马里奥、塞尔达等）
- 2D射击游戏
- 益智游戏
- 跑酷游戏
- 任何需要使用Canvas绘图的2D游戏

### 前置阅读
在阅读本文档前，请先阅读：
- [WasiCore 开发指南](../wasicore-dev/reference.md) - 框架通用开发指南
- [框架概述](../../FRAMEWORK_OVERVIEW.md) - 理解框架核心概念

---

## 最重要的事：正确的编译配置

WasiCore框架使用**条件编译**区分客户端和服务端代码。对于2D游戏开发（使用Canvas），**必须**使用客户端编译配置：

```bash
# 正确：编译客户端代码（2D游戏开发）
dotnet build *.sln -c Client-Debug

# 错误！会导致数千个编译错误
dotnet build *.sln
dotnet build *.sln -c Debug
```

### 不使用正确配置的后果
- 所有 `#if CLIENT` 包裹的代码不会被编译
- 导致 **3000+ 编译错误**
- `GameUI`、`Canvas` 等类型全部显示"找不到"
- AI可能会误以为是API不存在而尝试错误的替代方案

### 正确的代码结构
```csharp
#if CLIENT
using GameUI.Control.Primitive;
using GameUI.Graphics;

namespace YourGame
{
    public class GameRenderer
    {
        private Canvas canvas;
        
        public void Draw()
        {
            // Canvas绘图代码
        }
    }
}
#endif
```

---

## 设计分辨率规范

WasiCore框架的UI系统使用**设计分辨率**作为坐标基准，所有UI元素的位置和尺寸都在设计坐标系中定义，引擎自动缩放到物理屏幕。

### 默认设计分辨率

| 屏幕方向 | 默认设计分辨率 (宽×高) | 适用场景 |
|---------|----------------------|---------|
| **横屏** | **1920 × 1080** | 2D平台游戏（推荐）、横版射击等 |
| **竖屏** | **1080 × 1920** | 益智游戏、跑酷游戏等 |

设计分辨率可通过`GameDataGameUI`的`DesignResolutionWidth`/`DesignResolutionHeight`字段自定义。

### 缩放策略 (ScaleMode)

通过`GameDataGameUI.ScaleMode`配置引擎如何将设计坐标映射到物理屏幕：

| ScaleMode | 行为 | 适用场景 |
|-----------|------|---------|
| `Contain`（默认） | 保证设计区域完整可见，可能有留白 | 通用UI |
| `Cover` | 填充屏幕，右/下溢出被裁切 | 全屏游戏 |
| `CoverCentered` | 填充屏幕，居中对称裁切 | 全屏游戏（类似Unity） |
| `MatchWidth` | 宽度精确匹配，高度自适应 | 横版游戏 |
| `MatchHeight` | 高度精确匹配，宽度自适应 | 竖版游戏 |

### 正确的分辨率获取

```csharp
// 始终从 ScreenViewport 获取实际设计分辨率（而非硬编码）
var designRes = GameUI.Device.ScreenViewport.Primary.DesignResolution;
float gameWidth = designRes.Width;
float gameHeight = designRes.Height;

// 所有游戏元素的位置和尺寸都基于设计分辨率
float groundY = gameHeight * 0.907f;  // 约90.7%（接近底部）
float playerHeight = gameHeight * 0.111f;  // 约11.1%
```

### 安全区域 (Safe Zone) - 重要！

现代移动设备通常有**刘海屏**、**挖孔屏**、**圆角屏幕**或**系统手势区域**，这些区域可能遮挡或裁切游戏内容。WasiCore提供了 `SafeZonePadding` 属性来处理这些情况。

#### 什么是安全区域？

```csharp
// 获取安全区域内边距（设备独立像素）
var safeZone = GameUI.Device.ScreenViewport.Primary.SafeZonePadding;

// SafeZonePadding 包含四个方向的内边距：
// - Left: 左侧不安全区域宽度（刘海/挖孔/圆角）
// - Top: 顶部不安全区域高度（刘海/状态栏）
// - Right: 右侧不安全区域宽度（圆角）
// - Bottom: 底部不安全区域高度（Home Indicator/手势条/圆角）
```

#### 为什么需要考虑安全区域？

| 问题 | 后果 |
|------|------|
| **UI按钮放在不安全区域** | 用户无法点击或误触系统手势 |
| **重要信息被刘海遮挡** | 玩家看不到分数、生命值等 |
| **游戏内容被圆角裁切** | 视觉效果不佳，内容丢失 |

#### 正确使用安全区域

```csharp
// 推荐：将UI元素放置在安全区域内
public void CreateGameUI()
{
    var safeZone = GameUI.Device.ScreenViewport.Primary.SafeZonePadding;
    var viewportSize = GameUI.Device.ScreenViewport.Primary.Size;
    
    // 计算安全区域内的可用空间
    float safeLeft = safeZone.Left;
    float safeTop = safeZone.Top;
    float safeRight = viewportSize.Width - safeZone.Right;
    float safeBottom = viewportSize.Height - safeZone.Bottom;
    
    float safeWidth = safeRight - safeLeft;
    float safeHeight = safeBottom - safeTop;
    
    // 在安全区域内放置UI元素
    // 例如：左上角的分数显示
    var scoreLabel = new Label
    {
        Text = "Score: 0",
        Position = new Vector2(safeLeft + 20f, safeTop + 20f),  // 留出20px边距
        Parent = canvas
    };
    
    // 例如：右下角的按钮（考虑手势区域）
    var pauseButton = new Button
    {
        Width = 80f,
        Height = 80f,
        Position = new Vector2(
            safeRight - 100f,   // 距离右边界100px（避开圆角和边缘）
            safeBottom - 100f   // 距离底部100px（避开Home Indicator）
        ),
        Parent = canvas
    };
}
```

#### Canvas游戏内容的安全区域适配

```csharp
public class SafeGameRenderer
{
    private float gameContentLeft;
    private float gameContentTop;
    private float gameContentWidth;
    private float gameContentHeight;
    
    public SafeGameRenderer()
    {
        UpdateSafeArea();
        
        // 监听屏幕方向变化，重新计算安全区域
        GameUI.Device.ScreenViewport.Primary.OnOrientationChanged += _ => UpdateSafeArea();
    }
    
    private void UpdateSafeArea()
    {
        var safeZone = GameUI.Device.ScreenViewport.Primary.SafeZonePadding;
        var designResolution = GameUI.Device.ScreenViewport.Primary.DesignResolution;
        
        // 计算游戏内容区域（在安全区域内）
        gameContentLeft = safeZone.Left;
        gameContentTop = safeZone.Top;
        gameContentWidth = designResolution.Width - safeZone.Left - safeZone.Right;
        gameContentHeight = designResolution.Height - safeZone.Top - safeZone.Bottom;
        
        // 重新计算游戏元素位置
        RecalculateGameLayout();
    }
    
    private void RecalculateGameLayout()
    {
        // 例如：确保地面在安全区域内
        float safeGroundY = gameContentTop + gameContentHeight - 100f;
        
        // 例如：确保玩家初始位置在安全区域内
        float playerStartX = gameContentLeft + 100f;
        float playerStartY = safeGroundY - playerHeight;
    }
    
    public void DrawGame(Canvas canvas)
    {
        // 1. 绘制背景（全屏）
        DrawBackground(canvas);
        
        // 2. 在安全区域内绘制游戏内容
        canvas.Save();
        // 可选：裁剪到安全区域
        canvas.ClipRect(gameContentLeft, gameContentTop, gameContentWidth, gameContentHeight);
        
        DrawGameContent(canvas);
        
        canvas.Restore();
        
        // 3. UI元素已经在安全区域内放置（见上文）
    }
}
```

#### 调试：可视化安全区域

```csharp
// 开发时可以绘制安全区域边界，帮助调试
public void DrawSafeZoneDebug(Canvas canvas)
{
    var safeZone = GameUI.Device.ScreenViewport.Primary.SafeZonePadding;
    var viewport = GameUI.Device.ScreenViewport.Primary.Size;
    
    // 绘制不安全区域（半透明红色）
    canvas.FillPaint = Color.FromArgb(128, 255, 0, 0);
    
    // 左侧不安全区域
    if (safeZone.Left > 0)
        canvas.FillRectangle(0, 0, safeZone.Left, viewport.Height);
    
    // 顶部不安全区域
    if (safeZone.Top > 0)
        canvas.FillRectangle(0, 0, viewport.Width, safeZone.Top);
    
    // 右侧不安全区域
    if (safeZone.Right > 0)
        canvas.FillRectangle(viewport.Width - safeZone.Right, 0, safeZone.Right, viewport.Height);
    
    // 底部不安全区域
    if (safeZone.Bottom > 0)
        canvas.FillRectangle(0, viewport.Height - safeZone.Bottom, viewport.Width, safeZone.Bottom);
    
    // 绘制安全区域边界（绿色虚线）
    canvas.StrokePaint = Color.FromArgb(255, 0, 255, 0);
    canvas.StrokeWidth = 2f;
    canvas.StrokeRectangle(
        safeZone.Left, 
        safeZone.Top, 
        viewport.Width - safeZone.Left - safeZone.Right,
        viewport.Height - safeZone.Top - safeZone.Bottom
    );
}
```

#### 关键点

- **UI元素必须在安全区域内**：按钮、文本、重要信息等
- **游戏背景可以全屏**：装饰性背景可以延伸到不安全区域
- **监听方向变化**：屏幕旋转时安全区域可能变化
- **预留额外边距**：安全区域边界上仍建议留出10-20px边距
- **测试多种设备**：不同设备的安全区域差异很大（特别是iPhone的刘海和底部手势条）

### 常见错误

```csharp
// 错误：使用 Math.Max 导致地面位置错误
var gameWidth = Math.Max(800f, viewportSize.Width);  // 可能变成1920
var gameHeight = Math.Max(600f, viewportSize.Height); // 可能变成1080
const float GROUND_Y = 550f;  // 固定值
// 结果：550/1080 = 50.9%（画面中部）而不是预期的底部

// 正确：从 ScreenViewport 获取设计分辨率
var designRes = GameUI.Device.ScreenViewport.Primary.DesignResolution;
float groundY = designRes.Height * 0.907f;  // 90.7%（底部）
```

---

## Canvas API 详细说明

### Canvas 全屏布局（重要！）

Canvas 控件需要正确设置才能填满屏幕并正确响应交互：

```csharp
#if CLIENT
// 正确：使用 FullScreen() 扩展方法
var canvas = new Canvas();
canvas.FullScreen();  // 关键！使Canvas填满屏幕
canvas.AddToVisualTree();

// 错误：手动设置Stretch属性
var canvas = new Canvas
{
    HorizontalAlignment = HorizontalAlignment.Stretch,
    VerticalAlignment = VerticalAlignment.Stretch,
};
// 可能无法正确填满，且分辨率不会自动更新
#endif
```

#### AutoUpdateResolutionOnResize 机制

```csharp
// AutoUpdateResolutionOnResize 默认为 true
// 当使用 .FullScreen() 后，Resolution 会自动与 ActualSize 同步
// 无需手动处理 OnSizeChanged 事件

// 不必要的代码：
_canvas.OnSizeChanged += (sender, e) =>
{
    _canvas.Resolution = e.Size;  // 不需要！AutoUpdateResolutionOnResize 已处理
};

// 正确：直接使用 Resolution 进行坐标计算
float canvasWidth = _canvas.Resolution.Width;
float canvasHeight = _canvas.Resolution.Height;
```

### Canvas 鼠标事件处理（重要！）

Canvas 控件的鼠标事件与普通控件有所不同：

#### 可用的 Canvas 鼠标事件

| 事件 | 说明 | 适用场景 |
|------|------|----------|
| `OnPointerPressed` | 鼠标按下 | 检测按下位置 |
| `OnPointerClicked` | 鼠标点击 | 处理点击交互 |
| `OnPointerCapturedMove` | 捕捉状态下的移动 | 拖拽操作 |

#### Canvas 没有非捕捉状态的 OnPointerMoved 事件

```csharp
// 错误：错误：Canvas 没有 OnPointerMoved 事件
_canvas.OnPointerMoved += OnMouseMove;  // 编译错误！

// 正确：正确：使用全局 InputManager 事件实现悬停效果
using GameUI.Device;
using GameUI.TriggerEvent;

private static void CreateCanvas()
{
    _canvas = new Canvas();
    _canvas.FullScreen();
    
    // Canvas 自身事件
    _canvas.OnPointerPressed += OnPointerPressed;
    _canvas.OnPointerClicked += OnPointerClicked;
    
    // 全局鼠标移动事件（用于悬停效果）
    DeviceInfo.PrimaryInputManager.OnPointerButtonMove += OnPointerMove;
    
    _canvas.AddToVisualTree();
}

private static void OnPointerMove(EventGamePointerButtonMove e)
{
    var pos = e.PointerPosition;
    if (pos.HasValue)
    {
        float mouseX = pos.Value.X;
        float mouseY = pos.Value.Y;
        UpdateHoverState(mouseX, mouseY);
    }
}

// 记得在 Dispose 中取消订阅！
public static void Dispose()
{
    DeviceInfo.PrimaryInputManager.OnPointerButtonMove -= OnPointerMove;
    // ...
}
```

### PointerEventArgs 属性访问

```csharp
// PointerEventArgs 提供三种获取位置的方式：

// 正确：方式1：直接使用 X/Y（推荐，最简洁）
canvas.OnPointerClicked += (sender, e) =>
{
    float x = e.X;
    float y = e.Y;
    HandleClick(x, y);
};

// 正确：方式2：使用 Position（返回 PointF，便于绑定绘图API）
canvas.OnPointerClicked += (sender, e) =>
{
    var pos = e.Position;
    StrokeCircle(pos.X, pos.Y, 10);
};

// 正确：方式3：使用 PointerPosition（获取完整 UIPosition）
canvas.OnPointerClicked += (sender, e) =>
{
    var pos = e.PointerPosition;
    if (pos.HasValue)
    {
        // 使用完整的 UIPosition 信息
    }
};

// 错误：错误：Position 不是可空类型，不需要 .Value
float x = e.Position.Value.X;  // 错误！

// 错误：错误：混淆属性名
float x = e.Position.X;  // 这是正确的
float x = e.PointerPosition.X;  // 错误！PointerPosition 是可空类型
```

### 最重要的API差异

WasiCore的Canvas API与HTML5 Canvas有显著差异，AI工具必须注意：

| API | 参数模式 | 说明 |
|-----|---------|------|
| `FillRectangle` | **(x, y, width, height)** | 左上角坐标 + 尺寸 |
| `FillEllipse` | **(centerX, centerY, radiusX, radiusY)** | **中心坐标 + 半径** |
| `FillCircle` | **(centerX, centerY, radius)** | **中心坐标 + 半径** |

### 关键理解示例

```csharp
// 错误：错误理解（常见AI错误）
canvas.FillEllipse(x, y, width, height);  
// AI可能误以为是左上角+尺寸，类似FillRectangle

// 正确：正确理解
canvas.FillEllipse(centerX, centerY, radiusX, radiusY);  
// 中心坐标 + 半径

// 实例：绘制直径60×40的椭圆，中心在(100, 50)
canvas.FillEllipse(100, 50, 30, 20);  
// 注意：半径是30和20，而非宽60高40

// 如果已知左上角和尺寸，需要这样转换：
float x = 70f, y = 30f;      // 左上角
float width = 60f, height = 40f;
float centerX = x + width / 2;   // 100
float centerY = y + height / 2;  // 50
float radiusX = width / 2;       // 30
float radiusY = height / 2;      // 20
canvas.FillEllipse(centerX, centerY, radiusX, radiusY);
```

### 常用Canvas API速查

```csharp
// 矩形绘制（左上角+尺寸）
canvas.FillRectangle(x, y, width, height);
canvas.StrokeRectangle(x, y, width, height);

// 圆形绘制（中心+半径）
canvas.FillCircle(centerX, centerY, radius);
canvas.StrokeCircle(centerX, centerY, radius);

// 椭圆绘制（中心+半径）
canvas.FillEllipse(centerX, centerY, radiusX, radiusY);
canvas.StrokeEllipse(centerX, centerY, radiusX, radiusY);

// 线条绘制
canvas.DrawLine(x1, y1, x2, y2);

// 设置绘制样式
canvas.FillPaint = Color.FromArgb(255, r, g, b);
canvas.StrokePaint = Color.FromArgb(255, r, g, b);
canvas.StrokeWidth = 2f;
```

---

## 2D游戏物理系统

Canvas 2D 游戏有两种物理实现方式。简单游戏用**脚本物理**（手动计算速度和碰撞），复杂游戏用 **Physics2D**（Box2D 引擎）。

### 方式一：脚本物理

适合碰撞体少、无复杂物理交互的简单游戏。直接在 Canvas 坐标系（像素，Y 轴向下为正）中计算。

#### 跳跃高度计算公式

```csharp
// 物理公式：h = v² / (2g)
// 如果希望跳跃高度为 120 像素：
// v = sqrt(2 * g * h)

const float GRAVITY = 2000f;           // 重力加速度（像素/秒²）
const float DESIRED_JUMP_HEIGHT = 120f; // 期望跳跃高度

// 计算所需的跳跃速度
// v = sqrt(2 * 2000 * 120) = 693
// 留点余量：
const float JUMP_VELOCITY = -750f;  // 负值表示向上（Y轴向下为正）

// 在Update中应用
public void Update(float deltaTime)
{
    if (!IsOnGround)
    {
        velocityY += GRAVITY * deltaTime;  // 应用重力
    }
    
    if (InputJump && IsOnGround)
    {
        velocityY = JUMP_VELOCITY;  // 跳跃
        IsOnGround = false;
    }
    
    positionY += velocityY * deltaTime;
    
    // 地面检测
    if (positionY + height >= groundY)
    {
        positionY = groundY - height;
        velocityY = 0;
        IsOnGround = true;
    }
}
```

#### 碰撞检测（带容差）

```csharp
// 正确：使用位置范围检测 + 容差
float playerBottom = player.Position.Y + player.Height;
float platformTop = platform.Position.Y;

// 1. 检查水平重叠
bool horizontalOverlap = 
    player.Position.X + player.Width > platform.Position.X &&
    player.Position.X < platform.Position.X + platform.Width;

// 2. 从上方着陆（带容差）
if (player.Velocity.Y >= 0 &&                    // 正在下落
    playerBottom >= platformTop &&               // 底部已经到达平台
    player.Position.Y < platformTop &&           // 顶部还在平台上方
    playerBottom <= platformTop + 20f &&         // 20像素容差
    horizontalOverlap)
{
    player.Position = new Vector2(player.Position.X, platformTop - player.Height);
    player.Velocity = new Vector2(player.Velocity.X, 0);
    player.IsOnGround = true;
}
```

**关键点**：
- 先检查水平方向是否重叠
- 使用位置范围而不是速度预测
- 添加容差（20像素）提高鲁棒性
- 不要假设固定的 deltaTime

### 方式二：Physics2D + Canvas 架构

适合平台跳跃、多碰撞体交互（敌人踩踏、砖块顶撞、拾取物）等复杂 2D 游戏。核心思路：**SceneGraph 管理物理世界（不渲染），CanvasAnimated 负责绘制。**

#### 架构概览

```
SceneGraph (PhysicsWorld2D)              CanvasAnimated
 ├─ PhysicsWorld2D（设置重力等）          ├─ OnAnimatedRender → 绘制
 ├─ Node "Player"                         │   读取各 Node.LocalPosition
 │   ├─ RigidBody2D (Dynamic)            │   坐标转换：米 → 像素
 │   └─ CollisionBox2D                   │   绘制精灵/几何图形
 ├─ Node "Ground_0"                      └─ 输入事件 → 修改 RigidBody2D.LinearVelocity
 │   ├─ RigidBody2D (Static)
 │   └─ CollisionBox2D
 ├─ Node "Enemy_0"
 │   ├─ RigidBody2D (Kinematic)
 │   └─ CollisionBox2D (IsTrigger=true)
 └─ Node "Coin_0"
     ├─ RigidBody2D (Static)
     └─ CollisionCircle2D (IsTrigger=true)
```

#### CanvasAnimated（推荐替代 Canvas）

`CanvasAnimated` 继承自 `Canvas`，提供 `OnAnimatedRender` 事件，回调参数 `CanvasAnimatedEventArgs` 包含帧间隔和总时间，适合动画和帧率无关的游戏更新。

```csharp
#if CLIENT
using GameUI.Control.Primitive;
using GameUI.Control.Primitive.Struct;

var canvas = new CanvasAnimated();
canvas.FullScreen();
canvas.StartTiming();  // 必须调用，开始计时

canvas.OnAnimatedRender += (sender, e) =>
{
    float dt = e.DeltaTimeInSeconds;            // 距上一帧的时间差（秒）
    float total = e.TotalElapsedTimeInSeconds;  // 从 StartTiming() 开始的总时间（秒）
    
    canvas.ResetState();
    // 使用 dt 更新动画和物理
    // 使用 total 实现周期性效果
};

canvas.AddToVisualTree();
#endif
```

| 属性/方法 | 说明 |
|-----------|------|
| `StartTiming()` | 开始计时（必须调用，否则 `OnAnimatedRender` 不触发） |
| `StartTimingDelayed(int ms)` | 延迟 ms 毫秒后开始计时 |
| `e.DeltaTimeInSeconds` | 帧间隔（秒），用于帧率无关的更新 |
| `e.DeltaTimeInMilliseconds` | 帧间隔（毫秒） |
| `e.TotalElapsedTimeInSeconds` | 从计时开始的总时间（秒） |
| `e.TotalElapsedTimeInMilliseconds` | 从计时开始的总时间（毫秒） |

> **注意**：`CanvasAnimated` 继承 `Canvas` 的所有绘图方法和事件（包括 `OnRender`），但动态游戏应使用 `OnAnimatedRender` 以获取时间信息。

#### IThinker 游戏循环

`IThinker` 接口提供独立于渲染的逻辑更新循环。实现 `DoesThink`（是否启用）和 `Think(float dt)`（每帧调用），将游戏逻辑（物理更新、AI 移动、状态检测）与渲染分离。

```csharp
#if CLIENT
public class MyGame : DisposableObject, IGameClass, IThinker
{
    public bool DoesThink => !IsDisposed;
    
    public void Think(float dt)
    {
        UpdateEnemyMovement(dt);
        CheckPlayerState(dt);
        UpdateTimers(dt);
    }
}
#endif
```

`OnAnimatedRender` 中只做绘制，`Think` 中做逻辑更新。两者每帧都被调用，但职责分离使代码更清晰。

#### 坐标转换

Physics2D 使用米为单位、Y 朝上的坐标系。Canvas 使用像素为单位、Y 朝下的坐标系。需要一组转换函数：

```csharp
#if CLIENT
const float PixelsPerMeter = 64f;  // 1米 = 64像素（可根据游戏调整）

// 物理坐标 → 屏幕坐标
float PhysToScreenX(float physX, float cameraX)
    => physX * PixelsPerMeter - cameraX;

float PhysToScreenY(float physY)
    => viewportHeight - physY * PixelsPerMeter;

// 屏幕坐标 → 物理坐标（用于点击检测等）
float ScreenToPhysX(float screenX, float cameraX)
    => (screenX + cameraX) / PixelsPerMeter;

float ScreenToPhysY(float screenY)
    => (viewportHeight - screenY) / PixelsPerMeter;
#endif
```

| 坐标系 | 单位 | X 方向 | Y 方向 | 原点 |
|--------|------|--------|--------|------|
| Physics2D | 米 | 右正 | **上正** | 左下 |
| Canvas | 像素 | 右正 | **下正** | 左上 |

#### 碰撞方向判断（重要陷阱）

在 `OnCollisionBegin2D` 回调中，`ContactPoint2D.WorldNormal` 和 `RigidBody2D.LinearVelocity` **不可靠**用于判断碰撞方向。

**原因**：
- `WorldNormal` 受物理引擎求解顺序、碰撞体边缘、穿透深度等因素影响
- `LinearVelocity` 可能已被碰撞响应修改，不反映碰撞前的真实速度

**推荐**：始终使用 `Node.LocalPosition` 的相对位置比较。

```csharp
#if CLIENT
private void OnPlayerCollisionBegin(Node.CollisionContact2D contact)
{
    var other = contact.Other;
    if (other == null) return;
    
    // 敌人踩踏判定：位置比较 + 速度辅助
    if (other.Name.ToString().StartsWith("Enemy"))
    {
        float playerCenterY = playerNode.LocalPosition.Y;
        float enemyCenterY = other.LocalPosition.Y;
        
        // 玩家在敌人上方 且 正在下落 → 踩踏
        if (playerCenterY > enemyCenterY && playerBody.LinearVelocity.Y < 0f)
        {
            KillEnemy(other);
            // 踩踏反弹
            playerBody.LinearVelocity = new Vector2(
                playerBody.LinearVelocity.X, JumpImpulse * 0.6f);
        }
        else
        {
            DamagePlayer();
        }
        return;
    }
    
    // 从下方顶砖块：玩家在方块下方
    if (other.Name.ToString().StartsWith("Brick"))
    {
        if (playerNode.LocalPosition.Y < other.LocalPosition.Y)
        {
            BumpBlock(other);
        }
    }
    
    // 着地检测：WorldNormal 对平坦地面可靠
    if (IsGroundNode(other))
    {
        var pts = contact.ContactPoints;
        if (pts != null && pts.Length > 0 && pts[0].WorldNormal.Y < -0.5f)
        {
            groundContactCount++;
            isOnGround = true;
        }
    }
}
#endif
```

#### IsTrigger 与碰撞体配置

| 对象类型 | BodyType | IsTrigger | MaskBits | 说明 |
|---------|----------|-----------|----------|------|
| 地面/平台 | Static | false | Player | 物理阻挡玩家 |
| 砖块/问号块 | Static | false | Player | 物理阻挡 + 顶撞事件 |
| 玩家 | Dynamic | false | Ground+Enemy+Coin+Flag | 受物理模拟影响 |
| 敌人 | Kinematic | **true** | Player | 代码控制移动，不阻挡玩家 |
| 金币 | Static | **true** | Player | 拾取后销毁 |
| 终点旗帜 | Static | **true** | Player | 通关触发 |

**关键区别**：
- `IsTrigger = true` 的碰撞体不产生物理阻挡，仅触发 `OnCollisionBegin2D` / `OnCollisionEnd2D` 事件
- 敌人用 `Kinematic` + `IsTrigger` 组合：代码控制位移（不被物理引擎移动），碰撞只产生事件（不阻挡玩家走位）
- **不要**对敌人使用 `OnCollisionPreSolve2D` + `isActive = false` 来避免阻挡——直接用 `IsTrigger` 更简洁可靠

#### 着地检测

使用计数器追踪着地状态（玩家可能同时接触多个地面碰撞体）：

```csharp
#if CLIENT
private int groundContactCount = 0;
private bool isOnGround = false;

// OnCollisionBegin2D
if (IsGroundNode(other))
{
    var pts = contact.ContactPoints;
    if (pts != null && pts.Length > 0 && pts[0].WorldNormal.Y < -0.5f)
    {
        groundContactCount++;
        isOnGround = true;
    }
}

// OnCollisionEnd2D
if (IsGroundNode(other))
{
    groundContactCount = Math.Max(0, groundContactCount - 1);
    if (groundContactCount == 0) isOnGround = false;
}
#endif
```

配合 Coyote Time（离地后短暂保留跳跃能力）和 Jump Buffer（着地前短暂预输入跳跃），提升操作手感：

```csharp
const float CoyoteTime = 0.1f;      // 离地后 0.1 秒内仍可跳跃
const float JumpBufferTime = 0.12f;  // 着地前 0.12 秒内的跳跃输入自动执行

// 在 Think(dt) 中更新
if (isOnGround) coyoteTimer = CoyoteTime;
else coyoteTimer -= dt;

if (jumpPressed) jumpBufferTimer = JumpBufferTime;
else jumpBufferTimer -= dt;

if (jumpBufferTimer > 0 && coyoteTimer > 0)
{
    playerBody.LinearVelocity = new Vector2(playerBody.LinearVelocity.X, JumpImpulse);
    coyoteTimer = 0;
    jumpBufferTimer = 0;
}
```

#### SceneGraph 资源清理（必须）

Physics2D 依赖 SceneGraph，持有原生 C++ 资源。游戏类必须继承 `DisposableObject` 并在 `Game.OnGameEnd` 中清理：

```csharp
#if CLIENT
public class MyGame : DisposableObject, IGameClass, IThinker
{
    private SceneGraph? sceneGraph;
    
    private void Initialize()
    {
        sceneGraph = new SceneGraph("MyPhysicsScene");
        var pw = sceneGraph.CreateComponent<PhysicsWorld2D>();
        pw.Gravity = new Vector2(0, -28f);
        // ... 创建节点和碰撞体
        
        Game.OnGameEnd += OnGameEnd;
    }
    
    private void OnGameEnd()
    {
        Destroy();  // 触发 DisposeManaged → 清理 SceneGraph
    }
    
    protected override void DisposeManaged()
    {
        sceneGraph?.Destroy();
        base.DisposeManaged();
    }
}
#endif
```

> 详见 [GameGraphOverview - 游戏结束与资源清理](../../systems/GameGraphOverview.md#游戏结束与资源清理)。

---

## 渲染系统最佳实践

### 坐标系统设计原则

#### 1. 建立清晰的相对坐标

```csharp
// 正确：推荐：使用清晰的相对坐标和有意义的变量名
public void DrawPlayer(Canvas canvas, float screenX, float screenY, float height)
{
    // 从上到下定义各部分
    float headCenterY = screenY + height * 0.15f;  // 头部中心：15%
    float bodyTop = screenY + height * 0.35f;      // 身体顶部：35%
    float bodyHeight = height * 0.35f;             // 身体高度：35%
    float legTop = bodyTop + bodyHeight;           // 腿部顶部：70%
    float legHeight = height * 0.3f;               // 腿部高度：30%
    
    // 绘制各部分
    DrawHead(canvas, screenX, headCenterY, height * 0.2f);
    DrawBody(canvas, screenX, bodyTop, height * 0.35f);
    DrawLegs(canvas, screenX, legTop, height * 0.3f);
}

// 错误：避免：混淆的名称
float bodyBottom = screenY - 5f;  // 实际上是腿部顶部，名称误导
```

#### 2. 严格的绘制顺序（从后到前）

```csharp
public void DrawScene(Canvas canvas)
{
    // 1. 最底层：背景
    DrawBackground(canvas);
    
    // 2. 远景元素
    DrawClouds(canvas);
    
    // 3. 游戏对象（从后到前）
    DrawPlatforms(canvas);
    DrawEnemies(canvas);
    DrawPlayer(canvas);
    
    // 4. 特效层
    DrawParticles(canvas);
    
    // 5. 最顶层：UI
    DrawScore(canvas);
    DrawHealth(canvas);
}

public void DrawCharacter(Canvas canvas, float x, float y, float height)
{
    // 角色内部也要分层
    DrawBody(canvas, x, y);      // 1. 身体
    DrawArms(canvas, x, y);      // 2. 手臂
    DrawHead(canvas, x, y);      // 3. 头部
    DrawFacialFeatures(canvas);  // 4. 面部特征
    DrawHat(canvas, x, y);       // 5. 帽子（最上层）
}
```

### 常见渲染陷阱

#### 陷阱1：形状之间有空隙

**症状**：身体和腿脱节，背景色透出

```csharp
// 错误：错误：坐标计算不连续
float bodyTop = screenY - 50f;
float bodyBottom = screenY - 5f;  // 这实际是腿部顶部

// 身体：从 screenY-50 到 screenY-25
canvas.FillRectangle(x - 12f, bodyTop, 24f, 25f);

// 腿部：从 screenY-5 到 screenY
canvas.FillRectangle(x - 12f, bodyBottom, 8f, 5f);

// 结果：screenY-25 到 screenY-5 之间有 20 像素空隙！
```

**解决方案**：
```csharp
// 正确：正确：确保每个部分的底部 = 下一个部分的顶部
float bodyTop = screenY + height * 0.35f;
float bodyHeight = height * 0.35f;
float bodyBottom = bodyTop + bodyHeight;

float pantsHeight = height * 0.3f;
float pantsBottom = bodyBottom + pantsHeight;

float legTop = pantsBottom;  // 腿部从裤子底部开始
float legHeight = height * 0.3f;

// 填充裤子，连接身体和腿部
canvas.FillPaint = Color.Blue;
canvas.FillRectangle(x - 12f, bodyBottom, 24f, pantsHeight);
```

#### 陷阱2：角色尺寸变化时脚深入地面

**症状**：角色尺寸变化后，底部穿过地面或悬空

```csharp
// 错误：错误：修改高度时没有调整位置
public void ChangeSize(float newHeight)
{
    Height = newHeight;  // 直接修改高度
    // 由于位置是顶部坐标，底部位置改变了！
}

// 正确：正确：保持底部位置不变
public void ChangeSize(float newHeight)
{
    // 1. 记录底部位置
    float bottomY = Position.Y + Height;
    
    // 2. 修改高度
    Height = newHeight;
    
    // 3. 调整位置，保持底部位置不变
    Position = new Vector2(Position.X, bottomY - Height);
}
```

**关键原则**：角色尺寸变化时，应保持脚部（底部）位置不变，通过调整顶部位置来实现尺寸变化。

#### 陷阱3：渲染超出碰撞边界

**症状**：角色一出现脚就在地面以下，视觉与物理不一致

```csharp
// 错误：错误：比例超过100%
public void DrawPlayer(Canvas canvas, Player player, float height)
{
    float headHeight = height * 0.35f;    // 35%
    float bodyHeight = height * 0.35f;    // 35%
    float pantsHeight = height * 0.3f;    // 30%
    float legHeight = height * 0.3f;      // 30%
    float shoeHeight = height * 0.1f;     // 10%
    // 总计：35% + 35% + 30% + 30% + 10% = 140%
    
    // 绘制各部分...
    // 结果：鞋子底部在 player.Position.Y + height * 1.4，超出碰撞框！
}

// 正确：正确：确保所有部分在角色高度范围内
public void DrawPlayer(Canvas canvas, Player player, float height)
{
    // 方案1：所有部分总和 = 100%
    float headHeight = height * 0.35f;    // 35%
    float bodyHeight = height * 0.35f;    // 35%
    float legsHeight = height * 0.3f;     // 30%
    // 总计：100% ✓
    
    // 方案2：部分重叠绘制（腿和鞋在下半身内）
    float bodyTop = player.Position.Y + height * 0.35f;
    float bodyHeight = height * 0.35f;
    float pantsTop = bodyTop + bodyHeight;
    float pantsHeight = height * 0.3f;  // 到此 = 100%
    
    // 腿和鞋子在下半身区域内重叠绘制
    DrawLegsInsidePants(canvas, pantsTop, pantsHeight);
    DrawShoesInsidePants(canvas, pantsTop + pantsHeight - height * 0.05f);
}
```

**验证方法**：
```csharp
// 所有渲染部分的最底部必须满足：
float renderBottom = /* 计算所有部分的最低点 */;
Debug.Assert(renderBottom <= player.Position.Y + player.Height, 
    "渲染超出碰撞边界！");
```

---

## 游戏设计最佳实践

### 游戏平衡性考虑

#### 问题：敌人游荡到玩家初始位置导致开局死亡

**症状**：游戏加载后玩家还未操作就被敌人撞到死亡

**解决方案1 - 设置敌人移动边界**：
```csharp
public class Enemy
{
    // 添加移动边界属性
    public float MinX { get; set; } = 400f;  // 左边界：保护玩家起始区域
    public float MaxX { get; set; } = float.MaxValue;  // 右边界
    
    public void Update(float deltaTime)
    {
        // 更新位置
        Position += Velocity * deltaTime;
        
        // 检查移动边界
        if (Position.X < MinX)
        {
            Position = new Vector2(MinX, Position.Y);
            Velocity = new Vector2(-Velocity.X, Velocity.Y);
            MovingRight = true;
        }
        else if (Position.X + Width > MaxX)
        {
            Position = new Vector2(MaxX - Width, Position.Y);
            Velocity = new Vector2(-Velocity.X, Velocity.Y);
            MovingRight = false;
        }
    }
}
```

**解决方案2 - 给玩家初始无敌时间**：
```csharp
public class Player
{
    public bool IsInvincible { get; private set; }
    private float invincibleTimer;
    
    public void MakeInvincible(float duration)
    {
        IsInvincible = true;
        invincibleTimer = duration;
    }
    
    public void Update(float deltaTime)
    {
        if (IsInvincible)
        {
            invincibleTimer -= deltaTime;
            if (invincibleTimer <= 0)
            {
                IsInvincible = false;
            }
        }
        
        // 其他更新逻辑...
    }
}

public class GameState
{
    public GameState(float gameWidth, float gameHeight)
    {
        // 初始化玩家
        Player = new Player(100, groundY - playerHeight);
        
        // 给玩家2秒的初始无敌保护时间
        Player.MakeInvincible(2f);
    }
    
    public void LoseLife()
    {
        Lives--;
        if (Lives > 0)
        {
            Player = new Player(100, groundY - playerHeight);
            // 重生时也给予无敌保护时间
            Player.MakeInvincible(2f);
        }
    }
}
```

**关键点**：
- 敌人不应该能到达玩家的初始安全区域
- 初始无敌时间应该足够长（2-3秒），让玩家有时间反应
- 重生时也需要无敌保护时间
- 两种方案可以同时使用，提供双重保护

---

## 2D游戏开发检查清单

开发Canvas 2D游戏前，确保AI工具已理解和遵循：

### 编译和环境
- [ ] **使用正确的编译配置**：`dotnet build *.sln -c Client-Debug`
- [ ] **所有客户端代码包裹在** `#if CLIENT` 中
- [ ] **已确认GameUI命名空间可用**

### 设计规范
- [ ] **从 `ScreenViewport.Primary.DesignResolution` 获取设计分辨率**（默认横屏 1920×1080，竖屏 1080×1920，可配置）
- [ ] **所有游戏元素尺寸基于设计分辨率计算**（使用比例而非硬编码像素值）
- [ ] **UI元素考虑了SafeZonePadding**（避免被刘海/圆角/手势区域遮挡）
- [ ] **监听了屏幕方向变化事件**（如果需要适配旋转）

### Canvas API使用
- [ ] **理解椭圆/圆形使用中心+半径**，而非左上角+尺寸
- [ ] **理解矩形使用左上角+尺寸**
- [ ] **使用 `.FullScreen()` 扩展方法**使Canvas填满屏幕
- [ ] **悬停效果使用 `DeviceInfo.PrimaryInputManager.OnPointerButtonMove`**
- [ ] **PointerEventArgs 使用 `e.X`/`e.Y` 或 `e.Position`** 获取坐标

### 渲染系统
- [ ] **设计了清晰的相对坐标系统**
- [ ] **使用有意义的变量名**（如 `bodyTop`, `headCenterY`）
- [ ] **规划了正确的绘制层次**（从后到前）
- [ ] **检查了形状之间是否有空隙**
- [ ] **检查了角色渲染比例之和是否≤100%**（避免脚深入地面）

### 物理系统
- [ ] **选择了合适的物理方式**（脚本物理 vs Physics2D）
- [ ] **如果涉及跳跃，已正确计算跳跃速度**（使用公式 v = sqrt(2gh)）
- [ ] **碰撞检测使用位置范围而非速度预测**
- [ ] **碰撞检测添加了容差**（如20像素）
- [ ] **角色尺寸变化时保持底部位置不变**
- [ ] **Physics2D 游戏：碰撞方向用位置比较判断**（不依赖 WorldNormal / LinearVelocity）
- [ ] **Physics2D 游戏：着地检测使用接触计数器**（非单一布尔值）
- [ ] **Physics2D 游戏：事件触发类对象用 IsTrigger**（金币、敌人、旗帜）
- [ ] **Physics2D 游戏：继承 DisposableObject，Game.OnGameEnd 中 Destroy()**

### 游戏平衡性
- [ ] **敌人不会游荡到玩家初始位置**（设置移动边界或初始无敌时间）
- [ ] **初始无敌时间足够长**（2-3秒）
- [ ] **重生时有无敌保护时间**

### 项目结构
- [ ] **游戏类文件放在正确的项目目录下**
- [ ] **在 `ScopeData.GameMode.cs` 中注册了游戏模式**
- [ ] **在 `GlobalConfig.cs` 中添加了游戏模式**

---

## 常见错误速查表

| 错误症状 | 可能原因 | 解决方案 |
|---------|---------|---------|
| 3000+编译错误，GameUI找不到 | 未使用Client-Debug配置 | `dotnet build -c Client-Debug` |
| 椭圆/圆形位置不对 | 混淆了中心坐标和左上角 | 使用 `centerX, centerY, radius` |
| 角色各部分脱节有空隙 | 坐标计算不连续 | 确保每部分底部=下部分顶部 |
| 角色脚深入地面 | 渲染比例>100% | 所有部分比例总和≤100% |
| 跳不上平台 | 跳跃速度不足 | 用公式计算：v=sqrt(2gh) |
| 玩家穿透平台 | 碰撞检测逻辑错误 | 使用位置范围+容差检测 |
| 角色变大时脚深入地面 | 尺寸变化时位置未调整 | 保持底部位置不变 |
| 地面在画面中部而非底部 | 使用了动态分辨率计算 | 使用固定设计分辨率 |
| 开局就死亡 | 敌人到达初始位置 | 设置敌人边界或初始无敌 |
| UI按钮被刘海/圆角遮挡 | 未考虑SafeZonePadding | 将UI放在安全区域内 |
| 底部按钮误触系统手势 | 按钮太靠近屏幕边缘 | 使用SafeZonePadding留出边距 |
| Canvas点击位置不正确 | Canvas没有填满屏幕 | 使用 `.FullScreen()` 扩展方法 |
| Canvas没有 OnPointerMoved | Canvas控件不支持此事件 | 使用 `DeviceInfo.PrimaryInputManager.OnPointerButtonMove` 或触发器 `EventGamePointerButtonMove` |
| PointerEventArgs 找不到 Position | 使用了错误的属性名 | 使用 `e.X`/`e.Y` 或 `e.Position` |
| OnRender 签名不匹配 | 使用了错误的委托签名 | Canvas 用 `(object? sender, EventArgs e)`；CanvasAnimated 用 `OnAnimatedRender` + `CanvasAnimatedEventArgs` |
| Canvas.Invalidate() 不存在 | 这个方法不存在 | 无需调用，`OnRender` / `OnAnimatedRender` 每帧自动触发 |
| 画面残影/绘图状态混乱 | OnRender 开头未调用 `ResetState()` | 每帧第一行调用 `canvas.ResetState()` |
| WorldNormal 判断碰撞方向不准 | 2D 碰撞法线受求解顺序影响 | 用 `Node.LocalPosition` 位置比较判断方向 |
| Physics2D 游戏结束后内存泄漏 | 未清理 SceneGraph 原生资源 | 继承 `DisposableObject`，`Game.OnGameEnd` 中调用 `Destroy()` |
| 动态游戏无 deltaTime | 用了 `Canvas.OnRender`（无时间参数） | 改用 `CanvasAnimated.OnAnimatedRender` |
| CanvasAnimated 不渲染 | 未调用 `StartTiming()` | 创建后立即调用 `canvas.StartTiming()` |
| 文字不显示 | 未加载字体或未设置 FontFaceId | 先 `Canvas.CreateFont()` 再 `canvas.FontFaceId(id)` |
| TextAlign 找不到 | 缺少命名空间引用 | 添加 `using GameUI.Control.Enum;` |
| 键盘事件不触发 | 触发器被 GC 回收 | 用实例字段保存 `Trigger<EventGameKeyDown>` 引用 |
| VirtualKey 找不到 | 缺少命名空间引用 | 添加 `using GameCore.Platform.SDL;` |
| GameMode 命名空间冲突 | 尝试扩展 `GameCore.ScopeData` | 在项目自己的命名空间定义 `GameLink<GameDataGameMode, GameDataGameMode>` |
| LineCap 找不到 | 缺少命名空间引用 | 添加 `using GameUI.Graphics.Enum;` |

---

## 最佳实践总结

### 编译和环境
1. **编译配置**：始终使用 `-c Client-Debug` 编译
2. **条件编译**：所有客户端代码包裹在 `#if CLIENT` 中

### 设计规范
3. **设计分辨率**：横屏 1920×1080，竖屏 1080×1920（这一设计分辨率是通用的，不需要动态计算）
4. **相对尺寸**：所有元素尺寸使用设计分辨率的百分比

### API使用
5. **API使用**：永远先查文档，不要假设

### 渲染系统
7. **坐标系统**：建立清晰的相对坐标，使用有意义的变量名
8. **绘制顺序**：严格从后到前，分层绘制
9. **视觉检查**：代码正确≠视觉正确，需要实际运行测试

### 物理系统
10. **测试驱动**：先计算物理参数，确保游戏可玩性
11. **容差设计**：碰撞检测使用容差提高鲁棒性

### 游戏设计
12. **游戏平衡性**：保护玩家初始体验，给予足够的反应时间

---

## 相关文档

### 必读文档
- [WasiCore 开发指南](../wasicore-dev/reference.md) - 框架通用开发指南
- [流式布局 API](../ui-layout-api/reference.md) - UI系统使用指南

### 参考文档
- [框架概述](../../FRAMEWORK_OVERVIEW.md) - 框架核心概念
- [坐标系统指南](../../COORDINATE_SYSTEM_GUIDE.md) - 3D坐标系统说明
- API文档：`api/client/GameUI.Control.xml` - Canvas API详细文档

---

## AI工具使用提示

**当AI工具遇到Canvas 2D游戏开发问题时**：

### 编译问题
1. 首先检查是否使用了 `-c Client-Debug` 编译配置
2. 确认所有客户端代码包裹在 `#if CLIENT` 中

### 视觉问题
1. 检查API参数是否正确（中心 vs 左上角，半径 vs 尺寸）
2. 检查坐标计算是否连续（是否有空隙）
3. 检查绘制顺序是否正确（从后到前）
4. 检查渲染比例是否≤100%

### 物理问题
1. 使用公式计算跳跃速度：v = sqrt(2 * g * h)
2. 碰撞检测使用位置范围 + 容差
3. 角色尺寸变化时保持底部位置不变

### 游戏平衡性问题
1. 设置敌人移动边界保护初始区域
2. 给予玩家初始和重生无敌时间（2-3秒）

---

## Canvas 事件详解

### Canvas vs CanvasAnimated

| 控件 | 渲染事件 | 事件参数 | 适用场景 |
|------|---------|---------|---------|
| `Canvas` | `OnRender` | `EventArgs`（无时间信息） | 静态绘制、简单 UI |
| `CanvasAnimated` | `OnAnimatedRender` | `CanvasAnimatedEventArgs`（含 DeltaTime/TotalTime） | 动画、游戏循环 |

动态 2D 游戏推荐使用 `CanvasAnimated`：

```csharp
#if CLIENT
using GameUI.Control.Primitive;
using GameUI.Control.Primitive.Struct;

var canvas = new CanvasAnimated();
canvas.FullScreen();
canvas.StartTiming();  // 必须调用！否则 OnAnimatedRender 不触发

canvas.OnAnimatedRender += (sender, e) =>
{
    float dt = e.DeltaTimeInSeconds;            // 帧间隔（秒）
    float total = e.TotalElapsedTimeInSeconds;  // 总计时（秒）
    
    canvas.ResetState();
    UpdateGame(dt);
    DrawGame();
};

canvas.AddToVisualTree();
#endif
```

`CanvasAnimated` 继承 `Canvas`，所有 Canvas 的绘图方法和事件（包括 `OnRender`）均可用。

### OnRender 事件（Canvas 基类）

`OnRender` 是 Canvas 基类的渲染事件，每帧自动调用。

```csharp
#if CLIENT
// 正确的 OnRender 签名
private static void OnRender(object? sender, EventArgs e)
{
    DrawBackground();
    DrawGameObjects();
    DrawUI();
}

// 错误的签名
private static void OnRender()  // 缺少参数
private static void OnRender(object? sender, RenderEventArgs e)  // RenderEventArgs 不存在
#endif
```

**关键点**：
- Canvas 内容在帧间持久保留。若内容为静态，可以只绘制一次而不清除，无需每帧重绘
- 绘制动态内容时，每帧开头调用 `canvas.ResetState()` 清除画面并重置绘图状态（画笔、字体、变换等）
- `OnRender` / `OnAnimatedRender` 每帧自动调用，无需手动请求重绘
- `Canvas.Invalidate()` 方法**不存在**
- 需要 deltaTime 的游戏应使用 `CanvasAnimated.OnAnimatedRender` 而非 `Canvas.OnRender`

### 键盘输入

Canvas 游戏中使用 `Trigger<EventGameKeyDown>` / `Trigger<EventGameKeyUp>` 处理键盘输入。

```csharp
#if CLIENT
using GameCore.Platform.SDL;       // VirtualKey
using GameUI.TriggerEvent;         // EventGameKeyDown, EventGameKeyUp

public class MyGame : IGameClass
{
    // 必须用字段保持触发器引用，防止 GC 回收
    private Trigger<EventGameKeyDown>? keyDownTrigger;
    private Trigger<EventGameKeyUp>? keyUpTrigger;

    private void Initialize()
    {
        // 按键按下
        keyDownTrigger = Game.Subscribe<EventGameKeyDown>(async (s, d) =>
        {
            HandleKeyDown(d.Key);
        });

        // 按键释放（可选，用于检测按住状态）
        keyUpTrigger = Game.Subscribe<EventGameKeyUp>(async (s, d) =>
        {
            HandleKeyUp(d.Key);
        });
    }

    private void HandleKeyDown(VirtualKey key)
    {
        switch (key)
        {
            case VirtualKey.Left or VirtualKey.A:
                inputLeft = true;
                break;
            case VirtualKey.Right or VirtualKey.D:
                inputRight = true;
                break;
            case VirtualKey.Space or VirtualKey.W or VirtualKey.Up:
                inputJump = true;
                break;
            case VirtualKey.R:
                ResetGame();
                break;
        }
    }

    private void HandleKeyUp(VirtualKey key)
    {
        switch (key)
        {
            case VirtualKey.Left or VirtualKey.A:
                inputLeft = false;
                break;
            case VirtualKey.Right or VirtualKey.D:
                inputRight = false;
                break;
            case VirtualKey.Space or VirtualKey.W or VirtualKey.Up:
                inputJump = false;
                break;
        }
    }
}
#endif
```

#### VirtualKey 常用值速查

| 按键 | VirtualKey 枚举值 |
|------|------------------|
| 方向键 | `Up` / `Down` / `Left` / `Right` |
| WASD | `W` / `A` / `S` / `D` |
| 空格 | `Space` |
| 回车 | `Return` |
| ESC | `Escape` |
| 退格 | `Backspace` |
| Tab | `Tab` |
| 字母 A–Z | `A`–`Z`（值 97–122） |
| 数字 0–9 | `Number0`–`Number9`（值 48–57） |
| F1–F12 | `F1`–`F12` |
| Delete | `Delete` |
| Shift/Ctrl/Alt | `LeftShift` / `LeftCtrl` / `LeftAlt` 等 |

> `EventGameKeyDown` 的 `isRepeat` 字段可区分首次按下和持续按住（按住时后续事件 `isRepeat = true`）。

#### 必需的 using 声明

```csharp
using GameCore.Platform.SDL;   // VirtualKey
using GameUI.TriggerEvent;     // EventGameKeyDown, EventGameKeyUp
using Events;                  // Trigger<T>
```

### 图片资源路径

Canvas `DrawImage` 使用引擎 UI 图片路径。图片文件放在项目 `ui/` 下，代码路径从 `ui/` 下一级开始写：

```text
ui/image/player.png  ->  new Image("image/player.png")
ui/image/enemy/slime.png  ->  new Image("image/enemy/slime.png")
```

```csharp
#if CLIENT
var playerImage = new Image("image/player.png");
canvas.DrawImage(playerImage, 100, 100, 128, 128);
#endif
```

不要写 `new Image("ui/image/player.png")`，也不要把 Canvas 图片放到 `user_files`。`Image` 是引擎资源路径，不是脚本文件路径。`user_files` 只用于 `File.ReadAllText("user_files/...")` 这类直接文件读取。

### 文字渲染

Canvas 提供基于 NanoVG 的文字渲染 API。

```csharp
#if CLIENT
using GameUI.Control.Enum;  // TextAlign 枚举

// 1. 加载字体（全局只需一次）
private static int fontId = -1;

private void Initialize()
{
    if (fontId < 0)
    {
        fontId = Canvas.CreateFont("GameFont", "ui/font/regular/RegularBold.otf");
    }
}

// 2. 在 OnRender 中使用
private void DrawText(Canvas canvas)
{
    canvas.FontFaceId(fontId);             // 设置字体
    canvas.FontSize(28);                    // 字号
    canvas.TextAlign(TextAlign.Center | TextAlign.Middle);  // 水平居中 + 垂直居中
    canvas.FillPaint = Color.White;         // 文字颜色
    canvas.DrawText(960f, 540f, "Hello World");             // 绘制在指定位置
}
#endif
```

#### TextAlign 枚举值

TextAlign 通过水平和垂直标志的组合设置对齐方式：

| 水平对齐 | 值 | 垂直对齐 | 值 |
|---------|---|---------|---|
| `TextAlign.Left` | 默认 | `TextAlign.Top` | 顶部 |
| `TextAlign.Center` | 居中 | `TextAlign.Middle` | 垂直居中 |
| `TextAlign.Right` | 右对齐 | `TextAlign.Bottom` | 底部 |
| | | `TextAlign.Baseline` | 默认，基线对齐 |

组合使用：`canvas.TextAlign(TextAlign.Right | TextAlign.Top);`

#### 字体路径

字体路径使用框架内置资源路径格式，如 `"ui/font/regular/RegularBold.otf"`。可从项目的 `ref/fontref.txt` 文件查看所有可用字体。

#### 文字渲染 API 速查

| API | 说明 |
|-----|------|
| `Canvas.CreateFont(name, path)` | 加载字体，返回 fontId（只需一次） |
| `Canvas.FindFont(name)` | 按名称查找已加载的字体 |
| `canvas.FontFaceId(fontId)` | 设置当前字体 |
| `canvas.FontSize(size)` | 设置字号 |
| `canvas.TextAlign(align)` | 设置对齐（使用 `TextAlign` 枚举组合） |
| `canvas.DrawText(x, y, text)` | 在指定位置绘制文字 |
| `canvas.FontBlur(blur)` | 设置模糊（用于发光/阴影效果） |
| `canvas.LetterSpacing(spacing)` | 设置字间距 |

### 指针移动事件

Canvas 控件**没有**非捕获状态的 `OnPointerMoved` 事件，但可以使用：

1. **`DeviceInfo.PrimaryInputManager.OnPointerButtonMove`** - 全局 InputManager 事件
2. **`EventGamePointerButtonMove`** - 触发器事件

```csharp
#if CLIENT
// 方式1：InputManager 事件
DeviceInfo.PrimaryInputManager.OnPointerButtonMove += (EventGamePointerButtonMove e) =>
{
    var pos = e.PointerPosition;
    if (pos.HasValue)
    {
        _mouseX = pos.Value.X;
        _mouseY = pos.Value.Y;
    }
};
#endif
```

这两种方式都不需要控件捕获，可以在鼠标悬停时追踪位置。

### OnPointerCapturedMove 的关键前提

**必须调用 `CapturePointer()` 才能触发 `OnPointerCapturedMove` 事件！**

这是一个非常常见的错误：开发者订阅了 `OnPointerCapturedMove` 事件，却忘记在 `OnPointerPressed` 中调用 `CapturePointer()`，导致拖拽/绘制功能完全无响应。

```csharp
#if CLIENT
// 错误：错误：缺少 CapturePointer，OnPointerCapturedMove 永远不会触发！
canvas.OnPointerPressed += (sender, e) =>
{
    _isPressed = true;
    // 缺少 CapturePointer 调用！
};

canvas.OnPointerCapturedMove += (sender, e) =>
{
    // 这个事件永远不会触发！
};

// 正确：正确：必须调用 CapturePointer
canvas.OnPointerPressed += (sender, e) =>
{
    _isPressed = true;
    canvas.CapturePointer(e.PointerButtons);  // 关键！
};

canvas.OnPointerCapturedMove += (sender, e) =>
{
    // 现在可以正常接收移动事件了
    var pos = e.PointerPosition;
    if (pos != null)
    {
        HandleDrag(pos.X, pos.Y);
    }
};

canvas.OnPointerReleased += (sender, e) =>
{
    _isPressed = false;
    canvas.ReleasePointer(e.PointerButtons);  // 配对释放
};
#endif
```

**工作原理**：
1. 用户按下 → `OnPointerPressed` 触发 → 调用 `CapturePointer()` 开始捕获
2. 用户移动 → `OnPointerCapturedMove` 触发（只有捕获后才会触发）
3. 用户释放 → `OnPointerReleased` 触发 → 调用 `ReleasePointer()` 结束捕获

详细信息请参考：[指针捕获系统文档](../../systems/PointerCaptureSystem.md)

---

## 游戏模式注册

### 自定义 GameMode 的正确方式

**不要**尝试扩展 `GameCore.ScopeData.GameMode` 命名空间，会导致冲突。

```csharp
// 错误：错误：会导致命名空间冲突
namespace GameCore.ScopeData;
public static partial class GameMode
{
    public static readonly GameLink<GameDataGameMode, GameDataGameMode> MyGame = new("MyGame"u8);
}

// 正确：正确：在项目命名空间中定义
namespace GameEntry;
public static class MyGameData
{
    public static readonly GameLink<GameDataGameMode, GameDataGameMode> MyGameMode = new("MyGame"u8);
}
```

### 2D游戏 vs 3D游戏的场景配置

**场景（Scene）是为3D游戏设计的**，用于加载3D世界、地形、光照等。对于纯 Canvas 2D 游戏，不需要配置场景。

> 以下代码中的 `ScopeData.GameDataPlayerSettings`、`ScopeData.GameDataScene` 等为**项目自动生成的数据引用**，各项目不同，非框架 API。

```csharp
// 2D Canvas 游戏配置（无需场景）
_ = new GameDataGameMode(My2DGameData.My2DGameMode)
{
    Name = "My 2D Game",
    Gameplay = Gameplay.Default,
    PlayerSettings = ScopeData.GameDataPlayerSettings.PlayerSettings,
    SceneList = [],  // 空集合，2D游戏不需要3D场景
    GameUI = GameUI.ScopeData.GameUI.Default,
    // DefaultScene 不设置，2D游戏不需要默认场景
};

// 3D 游戏配置（需要场景，ScopeData 引用为项目示例）
_ = new GameDataGameMode(My3DGameData.My3DGameMode)
{
    Name = "My 3D Game",
    Gameplay = Gameplay.Default,
    PlayerSettings = ScopeData.GameDataPlayerSettings.PlayerSettings,
    SceneList = [
        ScopeData.GameDataScene.main_scene,
        ScopeData.GameDataScene.dungeon_scene,
    ],
    GameUI = GameUI.ScopeData.GameUI.Default,
    DefaultScene = ScopeData.GameDataScene.main_scene,  // 启动时加载的默认场景
};
```

| 属性 | 2D Canvas 游戏 | 3D 游戏 |
|------|---------------|---------|
| `SceneList` | `[]` 空集合 | 包含所有可用场景 |
| `DefaultScene` | 不设置 | 设置为启动场景 |

### 注册游戏启动逻辑

```csharp
#if CLIENT
public class MyGame : IGameClass
{
    public static void OnRegisterGameClass()
    {
        // 仅在目标游戏模式下注册
        if (GameDataGlobalConfig.TestGameMode != MyGameData.MyGameMode)
            return;
            
        Game.OnGameTriggerInitialization += OnGameTriggerInitialization;
    }
    
    private static void OnGameTriggerInitialization()
    {
        Game.Subscribe<EventGameStart>(async (s, d) =>
        {
            Initialize();
        });
    }
    
    private static void Initialize()
    {
        // 初始化 Canvas 和游戏逻辑
    }
}
#endif
```

### 资源清理说明

**Canvas/UI 无需手动清理**：游戏结束时 UI 控件随游戏实例自动清除，C# 对象随 WASM 沙箱回收。

- 纯 Canvas 绘制的游戏（无 SceneGraph）不需要在 `Game.OnGameEnd` 中做额外清理
- **但 2D 物理游戏常见模式是 Canvas 绘制 + SceneGraph/Physics2D 做物理模拟**（SceneGraph 不渲染，物理坐标映射到 Canvas 上）。这种情况下 SceneGraph 持有原生 C++ 资源，**必须**在 `Game.OnGameEnd` 中手动 `Destroy()` 释放，否则会导致原生内存泄漏
- 判断标准：代码中是否使用了 `new SceneGraph()`、`new Node()` 等 GameGraph 底层 API 创建原生对象。如果有，就需要清理。详见 [GameGraphOverview - 游戏结束与资源清理](../../systems/GameGraphOverview.md#游戏结束与资源清理)
- 如果需要在**游戏运行中**动态移除 Canvas，仍需取消事件订阅

---

> **记住**：将本文档的相关部分提供给AI工具，可以帮助AI更好地理解Canvas 2D游戏开发的特殊要求，避免常见错误。

> **注意**：本文档是 [WasiCore开发指南](../wasicore-dev/reference.md) 的专项补充，两者应配合使用。

