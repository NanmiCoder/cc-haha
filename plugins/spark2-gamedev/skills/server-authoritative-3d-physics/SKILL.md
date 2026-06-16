---
name: server-authoritative-3d-physics
description: 服务端权威 3D 物理与 GameGraph 发布图开发指南。当实现非 Unit 的同步 3D 物理物件、服务端模拟刚体、按玩家发布 SceneGraph、或排查客户端是否收到 replicated transform 时使用。
whenToUse: 当实现非 Unit 的同步 3D 物理物件、服务端模拟刚体、按玩家发布 SceneGraph、或排查客户端是否收到 replicated transform 时使用。
allowedTools: Bash, Read, Glob, Grep, Edit, Write
---

# 服务端权威 3D 物理指南

前置知识：先读 [wasicore-dev](../wasicore-dev/SKILL.md) 的编译配置和 SCE 场景 / GameGraph 速记。系统文档见 `docs/systems/PhysicsSystem.md` 与 `docs/systems/ServerGameGraphSceneGraphReplication.md`。

## 推荐架构

```
服务端（权威）                         客户端（表现）
├── PhysicsWorld local                 ├── 接收 replicated Node transform
├── Node.SetSyncVar 小型状态/元数据     ├── Node.TryGetSyncVar 读取状态/元数据
├── RigidBody local                    ├── StaticMesh / AnimatedModel local
├── CollisionShape local 或 replicated ├── 材质 / 粒子 / 音效 local
├── Node replicated                    ├── Camera / Viewport local（独立图渲染时）
└── SceneGraph 按玩家 Publish          └── UI / 调试可视化 local
```

核心原则：**同步节点，不同步权威物理计算本身**。服务端用本地物理组件推进真实状态，客户端接收 replicated `Node` 的 transform，并在本地补表现组件。

节点级小状态可以用 SyncVar：服务端 `SetSyncVar(...)`，客户端 `TryGetSyncVar(...)`。它适合对象类型、阵营、机关阶段、调试标记等轻量元数据；不要用于复杂对象、大字符串、背包、配置表或高频大 payload。客户端 SDK 不包含 `SetSyncVar(...)`，客户端想改变同步状态时应请求服务端处理。

客户端收到的 replicated transform 默认由 Urho `SmoothedTransform` 向最新网络目标平滑收敛。需要调追随速度或远距离瞬移阈值时，在客户端对应 `SceneGraph` 上设置 `TransformSmoothingConstant`、`TransformSnapThreshold`，或调用 `ConfigureTransformSmoothing(...)`。这些值不随网络同步；服务端设置不会自动改变客户端视觉平滑。

## 何时使用

| 需求 | 推荐 |
|------|------|
| 物体属于当前地图，随 SCE 场景生命周期存在 | 放进 SCE `Scene` 的 sync root |
| 物体是临时机关、调试对象、独立副本、或只发给部分玩家 | 服务端 `new SceneGraph(SceneGraphReplication.ReplicatedUnpublished)` 后 `Publish(player)` |
| 一个客户端需要同时看到多个独立物理/机关图 | 多个脚本创建的 SceneGraph 分别发布 |
| 只是客户端预览、特效、无权威判定 | 客户端 local GameGraph |

普通联机流程里，每个客户端同一时刻最多绑定一个当前 SCE 场景；脚本创建的发布图不受这个限制，一个客户端可同时订阅多个。

## 复制语义

- 动态权威对象：`NodeReplication.Replicated`
- 服务端物理组件：通常 `ComponentReplication.Local`
- 客户端需要知道或调试的碰撞形状：按需 `ComponentReplication.Replicated`
- 模型、材质、粒子、音效：客户端 local

不要用 `Node.Id` 正负判断复制状态；使用 `SceneGraph.IsReplicated`、`Node.IsReplicated`、`INodeComponent.IsReplicated`。

## 最小服务端模式

```csharp
#if SERVER
using GameGraph.NodeSystem;
using GameGraph.NodeSystem.Component.Physics;
using System.Numerics;

static SceneGraph CreateAuthorityBall(Player player)
{
    var graph = new SceneGraph(SceneGraphReplication.ReplicatedUnpublished, createOctree: false);

    var world = graph.CreateComponent<PhysicsWorld>(ComponentReplication.Local);
    if (world != null)
    {
        world.Gravity = new Vector3(0, 0, -980);
        world.Fps = 60;
        world.MaxSubSteps = 4;
        world.UpdateEnabled = true;
    }

    var ball = graph.CreateChild("authority_ball", NodeReplication.Replicated)
        ?? throw new InvalidOperationException("Failed to create ball node.");
    ball.Position = new Vector3(2048, 2048, 520);
    ball.SetSyncVar("kind", "authority_ball");
    ball.SetSyncVar("team", 1);

    var body = ball.CreateComponent<RigidBody>(ComponentReplication.Local);
    var shape = ball.CreateComponent<CollisionShape>(ComponentReplication.Local);
    shape?.SetSphere(80);

    if (body != null)
    {
        body.Mass = 1;
        body.UseGravity = true;
        body.LinearVelocity = new Vector3(120, 0, 80);
        body.WakeUp();
    }

    graph.Publish(player);
    return graph;
}
#endif
```

发布图不用时显式 `Unpublish(player)` 或 `Dispose()`。对已发布图 `Dispose()` 时框架会清理发布关系并通知客户端注销。

## 客户端表现挂载

客户端用 `SceneGraph.OnRegistered` / `OnNodeReplicated` 观察服务端发布图。只有确实需要节点生命周期时才订阅节点事件，避免不必要的 WASM/native 事件交互。

`SceneGraph.OnRegistered` / `GetRegisteredSceneGraphs()` 只覆盖脚本创建并 `Publish(player)` 的独立发布图，不包含当前 SCE 场景。当前 SCE 场景按框架场景系统默认同步；排查它内部的 replicated node 时，从当前 `Scene` / `Unit.Scene` 调 `GetSceneGraph()`，再轮询 `GetReplicatedNodes(...)` 或订阅该 SceneGraph 的 `OnNodeReplicated`。

```csharp
#if CLIENT
using GameGraph.NodeSystem;
using GameGraph.NodeSystem.Component.Graphics;

static void InstallAuthorityPhysicsView()
{
    SceneGraph.OnRegistered += graph =>
    {
        graph.OnNodeReplicated += node =>
        {
            if (!node.TryGetSyncVar("kind", out string kind) || kind != "authority_ball")
            {
                return;
            }

            node.TryGetSyncVar("team", out int team);
            Game.Logger.LogInformation("Authority ball replicated: team={Team}", team);

            // 示例：这里挂客户端 local 的 mesh / material / effect。
            // 实际项目优先复用 Actor / Unit 表现体系或本地表现 prefab。
            _ = node.CreateComponent<StaticMeshComponent>(ComponentReplication.Local);
        };
    };
}
#endif
```

## 客户端独立 SceneGraph 渲染

`SceneGraph.OnRegistered` 只说明发布图已到达客户端，不会自动让它进入当前画面。独立发布图有两种常见消费方式：

- **数据源模式**：不创建 Camera，不接管 Viewport。客户端读取 replicated 节点 transform / 状态后，绘制到 GameUI `Canvas`、小地图、调试 UI 或其他表现系统。SCE 默认场景可继续作为主游戏画面。
- **直接 3D 渲染模式**：客户端显式准备可视化和 viewport，把发布图渲染为一个 3D 画面。

直接 3D 渲染的底层模式如下：

```csharp
#if CLIENT
using GameGraph.NodeSystem;
using GameGraph.NodeSystem.Component.Graphics;
using System;
using System.Numerics;

static Action? ShowPublishedGraph(SceneGraph graph, Node focusNode)
{
    graph.EnsureOctree();

    // local 表现组件只负责显示，不参与服务端权威逻辑。
    _ = focusNode.CreateComponent<StaticMeshComponent>(ComponentReplication.Local);

    var cameraNode = graph.CreateChild("debug_camera", NodeReplication.Local);
    var camera = cameraNode?.CreateComponent<CameraComponent>(ComponentReplication.Local);
    if (camera == null || cameraNode == null)
    {
        return null;
    }

    cameraNode.Position = focusNode.Position + new Vector3(-600, -900, 450);
    cameraNode.LookAt(focusNode.Position, Vector3.UnitZ);
    camera.Fov = 60;
    camera.NearClip = 10;
    camera.FarClip = 30000;
    camera.AutoAspectRatio = true;

    var oldViewport = Renderer.GetMainViewport();
    var oldScene = oldViewport?.Scene;
    var oldCamera = oldViewport?.Camera;

    Renderer.SetupMainViewport(graph, camera);

    // 在 OnUnregistered 或 Game.OnGameEnd 中调用返回的委托恢复原主视口。
    return () =>
    {
        if (oldViewport != null)
        {
            oldViewport.Scene = oldScene;
            oldViewport.Camera = oldCamera;
        }
        else
        {
            Renderer.SetViewport(0, null);
        }
    };
}
#endif
```

`SceneGraphMainViewportController` 是可选 helper，可在项目需要频繁临时接管主视口时封装上述保存/恢复和 fallback 切换逻辑；它不是理解发布图或 Urho viewport 的必要入口。若主画面应继续显示 SCE 地图，就不要让调试发布图长期占用主视口。可把表现挂到当前 SCE 场景 / Actor / Unit 体系，或实现项目级的多 viewport / compositing 策略。使用 `MeshBuilder` 构造调试几何时记得写 normal，否则常规光照会异常。

## 静态障碍

静态障碍通常优先双端 local：

- 服务端 local 碰撞体用于物理模拟、射线、区域查询和权威判定。
- 客户端 local 场景资产用于渲染、音效和本地反馈。
- 只有运行时动态出现/消失、且客户端需要知道状态的障碍，才同步一个 replicated 节点或通过 GameCore 状态事件通知。

## 测试闭环

`published_scenegraph_sync_smoke` 已验证：

- 单客户端：`server-authority-physics` + `lifecycle-boundary`
- 双客户端：`late-join-catch-up` + `server-authority-physics` + `multi-client-isolation` + `player-disconnect-boundary`
- 服务端 authority physics：服务端 local RigidBody 推进 replicated Node，客户端采样到 transform 移动。
- 发布隔离：只发布给玩家 1 的 authority physics 图不会出现在玩家 2。
- 断线清理：服务端观察玩家 1 离线后以 `disconnected=True` dispose 已发布图。

日志检查命令示例：

```powershell
<SCE Projects>\published_scenegraph_sync_smoke\tools\Check-PublishedSceneGraphSmokeLogs.ps1 -ExpectedClients 2
```

如果使用本地服务器日志根目录，补充 `-LogsRoot E:\NE\logs`。

## 常见错误

| 症状 | 常见原因 | 处理 |
|------|----------|------|
| 客户端看不到服务端物理对象 | SceneGraph 没有 publish，或节点是 local | 使用 `SceneGraphReplication.ReplicatedUnpublished` + `Publish(player)`，节点用 `NodeReplication.Replicated` |
| 客户端收到节点日志但画面不可见 | 独立 SceneGraph 没有 local mesh、Octree、Camera 或 Viewport | 在客户端创建表现组件，`EnsureOctree()`，再用 `Renderer.SetupMainViewport(...)` 或项目自己的 viewport 策略显示 |
| 玩家 2 收到玩家 1 专属物理图 | 发布目标错误或共享图误发布给所有玩家 | 检查每次 `Publish(player)` 的玩家对象 |
| 服务端物理在动，客户端不动 | 节点 transform 未进入 replicated 路径，或客户端订阅了错误图 | 检查 `Node.IsReplicated`、`SceneGraphId`、客户端 `OnRegistered` 日志 |
| 客户端 transform 追随过慢或硬切太明显 | SceneGraph 平滑参数不适合当前玩法 | 在客户端设置 `TransformSmoothingConstant` / `TransformSnapThreshold` |
| 客户端读不到自定义状态 | 服务端没有写 `SetSyncVar(...)`，节点不是 replicated，或读取 key/type 不匹配 | 服务端写小型 SyncVar；客户端用同名 key 和匹配的 `TryGetSyncVar` overload |
| 想在客户端调用 `SetSyncVar(...)` | SyncVar 是服务端权威写入，客户端 API 不暴露 setter | 客户端发请求给服务端，由服务端校验后写入 |
| 客户端也在跑权威刚体 | 把 `RigidBody` 当成 replicated 逻辑同步 | 动态对象的权威 `RigidBody` 默认保持服务端 local |
| 静态场景重复同步成本高 | 把可双端本地加载的障碍做成 replicated 图 | 静态障碍优先双端 local，仅同步运行时状态 |
| 图结束后客户端仍有 snapshot | 服务端尚未 unpublish / dispose，或 disconnect 测试客户端先输出 verdict | 用服务端 verdict 验证 cleanup；流程结束前调用 `Game.FlushLogs()`。旧运行时若尚未包含 `IViewGame.FlushLogs`，把它当作可选诊断能力 |
