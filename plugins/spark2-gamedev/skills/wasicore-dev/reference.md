# AI开发指导文档

## 文档说明

本文档专为**使用AI工具开发WasiCore框架游戏**而设计，旨在解决以下核心问题：

### 文档目标
- **提供标准化提示词**：为AI工具提供准确、完整的框架信息
- **避免常见错误**：预防AI工具因不了解框架特性而产生的错误代码
- **提升开发效率**：通过模板化提示词减少重复解释框架概念的时间
- **确保代码质量**：引导AI工具生成符合框架规范的高质量代码

### 为什么需要这个文档？

WasiCore框架具有以下特殊性，需要专门的AI开发指导：

1. **WebAssembly环境限制**：禁用多线程API，需要特殊的异步处理方式
2. **独特的架构设计**：Entity/Actor分离、自动注册机制等需要特别说明
3. **框架特有API**：如`Game.Delay()`、`Game.Logger`等替代标准.NET API
4. **严格的编码规范**：特定的日志格式、属性系统使用方式等

### 如何使用本文档

1. **选择合适的提示词模板**：根据开发需求选择对应的提示词
2. **复制到AI对话中**：将相关提示词直接粘贴给AI工具
3. **替换占位符**：将`[游戏名称]`等占位符替换为具体内容
4. **根据需要组合使用**：可以组合多个提示词以满足复杂开发需求

### 使用场景示例

**场景1：新手开发者**
```
我想开发一个简单的井字棋游戏，但不熟悉WasiCore框架。
→ 使用"开发前准备"和"棋类游戏开发模板"提示词
```

**场景2：有经验的开发者**
```
我需要为现有游戏添加UI界面，但不确定框架的UI系统使用方式。
→ 使用"UI开发"和"技术约束提示"提示词
```

**场景3：调试和优化**
```
我的游戏出现了性能问题，需要AI帮助优化。
→ 使用"性能优化"和"调试技巧"提示词
```

---

## 最重要的事：正确的编译配置

WasiCore框架使用**条件编译**区分客户端和服务端代码。**必须**使用正确的编译配置：

```bash
# 正确：编译服务端代码
dotnet build *.sln -c Server-Debug

# 正确：编译客户端代码（UI、Canvas等）
dotnet build *.sln -c Client-Debug

# 错误：会导致数千个编译错误
dotnet build *.sln
dotnet build *.sln -c Debug
```

### 不使用正确配置的后果
- 所有 `#if CLIENT` 或 `#if SERVER` 包裹的代码不会被编译
- 导致 **3000+ 编译错误**
- `GameUI`、`Canvas` 等客户端专用类型显示"找不到"
- 某些服务端专用类型在错误配置下也会找不到
- AI可能会误以为是API不存在而尝试错误的替代方案

### 正确的代码结构示例

```csharp
// 客户端代码
#if CLIENT
using GameUI.Control.Primitive;
using GameUI.Graphics;

namespace YourGame
{
    public class GameRenderer
    {
        // 客户端逻辑
    }
}
#endif

// 服务端代码
#if SERVER
using GameCore.ServerSystem;

namespace YourGame
{
    public class GameServer
    {
        // 服务端逻辑
    }
}
#endif
```

**重要提示**：这是框架最常见的问题来源。AI工具在遇到编译错误时，应**首先**检查编译配置是否正确。

---

## 项目资源路径规则

AI 生成涉及资源的代码时，必须先区分“引擎资源加载”和“脚本直接读取文件”。完整说明见 `docs/guides/ResourcePathGuide.md` 与 `docs/guides/ProjectFileAccess.md`。

| 场景 | 文件位置 | 代码路径 |
|------|----------|----------|
| UI 图片、Canvas `Image`、图标、精灵图 | `ui/image/abc.png` | `image/abc.png` |
| `official-icons.json` 中的官方图标素材 | `ui/icon/buff/_0000_水晶能量.png` | `icon/buff/_0000_水晶能量.png` |
| UI Spine | `ui/Spine/hero/hero.skel` + `.atlas` + `.png` | `Spine/hero/hero` |
| 未上传云但需要随包的模型、粒子、音频等 | `res/effect/custom/particle.effect` 或 `res/sound/custom/click.wav` | `effect/custom/particle.effect` 或 `sound/custom/click.wav` |
| 脚本直接读取 JSON、文本、配置等普通文件 | 客户端 `ui/AppBundle/user_files/...`，服务端 `AppBundle/user_files/...` | `user_files/...` |

常见错误：不要写 `new Image("ui/image/abc.png")`，正确是 `new Image("image/abc.png")`；不要写 `spine.Resource = "ui/Spine/hero/hero.skel"`，正确是 `spine.Resource = "Spine/hero/hero"`；不要把引擎图片、Spine 或音频放到 `user_files`。`resources/ui-images.json` 来自 GameSystemUI，可以直接引用；需要先看原图时，从编辑器下载缓存 `<EditorUpdateRoot>/res/_m/maps/gamesystemui/<version>/gamesystemui/ui/{path}` 读取，多个版本优先看最大版本号。`resources/official-icons.json` 中的图标必须先复制到项目 `ui/icon/...`，代码或数据里仍写 `icon/...`；需要先看原图时，从 `<EditorUpdateRoot>/res/icon/{sourceRelativePath}` 读取。如果复制源不存在，告知用户打开编辑器美术资源库，点击左侧「图标」节点，等待右侧缩略图正常显示后再复制。自定义音频放在项目 `res/sound/...`，代码写 `sound/...`；`SoundResource.Load` 的参数类型是 `GameCore.ResourceType.Sound`，`Sound` 支持从 `string` 和 `UTF8String` 隐式转换；支持 WAV/OGG。需要发布统计的自定义音频，确保同一路径也出现在 `GameDataSound.Asset` 或其他 `Sound` / `IFile` 类型字段中，并优先直接写字面量路径。

自定义模型等资源通常在资源库中修改后会上传到云端，代码使用资源库路径即可。只有明确需要离线随包、暂时不走云端下载的资源，才放项目 `res/`。

---

## 核心开发提示词

### 1. 开发前准备

**必读框架资料**：
在开始开发之前，请AI工具先仔细阅读以下文档：

```
请先阅读以下框架文档来理解WasiCore框架的架构和特性：
- docs/FRAMEWORK_OVERVIEW.md - 框架概述
- docs/guides/QuickStart.md - 快速开始指南  
- docs/CONVENTIONS.md - 代码约定
- docs/systems/ - 各系统详细文档

特定场景专项指南：
- docs/ai/skills/canvas-2d-game/reference.md - Canvas 2D游戏开发专项指南
- docs/ai/skills/ui-layout-api/reference.md - AI友好的流式布局API

然后基于这些文档为我开发游戏功能。
```

### 2. 项目结构指导

**明确开发位置**：
根据游戏类型选择合适的项目：

```
请在以下项目中开发我的游戏：
- GameCore/ - 游戏核心逻辑（服务端权威）
- GameUI/ - 游戏界面组件
- Tests/Game/ - 游戏测试项目
- 或在现有的ClientTest/、HostTest/项目中添加功能

游戏逻辑应该在服务端实现以避免作弊，使用框架的同步机制。
```

### 3. 技术约束提示

**关键限制说明**：

```
重要技术约束：
1. 本框架当前仅支持单线程运行
2. 由于WebAssembly环境限制，禁止使用以下API：
   - Task.Run() - 会导致运行时错误
   - Task.Delay() - 在Wasm环境中不可用
   - Thread相关API - 不支持多线程
   - Console.WriteLine - 必须使用框架日志系统

3. 正确的替代方案：
   - 使用 Game.Delay() 替代 Task.Delay()
   - 使用 Game.Logger.LogInformation() 替代 Console.WriteLine
   - 所有异步操作必须与游戏tick对齐

UI开发特殊要求：
1. 优先使用流式布局模式（FlowOrientation）：
   - 避免元素重叠问题
   - 提高代码可维护性
   - 更适合AI代码生成
2. 使用 AutoMode.Auto 实现自适应尺寸
3. 通过 Parent 属性建立清晰的UI层级关系
4. 避免复杂的手动位置计算

3D坐标系统
WasiCore使用类似Unreal Engine的左手坐标系，Z轴是高度轴（这与许多开发者的直觉不同）：

坐标系统：
- X轴：水平方向（左右）
- Y轴：水平方向（前后，深度）
- Z轴：高度方向（上下，跳跃方向）
- XY平面：地面

正确用法：
```csharp
// 正确：Z轴用于高度
var position = new Vector3(x, y, height);  // Z是高度
velocity.Z -= gravity * deltaTime;         // 重力在Z轴负方向
velocity.Z = jumpForce;                     // 跳跃在Z轴正方向

// 地面检测
if (position.Z <= 0)  // Z=0是地面
{
    position.Z = 0;
    IsOnGround = true;
}

// 错误：Y轴用于高度（常见AI错误）
var position = new Vector3(x, height, z);  // 错误！
velocity.Y -= gravity * deltaTime;          // 错误！
```

详细说明请参考：docs/COORDINATE_SYSTEM_GUIDE.md
```

### 4. 构建验证指导

**编译检查提示**：

```
代码完成后，请使用以下命令编译项目以确保没有语法错误：

# 编译服务端调试版本
dotnet build *.sln -c Server-Debug

# 编译客户端调试版本  
dotnet build *.sln -c Client-Debug

如果有编译错误，请修正后再次编译验证。
```

## 具体游戏开发模板

### 游戏逻辑开发

```
结合框架的代码和文档，帮我在[GameEntry]项目中开发一个[游戏名称]。

要求：
1. 游戏逻辑在服务端实现以避免作弊
2. 使用框架的Entity/Actor系统
3. 使用框架的同步机制
4. 遵循框架的代码约定和最佳实践
5. 包含完整的错误处理和日志记录
```

### UI开发

```
AI开发UI界面时，请优先使用流式布局模式创建现代化界面。

推荐方式（流式布局）：
1. 使用 FlowOrientation = Orientation.Vertical 进行垂直布局
2. 使用 Height = AutoMode.Auto 实现自适应高度
3. 使用 Parent = parentPanel 建立清晰的层级关系
4. 避免手动计算像素位置，让框架自动处理间距

示例代码模式：
var panel = new Panel {
    FlowOrientation = Orientation.Vertical,  // 流式布局
    Height = AutoMode.Auto,                  // 自适应高度
    Padding = new Thickness(16, 12, 16, 12) // 统一内边距
};

var titleLabel = new Label {
    Text = "标题",
    Parent = panel,                          // 自动加入流式布局
    Margin = new Thickness(0, 0, 0, 12)     // 清晰的间距
};

避免传统方式：
- 避免手动设置复杂的 Margin 组合
- 避免使用魔法数字计算位置
- 避免可能导致元素重叠的固定布局

流式布局优势：
- 减少UI元素重叠问题
- 更易于AI理解和生成
- 代码可维护性更强
- 自动适应不同内容尺寸
```

### 测试开发

```
为[游戏名称]创建完整的测试用例。

要求：
1. 在Tests/Game/项目中创建测试
2. 测试游戏逻辑的正确性
3. 测试网络同步机制
4. 测试边界条件和异常情况
5. 使用框架的测试基础设施
```

## 开发最佳实践

### 1. 代码规范

- **使用框架的日志系统**：`Game.Logger.LogInformation("消息: {Parameter}", value)`
- **实现IGameClass接口**：确保自动注册机制正常工作
- **遵循命名约定**：参考`docs/CONVENTIONS.md`
- **使用属性系统**：正确使用框架的属性管理机制

### 2. 架构设计

- **Entity处理逻辑**：游戏状态、属性、同步
- **Actor处理视觉**：模型、特效、动画、声音
- **UI分层设计**：数据层、逻辑层、展示层分离
- **事件驱动**：使用框架的事件系统进行解耦

### 2.1 UI布局设计原则

- **优先流式布局**：使用 `FlowOrientation` 而非手动位置计算
- **自适应尺寸**：使用 `AutoMode.Auto` 让UI自动适应内容
- **清晰层级关系**：通过 `Parent` 属性建立明确的UI层级
- **语义化间距**：使用有意义的 Margin 值而非魔法数字
- **避免重叠**：让框架自动处理元素布局，减少手动干预

### 3. 性能优化

- **避免频繁分配**：使用对象池模式
- **批处理操作**：减少网络同步频率
- **延迟加载**：按需加载游戏资源
- **内存管理**：及时释放不需要的资源

### 4. 错误处理

```csharp
// 正确的错误处理模式
try
{
    // 游戏逻辑
}
catch (Exception ex)
{
    Game.Logger.LogError(ex, "操作失败: {Operation}", operationName);
    // 恢复策略
}
```

## 常见游戏类型开发模板

### 棋类游戏

```
开发一个[棋类游戏名称]：
1. 使用Entity系统管理棋盘状态
2. 服务端验证移动合法性
3. 实现回合制逻辑
4. 创建游戏UI界面
5. 添加游戏规则检查
6. 实现游戏结束判定
```

### 实时策略游戏

```
开发一个[RTS游戏名称]：
1. 使用Entity系统管理单位
2. 实现选择和移动系统
3. 创建资源管理系统
4. 实现建造系统
5. 添加战斗系统
6. 创建实时UI界面
```

### 卡牌游戏

```
开发一个[卡牌游戏名称]：
1. 使用ItemSystem管理卡牌
2. 实现卡组系统
3. 创建游戏场地
4. 实现回合制战斗
5. 添加卡牌效果系统
6. 创建卡牌UI界面
```

## 调试和测试指导

### 调试技巧

```
在开发过程中，使用以下调试方法：
1. 使用 Game.Logger 记录关键信息
2. 在测试项目中创建单元测试
3. 使用框架的调试工具
4. 检查网络同步状态
5. 监控性能指标
```

### 测试策略

```
创建全面的测试覆盖：
1. 单元测试：测试单个组件功能
2. 集成测试：测试系统间交互
3. 性能测试：测试游戏性能
4. 网络测试：测试客户端-服务器同步
5. 边界测试：测试极端情况
```

## 进阶开发指导

### 复杂功能开发

```
开发复杂游戏功能时：
1. 先设计系统架构
2. 分解成小的功能模块
3. 逐步实现和测试
4. 注意系统间的依赖关系
5. 考虑扩展性和维护性
```

### 性能优化

```
优化游戏性能：
1. 使用框架的性能分析工具
2. 优化网络同步频率
3. 减少不必要的计算
4. 使用缓存机制
5. 优化UI更新频率
```

## 开发检查清单

在开始开发和提交代码前，请AI工具确认以下事项：

### 编译和环境
- [ ] **使用正确的编译配置**：`-c Server-Debug` 或 `-c Client-Debug`
- [ ] **客户端代码包裹在** `#if CLIENT` 中
- [ ] **服务端代码包裹在** `#if SERVER` 中
- [ ] **已确认所需命名空间在目标平台可用**

### 代码规范
- [ ] **使用框架日志系统**：`Game.Logger.LogInformation("消息: {Param}", value)`
- [ ] **避免使用禁用的API**：`Task.Run()`, `Task.Delay()`, `Console.WriteLine`
- [ ] **使用正确的替代API**：`Game.Delay()`, `Game.Logger`
- [ ] **实现了IGameClass接口**（如需要自动注册）
- [ ] **遵循框架命名约定**

### 3D坐标系统（如涉及）
- [ ] **Z轴用于高度**（而非Y轴）
- [ ] **重力作用在Z轴负方向**
- [ ] **跳跃使用Z轴正方向**
- [ ] **地面检测检查Z坐标**

### Canvas 2D游戏（如涉及）
- [ ] **使用正确的设计分辨率**：横屏 1920×1080 或竖屏 1080×1920
- [ ] **理解椭圆/圆形使用中心+半径**
- [ ] **参考** [2D 游戏指南](../canvas-2d-game/reference.md)

### UI开发（如涉及）
- [ ] **优先使用流式布局**（FlowOrientation）
- [ ] **使用AutoMode.Auto实现自适应**
- [ ] **通过Parent属性建立层级**
- [ ] **参考** [流式布局 API](../ui-layout-api/reference.md)

### 架构设计
- [ ] **Entity处理逻辑**（游戏状态、属性、同步）
- [ ] **Actor处理视觉**（模型、特效、动画、声音）
- [ ] **服务端权威**（游戏逻辑在服务端以避免作弊）

### 测试和验证
- [ ] **代码已通过编译验证**
- [ ] **已添加适当的日志记录**
- [ ] **已考虑错误处理**
- [ ] **已测试基本功能**

---

## 常见问题解决

### 编译错误

**首先检查**：
- **是否使用了正确的编译配置**（`-c Server-Debug` 或 `-c Client-Debug`）
- 是否使用了禁用的API
- 确认项目引用关系正确
- 检查命名空间和using语句
- 检查条件编译指令（`#if CLIENT` / `#if SERVER`）

### 运行时错误

- 检查是否正确实现了IGameClass接口
- 确认异步操作使用了正确的方法
- 检查网络同步配置

### 游戏模式未识别

**错误信息**：`Game Mode is set to XXX, but the data is not set, using default game mode`

**常见原因及解决方案**：

1. **GameDataGameMode只在客户端注册**
```csharp
// 错误：游戏模式注册代码被 #if CLIENT 包裹
#if CLIENT
public class MyGame : IGameClass
{
    private static void OnGameDataInitialization()
    {
        _ = new GameDataGameMode(ScopeData.GameMode.MyGame) { ... };
    }
}
#endif

// 正确：游戏模式注册必须在客户端和服务端都执行
public class MyGame : IGameClass
{
    private static void OnGameDataInitialization()
    {
        _ = new GameDataGameMode(ScopeData.GameMode.MyGame) { ... };
    }

#if CLIENT
    // 只有UI相关的代码才需要包裹在 #if CLIENT 中
    public static void Start() { ... }
#endif
}
```

2. **GameDataGameMode缺少必需属性**
```csharp
// 错误：只设置了Name
_ = new GameDataGameMode(link) { Name = "游戏名" };

// 正确：设置必需属性（2D UI游戏可以使用空场景列表）
_ = new GameDataGameMode(link)
{
    Name = "游戏名",
    Gameplay = GameCore.ScopeData.Gameplay.Default,
    PlayerSettings = ScopeData.GameDataPlayerSettings.PlayerSettings,
    SceneList = [],  // 2D UI游戏不需要3D场景
    GameUI = GameUI.ScopeData.GameUI.Default,
    DefaultScene = null,  // 无默认场景
};
```

### 性能问题

- 减少频繁的属性访问
- 优化UI更新逻辑
- 使用对象池避免频繁分配

---

> **提示**：将本文档的相关部分复制到与AI工具的对话中，可以帮助AI更好地理解框架特性和开发要求。

> **参考**：更多详细信息请参考`docs/`目录下的其他文档。
