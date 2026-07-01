---
name: multiplayer-hybrid-sync
description: 联机游戏的数据同步选型与连续运动配方。当做有移动元素的联机游戏（FlappyBird/跑酷/弹球/竞速等 Canvas/2D 联机）、要把位置平滑同步给客户端、需要 per-property 隐私/反作弊、或在 PropertyObject 与 Node+PropertyHostComponent 之间选型时使用。它只管「同步」这条轴；Canvas 渲染那条轴见 canvas-2d-game。
whenToUse: 当做有移动元素的联机游戏、要把位置平滑同步给客户端、需要 per-property 隐私/反作弊、或在 PropertyObject 与 Node+PropertyHostComponent 之间选型时使用。
allowedTools: Bash, Read, Glob, Grep, Edit, Write
---

# 联机同步：选型与连续运动配方

前置知识：先读 [wasicore-dev](../wasicore-dev/SKILL.md)（编译配置、SCE/GameGraph 速记）。**Canvas 渲染/游戏循环/碰撞**那半见 [canvas-2d-game](../canvas-2d-game/SKILL.md)——联机 Canvas 游戏两个 skill 都要用：本 skill 管「状态怎么同步」，canvas-2d-game 管「画面怎么画」。相邻的 3D 物理同步见 [server-authoritative-3d-physics](../server-authoritative-3d-physics/SKILL.md)。完整参考见 `docs/systems/PropertyHostComponentSystem.md` 与 `docs/systems/ServerGameGraphSceneGraphReplication.md`。

联机是**服务端权威**的：状态在服务端算、同步给客户端，客户端只读、只表现。

## 先选型（最重要）

「把状态同步给客户端」有三条路，按**有没有连续运动的位置**、**要不要属性级隐私**选：

| 实体 | 选 | 为什么 |
|------|----|--------|
| 离散/无连续位置（卡牌、棋盘、回合制、放置、背包） | **PropertyObject** | 不需要场景与平滑，最轻；位置靠 OrderIndex/GroupId 或属性表达 |
| **连续运动**（小鸟、子弹、载具、物理球）+ 需要属性级隐私 | **Node + PropertyHostComponent** | 位置走 node 拿引擎原生平滑；数据按「看得到实体 ∩ 属性范围」分级 |
| 连续运动，但只要「看得到就全看得到」、不需属性级范围 | **裸 Node + SetSyncVar** | 最省样板 |

**推荐路线**：**Canvas 绘制的联机游戏只要有移动/持续变化的视觉元素，优先 Node + PropertyHostComponent。** 这套架构正是为此而生——PropertyObject 没有内置插值，用它同步连续位置就得在客户端手搓 smoothing/外插（易错难调）；位置走 node 后平滑交给引擎，玩法/渲染代码一行外插都不用写。

⚠️ **反模式**：用 PropertyObject 同步连续运动的坐标。客户端只能拿到一跳一跳的位置，逼你手写线性外插。连续位置请走 node。

## 推荐架构（Node + PropertyHostComponent）

```
服务端（权威，IThinker 跑模拟）           客户端（表现，CanvasAnimated 每帧画）
├── new SceneGraph(ReplicatedUnpublished) ├── SceneGraph.ObserveReplicatedNodes 发现 node
├── node.Position 写位置（replicated）    ├── node.Position 读平滑位置（零外插）
├── node.AddPropertyHost<T> 挂数据 facet  ├── node.Name 即时分类（AM_NET，随 node 到达）
├── facet.Xxx = ... 写数据                ├── node.TryGetPropertyHost<T> / OnPropertyHostReady 读数据
└── graph.Publish(player) 发布            └── graph.ConfigureTransformSmoothing 调平滑
```

核心：**位置走 node 的 transform（引擎 SmoothedTransform 原生平滑），数据走挂在 node 上的同步属性组件，二者按 node 关联，属性可独立做 per-property 可见性。**

## 配方（三步）

### ① 声明数据 facet（代码生成，类似 [PropertyObjectWrapper]）

```csharp
using EngineInterface.BaseType;
using GameCore.Extension;

[PropertyHostFacet]
[EnumExtension(Extendable = true)]
public enum EPropertyBird
{
    [PropertyType(typeof(int))]  Score,
    [PropertyType(typeof(bool))] IsAlive,

    [PropertyType(typeof(int))]
    [PropertySyncType(SyncType.Self)]   // 私有：仅 owner 可见（反作弊）
    SecretLoadout,
}
// → 自动生成 partial class Bird : PropertyHostComponent
```

枚举名以 `E` 开头、直属命名空间；生成类名去 `EProperty` 前缀（`EPropertyBird` → `Bird`）。

### ② 服务端：位置写 node，数据挂 facet

```csharp
#if SERVER
using GameGraph.NodeSystem;
using GameGraph.NodeSystem.Component;

var graph = new SceneGraph(SceneGraphReplication.ReplicatedUnpublished);
var node = graph.RootNode?.CreateChild("Bird", NodeReplication.Replicated);
var bird = node.AddPropertyHost<Bird>(player, SyncType.All); // 一行挂上，返回组件直接写
node.Position = new Vector3(x, y, 0);   // 位置 → transform
bird.Score = 0;                         // 数据 → facet
graph.Publish(player);                  // 发布给能看到这个实体的玩家
#endif
```

`AddPropertyHost` 已内部处理好「空收件人创建→绑图→放开目标 SyncType」的时序，无需手动编排；要求 node 已在某 SceneGraph 中（`CreateChild` 自图创建即满足）。

### ③ 客户端：发现 node、读平滑位置 + facet 数据

```csharp
#if CLIENT
using GameGraph.NodeSystem;
using GameGraph.NodeSystem.Component;

// 跟踪所有图里出现/消失的 replicated node（present + future），返回 IDisposable
var observer = SceneGraph.ObserveReplicatedNodes(
    onAdded: node =>
    {
        if (node.SceneGraph is { } g) g.ConfigureTransformSmoothing(50, 120); // 见下「平滑」
        if ((string)node.Name == "Bird")                                      // 按 Name 即时分类
            node.OnPropertyHostReady<Bird>(b => Track(node, b));              // 组件可能晚到，须容忍
    },
    onRemoved: node => Untrack(node));

// 渲染循环（CanvasAnimated.OnAnimatedRender）里：
if (node.IsValid && node.TryGetPropertyHost<Bird>(out var bird))
    Draw(node.Position, bird.Score, bird.IsAlive);   // node.Position 已是平滑值，零外插
#endif
```

按 `node.Name` 分类：Name 是 `AM_NET` 复制属性，随 node 创建快照一同到达，**不必等独立到达的属性组件**，分类无错判窗口。客户端读不在本端可见范围/未就绪的属性 → 返回默认值（这正是反作弊在 API 层的体现）。

## per-property 反作弊

字段标 `[PropertySyncType(SyncType.Self)]` → 只发给 owner，敌方读默认值。可见性是两层求交：**「该玩家订阅了实体所在的图（看得到实体）」且「该玩家在该字段 SyncType 范围内」**。于是能表达「看得到对面在动、却看不到对面背包」：图发布给双方，私有字段设 `Self`。owner 必须是具体玩家，`Self` 才有「仅该玩家」语义。

## 平滑（连续运动必调）

位置走 node 后平滑由 `SmoothedTransform` 负责，但默认 `TransformSnapThreshold = 5` 对快速运动太低：每次网络更新「当前→目标」距离一超阈值就直接贴合不插值 → 看着逐跳。**客户端**对图调 `graph.ConfigureTransformSmoothing(smoothingConstant, snapThreshold)`，阈值取「远大于正常每帧位移、小于真正瞬移（如重生）」。HybridFlappyBird 用 `(50, 120)`（场地 1200×800、约 220 单位/秒）。这是客户端本地设置，不随网络同步。

## 常见错误

| 症状 | 原因 | 处理 |
|------|------|------|
| 连续运动看着抖 | snap 阈值默认 5 对快速运动太低，每次更新贴合不插值（不是 fps） | 客户端 `ConfigureTransformSmoothing(50, 120)` 之类抬高阈值 |
| 客户端读到默认值 | 不在可见范围（正常，反作弊）或组件还没到达 | 用 `OnPropertyHostReady`/`TryGetPropertyHost` 容忍，别假设「node 在 ⇒ 数据在」 |
| 出现无人控制的幽灵实体 | 给电脑(AI)槽也建了实体——`IsOnline` 对 AI 槽恒 true | 建实体过滤 `Player.Controller == ControllerType.User && Player.IsOnline` |
| 想用 PropertyObject 同步移动坐标 | 误把连续位置当属性发，得手写外插 | 连续位置走 node；PropertyObject 留给离散状态 |
| Canvas 上 emoji 显示成方块 | 没注册 emoji 回退字体 | `Canvas.CreateFont("Emoji","ui/font/NotoEmoji/NotoEmoji.ttf")` + `AddFallbackFontId(主字体, emoji)` |
| 客户端想写同步属性 | 同步属性是服务端权威 | 客户端发请求给服务端，服务端校验后写 |

## 示例

- **HybridFlappyBird**（`code_sample`）：端到端混合同步联机 FlappyBird——位置走 node、数据走 facet、`CanvasAnimated` 渲染、`IThinker` 权威模拟、`node.Name` 分类。
- **PropertyHostPrivacy**（`code_sample`）：per-property `Self` 反作弊独立演示（敌方读默认值）。
