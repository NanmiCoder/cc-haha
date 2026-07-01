---
name: 3d-unit-game
description: WasiCore 3D 单位游戏开发指南。单位数据定义、属性系统、攻击技能、投射物/skillshot、自动索敌开火（有敌朝敌、无敌朝前）、弹药/资源消耗、目标过滤、状态栏、移动寻路、生命值、跨端通信、HUD。当开发 3D 单位对战/生存/射击/塔防游戏、做角色或敌人的攻击与开火、用投射物打击、实现自动瞄准或弹药消耗、使用 Unit 系统创建角色和敌人、或处理服务端-客户端同步时使用。
whenToUse: 当开发 3D 单位对战/生存/射击/塔防游戏、做角色或敌人的攻击与开火、用投射物打击、实现自动瞄准或弹药消耗、使用 Unit 系统创建角色和敌人、或处理服务端-客户端同步时使用。
allowedTools: Bash, Read, Glob, Grep, Edit, Write
---

> 注意：本文档篇幅较长，部分 API 参考内容可能更适合放在 reference.md 中。

# 3D 单位游戏开发指南

前置知识：先阅读 [wasicore-dev](../wasicore-dev/SKILL.md) 了解编译配置和框架约束。

3D 单位游戏同时需要服务端和客户端代码，分别用 `#if SERVER` / `#if CLIENT` 包裹。

## 架构概览

```
服务端（权威）                        客户端（表现）
├── GameDataUnit 定义（含攻击技能）   ├── GameSystemUI 移动/技能摇杆
├── GameDataAbilityExecute 攻击技能   ├── HUD Canvas
├── Unit 创建与生命周期               ├── DualEndEvent 监听
├── player.MainUnit 设置              └── 单位自动同步（框架处理）
├── TacticalAI 自动战斗
├── DualEndEvent 发送
└── Vital 生命值管理
```

单位由服务端创建后**自动同步**到客户端，无需手动同步位置/生命值。
**GameSystemUI**（项目已内置）提供平台自适应的移动摇杆和技能按钮，无需从零实现操控 UI。

## 重要约束：静态定义进表，动态数值改实例

处理敌人、刷怪、波次成长时，默认遵循这条边界：

- `GameDataUnit`、`GameDataModel`、`GameDataAI` 等静态定义应以数编文件或统一的 `OnGameDataInitialization` 注册代码为准。
- 不要在刷怪 trigger 中直接改 `ScopeData.GameDataUnit.SomeUnit.Data` 这类共享定义，尤其不要临时补丁 `Model`、`TacticalAI`、`SyncType`、默认属性。
- 按波次变化的生命、攻击、护甲、经验、出生后临时状态，应在 `CreateUnit` 之后修改具体 `Unit` 实例。
- 如果确实需要运行时代码生成 `GameData`，优先创建独立的 runtime-only 条目；若必须补丁共享 `GameData`，必须保证双端同路径初始化，而不是只在服务端懒修改。

## 重要约束：公式字段按可见性和偏向放置

写攻击、技能、效果树和 AI 行为树的 GameData 公式时，先看字段是否只存在于某一端 API，再看 `[DataEditor(FunctionBias = ...)]`：

- `GameDataAINodeValidateScan.Range` 这类只在服务端存在的字段，必须在 `#if SERVER` 中赋值。
- `GameDataEffectXXX` 中带 `FunctionBias.Server` 的公式字段，默认可以只在 `#if SERVER` 中赋值；效果树本身通常只在服务端执行。
- 技能 `Range` 这类客户端可能用来显示 UI 的字段，如果公式是常量或双端共有 API，可以共享赋值，例如 `Range = static (_) => 500`。
- 不要为了省事把所有 GameData 都包进 `#if SERVER`，客户端表现、Actor、UI 和显示数据仍需要客户端定义。

完整决策树见 `docs/best-practices/GameDataFormulaPlacement.md`。

## 完整最小示例

### 第 1 步：GameLink 和数据定义（共享代码）

```csharp
using GameCore.AbilitySystem.Data.Struct;
using GameCore.EntitySystem.Data;
using GameCore.EntitySystem.Data.Enum;
using GameCore.Execution.Data.Enum;
using GameCore.Execution.Data.Struct;
using GameCore.BaseType;
using GameCore.ModelAnimation.Data;
using GameCore.PlayerAndUsers.Enum;
// gamesparkcore.ScopeData 已通过 csproj 全局别名为 GSC
// gamesystemui.ScopeData 已通过 csproj 全局别名为 GSUI
// 用法: GSC.GameDataUnitProperty.LifeMax, GSUI.GameDataControl.MoveControl

namespace MyGame;

// GameLink 声明（不包裹在 #if 中）
public static class MyLinks
{
    // 单位
    public static readonly GameLink<GameDataUnit, GameDataUnit> Hero = new("Hero"u8);
    public static readonly GameLink<GameDataUnit, GameDataUnit> Enemy = new("Enemy"u8);
    // 英雄攻击：Vector 目标 → 扇形搜索 → 伤害（允许空挥）
    public static readonly GameLink<GameDataAbility, GameDataAbilityExecute> HeroAttack = new("HeroAttack"u8);
    public static readonly GameLink<GameDataEffect, GameDataEffectSearch> HeroSearch = new("HeroSearch"u8);
    public static readonly GameLink<GameDataEffect, GameDataEffectDamage> HeroDamage = new("HeroDamage"u8);
    // 敌人攻击：Unit 目标 → 直接伤害（AI 控制，总有目标）
    public static readonly GameLink<GameDataAbility, GameDataAbilityExecute> EnemyAttack = new("EnemyAttack"u8);
    public static readonly GameLink<GameDataEffect, GameDataEffectDamage> EnemyDamage = new("EnemyDamage"u8);
    // 攻击动画
    public static readonly GameLink<GameDataAnimation, GameDataAnimationSimple> HeroAttackAnim = new("HeroAttackAnim"u8);
    public static readonly GameLink<GameDataAnimation, GameDataAnimationSimple> EnemyAttackAnim = new("EnemyAttackAnim"u8);
}

public class ArenaGame : IGameClass
{
    public static void OnRegisterGameClass()
    {
        Game.OnGameDataInitialization += OnGameDataInitialization;
    }

    private static void OnGameDataInitialization()
    {
        // ── 攻击技能定义 ──

        // 英雄伤害效果：基于 AttackDamage 属性计算伤害
        _ = new GameDataEffectDamage(MyLinks.HeroDamage)
        {
            Amount = static (context) =>
                context.Caster.GetUnitPropertyFinal(GSC.GameDataUnitProperty.AttackDamage) ?? 0,
            Type = GSC.GameDataDamageType.Physical,
        };

        // 英雄搜索效果：以施法者为中心，扇形范围内搜索敌人，再对每个目标造成伤害
        _ = new GameDataEffectSearch(MyLinks.HeroSearch)
        {
            Method = SearchMethod.Cone,
            // Vector 技能的默认目标是方向末端坐标点，必须设为 Caster 使搜索以施法者为中心
            TargetLocation = new() { Value = TargetLocation.Caster },
            // 从施法者指向目标方向，避免施法者转身延迟导致扇形方向偏差
            Facing = new()
            {
                Location = new() { Value = TargetLocation.Caster },
                Method = EffectAngleMethod.AngleBetweenTwoPoints,
                OtherLocation = new() { Value = TargetLocation.MainTarget },
            },
            Radius = static (ctx) =>
                ctx.Caster.GetUnitPropertyFinal(GSC.GameDataUnitProperty.AttackRange) ?? 0,
            CentralAngle = static (_) => new Angle(120),
            Effect = MyLinks.HeroDamage,
            SearchFilters = [new()
            {
                Required = [UnitRelationship.Enemy, UnitFilter.Unit],
                Excluded = [UnitState.Dead, UnitState.Invulnerable],
            }],
            SearchFlags = new SearchFlags { ExtendByUnitRadius = true },
        };

        // 攻击动画：短普攻要显式压低 BlendIn，避免高攻速时混入时间盖过出手动作
        _ = new GameDataAnimationSimple(MyLinks.HeroAttackAnim)
        {
            File = "attack_01"u8,
            Priority = 120,
            BlendIn = TimeSpan.Zero,
        };
        _ = new GameDataAnimationSimple(MyLinks.EnemyAttackAnim)
        {
            File = "attack_01"u8,
            Priority = 120,
            BlendIn = TimeSpan.Zero,
        };

        // 英雄攻击技能：Vector 目标，允许空挥（周围没敌人时也能挥砍）
        // AlwaysAcquireTarget = true 使技能自动面向最近的敌人
        _ = new GameDataAbilityExecute(MyLinks.HeroAttack)
        {
            DisplayName = "攻击",
            Time = new()
            {
                Preswing = static (_) => TimeSpan.FromSeconds(0.4),
                Channel = static (_) => TimeSpan.FromSeconds(0.6),
                Backswing = static (_) => TimeSpan.FromSeconds(0.3),
                NormalizedDuration = static (_) => TimeSpan.FromSeconds(1.0),
            },
            Effect = MyLinks.HeroSearch,
            TargetType = AbilityTargetType.Vector,
            Range = static (e) =>
                (float)(e.Caster.GetUnitPropertyFinal(GSC.GameDataUnitProperty.AttackRange) ?? 0),
            AbilityExecuteFlags = new() { IsAttack = true, AlwaysAcquireTarget = true },
            Animation = [MyLinks.HeroAttackAnim],
            AcquireSettings = new()
            {
                Recast = true,
                TargetingFilters = [new()
                {
                    Required = [UnitRelationship.Enemy],
                    Excluded = [UnitState.Dead, UnitState.Invulnerable],
                }],
            },
        };

        // 敌人伤害效果
        _ = new GameDataEffectDamage(MyLinks.EnemyDamage)
        {
            Amount = static (context) =>
                context.Caster.GetUnitPropertyFinal(GSC.GameDataUnitProperty.AttackDamage) ?? 0,
            Type = GSC.GameDataDamageType.Physical,
        };

        // 敌人攻击技能
        _ = new GameDataAbilityExecute(MyLinks.EnemyAttack)
        {
            DisplayName = "攻击",
            Time = new()
            {
                Preswing = static (_) => TimeSpan.FromSeconds(0.5),
                Channel = static (_) => TimeSpan.FromSeconds(0.7),
                Backswing = static (_) => TimeSpan.FromSeconds(0.3),
                NormalizedDuration = static (_) => TimeSpan.FromSeconds(1.2),
            },
            Effect = MyLinks.EnemyDamage,
            TargetType = AbilityTargetType.Unit,
            Range = static (e) =>
                (float)(e.Caster.GetUnitPropertyFinal(GSC.GameDataUnitProperty.AttackRange) ?? 0),
            AbilityExecuteFlags = new() { IsAttack = true },
            Animation = [MyLinks.EnemyAttackAnim],
            AcquireSettings = new()
            {
                Recast = true,
                TargetingFilters = [new()
                {
                    Required = [UnitRelationship.Enemy],
                    Excluded = [UnitState.Dead, UnitState.Invulnerable],
                }],
            },
        };

        // ── 单位定义 ──

        // 英雄单位
        _ = new GameDataUnit(MyLinks.Hero)
        {
            CollisionRadius = 40f,
            AttackableRadius = 50f,
            Filter = [UnitFilter.Unit, UnitFilter.Hero],
            Leveling = GSC.GameDataUnitLeveling.HeroLevelingSample,
            Level = 1,
            UpdateFlags = new UpdateFlags
            {
                Walkable = true,
                Turnable = true,
                AllowMover = true,
            },
            Properties = new UnitPropertyInitialData
            {
                { GSC.GameDataUnitProperty.LifeMax, 500 },
                { GSC.GameDataUnitProperty.MoveSpeed, 300 },
                { GSC.GameDataUnitProperty.TurningSpeed, 720 },
                { GSC.GameDataUnitProperty.AttackDamage, 25 },
                { GSC.GameDataUnitProperty.Armor, 5 },
                { GSC.GameDataUnitProperty.Sight, 1200 },
                { GSC.GameDataUnitProperty.AttackRange, 150 },
            },
            VitalProperties = [GSC.GameDataVital.Health],
            PrimitiveShape = new PrimitiveShapeConfig
            {
                Shape = PrimitiveShape.Capsule,
                Scale = new Vector3(0.5f, 0.5f, 1f),
            },
            Abilities = [MyLinks.HeroAttack],
            StatusBarSetting = new()
            {
                DefaultStatusBar = GSC.GameDataStatusBar.AllyHeroNone,
                OverrideByRelationShip = new()
                {
                    { PlayerUnitRelationShip.MainUnit, GSC.GameDataStatusBar.MainHeroNone },
                    { PlayerUnitRelationShip.Alliance, GSC.GameDataStatusBar.AllyHeroNone },
                    { PlayerUnitRelationShip.Enemy, GSC.GameDataStatusBar.EnemyHeroNone },
                },
            },
        };

        // 敌人单位（这里示例使用默认 TacticalAI 预设；也可以替换为自定义 AIThinkTree）
        _ = new GameDataUnit(MyLinks.Enemy)
        {
            CollisionRadius = 30f,
            AttackableRadius = 40f,
            Filter = [UnitFilter.Unit],
            TacticalAI = GSC.GameDataAIThinkTree.Default,
            DeathRemovalDelay = TimeSpan.FromSeconds(3),
            UpdateFlags = new UpdateFlags
            {
                Walkable = true,
                Turnable = true,
                AllowMover = true,
            },
            Properties = new UnitPropertyInitialData
            {
                { GSC.GameDataUnitProperty.LifeMax, 200 },
                { GSC.GameDataUnitProperty.MoveSpeed, 200 },
                { GSC.GameDataUnitProperty.TurningSpeed, 720 },
                { GSC.GameDataUnitProperty.AttackDamage, 10 },
                { GSC.GameDataUnitProperty.Sight, 800 },
                { GSC.GameDataUnitProperty.AttackRange, 100 },
            },
            VitalProperties = [GSC.GameDataVital.Health],
            PrimitiveShape = new PrimitiveShapeConfig
            {
                Shape = PrimitiveShape.Sphere,
                Scale = new Vector3(0.6f, 0.6f, 0.6f),
            },
            Abilities = [MyLinks.EnemyAttack],
            StatusBarSetting = new()
            {
                DefaultStatusBar = GSC.GameDataStatusBar.EnemyNormalNone,
                OverrideByRelationShip = new()
                {
                    { PlayerUnitRelationShip.Alliance, GSC.GameDataStatusBar.AllyNormalNone },
                    { PlayerUnitRelationShip.Enemy, GSC.GameDataStatusBar.EnemyNormalNone },
                },
            },
        };

        // 不需要创建 GameDataGameMode —— 项目已有 MapGameMode（含场景、玩家配置）
        // 不需要修改 GlobalConfig.cs —— MapGameMode 已注册为默认测试模式
    }
}
```

### 第 2 步：DualEndEvent 定义（共享代码）

```csharp
// TriggerEncapsulation 已通过 csproj 全局 using 导入，无需手动 using

namespace MyGame;

// 服务端→客户端的游戏状态通知
public class GameStateEvent : IDualEndEvent<GameStateEvent>
{
    public Player? Sender { get; set; }
    public int WaveNumber { get; set; }
    public int EnemiesAlive { get; set; }
    public string Message { get; set; } = "";
}
```

### 第 3 步：服务端逻辑

```csharp
#if SERVER
using GameCore.EntitySystem;
using GameCore.GameSystem;
using GameCore.SceneSystem;
using GameCore.VitalSystem;
using GameCore.BaseType;
// GSC = gamesparkcore.ScopeData（全局别名，无需手动 using）

namespace MyGame;

public class ArenaServer : IGameClass
{
    private static Scene? scene;
    private static readonly List<Unit> enemies = [];
    private static int waveNumber;

    public static void OnRegisterGameClass()
    {
        Game.OnGameTriggerInitialization += OnGameTriggerInitialization;
    }

    private static void OnGameTriggerInitialization()
    {
        Game.Subscribe<EventGameStart>(async (s, d) =>
        {
            await StartGame();
        });
    }

    private static async Task StartGame()
    {
        // 加载项目中已有的场景（每个项目都有 new_scene 默认场景）
        scene = Scene.GetOrCreate(GameEntry.ScopeData.GameDataScene.new_scene);
        scene.Load();
        var center = new ScenePoint(2048, 2048, scene);

        // 为每个真人玩家创建英雄（跳过中立玩家）
        foreach (var player in Player.AllPlayers)
        {
            if (player.IsNeutral) continue;
            var hero = MyLinks.Hero.Data?.CreateUnit(player, center, new Angle(0));
            if (hero == null) continue;
            player.MainUnit = hero; // 设置主控单位（客户端自动跟随相机 + 启用操控）
            Game.Logger.LogInformation("为玩家 {PlayerId} 创建英雄", player.Id);
        }

        // 开始刷怪循环
        await SpawnWaveLoop();
    }

    private static async Task SpawnWaveLoop()
    {
        while (true)
        {
            waveNumber++;
            int count = 3 + waveNumber * 2;
            SpawnEnemies(count);

            // 通知客户端
            DualEndEvent.Publish(new GameStateEvent
            {
                WaveNumber = waveNumber,
                EnemiesAlive = enemies.Count,
                Message = $"第 {waveNumber} 波！",
            });

            // 等待所有敌人被消灭
            while (enemies.Count > 0)
            {
                enemies.RemoveAll(e => !e.IsAlive);
                await Game.Delay(500);
            }

            DualEndEvent.Publish(new GameStateEvent
            {
                WaveNumber = waveNumber,
                EnemiesAlive = 0,
                Message = "波次完成！",
            });
            await Game.Delay(3000);
        }
    }

    private static void SpawnEnemies(int count)
    {
        if (scene == null) return;
        // 敌方玩家：查看项目 PlayerSettings.cs 中的队伍配置确定 ID。
        // 默认模版：队伍0=中立(玩家0)、队伍1(玩家1/2)、队伍2(玩家3/4)。
        // 中立玩家(ID=0)的单位永远不会被判定为敌人。
        var enemyPlayer = Player.GetById(3);
        var random = new Random();

        for (int i = 0; i < count; i++)
        {
            float x = 512 + random.Next(3072);
            float y = 512 + random.Next(3072);
            var pos = new ScenePoint(x, y, scene);
            var enemy = MyLinks.Enemy.Data?.CreateUnit(enemyPlayer, pos, new Angle(0), useDefaultAI: true);
            if (enemy != null) enemies.Add(enemy);
        }
    }
}
#endif
```

### SCE Scene 与 GameGraph

`Scene.GetOrCreate(...).Load()` 加载的是框架管理的 SCE 数编场景。普通联机流程里每个客户端同一时刻最多绑定一个当前 SCE 场景；它的加载、切换、卸载由框架场景系统负责，不要对它的内置 GameGraph `SceneGraph` 手动 `Publish`、`Unpublish` 或 `Dispose`。

需要在当前 SCE 场景里访问或挂载 GameGraph 节点时，引入 `using GameGraph.NodeSystem;`：

```csharp
var sceneGraph = scene.GetSceneGraph();
var syncRoot = scene.GetSyncRoot();
scene.AddSyncNode(node, NodeReplication.Replicated);
```

服务端 `new SceneGraph(SceneGraphReplication.ReplicatedUnpublished)` 创建的是独立发布图，可按玩家 `Publish(player)`；同一个客户端可在当前 SCE 场景之外同时订阅多个发布图。客户端 `SceneGraph.OnRegistered` / `GetRegisteredSceneGraphs()` 面向这些额外发布图，不是获取当前 SCE 场景的入口。

发布图注册不等于自动渲染。独立 `SceneGraph` 可以只作为同步数据源使用，例如客户端读取节点状态后绘制到 Canvas/UI，而不创建 Camera 或接管 Viewport。若要直接显示为 3D 画面，客户端需要配置 `Octree`、local 表现组件、`CameraComponent` 和 Viewport；底层入口是 `Renderer.SetupMainViewport(...)`，`SceneGraphMainViewportController` 只是可选 helper。

### 非 Unit 的服务端权威 3D 物理

如果玩法对象不是 `Unit`，但仍需要服务端权威 3D 物理，默认使用 GameGraph 发布图模式：服务端创建 replicated `Node`，本地 `PhysicsWorld` / `RigidBody` 推动物理，客户端只接收 transform 并补本地模型、材质、粒子、音效。静态障碍优先双端 local；动态、会影响玩法判定、或需要按玩家隔离可见性的物体再放入 `SceneGraphReplication.ReplicatedUnpublished` 并 `Publish(player)`。

完整模式见 [`../server-authoritative-3d-physics/SKILL.md`](../server-authoritative-3d-physics/SKILL.md)。不要为了非 Unit 物理对象强行套 Unit / Actor；Unit 仍适合角色、怪物、目标过滤、生命值、技能、AI 等框架玩法实体。

### 第 4 步：客户端操控 + HUD

```csharp
#if CLIENT
// GameUI.Control.Extensions 已通过 csproj 全局 using 导入
// GameSystemUI.AbilitySystemUI.Advanced 已通过 csproj 全局 using 导入

namespace MyGame;

public class ArenaClient : IGameClass
{
    private static Label? waveLabel;
    private static Label? enemyLabel;
    private static Label? statusLabel;

    public static void OnRegisterGameClass()
    {
        Game.OnGameTriggerInitialization += OnGameTriggerInitialization;
    }

    private static void OnGameTriggerInitialization()
    {
        Game.Subscribe<GameStateEvent>(async (s, d) =>
        {
            if (waveLabel != null) waveLabel.Text = $"波次: {d.WaveNumber}";
            if (enemyLabel != null) enemyLabel.Text = $"剩余敌人: {d.EnemiesAlive}";
            if (!string.IsNullOrEmpty(d.Message) && statusLabel != null)
                statusLabel.Text = d.Message;
        });

        Game.Subscribe<EventGameStart>(async (s, d) =>
        {
            InitializeHUD();
            await InitializeControls();
        });
    }

    private static void InitializeHUD()
    {
        waveLabel = UI.Label("波次: 0").FontSize(20).TextColor(Color.White);
        enemyLabel = UI.Label("剩余敌人: 0").FontSize(20).TextColor(Color.White);
        statusLabel = UI.Label("等待游戏开始...").FontSize(16).TextColor(Color.FromArgb(255, 255, 220, 100));

        UI.VStack(5, waveLabel, enemyLabel, statusLabel)
            .Size(280, 90).AlignLeft().AlignTop().Margin(10)
            .Background(Color.FromArgb(160, 0, 0, 0)).Padding(10)
            .AddToRoot();
    }

    private static async Task InitializeControls()
    {
        for (int i = 0; i < 20; i++)
        {
            if (Player.LocalPlayer?.MainUnit != null) break;
            await Game.Delay(500);
        }

        var mainUnit = Player.LocalPlayer?.MainUnit;
        if (mainUnit == null) return;

        var moveControl = GSUI.GameDataControl.MoveControl.Data!.CreateControl();
        moveControl.AddToVisualTree();

        var abilityGroup = new AbilityJoyStickGroup(GSUI.GameDataControl.DefaultAbilityJoyStickGroup)
        {
            BindUnit = mainUnit,
        };
        abilityGroup.AddToRoot();
    }
}
#endif
```

## 关键 API 速查

### 攻击技能（GameDataAbilityExecute）

单位必须配置攻击技能才能攻击。没有技能 = 英雄没有攻击按钮，TacticalAI 也无法执行攻击。

```csharp
// 1. 定义伤害效果
_ = new GameDataEffectDamage(damageLink)
{
    Amount = static (ctx) => ctx.Caster.GetUnitPropertyFinal(GSC.GameDataUnitProperty.AttackDamage) ?? 0,
    Type = GSC.GameDataDamageType.Physical,
};

// 2. 定义攻击技能（IsAttack = true 标记为普攻，显示在技能摇杆上）
_ = new GameDataAbilityExecute(attackLink)
{
    DisplayName = "攻击", // 不设则技能按钮显示 GameLink 原始 ID
    Effect = damageLink,
    TargetType = AbilityTargetType.Unit,
    Range = static (e) => (float)(e.Caster.GetUnitPropertyFinal(GSC.GameDataUnitProperty.AttackRange) ?? 0),
    AbilityExecuteFlags = new() { IsAttack = true },
    Time = new()
    {
        Preswing = static (_) => TimeSpan.FromSeconds(0.4),  // 攻击前摇
        Channel = static (_) => TimeSpan.FromSeconds(0.6),   // 攻击锁定/持续阶段
        Backswing = static (_) => TimeSpan.FromSeconds(0.3), // 攻击后摇
        NormalizedDuration = static (_) => TimeSpan.FromSeconds(1.0), // 目标普攻周期
    },
    // 必须配置目标过滤！空过滤器放行所有目标（含自身），且 Unit 技能会校验目标合法性
    AcquireSettings = new()
    {
        Recast = true, // 需要连续普攻时开启；只想一次指令打一刀则保持 false
        TargetingFilters = [new()
        {
            Required = [UnitRelationship.Enemy],
            Excluded = [UnitState.Dead, UnitState.Invulnerable],
        }],
    },
};

// 3. 将技能绑定到单位
_ = new GameDataUnit(unitLink) { Abilities = [attackLink], /* ... */ };
```

> **`AcquireSettings.TargetingFilters` 是所有攻击技能的必需配置**。`TargetingFilters` 为空时放行所有目标（含自身）——SmartAcquire 自动选取会选中自身（默认按距离排序，自身距离为 0；可通过 `AcquireSorting` 自定义排序），`Unit` 目标技能的手动目标校验也会接受自身为合法目标，导致单位攻击自己。详见 [技能系统 — AcquireSettings](../../../systems/AbilitySystem.md#acquiresettings--目标获取配置)。

> **`IsAttack` 和 `AcquireSettings.Recast` 分工不同。** `IsAttack = true` 表示这个技能可以被 `Attack` 指令、`AttackTarget` 和默认战斗 AI 当作普攻技能使用；不设置时单位即使拥有这个技能，也不会被攻击指令自动选中。`AcquireSettings.Recast = true` 表示一次施法完成后继续尝试下发下一次同技能指令，用于按住攻击、自动施法或 AI 连续普攻。只需要单次攻击的技能可以不打开 `Recast`。

> **精确控制普攻速度时，用 `Time.NormalizedDuration`，不要把 `Cost.Cooldown` 当作普攻间隔。** `Cooldown` 是技能消耗/可用性门槛，作为 `Cost` 通常在进入 `Channel` 并消耗资源时启动；下一次攻击至少还要经历前摇、施法/引导等阶段。若把攻速公式只写在冷却上，施法时间仍会卡住攻速。需要固定或动态攻速的普攻，通常不配置 `Cost.Cooldown`，而是在 `NormalizedDuration` 中写目标攻击周期；有攻速属性时，把攻速换算公式放到 `NormalizedDuration`。

> **短普攻动画要单独配置 `GameDataAnimationSimple.BlendIn`。** `NormalizedDuration` 只控制技能阶段时长，并让技能动画按总施法时间调速；它不会自动缩短动画混入时间。`GameDataAnimationSimple.BlendIn` 默认约 0.15 秒，如果普攻周期可能接近或短于这个时间，剑还没完全混入到抬手姿态就会被下一次攻击压掉。短攻击动画建议在动画数据上写 `BlendIn = TimeSpan.Zero`，或按项目手感设置为 20-50ms。

### 英雄普攻目标类型选择（Unit vs Vector）

英雄的普攻技能是用 `Unit` 还是 `Vector` 目标类型，取决于游戏类型：

| 目标类型 | 行为 | 适合 |
|:--|:--|:--|
| `Unit` | 必须有合法目标才能攻击；无目标时按钮无效 | MOBA、RTS（敌人密集，总有目标） |
| `Vector` | 朝面朝方向挥砍，无目标也能空挥；搜索范围内有敌人则造成伤害 | 生存、ARPG、动作游戏（玩家随时可攻击） |

> **推荐**：如果游戏允许玩家在没有敌人时攻击（空挥），**英雄普攻应使用 `Vector` + `EffectSearch` + `EffectDamage`**（见上方主示例）。敌人由 AI 控制、总有目标，用 `Unit` 即可。

### 效果链配方（AbilityTargetType → Effect）

`AbilityTargetType` 决定了技能的施法目标类型，**也决定了传给效果链的主目标的性质**。不同目标类型需要不同的效果链结构：

| AbilityTargetType | 主目标性质 | 典型效果链 | 适用场景 |
|:--|:--|:--|:--|
| `Unit` | 单位实体 | Ability → `EffectDamage` | 单体攻击（最常见） |
| `Vector` | 方向末端坐标点 | Ability → `EffectSearch`(Cone) → `EffectDamage` | 扇形挥砍、剑气 |
| `Ground` | 地面坐标点 | Ability → `EffectSearch`(Circle) → `EffectDamage` | AOE 技能、轰炸 |
| `None` | 施法者自身 | Ability → `EffectSearch`(Circle, center=Caster) → `EffectDamage` | 新星、战吼 |

**关键规则**：`GameDataEffectDamage` 只能作用于**单位目标**。如果技能的主目标是坐标点（Vector/Ground/None），必须先用 `GameDataEffectSearch` 搜索范围内的单位，再对搜索到的每个单位执行 `EffectDamage`。

#### 单体攻击（Unit 目标，最常见）

```csharp
// 主目标就是单位，直接造伤害
_ = new GameDataAbilityExecute(attackLink)
{
    TargetType = AbilityTargetType.Unit,
    Effect = damageLink, // 直接指向 EffectDamage
    // ...
};
```

#### 扇形范围攻击（Vector 目标）

```csharp
using GameCore.Execution.Data.Enum;
using GameCore.Execution.Data.Struct;

// 1. 搜索效果：以施法者为中心，扇形范围内找到敌人
_ = new GameDataEffectSearch(searchLink)
{
    Method = SearchMethod.Cone,
    // Vector 技能的默认主目标是方向末端坐标点，必须设为 Caster 使搜索以施法者为中心
    TargetLocation = new() { Value = TargetLocation.Caster },
    // 显式设为从施法者到主目标（方向末端）的朝向，避免施法者转身延迟导致扇形方向偏差
    Facing = new()
    {
        Location = new() { Value = TargetLocation.Caster },
        Method = EffectAngleMethod.AngleBetweenTwoPoints,
        OtherLocation = new() { Value = TargetLocation.MainTarget },
    },
    Radius = static (ctx) =>
        ctx.Caster.GetUnitPropertyFinal(GSC.GameDataUnitProperty.AttackRange) ?? 0,
    CentralAngle = static (_) => new Angle(120),
    Effect = damageLink, // 对每个搜索到的单位执行伤害
    SearchFilters = [new()
    {
        Required = [UnitRelationship.Enemy, UnitFilter.Unit],
        Excluded = [UnitState.Dead, UnitState.Invulnerable],
    }],
    // 搜索半径额外扩大施法者的 InteractRadius，与指令系统的接近判定一致
    SearchFlags = new SearchFlags { ExtendByUnitRadius = true },
};

// 2. 技能指向搜索效果（不是直接指向伤害）
_ = new GameDataAbilityExecute(attackLink)
{
    TargetType = AbilityTargetType.Vector,
    Effect = searchLink, // 指向 EffectSearch，不是 EffectDamage
    AbilityExecuteFlags = new() { IsAttack = true, AlwaysAcquireTarget = true },
    // ...
};
```

> `AlwaysAcquireTarget = true` 使 Vector 技能自动面向最近的敌人，无需玩家手动选择方向。`TargetLocation = Caster` 使搜索以施法者为中心（Vector 默认主目标是方向末端坐标点）。`ExtendByUnitRadius = true` 将搜索半径额外扩大施法者的 InteractRadius，与指令系统的接近判定（`Range + InteractRadius`）一致。

#### 圆形范围攻击（Ground 目标）

```csharp
_ = new GameDataEffectSearch(searchLink)
{
    Method = SearchMethod.Circle,
    Radius = static (_) => 300,
    Effect = damageLink,
    SearchFilters = [new()
    {
        Required = [UnitRelationship.Enemy, UnitFilter.Unit],
        Excluded = [UnitState.Dead, UnitState.Invulnerable],
    }],
};

_ = new GameDataAbilityExecute(aoeLink)
{
    TargetType = AbilityTargetType.Ground,
    Effect = searchLink,
    Range = static (_) => 800, // 施法距离
    // ...
};
```

### 状态栏（StatusBarSetting）

单位默认没有血条。配置 `StatusBarSetting` 后才会显示：

```csharp
_ = new GameDataUnit(heroLink)
{
    // 使用 Hero 变体需要配置 Leveling，否则等级槽位显示黑块
    Leveling = GSC.GameDataUnitLeveling.HeroLevelingSample,
    Level = 1,
    StatusBarSetting = new()
    {
        DefaultStatusBar = GSC.GameDataStatusBar.AllyHeroNone,
        OverrideByRelationShip = new()
        {
            { PlayerUnitRelationShip.MainUnit, GSC.GameDataStatusBar.MainHeroNone },
            { PlayerUnitRelationShip.Alliance, GSC.GameDataStatusBar.AllyHeroNone },
            { PlayerUnitRelationShip.Enemy, GSC.GameDataStatusBar.EnemyHeroNone },
        },
    },
};
```

| 变体 | 前缀 | 说明 |
|:--|:--|:--|
| Hero | `AllyHeroNone` / `EnemyHeroNone` / `MainHeroNone` | 含等级槽位，需配合 `Leveling` |
| Normal | `AllyNormalNone` / `EnemyNormalNone` / `NeutralNormalNone` | 无等级槽位，适合小兵/敌人 |

### AI 两层职责速记

概念定义以 [AI 系统](../../systems/AISystem.md) 为准；这里给出做游戏时最常用的判断方式。

| 想解决什么问题 | 优先看什么 | 说明 |
|:--|:--|:--|
| 单个敌人会不会自动寻敌、攻击、施法 | `TacticalAI` / `AIThinkTree` | `GameDataUnit.TacticalAI` 是配置字段，运行时组件名叫 `AIThinkTree` |
| 一波敌人往哪走、跟随谁、如何主动追玩家 | `WaveAI` | 负责巡逻、跟随、追杀等宏观移动 |
| 怪物会巡逻/追人但不攻击 | `useDefaultAI` / `enableCombat` | 先查硬开关，再查 `scan range`、`MinimalApproachRange`、`HysteresisFactor`（Follow）/ `ReacquireRangeFactor`（Hunt） |

### AI 行为（TacticalAI）

这里的 `TacticalAI` 指 `GameDataUnit.TacticalAI` 配置字段；它引用的数编类型是 `GameDataAIThinkTree`，运行时组件名叫 `AIThinkTree`。`GSC.GameDataAIThinkTree.Default` 是框架提供的默认预设，但不是唯一合法取值。

如果你采用框架默认的自动寻敌 / 自动攻击方案，通常需要同时确认下面四点：

1. `TacticalAI` 指向一个可用的 `GameDataAIThinkTree`（最常用的是 `GSC.GameDataAIThinkTree.Default`，也可以是自定义战斗思考树）
2. `Abilities` 中有 `IsAttack = true` 的技能（默认 AI 用它作为攻击能力）
3. 创建时传入 `useDefaultAI: true`，或在创建后手动调用 `AIThinkTree.AddDefaultAI(unit)` / `myAIThinkTreeLink.Data!.CreateAI(unit)` 挂载战斗 AI
4. **目标单位的 `Filter` 命中当前 AI 的 `ScanFilters`**（默认 AI 攻击普通战斗单位时通常要求 `UnitFilter.Unit`）

如果你使用自定义 `AIThinkTree`，是否必须有 `IsAttack` 技能、目标需要哪些 `Filter`，要以你的行为树和 `ScanFilters` 设计为准。

`useDefaultAI` 只是**创建时自动挂载** `GameDataUnit.TacticalAI` 的便捷入口，不是唯一入口。单位创建出来后，仍然可以在服务端动态添加或替换战斗 AI：

```csharp
#if SERVER
var enemy = enemyLink.Data?.CreateUnit(player, pos, facing); // 不自动挂 AI
if (enemy is not null)
{
    AIThinkTree.AddDefaultAI(enemy);           // 方案 A：按 GameDataUnit.TacticalAI 自动创建
    // MyLinks.CustomAI.Data!.CreateAI(enemy); // 方案 B：显式挂自定义 AI，会替换已有 AI
}
#endif
```

> **排查顺序**：如果怪物“会巡逻/追人但不攻击”，先查单位最终有没有挂上 `AIThinkTree`（`CreateUnit(..., useDefaultAI: true)`、`AIThinkTree.AddDefaultAI(unit)`、`myAIThinkTreeLink.Data!.CreateAI(unit)` 三者至少走过一条），再查 `WaveAI` 是否被 `StartWaveAI(..., enableCombat: false)`、`SetCombatEnabled(false)` 或 `SetRoute(..., false)` 关掉了战斗。  
> 这两个是硬开关，优先级高于 `MinimalApproachRange`、`HysteresisFactor`（Follow）/ `ReacquireRangeFactor`（Hunt）、`MinimalScanRange` 这类调参项。

```csharp
// 数据定义
_ = new GameDataUnit(enemyLink)
{
    Filter = [UnitFilter.Unit],
    TacticalAI = GSC.GameDataAIThinkTree.Default, // 这里使用框架默认预设；也可换成自定义 AIThinkTree
    Abilities = [enemyAttackLink], // 必须有 IsAttack 技能
    // ...
};

// 创建时按 TacticalAI 自动挂载 AI
var enemy = enemyLink.Data?.CreateUnit(player, pos, facing, useDefaultAI: true);
```

> **`Filter` 是 AI 检测目标的前提**。使用默认自动攻击方案时，即使 `TacticalAI`、`IsAttack`、`useDefaultAI` 都已正确配置，如果目标单位的 `Filter` 不包含 `UnitFilter.Unit`，AI 仍然找不到可攻击目标。若使用自定义 `AIThinkTree`，则以自定义 `ScanFilters` 为准。

| 配置项 | 说明 |
|:--|:--|
| `TacticalAI = GSC.GameDataAIThinkTree.Default` | 使用框架内置默认战斗 AI 预设（推荐起步） |
| `TacticalAI = MyLinks.CustomAI` | 使用自定义 AIThinkTree（按自定义行为树 / ScanFilters 工作） |
| `TacticalAI = null`（默认） | 无 AI，单位不主动行动 |
| `useDefaultAI: true` | CreateUnit 时按 `GameDataUnit.TacticalAI` 自动挂载 AI；不传也可以后续手动 `AddDefaultAI/CreateAI` |
| `Filter = [UnitFilter.Unit]` | 使用默认 AI 攻击普通战斗单位时，目标通常需要此标签 |
| `DeathRemovalDelay = TimeSpan.FromSeconds(3)` | 死亡后 3 秒移除尸体（不设则立即消失） |

### 敌人群体 AI（WaveAI）

TacticalAI 只控制**单体战斗**（扫描范围内寻敌攻击）。如果需要敌人**主动追向玩家**（而非等玩家进入扫描范围），需要配合 WaveAI 群体 AI 系统。

| 场景 | 推荐方案 | 说明 |
|:--|:--|:--|
| 敌人守在刷新位置附近 | 仅 TacticalAI | 默认行为，扫描范围内寻敌 |
| **生存游戏：敌人全图追杀玩家** | **`GameDataWaveAIHunt`（追杀模式）** | **每个怪独立追杀距自己最近的敌方目标** |
| 敌人跟随首领/玩家 | `GameDataWaveAIFollow`（跟随模式） | 所有成员追向同一个目标 |
| 敌人沿路线行进 | `GameDataWaveAIPatrol`（巡逻模式） | 路线巡逻，遇敌战斗后可恢复巡逻 |

> **重要**：`WaveAI` 只负责宏观移动，不会替代 `TacticalAI` 完成战斗。  
> 如果创建单位时用了 `useDefaultAI: false`，而且后续也没有手动 `AddDefaultAI/CreateAI` 挂战斗 AI，或者在 `WaveAI` 上覆盖了 `enableCombat: false`，典型表现就是“怪物会走，但不出手”。

#### 追杀模式示例（生存类游戏推荐）

```csharp
using GameCore.AISystem.Data;

namespace MyGame;

public static class MyLinks
{
    // ... 其他 GameLink ...
    public static readonly GameLink<GameDataWaveAI, GameDataWaveAIHunt> MonsterHunt = new("MonsterHunt"u8);
}
```

数据定义（共享代码，不包裹在 `#if` 中）：

```csharp
_ = new GameDataWaveAIHunt(MyLinks.MonsterHunt)
{
    EnableCombat = true,
    MinimalScanRange = 500,
    MaximalScanRange = 2000,
};
```

服务端使用：

```csharp
#if SERVER
// 刷怪后用 WaveAI 管理整波敌人
var waveAI = MyLinks.MonsterHunt.Data!.CreateWaveAI();
foreach (var enemy in newEnemies) waveAI.Add(enemy);
waveAI.StartThinking();
// 无需其他设置：每个怪自动追杀距自己最近的敌方目标
// 目标死亡后自动切换到下一个最近目标

// 监听全灭事件
waveAI.OnWaveEliminated += (wave) =>
{
    Game.Logger.LogInformation("波次全灭");
};
#endif
```

**工作原理**：WaveAI 每 2 秒思考一次，遍历敌方 `Player.Units` 找到距该成员最近的目标，驱动成员移动接近。接近目标后自动交给 TacticalAI 处理战斗（滞后控制机制防止边界震荡）。

> **不要用 `AttackTarget` 轮询替代 WaveAI**。周期性对所有敌人调用 `AttackTarget` 会导致性能浪费和行为中断。WaveAI 利用框架内置的 Thinker 调度机制，自动分散思考负载。

> **调参提示**：在 Hunt 模式下，`MinimalApproachRange` 是"AIThinkTree 接管战斗的距离"，不是"攻击距离"。AIThinkTree 接管后用自己的 `ScanRange` 搜敌（默认 = `Clamp(AttackRange, MinimalScanRange, MaximalScanRange)`），所以 `MinimalApproachRange` 应 **≤ `MinimalScanRange`**（默认 500）或者至少 **≤ `AttackRange`**，否则刚接管就扫不到目标会站桩。无需 ≥ `AttackRange` —— AIThinkTree 接管后会自己贴近攻击位置。注意 `Sight` 是视野/战争迷雾用，跟 AI 搜敌范围无关，除非 AttackRange 超出了 Sight 范围。

如果项目引用了 `GameSparkCore`，可以直接使用它内置的默认追杀预设和扩展方法，无需每个项目重复手配这组参数：

```csharp
#if SERVER
using gamesparkcore.AISystem;

// 使用 GameSparkCore 内置的默认追杀AI
var waveAI = newEnemies.HuntAndAttack();

// 或指定固定目标
var waveAI2 = newEnemies.HuntAndAttack([hero]);

// 仅追击，不主动进入战斗
var waveAI3 = newEnemies.HuntWithoutAttack();
#endif
```

上面的扩展方法底层使用 `gamesparkcore.ScopeData.GameDataWaveAI.默认追杀AI`。这套预设面向近战生存/刷怪场景，Boss、远程怪和大地图玩法仍应按实际需求复制后调整。

详细文档见 [`../../systems/AISystem.md`](../../systems/AISystem.md)。

### 玩家控制（MainUnit + GameSystemUI）

玩家控制分两步：**服务端设置主控单位** + **客户端添加操控 UI**。

**服务端**（设置主控单位，使客户端相机自动跟随）：
```csharp
#if SERVER
player.MainUnit = hero; // 必须设置，否则相机不跟随、无法操控
#endif
```

**客户端**（添加移动摇杆和技能按钮）：
```csharp
#if CLIENT
// 等待 MainUnit 同步到客户端
var mainUnit = Player.LocalPlayer?.MainUnit;

// 平台自适应移动控件（手机=摇杆，PC=WASD/方向键）
var moveControl = GSUI.GameDataControl.MoveControl.Data!.CreateControl();
moveControl.AddToVisualTree();

// 技能摇杆组（自动显示主控单位的技能按钮）
var abilityGroup = new AbilityJoyStickGroup(GSUI.GameDataControl.DefaultAbilityJoyStickGroup)
{
    BindUnit = mainUnit,
};
abilityGroup.AddToRoot();
#endif
```

> **GameSystemUI 已内置**：`game_entry` 模板的 csproj 已引用 `GameSystemUI.dll`，`GameSystemUI.AbilitySystemUI.Advanced` 已通过全局 using 导入。无需额外配置。

### 单位数据属性（`UnitPropertyInitialData`）

`UnitPropertyInitialData` 继承 `QuickDictionary<IGameLink<GameDataUnitProperty>, double>`，用字典初始化器：

| 属性 GameLink | 含义 |
|:--|:--|
| `GameDataUnitProperty.LifeMax` | 最大生命值 |
| `GameDataUnitProperty.MoveSpeed` | 移动速度 |
| `GameDataUnitProperty.TurningSpeed` | 转向速度（`Turnable = true` 时**必须设置**，否则攻击时报错） |
| `GameDataUnitProperty.AttackDamage` | 攻击力 |
| `GameDataUnitProperty.Armor` | 护甲 |
| `GameDataUnitProperty.MagicResistance` | 魔抗 |
| `GameDataUnitProperty.Sight` | 视野范围 |
| `GameDataUnitProperty.AttackRange` | 攻击距离 |

完整列表见 `api/server/gamesparkcore_ScopeData.cs` 中的 `GameDataUnitProperty` 类。

### 生命值系统（Vital）

生命值由 `VitalProperties = [GameDataVital.Health]` 自动启用。

```csharp
// 获取生命值组件
var health = unit.GetTagComponent<Vital>(PropertyVital.Health);

if (health != null)
{
    double currentHp = health.Current;  // 当前 HP
    double maxHp = health.Max;          // 最大 HP
    health.Modify(-50);                 // 扣 50 HP
    health.Set(health.Max);             // 回满 HP
}
```

### 单位外观

有两种方式为单位设置 3D 外观：

**方案 A：基本形状（快速原型）** — 使用 `PrimitiveShapeConfig`，无需任何模型资源：

| 形状 | 适用场景 |
|:--|:--|
| `Capsule` | 角色/玩家 |
| `Sphere` | 敌人/弹丸 |
| `Cube` | 建筑/箱子 |
| `Cylinder` | 柱子/塔 |
| `Cone` | 箭头/标记 |

颜色由 `ShapeColorMode.SmartDefaults` 自动分配，每种形状有不同颜色。也可通过 `CustomColor` 自定义。

**方案 B：内置占位模型** — 使用 `GameDataModel` 指定真实 3D 模型，以下是所有项目内置的模型：

| 种类 | Asset 路径 | 说明 | Radius |
|:--|:--|:--|:--|
| 人形英雄 | `characters1/baiyijianke_e4wa/model.prefab` | 白衣剑客，推荐主角 | 52 |
| 人形通用 | `characters/general/sk_basic2/model.prefab` | 通用角色 | 50 |
| 小型怪物 | `characters/monster/sm_slm_a/model.prefab` | 史莱姆 A（小） | 40 |
| 中型怪物 | `characters/monster/sm_slm_b/model.prefab` | 史莱姆 B（中） | 60 |
| 大型怪物 | `characters/monster/sm_slm_c/model.prefab` | 史莱姆 C（大） | 80 |
| 蜘蛛怪 | `characters/monster/sk_spider_burrow/model.prefab` | 蜘蛛 | 32 |
| 狼人 | `characters/monster/sk_werewolf/model.prefab` | 狼人 | 50 |
| 石塔 | `deco/dungeon/sk_garden_stonetower_a03/model.prefab` | 防御塔/建筑 | — |

所有角色/怪物模型的标准动画别名：`idle`、`move`、`attack`、`death`。使用方式见 [reference.md](reference.md#3d-模型系统)。

> **模型阴影要 opt-in，基本形状默认就带。** `GameDataModel.ShadowSetting` 默认为 `null`——**真实模型不显式配置就不投阴影**；而 `PrimitiveShape`（方案 A）框架已默认给了 `DeviceDependentShadow`。所以主角用真实模型、子弹/敌人用基本形状时，会出现"**主角没影子、其它有影子**"的不一致。要影子就给模型补 `ShadowSetting = new() { ShadowType = ShadowType.DeviceDependentShadow }`；反过来不想要飞行物投影，就给投射物形状关掉。

> **更多资源**：上表仅列出推荐模型。旧版角色/怪物完整列表见 [`resources/characters.json`](../../../resources/characters.json)（1280+ 个模型含路径和**模型自带动画列表**）；官方捏人角色见 [`resources/characters1.json`](../../../resources/characters1.json)（`characters1/{name}/model.prefab`，含 Asset 路径和模型自带动画名）。
>
> **动画资源的两种来源**：
> - **模型自带动画**：在 `characters.json` 或 `characters1.json` 每个模型的 `anims` 字段中列出。可以直接用原名播放（如 `"attack_01"u8`），也可以通过 `AnimationMappings` 映射别名后用别名播放。
> - **共享 Humanoid 动画**：见 [`resources/animations.json`](../../../resources/animations.json)（136 个动画集，含 `hitPoint`/`cancelPoint` 打点时间，可用于设置 `Preswing`/`Backswing`）。可以用完整路径（带 `.ani`）播放，也可以通过 `AnimationMappings` 映射后用别名播放。建议在 `GameDataModel.HumanoidSourceAnimations` 中配置所需的共享动画，以便编辑器针对当前模型骨骼进行烘焙（不配置也能 fallback 播放原始动画，但可能出现体形不匹配的问题）。
>
> `AnimationMappings` 的主要作用：给动画起别名，同时**指定框架自动查找的 `idle`、`move`、`death` 等硬编码别名**对应哪个实际动画。

使用 3D 模型时，`idle`、`move`、`death` 由框架通过 `AnimationMappings` 别名自动播放，但 **攻击和技能动画需要手动配置**——用 `GameDataAnimationSimple`（`File = "attack_01"u8`，短普攻通常再设置 `BlendIn = TimeSpan.Zero`）定义动画，然后在 `GameDataAbilityExecute` 上设置 `Animation = [link]`。见上方完整示例。详细动画系统文档见 [`docs/systems/ModelAnimationSystem.md`](../../../systems/ModelAnimationSystem.md)。

**方案 C：仅 ActorArray（纯粒子特效单位）** — 不设 `Model`，仅通过 `ActorArray` 挂载粒子特效。框架会为单位创建隐含的场景 Node，`ActorArray` 中的 Actor 自动附着在该 Node 上。适用于经验宝石、掉落物、纯视觉标记等不需要 3D 模型的场景实体：

```csharp
// 1. 定义粒子特效资源
_ = new GameDataParticle(gemParticleLink) { Asset = "effect/eff_arpg/arpg_tongyong/diaoluo_1/particle.effect"u8 };

// 2. 定义粒子 Actor（持续播放）
_ = new GameDataActorParticle(gemActorLink) { AutoPlay = true, Particle = gemParticleLink };

// 3. 定义单位：无 Model，仅 ActorArray
_ = new GameDataUnit(gemUnitLink)
{
    Name = "经验宝石",
    Filter = [UnitFilter.Item],
    ActorArray = [gemActorLink],
    DeathProcedure = new() { Mode = DeathProcedureMode.Disintegrate },
    DeathRemovalDelay = TimeSpan.Zero,
};
```

### 移动方式

| 方式 | API | 用途 |
|:--|:--|:--|
| 寻路移动 | `Walkable.CreateInstance(unit).PathTo(target)` | 绕过障碍物的路径移动 |
| 直接传送 | `unit.SetPosition(scenePoint)` | 瞬间移动 |
| 匀速移动 | `unit.MoveTo(scenePoint)` | 直线匀速移动（不寻路） |
| 指令移动 | `unit.ProcessCommand(CommandIndex.Move, target)` | 发出移动命令 |

寻路移动需要 `UpdateFlags.Walkable = true`。

### 跨端通信（DualEndEvent）

```csharp
// 定义事件（共享）
public class MyEvent : IDualEndEvent<MyEvent>
{
    public Player? Sender { get; set; }
    public int Score { get; set; }
}

// 服务端发送 → 客户端接收
#if SERVER
DualEndEvent.Publish(new MyEvent { Score = 100 });
#endif

#if CLIENT
Game.Subscribe<MyEvent>(async (s, d) => { ShowScore(d.Score); });
#endif
```

- 服务端 `Publish` → 广播到所有客户端
- 客户端 `Publish` → 发送到服务端（`Sender` 自动设置为发送者玩家）

**Trigger 注册目标**：
- 全局游戏事件（`EventGameStart`、`DualEndEvent`）→ `Game.Subscribe<T>(handler)` 或 `.RegisterGlobal()`
- 单位事件（`EventUnitDeath` 等）→ `unit.Subscribe<T>(handler)` 注册到具体单位
- 类型级事件 → `gameDataUnit.Subscribe<T>(handler)` 注册到数据定义（监听同类型所有单位）
- 玩家事件 → `.Register(player)` 注册到具体玩家

### HUD 显示方式

优先使用 `UI.*` **流式布局 API** 构建 HUD，比属性设置模式更简洁：

```csharp
#if CLIENT
waveLabel = UI.Label("波次: 0").FontSize(20).TextColor(Color.White);
enemyLabel = UI.Label("剩余敌人: 0").FontSize(20).TextColor(Color.White);

UI.VStack(5, waveLabel, enemyLabel)
    .Size(280, 60).AlignLeft().AlignTop().Margin(10)
    .Background(Color.FromArgb(160, 0, 0, 0)).Padding(10)
    .AddToRoot();

// 事件回调中直接更新文字
waveLabel.Text = $"波次: {waveNumber}";
#endif
```

> `GameUI.Control.Extensions` 已通过 csproj 全局 using 导入，`UI` 类可直接使用（`UI.Label()`、`UI.VStack()` 等）。
> Canvas 适用于需要自定义绘制的场景（小地图、血条图形、粒子等），简单文本信息不需要用 Canvas。

## 常见错误速查

| 症状 | 原因 | 解决 |
|:--|:--|:--|
| 3000+ 编译错误 | 未用 `-c Server-Debug` / `-c Client-Debug` | 正确配置 |
| `ComponentTagEx.Walkable` 找不到 | 错误类名 | 用 `ComponentTag.Walkable` |
| **敌人站着不动** | **`TacticalAI` 未指向可用的战斗 AIThinkTree，或缺少 AI 所需的攻击能力，或单位创建后始终没挂上 AI** | **数据定义中配置 `TacticalAI`（默认或自定义）和所需 `Abilities`；创建时传 `useDefaultAI: true`，或后续手动 `AddDefaultAI/CreateAI`** |
| **怪物会巡逻/追人但不攻击** | **`CreateUnit(..., useDefaultAI: false)` 后也没手动挂战斗 AI，或 `StartWaveAI(..., false)` / `SetCombatEnabled(false)` / `SetRoute(..., false)` 把 WaveAI 战斗关掉了** | **确认单位最终真的挂了 `AIThinkTree`；WaveAI 默认用 `true` 或 `null`，不要误传 `false`** |
| **敌人能扫到玩家、但不接近也不攻击（明明在攻击距离外）** | **自定义 `CombatBehaviorTree` 子树里的 `GameDataAINodeValidateScan.Range` 被压成 `AttackRange`，导致进入战斗后 `ScanTargetThisTick` 为 null → `ValidateCast` `InvalidTarget` → 不接近**。战斗外 Scan 用 `AIThinkTree.ScanRange`（默认 ≥ 500），战斗内 Scan 用自定义子树的 Range，两者独立。 | **战斗内 Scan 节点的 `Range` 保持 `null`，回落到 `AIThinkTree.ScanRange`；或显式给一个 ≥ 期望追击距离的值（例如 1500）。不要让战斗内 Scan 比战斗外更小。** |
| **使用默认 AI 时仍不攻击** | **单位 `Filter` 未包含 `UnitFilter.Unit`，默认 AI 的 `ScanFilters` 要求目标具有此标签** | **英雄和敌人的 `GameDataUnit` 添加 `Filter = [UnitFilter.Unit]`（英雄可加 `UnitFilter.Hero`）** |
| **英雄无法攻击** | **未给英雄配置攻击技能** | **定义 `GameDataAbilityExecute`（`IsAttack = true`）并设 `Abilities = [attackLink]`** |
| **攻击打自己** | **`AcquireSettings.TargetingFilters` 为空，放行所有目标含自身** | **添加 `AcquireSettings` + `Required = [UnitRelationship.Enemy]`** |
| **单位没有血条** | **未配置 `StatusBarSetting`** | **添加 `StatusBarSetting`，按阵营分配 StatusBar 变体** |
| **血条有等级黑块** | **使用 Hero 状态栏变体但未配置 `Leveling`** | **添加 `Leveling = GSC.GameDataUnitLeveling.HeroLevelingSample` + `Level = 1`** |
| **主角(模型)没影子，但子弹/敌人(基本形状)有影子** | **`GameDataModel.ShadowSetting` 默认 null=不投影；`PrimitiveShape` 默认带 `DeviceDependentShadow`** | **给模型显式设 `ShadowSetting = new() { ShadowType = ShadowType.DeviceDependentShadow }`（不想要投影的形状则反向关掉）** |
| **攻击时报错 CannotTurnWhenSpeedIsZero** | **`Turnable = true` 但未设 `TurningSpeed`** | **Properties 中添加 `{ GSC.GameDataUnitProperty.TurningSpeed, 720 }`** |
| **技能按钮显示原始 ID** | **攻击技能未设 `DisplayName`** | **设置 `DisplayName = "攻击"`** |
| **玩家无法操控英雄** | **未设置 `MainUnit` 或未添加操控 UI** | **服务端 `player.MainUnit = hero` + 客户端添加 MoveControl** |
| **相机不跟随英雄** | **未设置 `player.MainUnit`** | **服务端 `player.MainUnit = hero`** |
| 单位不移动 | `UpdateFlags.Walkable` 未设为 true | 在 GameDataUnit 中启用 |
| `unit.PathTo()` 找不到 | PathTo 不在 Unit 上 | 用 `Walkable.CreateInstance(unit).PathTo(target)` |
| 客户端收不到事件 | 未注册触发器 | 检查 `Trigger` 是否已 `Register(Game.Instance)` |
| 生命值不生效 | 未配置 VitalProperties | 添加 `VitalProperties = [GameDataVital.Health]` |
| 属性 GameLink 找不到 | 需要 GSC 别名 | 使用 `GSC.GameDataUnitProperty.LifeMax`（csproj 已配置全局别名） |
| `HeightGrow`/`WidthGrow` 编译错误 | 在对象初始化器中当属性用 | 它们是扩展方法，用 `.HeightGrow(1)` 链式调用，或用原生属性 `HeightStretchRatio = 1` |
| `Game.Time` 用法不对 | 返回 `TimeSpan` 非毫秒 | 用 `Game.Time.TotalSeconds` 或 `Game.TotalElapsedTickInMilliseconds` |
| `Scene.CreateNewScene()` 不存在 | 该 API 已移除 | 用 `Scene.GetOrCreate(GameEntry.ScopeData.GameDataScene.new_scene)` + `Load()` |
| 场景加载后无地形 | `HostedSceneTag` 不匹配场景资产 | 使用 `GameEntry.ScopeData.GameDataScene` 中已有的场景，不要编造标签 |
| `Player.IsValid` 不存在 | Player 无此属性 | 用 `player.IsNeutral` 跳过中立玩家 |
| 敌人不会被攻击/不算敌人 | 敌人属于中立玩家（ID=0），`GetRelationShip` 返回 `Neutral` | 查看 `PlayerSettings.cs` 队伍配置，选择不同队伍的非中立玩家。默认模版中 `Player.GetById(3)`（队伍 2）与玩家 1/2（队伍 1）敌对 |
| **敌人不追杀玩家（只在原地等）** | **仅有 TacticalAI，扫描范围有限（默认 500-1000）** | **生存类游戏用 `GameDataWaveAIHunt` 追杀模式，不要用 `AttackTarget` 轮询** |
| **Vector 技能不造伤害** | **Vector 技能的主目标是坐标点，`EffectDamage` 需要单位目标** | **在技能和伤害之间插入 `EffectSearch`（扇形/圆形），搜索范围内单位后再造伤害** |
| **子弹/技能方向不对，手动转角色也没用** | **投射物方向取自技能 ExecutionTarget（索敌/向量方向），与单位 `Facing` 无关** | **用 `Vector` + `AlwaysAcquireTarget` + 无目标 `CastAbilityWithMainUnit(技能)` 让引擎索敌定向；删掉手动 `SetFacing`、客户端差分算朝向、`!IsSuccess` 补发（详见 [reference.md 投射物系统](reference.md#方向性自动索敌投射物玩家开火--朝敌人射击)）** |
| **瞬发技能弹药/消耗不生效（挂 Order 阶段事件没触发）** | **瞬发技能（`Transient=true`）不经过 Cast/Channel 阶段，`EventEntityOrderStage` handler 是死代码** | **消耗放效果树：首节点 `Validators` 当门槛（失败则指令下达失败），`GameDataEffectCustomAction.Func` 做消耗（详见 [reference.md](reference.md#瞬发技能的弹药与资源消耗)）** |
| `AttackTarget` 编译报错 | 扩展方法在 `TriggerEncapsulation.Commands` 命名空间 | 添加 `using TriggerEncapsulation.Commands;` |

## 开发检查清单

- [ ] 使用项目已有的 `GameEntry.ScopeData.GameDataGameMode.MapGameMode`（它与地形编辑器、玩家队伍设置联动，已包含完整的游戏模式配置。除非明确需要多个游戏模式，否则不要新建）
- [ ] 场景使用项目中已有的 `GameEntry.ScopeData.GameDataScene.new_scene`（不要编造 HostedSceneTag）
- [ ] `OnRegisterGameClass` 中订阅了 `Game.OnGameDataInitialization +=`（数据类）和 `Game.OnGameTriggerInitialization +=`（逻辑类）
- [ ] 不需要修改 `GlobalConfig.cs`（MapGameMode 已注册为默认测试模式）
- [ ] `GameDataUnit` 配置了 `Filter`（战斗单位至少包含 `UnitFilter.Unit`，否则 AI 无法检测到该单位；英雄加 `UnitFilter.Hero`）
- [ ] `GameDataUnit` 设置了 `UpdateFlags.Walkable = true`（如需移动）
- [ ] `GameDataUnit` 配置了 `VitalProperties = [GameDataVital.Health]`（如需生命值）
- [ ] `GameDataUnit` 配置了 `Properties` 初始属性（LifeMax、MoveSpeed 等）
- [ ] `GameDataUnit` 配置了 `PrimitiveShape`、`Model` 或 `ActorArray`（至少一种，否则看不到；仅 `ActorArray` 适用于纯粒子特效单位如掉落物）
- [ ] **单位配置了攻击技能（`GameDataAbilityExecute` + `GameDataEffectDamage` + `Abilities = [...]`）**
- [ ] **攻击技能配置了 `AcquireSettings.TargetingFilters`（`Required = [UnitRelationship.Enemy]`；空过滤器放行所有目标含自身）**
- [ ] **攻击技能设置了 `DisplayName`（否则技能按钮显示原始 GameLink ID）**
- [ ] **`Turnable = true` 的单位在 Properties 中设置了 `TurningSpeed`（否则攻击时报错）**
- [ ] **英雄配置了 `StatusBarSetting`（否则没有血条）**
- [ ] **使用 Hero 状态栏变体的单位配置了 `Leveling`（否则等级槽位显示黑块）**
- [ ] **敌人/NPC 配置了可用的 `TacticalAI`，并满足该 AI 所需的攻击能力；单位创建后最终真的挂上了 `AIThinkTree`（`useDefaultAI: true` 或手动 `AddDefaultAI/CreateAI`）**
- [ ] **使用 WaveAI 的战斗单位没有在 `StartWaveAI` / `SetCombatEnabled` / `SetRoute` 中把战斗覆盖成 `false`**
- [ ] **生存游戏的敌人使用 `GameDataWaveAIHunt` 追杀模式（仅 TacticalAI 只在扫描范围内有效，不会全图追击）**
- [ ] **非 Unit 目标类型的技能（Vector/Ground/None）使用 `EffectSearch` 中转再接 `EffectDamage`**
- [ ] **服务端设置了 `player.MainUnit = hero`**（否则相机不跟随、无法操控）
- [ ] **客户端添加了 `MoveControl`（移动摇杆/键盘）和 `AbilityJoyStickGroup`（技能按钮）**
- [ ] 敌方单位属于非中立的敌对阵营玩家（查看 `PlayerSettings.cs` 确认队伍配置，**不要**使用中立玩家 ID=0）
- [ ] 服务端单位创建代码包裹在 `#if SERVER` 中
- [ ] 客户端 UI 代码包裹在 `#if CLIENT` 中
- [ ] DualEndEvent 的 `Trigger` 已注册到全局（使用 `Game.Subscribe<T>()` 或 `.RegisterGlobal()`）
- [ ] 使用 `Game.Logger` 而非 `Console.WriteLine`
- [ ] 使用 `Game.Delay()` 而非 `Task.Delay()`

## 更多详细信息

完整文档（含属性系统详解、Vital 系统、伤害系统、移动系统深入说明）见 [reference.md](reference.md)。
