# Claude Code 记忆系统 — AutoDream 记忆整合

> Claude 会"做梦"——在后台静默回顾近期会话，整合、更新、修剪记忆，就像人类睡眠中整理白天的记忆一样。

<p align="center">
<a href="#一什么是-autodream">AutoDream</a> · <a href="#二触发条件">触发条件</a> · <a href="#三四阶段整合流程">整合流程</a> · <a href="#四安全限制">安全限制</a> · <a href="#五ui-展示">UI 展示</a> · <a href="#六配置与开关">配置开关</a> · <a href="#七与-extractmemories-的关系">对比</a> · <a href="#八源码导航">源码导航</a>
</p>

![AutoDream 概览](./images/11-autodream-overview.png)

---

## 一、什么是 AutoDream？

AutoDream 是 Claude Code 的 **后台记忆整合机制**，内部代号 **"Dream: Memory Consolidation"**。

核心隐喻：

| 人类 | Claude Code |
|------|-------------|
| 白天随手记笔记 | `extractMemories` — 每次对话后提取新记忆 |
| 晚上睡觉时整理笔记本 | `autoDream` — 定期回顾多个会话，整合全部记忆 |

当你不活跃时（默认间隔 24 小时、积累 5 个会话后），Claude 会在后台静默启动一个 **"做梦"子智能体**（forked subagent），回顾所有近期会话记录，将零散的记忆整合为结构化的、去重的、去过时的持久化知识。

**关键源码**：`src/services/autoDream/autoDream.ts`

```typescript
// Background memory consolidation. Fires the /dream prompt as a forked
// subagent when time-gate passes AND enough sessions have accumulated.
```

---

## 二、触发条件

![AutoDream 触发流程](./images/12-autodream-trigger.png)

AutoDream 采用 **五重门控** 机制，按开销从低到高逐级检查：

### 门控链

| 序号 | 门控 | 说明 | 开销 |
|------|------|------|------|
| 1 | **功能开关** | `isAutoDreamEnabled()` + 非 KAIROS + 非远程模式 + autoMemory 已启用 | 内存读取 |
| 2 | **时间门控** | 距上次整合 >= `minHours`（默认 24h） | 1 次 stat |
| 3 | **扫描节流** | 上次扫描后至少等 10 分钟再重新扫描 | 时间戳比较 |
| 4 | **会话门控** | 自上次整合后至少 `minSessions` 个新会话（默认 5 个，排除当前） | 目录扫描 |
| 5 | **锁门控** | 没有其他进程正在做梦（PID 锁文件） | stat + read |

**关键源码** `src/services/autoDream/autoDream.ts:63-66`：

```typescript
const DEFAULTS: AutoDreamConfig = {
  minHours: 24,      // 距离上次整合至少 24 小时
  minSessions: 5,    // 期间至少积累了 5 个会话
}
```

### 扫描节流

当时间门控通过但会话门控未通过时，锁文件的 mtime 不会更新，导致时间门控在后续每个 turn 都会通过。为避免频繁的目录扫描，设有 **10 分钟的扫描节流**：

```typescript
const SESSION_SCAN_INTERVAL_MS = 10 * 60 * 1000
```

### 执行入口

AutoDream 在每次 AI 回复完成后的 stop hook 阶段被触发（fire-and-forget，不阻塞主线程）：

**关键源码** `src/query/stopHooks.ts:154-156`：

```typescript
if (!toolUseContext.agentId) {
  void executeAutoDream(stopHookContext, toolUseContext.appendSystemMessage)
}
```

### 阻止条件

以下情况不会触发 AutoDream：

- **KAIROS 模式**：使用独立的 disk-skill dream
- **远程模式**：`getIsRemoteMode() === true`
- **autoMemory 未启用**
- **`--bare` / SIMPLE 模式**
- **子代理内**：只有主代理才触发

---

## 三、四阶段整合流程

![AutoDream 四阶段流程](./images/13-autodream-phases.png)

一旦所有门控通过，AutoDream 启动一个 **分叉子智能体**，按照 `consolidationPrompt.ts` 定义的 4 阶段提示词工作：

### Phase 1 — Orient（定向）

```
- ls 记忆目录，查看已有文件
- 读取 MEMORY.md 索引，理解当前知识结构
- 浏览现有主题文件，避免创建重复
- 如存在 logs/ 或 sessions/ 子目录，检查最近条目
```

### Phase 2 — Gather recent signal（收集近期信号）

按优先级从高到低搜集信息：

1. **Daily logs** — `logs/YYYY/MM/YYYY-MM-DD.md`（追加流日志）
2. **漂移的记忆** — 与代码库现状矛盾的旧事实
3. **会话记录搜索** — 用 `grep` 在 JSONL 转录文件中窄范围检索

```
不要穷尽读取转录文件。只查找你已经怀疑重要的内容。
```

### Phase 3 — Consolidate（整合）

- **合并**新信号到已有主题文件（而非创建新的近似文件）
- **转换**相对日期为绝对日期（"昨天" → "2026-04-03"）
- **删除**被推翻的旧事实

### Phase 4 — Prune and index（修剪与索引）

- 更新 `MEMORY.md`，保持 ≤ 规定行数且 ≤ 25KB
- 删除指向过时记忆的指针
- 压缩冗长条目（>200 字符的索引行，将内容移入主题文件）
- 新增指向重要记忆的指针
- 解决矛盾（两个文件意见不一致时，修复错误的那个）

**关键源码** `src/services/autoDream/consolidationPrompt.ts:10-64`

---

## 四、安全限制

AutoDream 子智能体受到严格的工具权限限制：

### Bash 仅限只读

```
允许：ls, find, grep, cat, stat, wc, head, tail
拒绝：所有写入、重定向、修改状态的命令
```

### 文件操作仅限记忆目录

`createAutoMemCanUseTool()` 是 `extractMemories` 和 `autoDream` 共享的权限函数：

```
允许 Read / Grep / Glob — 无限制
允许 Edit / Write — 仅 auto-memory 目录内
拒绝 MCP / Agent / 非只读 Bash / 其他写操作
```

**关键源码** `src/services/extractMemories/extractMemories.ts:167-171`

### 锁文件机制

使用 `.consolidate-lock` 文件实现进程级互斥：

| 机制 | 说明 |
|------|------|
| **锁内容** | 持有者 PID |
| **时间戳** | 锁文件 mtime = 上次整合时间 |
| **过期** | 持有超过 1 小时视为过期（防 PID 复用） |
| **竞争** | 两个进程同时写入 → 最后写入者获胜，失败者在 re-read 时退出 |
| **回滚** | 失败时回退 mtime 到获取前的值，让下次尝试不受影响 |
| **崩溃恢复** | mtime 卡住 + 死 PID → 下个进程回收锁 |

**关键源码** `src/services/autoDream/consolidationLock.ts`

---

## 五、UI 展示

### 底部状态栏

当 AutoDream 运行时，底部状态栏会显示 **"dreaming"** 标签：

```typescript
// src/tasks/pillLabel.ts:61-62
case 'dream':
  return 'dreaming'
```

### 任务详情对话框

用户按 `Shift+Down` 可打开后台任务对话框，查看梦境的实时进度：

- **DreamDetailDialog** 组件展示：
  - 正在回顾的会话数量
  - 当前阶段：`starting`（正在分析）→ `updating`（正在修改记忆文件）
  - 最近的助手文本响应和工具调用次数
  - 已触碰的文件路径列表

- **用户可按 `x` 键终止**正在进行的梦境（触发 abort + 锁回滚）

### 完成通知

梦境完成后，如果有文件被修改，会在主会话中显示内联通知：

```typescript
appendSystemMessage({
  ...createMemorySavedMessage(dreamState.filesTouched),
  verb: 'Improved',
})
```

**关键源码**：
- `src/tasks/DreamTask/DreamTask.ts` — 任务状态管理
- `src/components/tasks/DreamDetailDialog.tsx` — UI 组件

---

## 六、配置与开关

### settings.json

```json
{
  "autoDreamEnabled": true
}
```

- **显式设置时**：直接使用用户的值
- **未设置时**：由远程 GrowthBook feature flag `tengu_onyx_plover` 控制

**关键源码** `src/services/autoDream/config.ts:13-21`：

```typescript
export function isAutoDreamEnabled(): boolean {
  const setting = getInitialSettings().autoDreamEnabled
  if (setting !== undefined) return setting
  const gb = getFeatureValue_CACHED_MAY_BE_STALE<{ enabled?: unknown } | null>(
    'tengu_onyx_plover', null,
  )
  return gb?.enabled === true
}
```

### 远程配置参数

`tengu_onyx_plover` feature flag 可配置：

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `enabled` | boolean | — | 功能总开关 |
| `minHours` | number | 24 | 最小间隔（小时） |
| `minSessions` | number | 5 | 最小会话数 |

### 手动触发 `/dream`

除了自动触发，用户可以通过 `/dream` 命令手动触发记忆整合。手动触发会调用 `recordConsolidation()` 更新锁文件时间戳。

---

## 七、与 extractMemories 的关系

| 维度 | extractMemories | autoDream |
|------|----------------|-----------|
| **触发频率** | 每次对话回合结束 | 每 24h + 5 个会话 |
| **触发位置** | `stopHooks.ts` L149 | `stopHooks.ts` L155 |
| **处理范围** | 当前对话最近的消息 | 多个会话的历史记录 |
| **目标** | 提取新记忆 | 整合/去重/修剪已有记忆 |
| **人类类比** | 白天随手记笔记 | 睡觉时整理笔记本 |
| **共享组件** | `createAutoMemCanUseTool` | `createAutoMemCanUseTool` |
| **分叉代理** | 最多 5 turns | 无 turn 限制 |
| **转录** | 不记录（`skipTranscript`） | 不记录（`skipTranscript`） |

### 协作流

```
每次对话结束
    ↓
extractMemories → 提取新记忆片段 → 写入 *.md + MEMORY.md
    ↓
（积累 24h + 5个会话后）
    ↓
autoDream → 回顾所有记忆 + 会话记录
    ↓
合并重复 / 修正过时 / 删除矛盾 / 压缩索引
    ↓
MEMORY.md 和主题文件焕然一新
```

---

## 八、源码导航

| 文件 | 职责 |
|------|------|
| `src/services/autoDream/autoDream.ts` | 主逻辑：门控检查、启动分叉代理、进度监控 |
| `src/services/autoDream/config.ts` | 开关控制：settings.json 或 GrowthBook |
| `src/services/autoDream/consolidationPrompt.ts` | 梦境提示词：4 阶段整合工作流 |
| `src/services/autoDream/consolidationLock.ts` | 锁文件机制：防并发、时间戳、回滚 |
| `src/tasks/DreamTask/DreamTask.ts` | UI 任务注册：状态管理、终止、回滚 |
| `src/tasks/pillLabel.ts` | 底部状态栏标签："dreaming" |
| `src/components/tasks/DreamDetailDialog.tsx` | 梦境详情对话框 UI |
| `src/query/stopHooks.ts` | 执行入口：每次回复后触发 |
| `src/utils/backgroundHousekeeping.ts` | 初始化入口：`initAutoDream()` |
| `src/services/extractMemories/extractMemories.ts` | 共享的 `createAutoMemCanUseTool` |

---

## 九、分析事件

AutoDream 通过以下事件记录运行状态：

| 事件 | 时机 | 附带数据 |
|------|------|----------|
| `tengu_auto_dream_fired` | 梦境启动 | `hours_since`, `sessions_since` |
| `tengu_auto_dream_completed` | 梦境完成 | `cache_read`, `cache_created`, `output`, `sessions_reviewed` |
| `tengu_auto_dream_failed` | 梦境失败 | — |
