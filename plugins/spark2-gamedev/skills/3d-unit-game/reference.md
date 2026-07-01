# 3D 单位游戏开发 - 完整参考

本文档是 [SKILL.md](SKILL.md) 的详细补充，覆盖 3D 单位游戏开发中的所有子系统。

> **项目特定 API 说明**：部分示例使用 `GSC`（gamesparkcore.ScopeData 别名）、`GSUI`（gamesystemui.ScopeData 别名）、`GameEntry.ScopeData` 等。这些是 GameSparkCore 项目或 game_entry 模板中预置的数据，不同项目的 ScopeData 结构可能不同。框架级 API（如 `GameDataUnit`、`Unit`、`Scene` 等）为通用 API。

## 目录

- [单位数据定义](#单位数据定义)
- [属性系统](#属性系统)
- [生命值系统（Vital）](#生命值系统vital)
- [攻击技能系统](#攻击技能系统)
- [目标过滤（AcquireSettings）](#目标过滤acquiresettings)
- [状态栏（StatusBarSetting）](#状态栏statusbarsetting)
- [相机系统](#相机系统)
- [单位创建与生命周期](#单位创建与生命周期)
- [移动系统](#移动系统)
- [基本形状系统](#基本形状系统)
- [3D 模型系统](#3d-模型系统)
- [跨端通信](#跨端通信)
- [场景系统](#场景系统)
- [玩家与队伍](#玩家与队伍)
- [AI 系统（TacticalAI）](#ai-系统tacticalai)
- [玩家控制（MainUnit + GameSystemUI）](#玩家控制mainunit--gamesystemui)
- [伤害系统](#伤害系统)
- [投射物系统](#投射物系统)
- [瞬发技能的弹药与资源消耗](#瞬发技能的弹药与资源消耗)
- [扩展功能](#扩展功能)
- [完整游戏示例](#完整游戏示例)
- [常见问题与陷阱](#常见问题与陷阱)

---

## 单位数据定义

### GameDataUnit 完整属性

```csharp
_ = new GameDataUnit(myUnitLink)
{
    // === 基础信息 ===
    DisplayName = "英雄",          // 可选，本地化名称
    Description = "玩家控制的英雄", // 可选，本地化描述

    // === 碰撞 ===
    CollisionRadius = 40f,         // 物理碰撞半径（寻路/碰撞避让）
    AttackableRadius = 50f,        // 可被攻击的判定半径
    DynamicCollisionMask = DynamicCollisionMask.Default, // 可选

    // === 行为标志 ===
    UpdateFlags = new UpdateFlags
    {
        Walkable = true,           // 启用寻路组件
        Turnable = true,           // 启用转向
        AllowMover = true,         // 允许被 Mover 移动
        DisableClientUpdate = false,
    },

    // === 属性与生命值 ===
    Properties = new UnitPropertyInitialData
    {
        { GSC.GameDataUnitProperty.LifeMax, 500 },
        { GSC.GameDataUnitProperty.MoveSpeed, 300 },
        { GSC.GameDataUnitProperty.AttackDamage, 25 },
        { GSC.GameDataUnitProperty.Armor, 5 },
        { GSC.GameDataUnitProperty.MagicResistance, 0 },
        { GSC.GameDataUnitProperty.Sight, 1200 },
        { GSC.GameDataUnitProperty.AttackRange, 150 },
        { GSC.GameDataUnitProperty.TurningSpeed, 360 },
    },
    VitalProperties = [GSC.GameDataVital.Health],           // 启用 Health vital
    // VitalProperties = [GSC.GameDataVital.Health, GSC.GameDataVital.Mana], // 同时启用法力

    // === 外观 ===
    // 方案 A：基本形状（无需 3D 模型，适合原型开发）
    PrimitiveShape = new PrimitiveShapeConfig
    {
        Shape = PrimitiveShape.Capsule,
        Scale = new Vector3(0.5f, 0.5f, 1f),
    },
    // 方案 B：3D 模型（需要在编辑器中导入）
    // Model = new GameLink<GameDataModel, GameDataModel>("HeroModel"),

    // === 攻击技能（必需，否则无法攻击） ===
    Abilities = [myAttackLink],                        // 绑定攻击技能

    // === 状态栏（必需，否则无血条） ===
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
    Leveling = GSC.GameDataUnitLeveling.HeroLevelingSample, // Hero 状态栏需要
    Level = 1,

    // === 单位分类（必需，影响 AI 目标检测和技能过滤） ===
    Filter = [UnitFilter.Unit, UnitFilter.Hero],       // 战斗单位必须包含 UnitFilter.Unit
    // === 可选配置 ===
    TacticalAI = GSC.GameDataAIThinkTree.Default,      // 这里使用框架默认 AI 预设；也可换成自定义 AIThinkTree
    DeathRemovalDelay = TimeSpan.FromSeconds(5),        // 死亡后 5 秒移除
    // Loot = ...,                                      // 掉落物
    // ScaleVector = new Vector3(1.5f, 1.5f, 1.5f),    // 模型缩放
};
```

### GameLink 声明规范

```csharp
// GameLink<数据类型, 数据类型> — 通常两个类型参数相同
public static readonly GameLink<GameDataUnit, GameDataUnit> MyUnit = new("MyUnit"u8);

// 使用 u8 后缀的 UTF-8 字面量（推荐，性能更好）
// 或普通字符串（也可以）
public static readonly GameLink<GameDataUnit, GameDataUnit> MyUnit = new("MyUnit");
```

### UnitFilter 分类体系

> 完整的目标过滤系统文档（含 UnitRelationship、UnitState、UnitFilter 三类标签和过滤组合逻辑）参见 [目标过滤系统](../../systems/TargetFilteringSystem.md)。

`Filter` 字段定义单位的分类标签，用于 AI 目标扫描（`ScanFilters`）和技能目标过滤（`TargetingFilters`）。**所有参与战斗的单位必须配置 `Filter`**，否则 AI 无法检测到该单位。

| 主分类 | 含义 | 标准 Filter 配置 |
|:--|:--|:--|
| `UnitFilter.Unit` | 可移动的战斗单位（英雄、小兵、怪物） | `[UnitFilter.Unit]` |
| `UnitFilter.Structure` | 固定建筑（塔、基地） | `[UnitFilter.Structure]` |
| `UnitFilter.Missile` | 投射物 | `[UnitFilter.Missile]` |
| `UnitFilter.Item` | 物品 | `[UnitFilter.Item]` |

| 子分类（叠加） | 含义 | 典型用法 |
|:--|:--|:--|
| `UnitFilter.Hero` | 英雄 | `[UnitFilter.Unit, UnitFilter.Hero]` |
| `UnitFilter.Ground` | 地面单位 | 与 Unit 或 Structure 叠加 |
| `UnitFilter.Air` | 空中单位 | 与 Unit 叠加 |

**Unit 和 Structure 是并列的主分类**，两者互不包含。默认 AI（`GSC.GameDataAIThinkTree.Default`）的 `ScanFilters` 同时匹配 `UnitFilter.Unit` 和 `UnitFilter.Structure`（OR 逻辑），会自动攻击两种目标。

### GameMode 使用

每个项目已有 `MapGameMode`（由编辑器创建，含场景、玩家设置等完整配置）。直接使用它即可，无需新建游戏模式或修改 `GlobalConfig.cs`：

```csharp
public class MyGame : IGameClass
{
    public static void OnRegisterGameClass()
    {
        Game.OnGameDataInitialization += OnGameDataInitialization;       // 数据定义
        Game.OnGameTriggerInitialization += OnGameTriggerInitialization; // 事件注册
    }

    private static void OnGameDataInitialization() { /* 创建 GameDataUnit 等 */ }
    private static void OnGameTriggerInitialization() { /* 注册 Trigger */ }
}
```

> 进阶：若确实需要多个游戏模式，可在 `OnGameDataInitialization` 中创建新的 `GameDataGameMode` 并在 `GlobalConfig.cs` 中注册。但 99% 的项目只需一个游戏模式。

---

## 属性系统

### 可用属性（GameDataUnitProperty）

完整的预定义属性列表（来自 `GSC.GameDataUnitProperty`）。代码中访问时需加 `GSC.` 前缀，例如 `GSC.GameDataUnitProperty.LifeMax`。

| 属性 | 说明 | 典型值 |
|:--|:--|:--|
| `LifeMax` | 最大生命值 | 100 - 5000 |
| `ManaMax` | 最大法力值 | 0 - 2000 |
| `MoveSpeed` | 移动速度 | 200 - 500 |
| `AttackDamage` | 攻击力 | 10 - 200 |
| `AttackRange` | 攻击距离 | 100 - 700 |
| `Armor` | 物理护甲 | 0 - 30 |
| `MagicResistance` | 魔法抗性 | 0 - 30 |
| `ArmorPenetration` | 护甲穿透 | 0 - 20 |
| `MagicPenetration` | 魔抗穿透 | 0 - 20 |
| `CriticalRate` | 暴击率 | 0.0 - 1.0 |
| `CriticalDamage` | 暴击伤害系数 | 1.5 - 3.0 |
| `Sight` | 视野范围 | 800 - 2000 |
| `ShrubSight` | 草丛视野 | 0 - 500 |
| `TurningSpeed` | 转向速度（度/秒），**`Turnable = true` 时必须设置** | 180 - 720 |
| `Height` | 单位飞行高度 | 0 - 500 |
| `Block` | 格挡值 | 0 - 50 |
| `JumpHeight` | 跳跃高度 | 0 - 500 |
| `JumpCount` | 跳跃次数 | 0 - 3 |
| `LevelMax` | 最大等级 | 1 - 30 |

### 运行时读写属性

```csharp
// 读取属性（通过 PropertyUnit 枚举）
int level = unit.GetProperty<int>(PropertyUnit.Level);
bool isDead = unit.GetProperty<bool>(PropertyUnit.Dead);

// UnitProperty 系统的复杂属性需要 UnitPropertyComplex 组件
var propComplex = unit.GetTagComponent<UnitPropertyComplex>(ComponentTag.UnitPropertyComplex);
if (propComplex != null)
{
    double moveSpeed = propComplex.GetFinal(GSC.GameDataUnitProperty.MoveSpeed);
    double maxHp = propComplex.GetFinal(GSC.GameDataUnitProperty.LifeMax);
}
```

---

## 生命值系统（Vital）

### 概念

`Vital` 是一种动态资源属性（如 HP、MP），拥有当前值、最大值和回复速率。通过在 `GameDataUnit.VitalProperties` 中声明来启用。

### 生命值操作

```csharp
// 获取生命值组件（通过 PropertyVital 标签）
var health = unit.GetTagComponent<Vital>(PropertyVital.Health);
if (health == null) return;

// 读取
double currentHp = health.Current;     // 当前 HP
double maxHp = health.Max;             // 最大 HP
double hpPercent = currentHp / maxHp;  // 血量百分比

// 修改
health.Modify(-100);                   // 扣 100 HP
health.Modify(50);                     // 恢复 50 HP
health.Set(health.Max);               // 回满
health.Set(0);                         // 清零

// 回复速率
health.Regen;                          // 获取回复速率
```

### 法力值

```csharp
// 启用法力值：VitalProperties = [GSC.GameDataVital.Health, GSC.GameDataVital.Mana]
var mana = unit.GetTagComponent<Vital>(PropertyVital.Mana);
if (mana != null)
{
    double currentMp = mana.Current;
    mana.Modify(-30);  // 消耗 30 MP
}
```

### 监测死亡

单位生命值归零时框架自动处理死亡流程。可通过触发器监听：

```csharp
#if SERVER
Game.Subscribe<EventEntityDeath>(async (s, d) =>
{
    var deadUnit = d.Entity as Unit;
    if (deadUnit != null)
    {
        Game.Logger.LogInformation("单位 {UnitId} 死亡", deadUnit.EntityId);
    }
});
#endif
```

或通过属性检查：

```csharp
if (!unit.IsAlive)  // Entity.IsAlive 属性
{
    // 单位已死亡
}
```

---

## 攻击技能系统

单位必须配置攻击技能才能进行攻击。没有技能的单位：英雄没有攻击按钮，TacticalAI 也无法执行攻击行为。

### 完整攻击链路

攻击由三个数据对象组成：

```
GameDataEffectDamage（伤害计算）
    ↑ 被引用
GameDataAbilityExecute（技能定义：范围、时间、目标过滤）
    ↑ 被引用
GameDataUnit.Abilities（挂载到单位）
```

### GameDataEffectDamage

定义技能造成的伤害计算逻辑：

```csharp
_ = new GameDataEffectDamage(damageLink)
{
    Amount = static (context) =>
        context.Caster.GetUnitPropertyFinal(GSC.GameDataUnitProperty.AttackDamage) ?? 0,
    Type = GSC.GameDataDamageType.Physical,
};
```

| 属性 | 说明 |
|:--|:--|
| `Amount` | 伤害数值计算委托，`context.Caster` 是施法者单位 |
| `Type` | 伤害类型：`Physical` / `Magical` / `Pure` |

### GameDataAbilityExecute

定义攻击技能的完整行为：

```csharp
_ = new GameDataAbilityExecute(attackLink)
{
    DisplayName = "攻击",
    Effect = damageLink,
    TargetType = AbilityTargetType.Unit,
    Range = static (e) =>
        (float)(e.Caster.GetUnitPropertyFinal(GSC.GameDataUnitProperty.AttackRange) ?? 0),
    AbilityExecuteFlags = new() { IsAttack = true },
    Time = new()
    {
        Preswing = static (_) => TimeSpan.FromSeconds(0.4),
        Channel = static (_) => TimeSpan.FromSeconds(0.6),
        Backswing = static (_) => TimeSpan.FromSeconds(0.3),
        NormalizedDuration = static (_) => TimeSpan.FromSeconds(1.0),
    },
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
```

| 属性 | 说明 | 必需 |
|:--|:--|:--|
| `DisplayName` | 技能按钮上显示的名称。不设则显示 GameLink 原始 ID | 推荐 |
| `Effect` | 指向 `GameDataEffectDamage` 的 GameLink | 是 |
| `TargetType` | 目标类型：`Unit` / `Point` / `None` | 是 |
| `Range` | 施法距离委托 | 是 |
| `AbilityExecuteFlags.IsAttack` | 标记为普攻，TacticalAI 使用此标记寻找攻击能力 | 是 |
| `Time.Preswing` | 攻击前摇时间 | 推荐 |
| `Time.NormalizedDuration` | 目标普攻周期；需要精确控制普攻速度或攻速动态变化时推荐使用 | 推荐 |
| `Time.Backswing` | 攻击后摇时间 | 推荐 |
| `AcquireSettings.Recast` | 是否在一次攻击结束后自动续发下一次；连续普攻时推荐开启 | 推荐 |
| `AcquireSettings` | 目标过滤设置（见下节） | **必需** |
| `Animation` | 攻击/技能动画列表（使用 `GameDataAnimationSimple`），不设则施放时无动画 | 推荐 |

### IsAttack 与 Recast

`AbilityExecuteFlags.IsAttack = true` 表示这个 `GameDataAbilityExecute` 是攻击技能。攻击指令（如 `AttackTarget`）和默认战斗 AI 会从单位技能列表中查找 `IsAttack && IsValid && IsEnabled` 的技能作为普攻；如果漏配 `IsAttack`，单位可以拥有这个技能，但攻击指令不会自动使用它。

`AcquireSettings.Recast = true` 表示一次施法完成后继续尝试下发下一次同技能指令。它适合需要连续普攻的场景，例如玩家按住攻击、自动施法或 AI 持续攻击同一个目标。只想让一次指令打一刀的技能可以保持 `false`。`Recast` 不是攻击技能标记；它只控制已经发起的技能是否连续释放。

### 普攻间隔与冷却

当游戏策划需要精确控制单位普攻速度时，优先用 `Time.NormalizedDuration` 表达目标普攻周期。`NormalizedDuration` 会按比例缩放 `Preswing + Cast + Channel`，使这些核心阶段合计等于目标周期；`Backswing` 会按同一比例缩放，但默认可以被下一条攻击指令打断。

不要把 `Cost.Cooldown` 当作“最短攻击间隔”。冷却是技能消耗/可用性门槛，作为 `Cost` 通常在进入 `Channel` 并消耗资源时启动；它不会自动压缩前摇、施法、引导或后摇。下一次攻击要开始，至少还要等当前攻击进入后续阶段、冷却走完，并重新执行前摇等流程。因此把攻速公式只写在冷却上时，即使冷却变短，施法时间仍可能卡住实际攻速。

常见做法：

```csharp
Time = new()
{
    Preswing = static (_) => TimeSpan.FromSeconds(0.25),
    Channel = static (_) => TimeSpan.FromSeconds(0.75),
    Backswing = static (_) => TimeSpan.FromSeconds(0.25),
    // 固定 1 秒一次普攻；如果项目有攻速属性，把换算公式写在这里。
    NormalizedDuration = static (_) => TimeSpan.FromSeconds(1.0),
},
AcquireSettings = new()
{
    Recast = true,
    TargetingFilters = [new()
    {
        Required = [UnitRelationship.Enemy],
        Excluded = [UnitState.Dead, UnitState.Invulnerable],
    }],
},
// 普攻通常不配置 Cost.Cooldown，除非设计上还需要额外的可用性限制。
```

### 攻击动画配置

使用 `GameDataAnimationSimple` + `File` 播放动画片段。
`File` 可以是模型自带动画的原名（如 `"attack_01"u8`），也可以是 `AnimationMappings` 中映射的别名。
所有推荐模型的攻击动画名均为 `attack_01`。
短普攻或高攻速普攻要在动画数据上显式减小 `BlendIn`。`BlendIn` 属于 `GameDataAnimationSimple`，不是 `Time`；默认混入时间约 0.15 秒，攻击周期很短时会让出手动作尚未完全混入就被下一次攻击覆盖。

```csharp
// 1. 声明 GameLink
public static readonly GameLink<GameDataAnimation, GameDataAnimationSimple> AttackAnim = new("AttackAnim"u8);

// 2. 定义动画数据
_ = new GameDataAnimationSimple(AttackAnim)
{
    File = "attack_01"u8,
    Priority = 120,
    BlendIn = TimeSpan.Zero, // 或按项目手感设置为 20-50ms
};

// 3. 在技能上引用
_ = new GameDataAbilityExecute(attackLink)
{
    Animation = [AttackAnim],
    // ...其他属性
};
```

> 更复杂的场景（多动画编排、定时 Actor 生成、事件触发）使用 `GameDataAnimationSequence`。详见 `docs/systems/ModelAnimationSystem.md`。

### 将技能绑定到单位

```csharp
_ = new GameDataUnit(unitLink)
{
    Abilities = [attackLink],  // 可以绑定多个技能
    // ...
};
```

### 需要的 using

```csharp
using GameCore.AbilitySystem.Data.Struct;   // AbilityTargetType, AbilityExecuteFlags
using GameCore.EntitySystem.Data.Enum;       // UnitRelationship, UnitState
using GameCore.ModelAnimation.Data;          // GameDataAnimationSimple
```

---

## 目标过滤（AcquireSettings）

`AcquireSettings.TargetingFilters` 控制技能自动选取目标的过滤逻辑。**这是所有攻击技能的必需配置**。

### 不配置的后果

当 `TargetingFilters` 为空时，技能自动选中距离施法者最近的可攻击单位——包括施法者自己。这导致英雄在原地使用攻击技能时攻击自己。

### 配置方式

```csharp
AcquireSettings = new()
{
    TargetingFilters = [new()
    {
        Required = [UnitRelationship.Enemy],                        // 只选敌方
        Excluded = [UnitState.Dead, UnitState.Invulnerable],        // 排除死亡和无敌
    }],
},
```

### 可用过滤条件

**UnitRelationship（关系过滤）**：

| 值 | 含义 |
|:--|:--|
| `UnitRelationship.Enemy` | 敌方单位 |
| `UnitRelationship.Ally` | 友方单位 |
| `UnitRelationship.Neutral` | 中立单位 |

**UnitState（状态排除）**：

| 值 | 含义 |
|:--|:--|
| `UnitState.Dead` | 已死亡 |
| `UnitState.Invulnerable` | 无敌状态 |

### 治疗技能的目标过滤

```csharp
AcquireSettings = new()
{
    TargetingFilters = [new()
    {
        Required = [UnitRelationship.Ally],
        Excluded = [UnitState.Dead],
    }],
},
```

---

## 状态栏（StatusBarSetting）

单位默认没有头顶血条。必须配置 `StatusBarSetting` 才会显示。

### 基本配置

```csharp
StatusBarSetting = new()
{
    DefaultStatusBar = GSC.GameDataStatusBar.EnemyNormalNone,
    OverrideByRelationShip = new()
    {
        { PlayerUnitRelationShip.Alliance, GSC.GameDataStatusBar.AllyNormalNone },
        { PlayerUnitRelationShip.Enemy, GSC.GameDataStatusBar.EnemyNormalNone },
        { PlayerUnitRelationShip.Neutral, GSC.GameDataStatusBar.NeutralNormalNone },
    },
},
```

`OverrideByRelationShip` 让不同阵营的玩家看到不同样式的血条（友方绿色、敌方红色等）。

### 预置状态栏变体

| 变体名 | 适用单位 | 特性 |
|:--|:--|:--|
| `AllyHeroNone` / `EnemyHeroNone` / `MainHeroNone` | 英雄 | 含等级槽位，**必须配合 `Leveling`** |
| `AllyNormalNone` / `EnemyNormalNone` / `NeutralNormalNone` | 普通单位/小兵 | 无等级槽位 |

### Hero 变体必须配合 Leveling

使用 Hero 变体但未配置 `Leveling` 时，等级槽位会显示为黑块。解决方法：

```csharp
_ = new GameDataUnit(heroLink)
{
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

### 需要的 using

```csharp
using GameCore.PlayerAndUsers.Enum;  // PlayerUnitRelationShip
```

---

## 相机系统

### 默认行为

设置 `player.MainUnit` 后，客户端相机自动跟随该单位。默认相机参数由项目场景模板决定。

### 自定义相机

当默认相机视角不适合游戏类型时（如默认 RTS 视角过高、过远），可创建自定义相机并在客户端切换：

```csharp
// 共享代码：定义自定义相机
public static readonly GameLink<GameDataCamera, GameDataCamera> RpgCamera = new("RpgCamera"u8);

// OnGameDataInitialization 中注册
_ = new GameDataCamera(MyLinks.RpgCamera)
{
    TargetingMode = GameCore.CameraSystem.Enum.CameraTargetingMode.Follow,
    FollowMainUnitByDefault = false,
    PositionMode = GameCore.CameraSystem.Enum.CameraPositionMode.FocalPoint,
    Rotation = new() { Pitch = -45f, Roll = 0f, Yaw = 0f },
    FocalLength = new() { Min = 500f, Max = 800f },
    FieldOfView = 45f,
    NearClipPlane = 1f,
    FarClipPlane = 100000f,
};
```

### 客户端切换相机

```csharp
#if CLIENT
var camera = DeviceInfo.PrimaryViewport.Camera;
camera.FollowTarget = Player.LocalPlayer?.MainUnit;
camera.Switch(MyLinks.RpgCamera, TimeSpan.FromSeconds(0.3));
#endif
```

---

## 单位创建与生命周期

### 创建单位（仅服务端）

```csharp
#if SERVER
// 推荐：通过 GameDataUnit.CreateUnit（安全，失败返回 null）
var unit = myUnitLink.Data?.CreateUnit(player, scenePoint, facing);

// 创建 AI 单位时传 useDefaultAI: true，按 TacticalAI 自动挂载 AI
var enemy = enemyLink.Data?.CreateUnit(player, scenePoint, facing, useDefaultAI: true);
#endif
```

### 参数说明

| 参数 | 类型 | 说明 |
|:--|:--|:--|
| `player` | `Player` | 所有者 |
| `scenePoint` | `ScenePoint` | 出生位置 |
| `facing` | `Angle` | 朝向（度数） |
| `useDefaultAI` | `bool`（可选，默认 `false`） | 传 `true` 时按 `GameDataUnit.TacticalAI` 自动创建并激活 `AIThinkTree`；不传也可后续手动挂载 |

### 销毁单位

```csharp
#if SERVER
unit.Kill(DeathType.Kill);     // 正常击杀（触发死亡流程）
unit.Kill(DeathType.Destroy);  // 直接销毁（跳过死亡流程）
#endif
```

### 生命周期

```
CreateUnit → 自动同步到客户端 → IsAlive = true
  → 受伤/HP=0 → 死亡流程 → IsAlive = false
  → DeathRemovalDelay 后移除（如果配置了）
```

---

## 移动系统

### 四种移动方式

#### 1. 寻路移动（推荐用于 AI）

需要 `UpdateFlags.Walkable = true`，使用 `Walkable` 组件：

```csharp
#if SERVER
var walkable = Walkable.CreateInstance(unit);
if (walkable != null)
{
    walkable.PathTo(targetPosition);  // 自动寻路
}
#endif
```

#### 2. 直线移动（MoveTo）

沿直线匀速移动到目标，不绕路：

```csharp
#if SERVER
unit.MoveTo(targetScenePoint);
#endif
```

#### 3. 瞬间传送（SetPosition）

立即移动到目标位置：

```csharp
unit.SetPosition(new ScenePoint(x, y, scene));
```

#### 4. 指令移动（ProcessCommand）

模拟玩家下达移动命令：

```csharp
#if SERVER
unit.ProcessCommand(CommandIndex.Move, targetScenePoint);
#endif
```

### 停止移动

```csharp
#if SERVER
unit.ProcessCommand(CommandIndex.Stop);
#endif
```

---

## 基本形状系统

当没有 3D 模型时，使用 `PrimitiveShapeConfig` 为单位分配基本几何形状。

### 可用形状

| 形状 | 说明 | 标准尺寸 | 原点位置 | 默认颜色 |
|:--|:--|:--|:--|:--|
| `Sphere` | 球体 | 直径 100 | 球心 | 红色 |
| `Cube` | 立方体 | 边长 100 | 底面中心 | 橙色 |
| `Cylinder` | 圆柱体 | 直径 100 高 100 | 底面圆心 | 灰色 |
| `Capsule` | 胶囊 | 直径 100 总高 200 | 底端圆心 | 蓝色 |
| `Cone` | 圆锥 | 直径 100 高 100 | 底面圆心 | 黄色 |
| `Pyramid` | 金字塔 | 边长 100 高 100 | 底面中心 | 沙黄 |
| `Torus` | 环形 | 外径 100 高 40 | 几何中心 | 紫色 |
| `Wedge` | 楔形 | 边长 100 高 100 | 底面后端中心 | 绿色 |
| `Plane` | 平面 | 边长 100 | 几何中心 | 棕色 |

### 单形状配置

```csharp
PrimitiveShape = new PrimitiveShapeConfig
{
    Shape = PrimitiveShape.Capsule,
    Scale = new Vector3(0.5f, 0.5f, 1f),
    // Offset = new Vector3(0, 0, 0),         // 可选偏移
    // Rotation = new Vector3(0, 0, 0),        // 可选旋转（欧拉角）
    // CustomColor = new HdrColor(255, 0, 0, 255), // 可选自定义颜色（short 0-255）
},
```

### 复合形状（多个形状组合）

```csharp
CompositeShapes =
[
    new PrimitiveShapeConfig
    {
        Shape = PrimitiveShape.Cube,
        Scale = new Vector3(1f, 1f, 0.5f),
        AttachToRoot = true,
        Priority = 0,
        Tag = "Body",
    },
    new PrimitiveShapeConfig
    {
        Shape = PrimitiveShape.Sphere,
        Scale = new Vector3(0.3f, 0.3f, 0.3f),
        Offset = new Vector3(0, 0, 60),
        AttachToRoot = true,
        Priority = 1,
        Tag = "Head",
    },
],
```

### 颜色系统

```csharp
// 自动语义颜色（每种形状有不同颜色，默认模式）
ColorMode = ShapeColorMode.SmartDefaults,

// 自定义颜色（覆盖自动颜色）
CustomColor = new HdrColor(51, 204, 77, 255),  // RGBA (short 0-255, 支持 HDR 超过 255)

// 随机颜色（调试用）
ColorMode = ShapeColorMode.RandomColors,

// 颜色主题
ColorTheme = ShapeColorTheme.Gaming,  // Standard / Gaming / Educational / Natural
```

---

## 3D 模型系统

当需要使用真实 3D 模型（而不是 PrimitiveShape 几何形状）时，通过 `GameDataModel` + `GameDataUnit.Model` 实现。

### 内置占位模型清单

以下模型在所有项目中内置可用，无需额外导入：

| 种类 | Asset 路径 | 说明 | Radius | AnimationRaw 映射 |
|:--|:--|:--|:--|:--|
| 人形英雄 | `characters1/baiyijianke_e4wa/model.prefab` | 白衣剑客，推荐主角 | 52 | idle→idle, move→move, attack→attack_01, death→death |
| 人形通用 | `characters/general/sk_basic2/model.prefab` | 通用角色 | 50 | idle→sword_idle, move→sword_move |
| 小型怪物 | `characters/monster/sm_slm_a/model.prefab` | 史莱姆 A（小） | 40 | idle→idle, move→move_02, attack→attack_01, death→death |
| 中型怪物 | `characters/monster/sm_slm_b/model.prefab` | 史莱姆 B（中） | 60 | idle→idle, move→move_02 |
| 大型怪物 | `characters/monster/sm_slm_c/model.prefab` | 史莱姆 C（大） | 80 | idle→idle, move→move_02 |
| 蜘蛛怪 | `characters/monster/sk_spider_burrow/model.prefab` | 蜘蛛 | 32 | idle→idle, move→walk, attack→Attack |
| 狼人 | `characters/monster/sk_werewolf/model.prefab` | 狼人 | 50 | idle→idle, move→move, attack→attack_01, death→death |
| 石塔 A03 | `deco/dungeon/sk_garden_stonetower_a03/model.prefab` | 大型石塔 | — | 无动画（静态建筑） |
| 石塔 A | `deco/dungeon/sk_garden_stonetower_a/model.prefab` | 标准石塔 | — | 无动画（静态建筑） |

> **AnimationMappings 说明**：表中 `idle→idle` 表示 `AnimationAlias = "idle"` 对应 `AnimationRaw = "idle"`；`move→move_02` 表示别名 `"move"` 对应模型中的实际动画名 `"move_02"`。不同模型的实际动画名称不同，需通过 `AnimationMappings` 正确映射。`AnimationMappings` 的核心作用是指定框架自动查找的 `idle`、`move`、`death` 等**硬编码别名**对应哪个实际动画——这些别名不映射的话，框架就无法自动播放对应动画。模型自带动画也可以直接用原名播放（不一定需要先映射）。
>
> **更多模型**：旧版角色/怪物完整列表见 [`resources/characters.json`](../../../resources/characters.json)；官方捏人角色见 [`resources/characters1.json`](../../../resources/characters1.json)，路径格式为 `characters1/{name}/model.prefab`。`characters1` 索引不提供 Radius，请按角色体型手动配置 `GameDataModel.Radius`、`CollisionRadius`、`AttackableRadius`。
>
> **共享 Humanoid 动画**：如需使用 `resources/animations.json` 中的共享动画集，可用完整路径（带 `.ani`）播放或通过 `AnimationMappings` 映射后用别名播放。建议在 `GameDataModel.HumanoidSourceAnimations` 中列出所需的共享动画，以便编辑器为当前模型骨骼烘焙适配版本（不配置也能 fallback 到原始动画，但可能出现体形不匹配的视觉问题）。

### 使用 GameDataModel 的完整示例

```csharp
using GameCore.ResourceType.Data;
using GameCore.ResourceType.Data.Enum;

// 第 1 步：定义 GameLink
public static class MyLinks
{
    public static readonly GameLink<GameDataUnit, GameDataUnit> Hero = new("MyHero");
    public static readonly GameLink<GameDataModel, GameDataModel> HeroModel = new("MyHeroModel");
}

// 第 2 步：注册 GameDataModel（在 OnRegisterGameData 或 OnGameDataInitialization 中）
_ = new GameDataModel(MyLinks.HeroModel)
{
    Asset = "characters1/baiyijianke_e4wa/model.prefab",
    Radius = 52f,
    ShadowSetting = new()
    {
        ShadowType = ShadowType.DeviceDependentShadow,
    },
    AnimationMappings = [
        new() { AnimationAlias = "idle", AnimationRaw = "idle" },
        new() { AnimationAlias = "move", AnimationRaw = "move" },
        new() { AnimationAlias = "attack", AnimationRaw = "attack_01" },
        new() { AnimationAlias = "death", AnimationRaw = "death" },
    ],
};

// 第 3 步：在 GameDataUnit 中引用
_ = new GameDataUnit(MyLinks.Hero)
{
    Name = "我的英雄",
    Model = MyLinks.HeroModel,   // ← 替代 PrimitiveShape
    CollisionRadius = 32f,
    AttackableRadius = 50f,
    UpdateFlags = new() { Walkable = true, Turnable = true, AllowMover = true },
    UnitPropertyInitialData = new()
    {
        { GSC.GameDataUnitProperty.LifeMax, 1000 },
        { GSC.GameDataUnitProperty.MoveSpeed, 350 },
    },
    VitalProperties = [GSC.GameDataVital.Health],
};
```

### 怪物模型示例（史莱姆三种体型）

```csharp
// 小型敌人 — 史莱姆 A
_ = new GameDataModel(MyLinks.SmallEnemyModel)
{
    Asset = "characters/monster/sm_slm_a/model.prefab",
    Radius = 40f,
    ShadowSetting = new() { ShadowType = ShadowType.DeviceDependentShadow },
    AnimationMappings = [
        new() { AnimationAlias = "idle", AnimationRaw = "idle" },
        new() { AnimationAlias = "move", AnimationRaw = "move_02" },
        new() { AnimationAlias = "attack", AnimationRaw = "attack_01" },
        new() { AnimationAlias = "death", AnimationRaw = "death" },
    ],
};

// 中型敌人 — 史莱姆 B
_ = new GameDataModel(MyLinks.MediumEnemyModel)
{
    Asset = "characters/monster/sm_slm_b/model.prefab",
    Radius = 60f,
    ShadowSetting = new() { ShadowType = ShadowType.DeviceDependentShadow },
    AnimationMappings = [
        new() { AnimationAlias = "idle", AnimationRaw = "idle" },
        new() { AnimationAlias = "move", AnimationRaw = "move_02" },
    ],
};

// 大型敌人（Boss）— 史莱姆 C
_ = new GameDataModel(MyLinks.LargeEnemyModel)
{
    Asset = "characters/monster/sm_slm_c/model.prefab",
    Radius = 80f,
    ShadowSetting = new() { ShadowType = ShadowType.DeviceDependentShadow },
    AnimationMappings = [
        new() { AnimationAlias = "idle", AnimationRaw = "idle" },
        new() { AnimationAlias = "move", AnimationRaw = "move_02" },
    ],
};
```

### PrimitiveShape vs Model 对比

| | PrimitiveShape | GameDataModel |
|:--|:--|:--|
| **适用阶段** | 原型开发、快速验证 | 正式游戏、演示 |
| **依赖** | 无外部依赖 | 需要模型文件存在 |
| **外观** | 彩色几何体 | 真实 3D 模型 + 动画 |
| **设置复杂度** | 低（直接在 GameDataUnit 上设置） | 中（需要单独注册 GameDataModel + AnimationMappings） |
| **互斥** | 与 Model 互斥 | 与 PrimitiveShape 互斥 |

> **注意**：`PrimitiveShape` 和 `Model` 不能同时设置。设置了 `Model` 后 `PrimitiveShape` 会被忽略。

---

## 跨端通信

### 三层通信机制

| 层级 | API | 适用场景 |
|:--|:--|:--|
| 初级 | `DualEndEvent` | 游戏事件、状态通知 |
| 中级 | `TypedMessage<T>` | 结构化数据交换 |
| 高级 | `ProtoCustomMessage` | 高频同步、自定义二进制 |

3D 单位游戏通常使用 DualEndEvent 即可满足需求。

### DualEndEvent 详细用法

#### 定义事件

```csharp
// 必须实现 IDualEndEvent<TSelf>
public class WaveStartEvent : IDualEndEvent<WaveStartEvent>
{
    public Player? Sender { get; set; }  // 框架自动填充
    public int WaveNumber { get; set; }
    public int EnemyCount { get; set; }
}
```

#### 服务端广播

```csharp
#if SERVER
// 广播给所有客户端
DualEndEvent.Publish(new WaveStartEvent
{
    WaveNumber = 3,
    EnemyCount = 10,
});

// 发送给特定玩家
DualEndEvent.Publish(specificPlayer, new WaveStartEvent { WaveNumber = 3 });
#endif
```

#### 客户端监听

```csharp
#if CLIENT
Game.Subscribe<WaveStartEvent>(async (s, d) =>
{
    ShowWaveUI(d.WaveNumber, d.EnemyCount);
});
#endif
```

#### 客户端发送 → 服务端接收

```csharp
// 客户端发送
#if CLIENT
DualEndEvent.Publish(new PlayerActionEvent { ActionType = "UseItem" });
#endif

// 服务端监听
#if SERVER
Game.Subscribe<PlayerActionEvent>(async (s, d) =>
{
    var player = d.Sender;  // 自动填充为发送者
    HandleAction(player, d.ActionType);
});
#endif
```

### TypedMessage（中级）

当需要更精细的消息路由时使用：

```csharp
// 定义消息
public class ScoreUpdate : TypedMessage<ScoreUpdate>
{
    public int PlayerId { get; set; }
    public int Score { get; set; }
}

// 服务端发送
#if SERVER
ScoreUpdate.Send(player, new ScoreUpdate { PlayerId = 1, Score = 100 });
#endif

// 客户端接收
#if CLIENT
ScoreUpdate.OnReceived += (msg) => UpdateScoreboard(msg.PlayerId, msg.Score);
#endif
```

---

## 场景系统

### 场景加载

场景的地形资产由编辑器创建，不可在代码中凭空创建。每个项目都自带一个默认场景。

> **项目特定**：`GameEntry.ScopeData.GameDataScene.new_scene` 为 game_entry 模板的默认场景名，你的项目可能使用不同的场景标识。

加载场景的正确流程：

```csharp
#if SERVER
// 通过项目中已有的 GameDataScene 加载场景
var scene = Scene.GetOrCreate(GameEntry.ScopeData.GameDataScene.new_scene);
scene.Load();

// 场景中的坐标
var center = new ScenePoint(2048, 2048, scene);
var corner = new ScenePoint(100, 100, scene);
#endif
```

> **注意**：`HostedSceneTag` 必须对应编辑器中已创建的场景资产。项目中所有可用的场景都在 `GameEntry.ScopeData.GameDataScene` 下以静态字段形式存在。不要编造不存在的 SceneTag。

### ScenePoint 工具方法（GameSparkCore 项目扩展）

> **项目特定**：以下扩展方法来自 GameSparkCore 项目，非框架内置。其他项目需自行实现或引用对应库。

```csharp
using gamesparkcore.SceneSystem;

// 将点钳制到地图范围内
var safePoint = ScenePointExtensions.ClampToMap(point);

// 在半径内随机点
var randomPos = ScenePointExtensions.RandomInRadius(center, 500f, random);

// 在环形区域内随机点
var ringPos = ScenePointExtensions.RandomInRing(center, 200f, 600f, random);
```

### 坐标系统

WasiCore 使用 **Z 轴为高度轴**的坐标系（类似 Unreal）：

- X 轴：水平（左右）
- Y 轴：水平（前后）
- Z 轴：高度（上下）
- XY 平面 = 地面

`ScenePoint` 是 2D 地面坐标（X, Y），关联特定场景。

---

## 玩家与队伍

### 获取玩家

```csharp
// 所有玩家
var allPlayers = Player.AllPlayers;

// 按 ID 获取
var player1 = Player.GetById(1);

// 中立玩家（ID=0，与所有人默认中立关系，不适合作为敌人）
var neutralPlayer = Player.GetById(0);

// 客户端本地玩家
#if CLIENT
var localPlayer = Player.LocalPlayer;
#endif
```

### 玩家关系与队伍配置

> 完整文档见 [PlayerSystem.md](../../systems/PlayerSystem.md#队伍与玩家关系)。

玩家之间的关系由 `Player.GetRelationShip(other)` 判定，返回 `PlayerRelationShip` 枚举：

| 关系 | 条件 |
|:--|:--|
| `Player` | 同一玩家 |
| `Ally` | 不同玩家，同一队伍 |
| **`Neutral`** | **任一方为中立玩家**（`IsNeutral = true`） |
| `Enemy` | 不同队伍，且双方都非中立 |

> **关键规则**：中立玩家（`IsNeutral = true`）的单位 **永远不会** 被判定为 `Enemy`，因此不能用来创建敌人。

**队伍配置来源**：项目中 `DataGenerated/.../GameDataPlayerSettings/PlayerSettings.cs`（由编辑器生成）定义了所有队伍及其玩家。查看此文件可确定哪些玩家属于哪个队伍。

默认模版（`game_entry`）的配置为：
- 队伍 0：玩家 0（Computer, **IsNeutral=true**）
- 队伍 1：玩家 1（User）, 玩家 2（Computer）
- 队伍 2：玩家 3（Computer）, 玩家 4（Computer）

```csharp
// 创建敌方单位时，需选择与英雄不同队伍的非中立玩家
// 查看项目 PlayerSettings.cs 确认队伍配置。默认模版中：
var enemyPlayer = Player.GetById(3); // 队伍2，与队伍1（玩家1/2）敌对

// 错误：中立玩家的单位不算敌人
// var enemyPlayer = Player.GetById(0); // Neutral，永远不会触发 Enemy 判定

// 运行时检查关系
var relation = player1.GetRelationShip(enemyPlayer); // → Enemy
var relation2 = player1.GetRelationShip(neutralPlayer); // → Neutral
```

> **注意**：玩家 0 默认为中立且编辑器强制保护（不可删除、不可改队伍、不可设为非中立）。但其他玩家的 ID、队伍分配、是否中立均可由用户在编辑器中自定义，不要假设固定的队伍结构。

### 玩家昵称（GameSparkCore 项目扩展）

> **项目特定**：以下扩展方法来自 GameSparkCore 项目，非框架内置。

```csharp
using gamesparkcore.PlayerAndUsers;

string name = PlayerExtensions.GetNicknameOrDefault(player, "玩家");
bool isHuman = PlayerExtensions.IsHuman(player);
```

### 玩家拥有的单位

```csharp
// 获取玩家拥有的所有存活单位（框架自动维护，创建时加入，销毁时移除）
IReadOnlyCollection<Unit> units = player.Units;

// 获取玩家的主控单位
var mainUnit = player.MainUnit;

// 遍历玩家的所有单位
foreach (var unit in player.Units)
{
    if (unit.IsAlive) { /* ... */ }
}
```

---

## AI 系统（TacticalAI）

### 概念

`TacticalAI` 控制 NPC/敌人的自主行为。若使用框架默认的自动寻敌 / 自动攻击方案，通常需要同时满足这些前提：

1. **数据定义** `TacticalAI` 指向一个可用的 `GameDataAIThinkTree`（最常用的是 `GSC.GameDataAIThinkTree.Default`，也可以是自定义思考树）
2. **攻击技能** `Abilities` 中至少有一个 `IsAttack = true` 的技能（默认 AI 用它作为攻击能力）
3. **挂载 AI** 创建时传 `CreateUnit(..., useDefaultAI: true)`，或创建后手动调用 `AIThinkTree.AddDefaultAI(unit)` / `myAIThinkTreeLink.Data!.CreateAI(unit)`

如果使用自定义 `AIThinkTree`，是否必须有 `IsAttack` 技能、目标需要哪些 `Filter`，要以你的行为树和 `ScanFilters` 设计为准。

### 配置 AI

```csharp
// 数据定义（共享代码）
_ = new GameDataUnit(enemyLink)
{
    TacticalAI = GSC.GameDataAIThinkTree.Default, // 这里使用框架默认预设；也可换成自定义 AIThinkTree
    Abilities = [enemyAttackLink], // 必须有 IsAttack 技能
    // ...
};

// 创建单位（服务端）
#if SERVER
var enemy = enemyLink.Data?.CreateUnit(player, pos, facing, useDefaultAI: true);
// 或者先创建，再动态挂 / 替换 AI：
// var enemy = enemyLink.Data?.CreateUnit(player, pos, facing);
// if (enemy is not null)
// {
//     AIThinkTree.AddDefaultAI(enemy);         // 方案 A：按 GameDataUnit.TacticalAI 自动创建
//     // myAIThinkTreeLink.Data!.CreateAI(enemy); // 方案 B：显式挂自定义 AI，会替换已有 AI
// }
#endif
```

`GSC.GameDataAIThinkTree.Default` 是框架预置的通用战斗 AI，行为逻辑：
1. 扫描范围内的敌方单位（`ScanFilters` 过滤：`Required = [UnitRelationship.Enemy, UnitFilter.Unit, UnitRelationship.Visible]`）
2. 选择目标并尝试施放技能

> **关键约束**：目标单位的 `Filter` 必须包含 `UnitFilter.Unit`，否则不满足 `ScanFilters` 的 `Required` 条件，AI 会跳过该目标。这意味着所有参与战斗的英雄和敌人都必须在 `GameDataUnit.Filter` 中配置 `UnitFilter.Unit`。

### 玩家控制的单位（不需要 AI）

玩家控制的英雄单位通常**不设置** `TacticalAI`，由玩家通过移动摇杆和技能按钮操控。如果英雄同时需要自动攻击（如 ARPG 自动战斗），可以设置 TacticalAI 并在需要时禁用。

### 死亡移除延迟

```csharp
DeathRemovalDelay = TimeSpan.FromSeconds(3), // 死亡后 3 秒移除
// null（默认）= 立即移除
// Timeout.InfiniteTimeSpan = 永不移除（尸体永久保留）
```

---

## 玩家控制（MainUnit + GameSystemUI）

### 概念

玩家控制分为两个层面：

1. **服务端**：`player.MainUnit = hero` 设置主控单位，客户端自动跟随相机
2. **客户端**：通过 GameSystemUI 提供的控件（移动摇杆、技能按钮）让玩家操控单位

### 服务端设置主控单位

```csharp
#if SERVER
var hero = heroLink.Data?.CreateUnit(player, position, facing);
if (hero != null)
{
    player.MainUnit = hero; // 客户端相机自动跟随此单位
}
#endif
```

`MainUnit` 的作用：
- 客户端相机自动跟随该单位
- 客户端 `Player.LocalPlayer.MainUnit` 返回此单位
- GameSystemUI 控件（MoveControl、AbilityJoyStickGroup）通过 MainUnit 获取操控目标

> **不设置 MainUnit 的后果**：相机停留在场景默认位置，玩家看不到自己的英雄，无法操控。

### 客户端添加操控 UI（GameSystemUI）

GameSystemUI 已内置在 game_entry 模板项目中，提供两类核心控件。`GSUI.GameDataControl.MoveControl` 和 `DefaultAbilityJoyStickGroup` 为模板预置的控件配置（`GSUI` = `gamesystemui.ScopeData`，csproj 已配置全局别名），不同项目可能使用不同的 GameDataControl 标识。

#### 移动控件（MoveControl）

平台自适应：手机显示虚拟摇杆，PC 使用 WASD/方向键。

```csharp
#if CLIENT
var moveControl = GSUI.GameDataControl.MoveControl.Data!.CreateControl();
moveControl.AddToVisualTree();
#endif
```

#### 技能摇杆组（AbilityJoyStickGroup）

自动显示主控单位的所有主动技能，支持冷却显示、方向施法、快捷键绑定。

```csharp
#if CLIENT
// GameSystemUI.AbilitySystemUI.Advanced 已通过 csproj 全局 using 导入
var abilityGroup = new AbilityJoyStickGroup(GSUI.GameDataControl.DefaultAbilityJoyStickGroup)
{
    BindUnit = Player.LocalPlayer.MainUnit,
};
abilityGroup.AddToRoot();
#endif
```

#### 完整初始化模式

```csharp
#if CLIENT
private static async Task InitializeControls()
{
    // 1. 等待主控单位就绪（服务端设置后客户端异步同步）
    for (int i = 0; i < 20; i++)
    {
        if (Player.LocalPlayer?.MainUnit != null) break;
        await Game.Delay(500);
    }

    var mainUnit = Player.LocalPlayer?.MainUnit;
    if (mainUnit == null)
    {
        Game.Logger.LogWarning("等待主控单位超时");
        return;
    }

    // 2. 添加移动控件（GSUI = gamesystemui.ScopeData，csproj 已配置全局别名）
    var moveControl = GSUI.GameDataControl.MoveControl.Data!.CreateControl();
    moveControl.AddToVisualTree();

    // 3. 添加技能摇杆
    var abilityGroup = new AbilityJoyStickGroup(GSUI.GameDataControl.DefaultAbilityJoyStickGroup)
    {
        BindUnit = mainUnit,
    };
    abilityGroup.AddToRoot();
}
#endif
```

### 指令系统（手动发出单位命令）

除了 GameSystemUI 自动处理的操控外，也可以通过代码手动向单位发出命令：

```csharp
#if SERVER
// 移动到目标点
unit.ProcessCommand(CommandIndex.Move, targetScenePoint);

// 攻击目标单位
unit.ProcessCommand(CommandIndex.Attack, targetUnit);

// 停止当前行动
unit.ProcessCommand(CommandIndex.Stop);
#endif
```

---

## 伤害系统

### 直接伤害（通过 Vital）

```csharp
#if SERVER
var health = unit.GetTagComponent<Vital>(PropertyVital.Health);
health?.Modify(-100);  // 扣 100 HP
#endif
```

### 伤害类型

`GSC.GameDataDamageType` 提供预定义伤害类型：

| 类型 | GameLink |
|:--|:--|
| 物理伤害 | `GameDataDamageType.Physical` |
| 魔法伤害 | `GameDataDamageType.Magical` |
| 真实伤害 | `GameDataDamageType.Pure` |

### 浮动文字

`GSC.GameDataFloatingText` 提供预定义浮动文字类型：

| 类型 | 说明 |
|:--|:--|
| `PhysicalDamage` | 物理伤害数字 |
| `MagicDamage` | 魔法伤害数字 |
| `PureDamage` | 真实伤害数字 |
| `Heal` | 治疗数字 |
| `Gold` | 金币获得 |
| `Exp` | 经验获得 |
| `Missed` | 未命中 |

---

## 投射物系统

投射物使用 `GameDataEffectLaunchMissile` 发射，有三种模式。详细文档见 [投射物模式指南](../../../systems/ProjectilePatterns.md)。

### 模式速查

| 模式 | DoImpactEntity | 命中效果 | FixedRange | 示例 |
|------|---------------|---------|-----------|------|
| 追踪型 | false | CompleteEffect | 不设 | 普攻弹道 |
| Skillshot 穿透型 | true | ImpactEffect | 推荐 | 火球 |
| 落点 AOE 型 | false | CompleteEffect→Search | 可选 | 迫击炮 |

### Skillshot 穿透型模板（最常用）

```csharp
// 投射物单位
_ = new GameDataUnit(Unit.MyMissile)
{
    Filter = [UnitFilter.Missile],
    State = [UnitState.Invulnerable],
    CollisionRadius = 16,
    AttackableRadius = 32,
    Particle = "effect/missile/particle.effect"u8,
    UpdateFlags = new() { AllowMover = true },
};

// 发射效果
_ = new GameDataEffectLaunchMissile(Effect.MyLaunch)
{
    Missile = Unit.MyMissile,
    FixedRange = static (_) => 800f,
    DoImpactEntity = true,
    ImpactEffect = Effect.MyDamage,
    ImpactMaxCount = static (_) => 1,
    ImpactSearchRadius = static (_) => 48,
    Speed = static (_) => 800,
    LaunchHeight = (_) => 80,
    TargetHeight = (_) => 80,
};

// 搜索效果
_ = new GameDataEffectSearch(Effect.MySearch)
{
    Method = SearchMethod.Circle,
    Radius = static (_) => 600,
    MaxCount = static (_) => 3,
    SearchFilters = [new() {
        Required = [UnitRelationship.Enemy],
        Excluded = [UnitState.Dead, UnitState.Invulnerable]
    }],
    Effect = Effect.MyLaunch,
};
```

### 常见陷阱

- Search 找到的是**单位目标** → 直接给 LaunchMissile 会变成追踪弹，用 `FixedRange` 转为点目标
- 追踪型投射物**不要开** `DoImpactEntity`，否则中途碰到别的单位会提前引爆
- Skillshot 伤害放 `ImpactEffect`，不是 `CompleteEffect`
- `LaunchHeight` 和 `TargetHeight` 同高度可确保水平飞行

### 方向性自动索敌投射物（玩家开火 / 朝敌人射击）

"范围内有敌人就朝最近敌人射、没敌人就朝当前朝向射"——这是引擎**内置能力**，不要手写索敌/转向。配方：

- 技能 `GameDataAbilityExecute`：`TargetType = AbilityTargetType.Vector` + `AbilityExecuteFlags.AlwaysAcquireTarget = true` + `AcquireSettings { AcquireRange, TargetingFilters }`（`SmartAcquire` 默认 true）。`Effect` 指向上面的 Skillshot 穿透型 `GameDataEffectLaunchMissile`（带 `FixedRange`）。
- 客户端开火只做一件事：对主控单位**无目标**施放——`player.CastAbilityWithMainUnit(技能链接)`，**不传角度、不传目标**。无目标时 `SmartAcquire` 自动在 `AcquireRange` 内按 filter 找最近敌人填入目标；找不到则按施法者当前朝向发射。

> **投射物方向取自技能的 ExecutionTarget（索敌到的目标 / 向量方向），与单位 `Facing` 无关。** 所以**不要为了"瞄准"去手动 `SetFacing` 转角色**——转了也不改子弹方向，纯属表现层多余动作；瞬发技能尤其不需要转向（见下一节）。若确实想让角色视觉上面向目标，用数据驱动的 `GameDataEffectUnitModifyFacing`，而不是在 trigger/Order 事件里手动 `SetFacing`。

**反模式（出现即多半在和引擎对着干，应删除）**：

- 服务端手动 `unit.SetFacing(...)` 去"对准"目标；
- 监听 `EventEntityOrderStage` 在 Cast 阶段手动转向或扣资源；
- 客户端用每 tick 位置差分算"朝向"当开火方向；
- 用 `!result.IsSuccess` 判断"有没有敌人"再补一发定向 cast——Vector 技能无目标**并不会失败**，这个信号不成立。

---

## 瞬发技能的弹药与资源消耗

瞬发技能（`AbilityActiveFlags.Transient = true`，如"按住连射"的射击）**入队后立即执行（`TransientExecute`），不经过 Preswing / Cast / Channel 等施法阶段**。因此：

- **不要把"扣弹药 / 没资源就打不出来"挂在 `EventEntityOrderStage`（Order 阶段事件）上**——瞬发技能不经过 Cast 阶段，挂上去的逻辑根本不会触发（典型坑：gate 在 `data.Stage == OrderStage.Cast` 的 handler，对瞬发技能是死代码）。
- **正确做法：放进技能效果树。** 门槛放在**第一个效果节点的 `Validators`**（`ValidatorEffect = delegate CmdResult(Effect)`）——条件不满足返回 `CmdError`（如 `NotEnoughResource`），技能指令会**直接下达失败**，客户端据此停止连发；真正的消耗放进效果里执行（如 `GameDataEffectCustomAction.Func` 跑服务端逻辑，返回 `true` 再执行子效果）。

```csharp
// 效果树首节点：弹药门槛(Validators) + 消耗(Func) + 子效果发射
var fireLink = new GameLink<GameDataEffect, GameDataEffectCustomAction>("MyFire"u8);
_ = new GameDataEffectCustomAction(fireLink)
{
#if SERVER
    // 门槛：没弹药 → 返回失败 → 开火指令下达失败（客户端据 !IsSuccess 停连发）
    Validators = static (ctx) =>
    {
        if (ctx.Caster is Unit u && MyServer.HasAmmo(u.Player.Id)) return CmdResult.Ok;
        return CmdError.NotEnoughResource;
    },
    // 消耗：通过门槛后扣弹药 / 施加减速 / 刷新 HUD，再执行子效果
    Func = static (ctx) =>
    {
        if (ctx.Caster is Unit u) MyServer.OnFired(u);
        return new ValueTask<bool>(true);
    },
#endif
    Effect = launchMissileLink,   // 子效果：发射投射物
};

// 技能 Effect 指向首节点（不是直接指向发射效果）
_ = new GameDataAbilityExecute(attackLink) { Effect = fireLink, /* ... */ };
```

> 弹药等服务端独有状态放在服务端类里，`Validators`/`Func` 引用它们要包 `#if SERVER`（效果树只在服务端执行）；`Effect` 子链接两端都要设。`Validators` 可能被多次预验证（如 SmartAcquire 试目标时），所以**只做判断、不要在里面扣资源**；扣减放 `Func`。

---

## 扩展功能

### Buff 管理（GameSparkCore 项目扩展）

> **项目特定**：以下扩展方法来自 GameSparkCore 项目，非框架内置。

```csharp
using gamesparkcore.UnitSystem;

// 检查 Buff
bool hasBuff = UnitExtensions.HasBuff(unit, myBuffLink);
var buff = UnitExtensions.GetBuff(unit, myBuffLink);
var allBuffs = UnitExtensions.GetAllBuffs(unit);

// 按极性查询
var posBuffs = UnitExtensions.GetBuffsByPolarity(unit, BuffPolarity.Positive);
int negCount = UnitExtensions.CountBuffsByPolarity(unit, BuffPolarity.Negative);

// 驱散（仅服务端）
#if SERVER
UnitExtensions.DispelNegativeBuffs(unit);
UnitExtensions.ClearAllDispellableBuffs(unit);
#endif
```

### 技能管理（GameSparkCore 项目扩展）

> **项目特定**：以下扩展方法来自 GameSparkCore 项目，非框架内置。

```csharp
using gamesparkcore.UnitSystem;

bool hasAbility = UnitExtensions.HasAbility(unit, myAbilityLink);
var ability = UnitExtensions.GetAbility(unit, myAbilityLink);
var allAbilities = UnitExtensions.GetAllAbilities(unit);
bool isActive = UnitExtensions.IsAbilityActivated(unit, myAbilityLink);
```

### 状态栏（血条）

详见 [状态栏（StatusBarSetting）](#状态栏statusbarsetting) 章节。使用 `OverrideByRelationShip` 按阵营分配不同样式：

```csharp
StatusBarSetting = new()
{
    DefaultStatusBar = GSC.GameDataStatusBar.EnemyNormalNone,
    OverrideByRelationShip = new()
    {
        { PlayerUnitRelationShip.Alliance, GSC.GameDataStatusBar.AllyNormalNone },
        { PlayerUnitRelationShip.Enemy, GSC.GameDataStatusBar.EnemyNormalNone },
    },
},
```

### 等级系统

```csharp
_ = new GameDataUnit(myLink)
{
    Leveling = GSC.GameDataUnitLeveling.HeroLevelingSample,
    Level = 1,  // 初始等级
    Properties = new UnitPropertyInitialData
    {
        { GSC.GameDataUnitProperty.LevelMax, 25 },
        // ...
    },
};
```

---

## 完整游戏示例

### 塔防游戏骨架

```csharp
using GameCore.EntitySystem.Data;
using GameCore.BaseType;
// GSC = gamesparkcore.ScopeData（全局别名）
// TriggerEncapsulation 已通过 csproj 全局 using 导入，无需手动 using

namespace TowerDefense;

public static class TD
{
    public static readonly GameLink<GameDataGameMode, GameDataGameMode> TDMode = new("TD"u8);
    public static readonly GameLink<GameDataUnit, GameDataUnit> Tower = new("Tower"u8);
    public static readonly GameLink<GameDataUnit, GameDataUnit> Creep = new("Creep"u8);
}

public class TDStatusEvent : IDualEndEvent<TDStatusEvent>
{
    public Player? Sender { get; set; }
    public int Lives { get; set; }
    public int Gold { get; set; }
    public int Wave { get; set; }
}

public class TowerDefenseGame : IGameClass
{
    public static void OnRegisterGameClass()
    {
        Game.OnGameDataInitialization += OnGameDataInitialization;
    }

    private static void OnGameDataInitialization()
    {
        _ = new GameDataUnit(TD.Tower)
        {
            CollisionRadius = 50f,
            AttackableRadius = 60f,
            UpdateFlags = new UpdateFlags { Turnable = true },
            Properties = new UnitPropertyInitialData
            {
                { GSC.GameDataUnitProperty.LifeMax, 1000 },
                { GSC.GameDataUnitProperty.AttackDamage, 50 },
                { GSC.GameDataUnitProperty.AttackRange, 500 },
                { GSC.GameDataUnitProperty.Sight, 600 },
            },
            VitalProperties = [GSC.GameDataVital.Health],
            PrimitiveShape = new PrimitiveShapeConfig
            {
                Shape = PrimitiveShape.Cylinder,
                Scale = new Vector3(0.5f, 0.5f, 1.5f),
            },
        };

        _ = new GameDataUnit(TD.Creep)
        {
            CollisionRadius = 25f,
            AttackableRadius = 30f,
            UpdateFlags = new UpdateFlags
            {
                Walkable = true,
                Turnable = true,
                AllowMover = true,
            },
            Properties = new UnitPropertyInitialData
            {
                { GSC.GameDataUnitProperty.LifeMax, 100 },
                { GSC.GameDataUnitProperty.MoveSpeed, 150 },
                { GSC.GameDataUnitProperty.Armor, 2 },
            },
            VitalProperties = [GSC.GameDataVital.Health],
            PrimitiveShape = new PrimitiveShapeConfig
            {
                Shape = PrimitiveShape.Sphere,
                Scale = new Vector3(0.4f, 0.4f, 0.4f),
            },
        };

        // 不需要创建 GameDataGameMode —— 使用项目已有的 MapGameMode
    }
}
```

---

## 常见问题与陷阱

### 编译相关

| 问题 | 原因 | 解决 |
|:--|:--|:--|
| 3000+ 编译错误 | 未指定编译配置 | `dotnet build *.sln -c Server-Debug` 或 `-c Client-Debug` |
| 找不到 `GameDataUnitProperty` | 需要通过 GSC 别名访问 | 使用 `GSC.GameDataUnitProperty.LifeMax`（csproj 已配置全局别名） |
| `GameDataUnit` 歧义 | `gamesparkcore.ScopeData.GameDataUnit`（静态 Link 类）与框架类 `GameCore.EntitySystem.Data.GameDataUnit` 同名 | 通过 `GSC.GameDataUnit.xxx` 访问 Link，框架类型裸写 `GameDataUnit` |
| 找不到 `UpdateFlags` | 在 `GameCore.EntitySystem.Data.Struct` 中 | 新模板已添加全局 using；旧项目需手动添加 `using GameCore.EntitySystem.Data.Struct;` |
| `ComponentTagEx.Walkable` 不存在 | 历史 API 变更 | 用 `ComponentTag.Walkable` |

### 运行时相关

| 问题 | 原因 | 解决 |
|:--|:--|:--|
| **敌人站着不动** | **`TacticalAI` 未指向可用的战斗 AIThinkTree，或缺少 AI 所需的攻击能力，或单位创建后始终没挂上 AI** | **数据定义配 `TacticalAI`（默认或自定义）和所需 `Abilities`；创建时传 `useDefaultAI: true`，或后续手动 `AddDefaultAI/CreateAI`** |
| **使用默认 AI 时仍不攻击** | **目标单位 `Filter` 未包含 `UnitFilter.Unit`** | **英雄和敌人的 `GameDataUnit` 添加 `Filter = [UnitFilter.Unit]`（英雄可加 `UnitFilter.Hero`）** |
| **英雄无法攻击** | **未给英雄配置攻击技能** | **定义 `GameDataAbilityExecute`（`IsAttack = true`）并设 `Abilities = [attackLink]`** |
| **攻击打自己** | **技能未配 `AcquireSettings.TargetingFilters`** | **添加 `Required = [UnitRelationship.Enemy]`** |
| **单位没有血条** | **未配 `StatusBarSetting`** | **添加 `StatusBarSetting` + `OverrideByRelationShip`** |
| **血条有等级黑块** | **Hero 状态栏变体缺少 `Leveling`** | **添加 `Leveling = GSC.GameDataUnitLeveling.HeroLevelingSample`** |
| **攻击时报错 CannotTurn** | **`Turnable = true` 但 `TurningSpeed = 0`** | **Properties 中加 `TurningSpeed, 720`** |
| **玩家无法操控英雄** | **未设置 `MainUnit` 或缺少操控 UI** | **服务端 `player.MainUnit = hero` + 客户端 MoveControl** |
| **相机不跟随英雄** | **未设置 `MainUnit`** | **服务端 `player.MainUnit = hero`** |
| 单位不移动 | `UpdateFlags.Walkable` 未启用 | 设为 `true` |
| `unit.PathTo()` 编译错误 | PathTo 不是 Unit 的方法 | `Walkable.CreateInstance(unit).PathTo(target)` |
| 生命值始终为 0 | 未配置 `VitalProperties` | `VitalProperties = [GSC.GameDataVital.Health]` |
| 未配置 `LifeMax` | 最大 HP 为 0 | `Properties` 中添加 `GameDataUnitProperty.LifeMax` |
| 单位看不到 | 未配置外观 | 设置 `PrimitiveShape` 或 `Model` |
| 客户端收不到事件 | 未注册到全局 | 使用 `Game.Subscribe<T>(handler)` 或 `trigger.RegisterGlobal()` |
| DualEndEvent 单播 | 默认广播 | 用 `DualEndEvent.Publish(player, evt)` 指定接收者 |

### 架构相关

| 问题 | 原因 | 解决 |
|:--|:--|:--|
| 客户端创建单位报错 | Unit 创建仅服务端 | 包裹在 `#if SERVER` 中 |
| `Console.WriteLine` 无输出 | WASM 环境限制 | 用 `Game.Logger.LogInformation()` |
| `Task.Delay` 异常 | 无线程池 | 用 `Game.Delay()` |
| `Game.Time` 值不对 | 返回 `TimeSpan` 非数字 | 用 `Game.Time.TotalSeconds` 或 `Game.TotalElapsedTickInMilliseconds` |
| `IGameLink` 比较失败 | `==` 不正确 | 用 `.Equals()` 比较；`GameLink<T,V>` 可用 `==` |

### IGameClass 注册

```csharp
// OnRegisterGameClass 必须是 public static
public class MyGame : IGameClass
{
    public static void OnRegisterGameClass()    // ← 必须 public static
    {
        Game.OnGameTriggerInitialization += OnGameTriggerInitialization;
    }

    // 事件注册在 OnGameTriggerInitialization 中（不是 OnGameDataInitialization）
    private static void OnGameTriggerInitialization()
    {
        Game.Subscribe<EventGameStart>(async (s, d) => { ... });
    }

    // GameData 注册在 OnGameDataInitialization 中
    private static void OnGameDataInitialization()
    {
        _ = new GameDataUnit(...);
        _ = new GameDataGameMode(...);
    }
}
```

### 日志

```csharp
// 正确：参数化消息
Game.Logger.LogInformation("波次 {Wave} 开始，敌人数量: {Count}", wave, count);

// 错误：字符串插值
Game.Logger.LogInformation($"波次 {wave} 开始");  // ← 禁止

// 错误：Console
Console.WriteLine("test");  // ← 禁止
```
