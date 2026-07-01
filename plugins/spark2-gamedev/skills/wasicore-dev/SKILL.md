---
name: wasicore-dev
description: WasiCore 游戏框架开发指南。编译配置、技术约束、代码规范、坐标系统。当开发 WasiCore 框架游戏、遇到编译错误、或需要了解框架约束时使用。
whenToUse: 当开发 WasiCore 框架游戏、遇到编译错误、需要了解框架约束、或配置项目编译选项时使用。
allowedTools: Bash, Read, Glob, Grep, Edit, Write
---

# WasiCore 框架开发指南

## 编译配置（最重要）

WasiCore 使用条件编译区分客户端和服务端代码。**必须**指定正确的配置：

```bash
dotnet build *.sln -c Server-Debug   # 编译服务端代码
dotnet build *.sln -c Client-Debug   # 编译客户端代码（UI、Canvas等）
```

**不指定配置或用 `-c Debug` 会导致 3000+ 编译错误**（`#if CLIENT` / `#if SERVER` 包裹的代码不会被编译）。

遇到编译错误时，**首先检查编译配置是否正确**。

### 条件编译代码结构

```csharp
#if CLIENT
using GameUI.Control.Primitive;
using GameUI.Graphics;
namespace YourGame
{
    public class GameRenderer { }
}
#endif

#if SERVER
using GameCore.ServerSystem;
namespace YourGame
{
    public class GameServer { }
}
#endif
```

## GameData 公式字段赋值位置

手写 C# GameData 时，先按字段可见性判断，再按公式偏向判断：

- 字段只存在于服务端 API：只在 `#if SERVER` 中赋值。
- 字段只存在于客户端 API：只在 `#if CLIENT` 中赋值。
- `[DataEditor(FunctionBias = FunctionBias.Server)]` 是服务端公式偏向，不是字段服务端专属；默认只在 `#if SERVER` 中赋值，尤其是 `GameDataEffectXXX` 效果节点。
- `[DataEditor(FunctionBias = FunctionBias.Client)]` 默认只在 `#if CLIENT` 中赋值。
- 客户端 UI / 预览确实要读取同一个公式字段，且公式只用常量或双端共有 API 时，可以共享赋值，例如 `Range = static (_) => 500`。
- 不要把所有 GameData 都放进 `#if SERVER`：表现、Actor、UI、单位显示数据仍然需要客户端定义。

详细例子见 `docs/best-practices/GameDataFormulaPlacement.md`。

## 运行时日志（排查“表现不对”时必看）

通过编辑器启动地图后，运行时日志默认写到编辑器安装目录，而不是地图工程根目录：

- 日志根目录：`<EditorRoot>/logs`（包含 `client`、`server`、`lua`、`CSharp`、`Network` 等子目录，以及根目录下的零散日志文件）
- 客户端运行时日志：`<EditorRoot>/logs/client`
- 服务端运行时日志：`<EditorRoot>/logs/server`
- 编辑器 Lua 日志：`<EditorRoot>/logs/lua`

常见安装示例：`E:/WasmSCE/logs`，其中客户端和服务端日志分别在 `client`、`server` 子目录。

常见误区：

- 地图根目录里的 `Client-Debug.log` / `Server-Debug.log` 往往只是 `dotnet build` 输出，不是实际跑图日志。
- 真正的运行时日志文件名通常类似 `wasm-default-*.log-*.log`（client）和 `wasm-game-server-*.log`（server）。
- 如果需求只说“编辑器日志”，先列出并按时间排序 `<EditorRoot>/logs`，再进入 `client`、`server`、`lua` 或其它子目录。

遇到“编译通过，但首波怪不动 / UI 不显示 / 事件没触发”这类问题时，先看 `Game.Logger` 输出是否进入了正确分支，再去上述运行时日志里按关键字定位。

当前客户端 wasm 运行时存在一个 BCL 兼容性陷阱：`string.Concat("a", "b", ...)` 和 `string.Join(";", "a", "b", ...)` 这类 params 重载可能触发 `System.Runtime.InteropServices.MemoryMarshal` 的 `TypeLoadException`。模板里的 BannedSymbols 按 symbol 禁用了 `String.Join(string, string[])`，因此需要拼接调试日志时优先用 `string.Join(separator, List<string>/IEnumerable<string>)` 或手写循环拼接；不要把这个异常误判为 SyncVar / GameGraph marshal 问题。

## 本地 AppBundle 加载配置

地图项目的 `project/use_local_appbundle_config.txt` 会影响编辑器调试时从哪里加载 wasm 运行时和 DLL：

| 值 | 行为 |
|:--|:--|
| 不存在或 `0` | 默认加载路径，使用编辑器/update 下载的 wasm 运行时和官方 DLL |
| `2` | 仍使用默认 wasm 运行时和基础 AppBundle；只从项目 `AppBundle/managed`、`ui/AppBundle/managed` 读取本地 override 的同名 DLL |
| `3` | 完整使用项目 `AppBundle/`、`ui/AppBundle/` 下的 DLL 与 wasm 文件；跳过 `update/` 下的内容，也跳过客户端自身 AppBundle 中的 BCL 内容与 wasm 文件 |

只改 `GameEntry.dll` 或某个框架 DLL 并想沿用当前编辑器运行时，优先用 `2`。需要验证本地完整 AppBundle、wasm 文件或 BCL/运行时载荷时才用 `3`；否则容易把本地 AppBundle 中缺失或陈旧的 wasm/BCL 文件误判成业务代码问题。

## 纯客户端调试

编辑器的纯客户端调试会以 `-client_only` 启动单独客户端进程，不启动服务端。代码中用 `Game.IsClientOnly` 判断：

```csharp
if (Game.IsClientOnly)
{
    // UI 假数据、GameGraph 原型、模型场景渲染测试、本地调试工具等
}
```

纯客户端模式下 Entity / Unit / CloudData / 服务端消息不可用，但纯表现层 Actor（如 `ActorSound`、`ActorModel`、`ActorParticle`）、GameGraph 和 UI 可用于本地预览。需要加载数编场景资产时，在 `#if CLIENT` 且 `Game.IsClientOnly` 分支中使用 `Scene.GetOrCreate(ScopeData.GameDataScene.xxx).LoadClientOnly()`；如果只需要当前 GameMode 的默认场景，使用 `Scene.LoadDefaultClientOnly()`。项目也可以在 `GameDataGameMode` 上设置 `AutoLoadDefaultSceneInClientOnly = true`，让纯客户端启动后自动加载 `DefaultScene`，该配置默认关闭。普通客户端/服务端流程仍由服务端切场景，不要用客户端本地切场景替代。主项目 `user_files` 在客户端编辑器调试阶段可写，包括纯客户端调试；依赖库 `deps/.../user_files` 和 AppBundle 根目录仍只读。完整说明见 `docs/guides/ClientOnlyDebug.md` 与 `docs/guides/ProjectFileAccess.md`；需要 AI 直接启动客户端测试时使用 `docs/ai/skills/client-only-debug/SKILL.md`。

## SCE 场景与 GameGraph 速记

普通联机流程里，每个客户端同一时刻最多绑定一个当前 SCE `Scene`；这个场景由框架加载、切换和卸载，不需要脚本手动维护其生命周期。SCE `Scene` 内置一个 GameGraph `SceneGraph` 包装，可通过 `using GameGraph.NodeSystem; scene.GetSceneGraph()` 获取；同步挂载根用 `scene.GetSyncRoot()`，向当前 SCE 场景加入同步节点用 `scene.AddSyncNode(node, NodeReplication.Replicated)`。

脚本 `new SceneGraph(SceneGraphReplication.ReplicatedUnpublished)` 创建的是独立发布图，不是 SCE 场景。服务端可以按玩家 `Publish(player)` / `Unpublish(player)`；同一个客户端可以在当前 SCE 场景之外同时订阅多个这种发布图。客户端 `SceneGraph.OnRegistered` / `GetRegisteredSceneGraphs()` 面向这些额外发布图，不是获取当前 SCE 场景的入口。当前 SCE 场景即使正在正常同步，也不会出现在 `GetRegisteredSceneGraphs()` 结果里；排查 SCE 场景内 replicated node 时，从当前 `Scene` / `Unit.Scene` 调 `GetSceneGraph()` 后轮询 `GetReplicatedNodes(...)`，或在拿到该 SceneGraph 后订阅它的 `OnNodeReplicated`。

发布图注册不等于自动渲染。独立 `SceneGraph` 可以只作为同步数据源使用，例如客户端读取节点状态后绘制到 Canvas/UI，而不创建 Camera 或接管 Viewport。若要直接显示为 3D 画面，客户端需要配置 `Octree`、local 表现组件、`CameraComponent` 和 Viewport；底层入口是 `Renderer.SetupMainViewport(...)`，`SceneGraphMainViewportController` 只是可选 helper。

GameGraph 3D 场景建议在初始化时主动设置 RenderPath，避免不同调试配置下默认渲染管线不一致：

```csharp
Renderer.SetupMainViewport(sceneGraph, camera);
Renderer.GetMainViewport()?.SetRenderPath(
    "EngineRes/RenderPaths/CEMapSSAO.xml"u8);
```

常用内置 RenderPath：

| 路径 | 用途 |
|:--|:--|
| `EngineRes/RenderPaths/EditorMapSSAOBloomHDR.xml` | 编辑器主视口同款，一般只在编辑器调试时使用 |
| `EngineRes/RenderPaths/CEMapSSAO.xml` | 游戏运行时常用 Forward 光照 + SSAO |
| `EngineRes/RenderPaths/CEMapDeferred.xml` | 游戏运行时 Deferred 光照 + SSAO |
| `EngineRes/RenderPaths/EditorMapDeferred.xml` | 编辑器 Deferred 变体 + SSAO |
| `EngineRes/RenderPaths/CEMapUnderUISSAO.xml` | UI 之下的游戏渲染变体，Forward 光照 + SSAO |

附加 Viewport 和 RenderToTexture Viewport 都可以独立 `SetRenderPath(...)`。推荐 init 时只设一次；运行时频繁切换可能在 D3D11 debug layer 下产生 framebuffer validation 警告。做画中画或多摄像机画面时，不要硬编码 viewport 编号，优先用 `Renderer.GetNextFreeViewportIndex()`；排查占用时用 `Renderer.GetOccupiedViewportIndices()`。`Viewport.SetRect(...)` 使用当前 render target 的像素坐标，编辑器内嵌调试时坐标以编辑器管理的游戏画布 RenderTarget 为基准。

RenderToTexture 流程：`Texture2D.CreateRenderTarget(...)` 创建纹理，取 `texture.RenderSurface`，创建独立 `Viewport`，设置 `surface.NumViewports`、`surface.SetViewport(...)` 和 `surface.UpdateMode`。RTT 结果可以挂到材质贴图槽，也可以进入 GameUI：普通控件用 `RuntimeTexture.Register("Name", texture)` 或 `.Image(texture, "Name")` 注册为 `RT:` 运行时图片；Canvas 可直接 `canvas.DrawTexture(texture, x, y, w, h)`。RTT 用于 UI 时通常用 `highDynamicRange: false`。完整代码示例见 `docs/systems/GameGraphOverview.md#客户端-viewport-与-renderpath`。

编辑器内嵌调试模式下，主 GameGraph 视口用 `Renderer.SetupMainViewport(...)`，不要用 `CreateViewport + SetViewport(0, ...)` 替代。若直接调用 `Renderer.SetViewport(...)`，SDK 会发出一次性 warning：内嵌调试的 viewport/render-target 配置与实机或独立客户端不同，手动 viewport 编号和 `SetRect` 坐标不一定代表真实运行结果。测试画中画、多 viewport 或 RenderToTexture 时，建议在编辑器启动参数中加 `-no_debug_game_in_editor`，或使用纯客户端调试模式。完整说明见 `docs/systems/GameGraphOverview.md#客户端-viewport-与-renderpath`。

Replicated `Node` 的 transform 在客户端默认会用 Urho `SmoothedTransform` 平滑到最新网络目标。平滑参数在 `SceneGraph` 上配置：`TransformSmoothingConstant`、`TransformSnapThreshold` 或 `ConfigureTransformSmoothing(...)`。这些值不随网络同步；调整客户端视觉表现时应在客户端拿到对应 `SceneGraph` 后设置。

Replicated `Node` 支持轻量 SyncVar：服务端用 `SetSyncVar(...)` 写入 `int`、`bool`、`float`、`string`、`Vector2`、`Vector3`、`Quaternion`，客户端和服务端用 `TryGetSyncVar(...)` / `HasSyncVar(...)` 读取。`SetSyncVar(...)` 只在服务端 SDK 暴露；客户端需要改变同步状态时应请求服务端处理。SyncVar 适合节点级元数据或小型状态，不替代 Entity / Unit / Player 属性系统，也不要存复杂对象或大 payload。

## 场景视野速记

需要战争迷雾、视野全开、精确视野或扇形视野时，优先读 `docs/systems/SceneVisionSystem.md`。对 AI 助手来说，默认按下面分层生成代码：

- 场景级入口是 `GameDataScene.Vision`，按 scene 生效；`SceneVisionMode.Normal` 是正常视野，`Open` 是视野全开，`Precise` 是距离 + 阻挡 + 可选扇形角度过滤。
- 精确视野的观察者策略是 `VisionObserverPolicy.AllOwnedUnits`、`Explicit`、`MainControlledUnit`。单位很多、只想让少量单位提供视野时优先用 `Explicit`，并给观察者单位配置 `ObserverEnabled = true`。
- 单位默认入口是可选的 `GameDataUnit.Vision = new UnitVisionConfig { ... }`。没有配置时不要强行创建 `UnitVision`；该配置目前只影响精确视野下的观察者选择、圆形/扇形形状和本地遮罩表现。
- 视野距离始终来自 `GSC.GameDataUnitProperty.Sight`。不要在 `UnitVisionConfig` 里编造 `Range` 字段；运行时 `unit.Vision.Range` 读写的也是 `Sight`，服务端可写，客户端只读。
- 扇形视野使用 `Shape = UnitVisionShape.Cone`、`CentralAngle < 360`、可选 `InnerRadius` 和 `DirectionSource`。`InnerRadius` 不是视野距离。
- 客户端有现成可用的本地迷雾遮罩渲染，由 `Player.LocalVisionFocus` 决定，同一客户端同一时间只支持一个焦点，通常是主控单位。开启 `SceneVisionConfig.UseMainUnitAsLocalVisionFocus` 后，会自动回退到本地玩家 `MainUnit`；手动设置 `LocalVisionFocus` 后不再自动回退，调用 `ClearLocalVisionFocusOverride()` 恢复。
- 单焦点只是内置客户端渲染的限制，不是服务端视野机制限制。服务端精确/扇形视野可以由多个观察者共同提供；如果客户端需要同时显示多个单位的圆形或扇形视野形状，建议用 Canvas 或 GameGraph 绘制 API 自绘表现，不要直接调用低层视野导入接口。
- 精确视野比普通视野更贵；优先把观察者数量控制在少量关键单位上。几十到一两百个通常更稳，达到几百个应压测；避免让成百上千个小怪都成为扇形精确视野观察者。
- 玩家单位少、敌方怪物多且怪物不需要遵守迷雾/墙体/扇形时，可以不给怪物配置 `GameDataUnit.Vision`，改自定义怪物 `GameDataAIThinkTree.ScanFilters` 去掉 `UnitRelationship.Visible`，让怪物按 AI 扫描范围发现敌人。若有潜行玩法，优先用自定义扩展 `UnitState`，并在 AI `ScanFilters`、技能 `AcquireSettings.TargetingFilters`、必要的 `GameDataEffectSearch.SearchFilters` 中排除该状态；复用 `UnitState.InvisibleToEnemy` 时要额外确认侦测/反隐语义。
- 服务端可见性是权威来源；客户端遮罩只是表现。不要直接调用低层视野导入接口，也不要把技能扇形范围误写成场景视野。

## 服务端权威 3D 物理速记

3D 物理 API 已双端可用。非 Unit 的服务端权威物理对象推荐使用 replicated `Node` 同步 transform，`PhysicsWorld` / `RigidBody` / `CollisionShape` 默认保持服务端 local；客户端在 replicated 节点上补本地 `StaticMesh`、材质、粒子、音效等表现。静态障碍优先双端 local，只有运行时状态变化才同步 replicated 节点、节点 SyncVar 或事件。

需要按玩家隔离或一个客户端同时接收多个临时图时，用脚本创建的 `SceneGraphReplication.ReplicatedUnpublished` 并在服务端 `Publish(player)`。完整模式和 smoke 测试结论见 `docs/ai/skills/server-authoritative-3d-physics/SKILL.md`、`docs/systems/PhysicsSystem.md` 与 `docs/systems/ServerGameGraphSceneGraphReplication.md`。

## 项目资源路径速记

引擎资源路径和脚本文件读写路径不同，生成代码时先判断使用场景：

| 场景 | 文件位置 | 代码路径 |
|:--|:--|:--|
| UI 图片 / Canvas `Image` / 图标 / 精灵图 | `ui/image/abc.png` | `image/abc.png` |
| `official-icons.json` 中的官方图标素材 | `ui/icon/buff/_0000_水晶能量.png` | `icon/buff/_0000_水晶能量.png` |
| UI Spine | `ui/Spine/hero/hero.skel` + `.atlas` + `.png` | `Spine/hero/hero` |
| 未上传云但要随包的模型/粒子/音频等 | `res/effect/custom/particle.effect` 或 `res/sound/custom/click.wav` | `effect/custom/particle.effect` 或 `sound/custom/click.wav` |
| 脚本直接 `File.ReadAllText` 读取的普通文件 | `ui/AppBundle/user_files/config.json` 或 `AppBundle/user_files/config.json` | `user_files/config.json` |

不要把引擎图片、Spine 或音频放到 `user_files`，也不要在 `Image` 路径里写 `ui/` 前缀。`resources/ui-images.json` 来自 GameSystemUI，可以直接引用；需要先看原图时，从编辑器下载缓存 `<EditorUpdateRoot>/res/_m/maps/gamesystemui/<version>/gamesystemui/ui/{path}` 读取，多个版本优先看最大版本号。`resources/official-icons.json` 中的图标必须先复制到项目 `ui/icon/...`，代码或数据里仍写 `icon/...`；需要先看原图时，从 `<EditorUpdateRoot>/res/icon/{sourceRelativePath}` 读取。如果复制源不存在，告知用户打开编辑器美术资源库，点击左侧「图标」节点，等待右侧缩略图正常显示后再复制。自定义音频放在项目 `res/sound/...`，代码写 `sound/...`；`SoundResource.Load` 的参数类型是 `GameCore.ResourceType.Sound`，`Sound` 支持从 `string` 和 `UTF8String` 隐式转换；支持 WAV/OGG，扩展名按实际文件填写。需要发布统计的自定义音频，确保同一路径也出现在 `GameDataSound.Asset` 或其他 `Sound` / `IFile` 类型字段中，并优先直接写字面量路径，避免路径只出现在 `SoundResource.Load(...)` 代码调用里导致清单漏收。自定义模型等资源通常由资源库上传到云端；只有特殊随包需求才放项目 `res/`。完整说明见 `docs/guides/ResourcePathGuide.md`。

## AI 两层职责速记

概念定义以 [AI 系统](../../systems/AISystem.md) 为准；做排障时可以先按下面的职责边界判断，不要把 `WaveAI` 和 `TacticalAI / AIThinkTree` 混在一起。

| 现象 / 目标 | 优先看什么 | 说明 |
|:--|:--|:--|
| 单个怪会不会自动扫描、攻击、施法 | `TacticalAI / AIThinkTree` | `GameDataUnit.TacticalAI` 是配置字段，运行时组件名叫 `AIThinkTree` |
| 一波怪沿路巡逻、跟随首领、主动接近玩家 | `WaveAI` | 负责宏观移动、路线和接近逻辑 |
| 怪物会走但不打 | `AIThinkTree` 是否真的已挂上 / `enableCombat` | 先查单位最终有没有战斗 AI，再查 WaveAI 战斗开关，最后才查 `scan range`、`MinimalApproachRange`、`HysteresisFactor`（Follow）/ `ReacquireRangeFactor`（Hunt） |

## AI 战斗排查顺序（会动但不打先看这里）

如果现象是“怪物会巡逻、跟随或追人，但就是不攻击”，**不要先猜 `scan range`、`MinimalApproachRange` 或 `HysteresisFactor`（Follow）/ `ReacquireRangeFactor`（Hunt）**。这类问题优先按下面顺序排查：

1. **先查单位最终是否真的挂上了战斗 AI**

   ```csharp
   var enemy = enemyLink.Data?.CreateUnit(player, pos, facing, useDefaultAI: true);
   AIThinkTree.AddDefaultAI(enemy!);        // 或者：
   // myAIThinkTreeLink.Data!.CreateAI(enemy!);
   ```

   对依赖 `GameDataUnit.TacticalAI` 的战斗单位，`CreateUnit(..., useDefaultAI: false)` 只表示**创建时不自动创建 `AIThinkTree`**，不代表之后不能动态添加。  
   如果既没有在创建时传 `useDefaultAI: true`，也没有后续调用 `AIThinkTree.AddDefaultAI(unit)` 或 `myAIThinkTreeLink.Data!.CreateAI(unit)`，结果通常就是：单位仍然能被 `WaveAI` 驱动移动，但不会进入单体战斗决策。

2. **再查 WaveAI 有没有在运行时把战斗关掉**

   ```csharp
   var waveAI = patrolLink.Data!.StartWaveAI(units, enableCombat: true);
   waveAI.SetCombatEnabled(null);  // 或 true
   waveAI.SetRoute(routePoints, enableCombat: true);
   ```

   下列写法都表示“行军但不战斗”：

   - `StartWaveAI(..., enableCombat: false)`
   - `waveAI.SetCombatEnabled(false)`
   - `waveAI.SetRoute(..., enableCombat: false)`

   如果只是想沿用数编里的 `EnableCombat`，优先传 `null`，不要手写 `false`。

3. **然后再查战斗 AI / 攻击能力 / 目标过滤**

   - `GameDataUnit.TacticalAI` 已配置为可用的 `GameDataAIThinkTree`（`GSC.GameDataAIThinkTree.Default` 只是默认预设，也可以自定义）
   - 如果使用默认自动攻击方案，`Abilities` 中至少一个技能设置了 `IsAttack = true`
   - 目标单位的 `Filter` 命中当前 AI 的 `ScanFilters`；默认 AI 攻击普通战斗单位时通常要求 `UnitFilter.Unit`
   - 敌我阵营关系正确，不要把敌人放到中立玩家上

   如果单位要攻击建筑，还要额外确认 `AIThinkTree.ScanFilters` / 技能 `AcquireSettings.TargetingFilters` 是否允许 `Structure`。

4. **最后才调扫描和接近参数**

   只有在前面的“硬开关”都确认正确之后，才去看：

   - `MinimalScanRange`
   - `MaximalScanRange`
   - `MinimalApproachRange`
   - `HysteresisFactor`（Follow）/ `ReacquireRangeFactor`（Hunt）
   - `CombatLeash` / `CombatResetRange`

   否则很容易把“AI 根本没启用”误判成“扫描距离太小”。

## GameData 边界与运行时修改（重要）

默认把 `ScopeData.*.Data` 视为双端共享的静态定义来源；如果这些条目来自数据编辑器，它们通常也对应 `editor/data` 下的 JSON 数编文件。

这一节**不是禁止**你在代码中动态创建或修改 `GameData`。引擎允许这样做，而且某些诉求本来就应该通过代码动态生成，例如：

- 在运行时创建带特定属性组合的单位或物品数编
- 为某个系统构造 runtime-only 的临时模板
- 按局内规则生成不需要落回数据编辑器的派生定义

真正需要避免的，是把**静态定义**、**运行时模板**和**实例状态**混写在一起，导致数据编辑器预览失去意义、代码和 JSON 同时改同一份定义、以及用户和 AI 助手都难以判断“这个值到底以哪边为准”。

### 推荐分层方式

- **静态定义**：如果某份数据本来就应该长期存在、需要在编辑器里预览、调参、复用，优先写在数据编辑器 / JSON 中，不要再在运行时把同一份共享定义改成另一套逻辑。
- **运行时模板**：如果某份定义本来就是局内动态生成、只服务某段运行时逻辑，那么可以在代码中创建独立的 runtime-only `GameData` 对象，而不是去补丁已有的共享表。
- **实例状态**：如果变化只影响某个已经创建出来的单位、物品或对象，优先修改实例本身，而不是回头修改其共享 `GameData`。

### 避免混乱的默认原则

- 不要在 gameplay trigger、刷怪逻辑或临时调试代码里直接修改 `ScopeData.*.Data` 指向的共享 `GameData`，尤其不要把模型、AI、同步方式、默认属性这类“单位定义”语义写成运行时补丁。
- 静态定义优先写回数编文件，或在 `OnGameDataInitialization` 中创建独立的 runtime-only `GameData` 对象；不要把“编辑器数据”和“运行时实例逻辑”混写在同一段刷怪代码里。
- 按波次成长、临时倍率、局内 Buff、出生后附加状态等动态变化，优先在 `CreateUnit` 之后修改单位实例的属性，而不是回头改 `GameDataUnit`。

### 需要刷新底层缓存的情况

部分 `GameData` 类型在运行时会被引擎底层缓存。相关类型实现 `IGameDataNativeCacheRefreshable`，可以在修改后调用 `SetNativeCacheRefresh()`，请求后续底层重新读取并更新这份定义。这个调用在客户端和服务端都可以使用；如果当前一侧没有使用对应缓存，会安全忽略该请求。

常见需要注意的类型主要包括：

- `GameDataUnit`
- `GameDataActorScope`
- `GameDataActor`
- `GameDataModel`
- `GameDataParticle`
- `GameDataSound`
- `GameDataAnimationSequence`

这些类型的方法在双端都可以调用。实际是否会对当前平台产生刷新效果，取决于该平台是否使用了对应的底层缓存；未使用的一侧会安全忽略刷新请求。

`GameDataUnit` 是最需要注意的例子。它对应的单位定义在引擎底层会被缓存。如果你在运行中修改了共享的 `GameDataUnit`，例如改了默认属性、模型、碰撞或其他会影响单位定义的字段，但没有调用 `SetNativeCacheRefresh()`，那么**后续新创建**的同类单位仍可能沿用旧缓存生成；而**已经创建**出来的单位通常也不会自动回溯更新。

一个常见错误是：运行中把某个 `GameDataUnit` 的默认生命值或模型改掉，然后继续用同一个 `UnitLink` 刷怪，却没有刷新缓存。结果可能是你看到“代码里已经是新数值了”，但后续刷出来的单位仍带着旧表现或旧默认数据。更危险的是，如果这段修改只在服务端或只在客户端执行，或者两端字段值、执行时机不一致，那么同一个 `UnitLink` 在两端就可能代表不同的单位定义，导致服务端逻辑和客户端表现发生偏差。

### 双端一致性要求

如果确实必须补丁共享 `GameData`，必须通过客户端和服务端一致的初始化路径执行，并明确记录原因；不要只在服务端懒触发或只在某个触发器分支里单边修改。

不管是**动态创建**还是**动态修改**数编，都必须优先保证客户端和服务端的一致性，尤其是 `GameDataUnit`：

- 两端使用同一组 `GameLink`
- 两端写入同一份字段值
- 两端在相同的初始化或运行时路径中执行相同的修改逻辑
- 修改会影响底层缓存结果的共享数编后，及时调用 `SetNativeCacheRefresh()`

不要把“只在某个触发器分支里临时改一下单位表”当成安全做法，也不要假设同步系统会自动修正两端不同的 `GameDataUnit` 定义。

换句话说，推荐的优先级是：

1. 需要编辑器可见、可预览、可复用的定义，放进数据编辑器 / JSON
2. 需要局内动态生成的一份新模板，用代码创建新的 `GameData`
3. 只影响单个对象的临时变化，修改实例而不是共享表
4. 只有在确实要修改共享定义时，才同时处理双端一致性和 `SetNativeCacheRefresh()`

## 技术约束

由于 WebAssembly 环境限制，以下 API **禁止使用**：

| 禁止的 API | 替代方案 |
|------------|---------|
| `Task.Run()` | 不需要，单线程 |
| `Task.Delay()` | `Game.Delay()` |
| `Thread` 相关 API | 不支持多线程 |
| `Console.WriteLine` | `Game.Logger.LogInformation()` |

游戏逻辑应在服务端实现以避免作弊，使用框架的同步机制。

 ## 时间 API

| API | 返回类型 | 用途 |
|-----|---------|------|
| `Game.Time` | `TimeSpan` | 游戏启动后的总时间，用 `.TotalSeconds` 或 `.TotalMilliseconds` 取数值 |
| `Game.ElapsedTime` | `TimeSpan` | 上一帧到当前帧的时间差（deltaTime），用 `.TotalSeconds` 取浮点秒数 |
| `Game.TotalElapsedTickInMilliseconds` | `int` | 游戏启动后的总毫秒数（整数），适合计时、超时判断 |
| `Game.Delay(ms)` | `Task` | 异步等待指定毫秒数（替代 `Task.Delay`） |

```csharp
// deltaTime（每帧时间差）
float dt = (float)Game.ElapsedTime.TotalSeconds;

// 绝对时间戳（判断超时、冷却）
int now = Game.TotalElapsedTickInMilliseconds;
if (now - lastActionTime > cooldownMs) { /* 冷却结束 */ }

// 异步等待
await Game.Delay(3000);  // 等待 3 秒
```

## ScopeData（数据编辑器生成的公开 Link）

数据编辑器中创建的公开数据条目会被代码生成器生成到 `<库名>.ScopeData` 命名空间中，以静态 `GameLink` 字段的形式暴露。

### 命名规则

```
<库名>.ScopeData.<数据类型名>.<条目名>
```

| 来源 | 命名空间 | 示例 |
|------|---------|------|
| 框架预置库 `gamesparkcore` | `gamesparkcore.ScopeData` | `GameDataUnitProperty.LifeMax`, `GameDataVital.Health` |
| 用户游戏项目 `GameEntry` | `GameEntry.ScopeData` | `GameDataScene.new_scene`, `GameDataCamera.DefaultCamera` |
| 自定义库 `MyLib` | `MyLib.ScopeData` | `GameDataUnit.CustomUnit` |

每个数据类型对应一个同名静态类（如 `GameDataUnit`、`GameDataUnitProperty`），其中包含该类型所有公开条目的 `GameLink` 字段。

### GSC 别名

`gamesparkcore.ScopeData` 中的静态类名与框架基类同名（如两者都有 `GameDataUnit`），直接 `using` 会产生歧义。因此 csproj 中预置了全局命名空间别名：

```csharp
// csproj 中已配置: global using GSC = gamesparkcore.ScopeData;
GSC.GameDataUnitProperty.LifeMax    // 生命值上限属性
GSC.GameDataVital.Health            // 生命值 Vital
GSC.GameDataDamageType.Physical     // 物理伤害类型
GSC.GameDataGameplay.Default        // 默认 Gameplay 配置
GSC.GameDataPlayerSettings.Default  // 默认玩家设置
GSC.GameDataGameUI.Default          // 默认游戏 UI
```

用户项目自己的 ScopeData（如 `GameEntry.ScopeData`）通常不冲突，可以直接 `using`。但如果项目引用了自定义库，库的 ScopeData 也可能包含同名静态类（如 `MyLib.ScopeData.GameDataUnit`），此时同样需要为库的 ScopeData 设置别名以避免歧义。

### 常用框架预置数据

| 类别 | 访问方式 | 说明 |
|------|---------|------|
| 单位属性 | `GSC.GameDataUnitProperty.LifeMax` | 生命上限、攻击力、护甲等 |
| 生命值 | `GSC.GameDataVital.Health` / `.Mana` | Vital 组件标识 |
| 伤害类型 | `GSC.GameDataDamageType.Physical` / `.Magical` / `.Pure` | 伤害系统分类 |
| 游戏模式配置 | `GSC.GameDataGameplay.Default` | Gameplay 默认配置 |
| 玩家设置 | `GSC.GameDataPlayerSettings.Default` | 默认玩家设置 |
| AI 思维树 | `GSC.GameDataAIThinkTree.Default` | 框架内置默认战斗 AI 预设，可替换为自定义 `GameDataAIThinkTree` |

完整列表见 `api/server/gamesparkcore_ScopeData.cs`。

## 必读框架资料

- `docs/FRAMEWORK_OVERVIEW.md` - 框架概述
- `docs/guides/QuickStart.md` - 快速开始指南
- `docs/guides/ResourcePathGuide.md` - 图片、Spine、`res/` 随包资源与 `user_files` 的路径规则
- `docs/CONVENTIONS.md` - 代码约定
- `docs/systems/` - 各系统详细文档
- `docs/ai/skills/canvas-2d-game/SKILL.md` - Canvas 2D 游戏开发
- `docs/ai/skills/3d-unit-game/SKILL.md` - 3D 单位游戏开发（Unit、Vital、移动、跨端通信）
- `docs/ai/skills/ui-layout-api/SKILL.md` - 流式布局 UI API

## 坐标系统（3D 游戏）

WasiCore 使用类似 Unreal Engine 的坐标系，**Z 轴是高度轴**：

- X 轴：水平方向（左右）
- Y 轴：水平方向（前后）
- Z 轴：高度方向（上下）
- XY 平面：地面

```csharp
var position = new Vector3(x, y, height);  // Z 是高度
velocity.Z -= gravity * deltaTime;         // 重力在 Z 轴负方向
velocity.Z = jumpForce;                     // 跳跃在 Z 轴正方向

if (position.Z <= 0) { position.Z = 0; IsOnGround = true; }
```

详见：`docs/COORDINATE_SYSTEM_GUIDE.md`

## 架构设计

- **Entity 处理逻辑**：游戏状态、属性、同步
- **Actor 处理视觉**：模型、特效、动画、声音
- **服务端权威**：游戏逻辑在服务端以避免作弊

## UI 布局

优先使用流式布局模式，详见 `docs/ai/skills/ui-layout-api/SKILL.md`。

```csharp
var panel = new Panel {
    FlowOrientation = Orientation.Vertical,
    Height = AutoMode.Auto,
    Padding = new Thickness(16, 12, 16, 12)
};
var titleLabel = new Label {
    Text = "标题",
    Parent = panel,
    Margin = new Thickness(0, 0, 0, 12)
};
```

## 代码规范

- 日志：`Game.Logger.LogInformation("消息: {Parameter}", value)`（结构化日志，禁止字符串插值）
- 实现 `IGameClass` 接口确保自动注册
- 遵循 `docs/CONVENTIONS.md` 命名约定

## 错误处理

```csharp
try { /* 游戏逻辑 */ }
catch (Exception ex)
{
    Game.Logger.LogError(ex, "操作失败: {Operation}", operationName);
}
```

## 游戏模式

每个项目已有一个 `MapGameMode`，它与地形编辑器和玩家队伍设置编辑器联动，已包含场景、玩家配置等完整设置。**直接使用它，不需要新建游戏模式，也不需要修改 `GlobalConfig.cs`。** 除非有在一个项目中使用多个游戏模式的明确需求，否则不需要新建游戏模式。

```csharp
public class MyGame : IGameClass
{
    public static void OnRegisterGameClass()
    {
        Game.OnGameTriggerInitialization += OnGameTriggerInitialization;
    }

    private static void OnGameTriggerInitialization()
    {
        // 使用项目已有的 MapGameMode（已在 GlobalConfig 中注册为默认测试模式）
        if (Game.GameModeLink != ScopeData.GameDataGameMode.MapGameMode) return;

        Game.Subscribe<EventGameStart>(async (s, d) =>
        {
            // 加载场景（MapGameMode 已配置 new_scene）
            var scene = Scene.GetOrCreate(ScopeData.GameDataScene.new_scene);
            scene.Load();
            // ... 游戏逻辑
        });
    }
}
```

> `HostedSceneTag` 对应编辑器中创建的地形资产，不可在代码中编造。使用 `ScopeData.GameDataScene.*` 引用已有场景。

## 开发检查清单

### 编译和环境
- [ ] 使用正确的编译配置：`-c Server-Debug` 或 `-c Client-Debug`
- [ ] 客户端代码包裹在 `#if CLIENT` 中
- [ ] 服务端代码包裹在 `#if SERVER` 中

### 游戏模式
- [ ] 使用项目已有的 `ScopeData.GameDataGameMode.MapGameMode`（与地形编辑器和玩家队伍设置联动，除非明确需要多个游戏模式，否则不要新建）
- [ ] 不要修改 `GlobalConfig.cs`（MapGameMode 已注册为默认测试模式）
- [ ] 游戏模式判断放在 `OnGameTriggerInitialization` handler 中（`Game.GameModeLink` 在 `OnRegisterGameClass` 阶段尚未赋值）
- [ ] 3D 游戏场景通过 `Scene.GetOrCreate(ScopeData.GameDataScene.new_scene)` + `Load()` 加载

### 代码规范
- [ ] 使用框架日志系统：`Game.Logger.LogInformation("消息: {Param}", value)`
- [ ] 避免禁用 API：`Task.Run()`, `Task.Delay()`, `Console.WriteLine`
- [ ] 使用正确替代 API：`Game.Delay()`, `Game.Logger`
- [ ] 实现了 `IGameClass` 接口（如需自动注册）

### 3D 坐标系统（如涉及）
- [ ] Z 轴用于高度（而非 Y 轴）
- [ ] 重力作用在 Z 轴负方向

### 玩家与队伍（如涉及敌我判定）
- [ ] 查看项目 `PlayerSettings.cs` 确认队伍配置（不要假设固定的队伍结构）
- [ ] 中立玩家（`IsNeutral=true`，默认为玩家 0）的单位永远不会被判定为 `Enemy`
- [ ] 使用 `Player.GetRelationShip(other)` 判定玩家关系（详见 [PlayerSystem.md](../../systems/PlayerSystem.md#队伍与玩家关系)）

### 架构设计
- [ ] Entity 处理逻辑，Actor 处理视觉
- [ ] 服务端权威

## 常见问题

### 编译错误
首先检查：编译配置是否正确 → 是否使用了禁用 API → 项目引用 → 条件编译指令

### 运行时错误
检查 `IGameClass` 接口 → 异步操作方式 → 网络同步配置 → 编辑器安装目录下的 `logs/` 根目录、`logs/client` 与 `logs/server`

## 更多详细信息

完整文档见 [reference.md](reference.md)。
