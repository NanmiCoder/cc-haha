# 提案：项目列表改为显式注册制

> 状态：设计提案，仅讨论产品与数据模型，不包含实现代码。
> 相关 issue：NanmiCoder/cc-haha#1595、NanmiCoder/cc-haha#480、NanmiCoder/cc-haha#1566、NanmiCoder/cc-haha#1202、NanmiCoder/cc-haha#749

## 摘要

桌面端的“项目”目前是从会话历史推导出来的副产品。本提案建议把项目升级为一等记录：列表初始为空，用户显式添加项目目录；添加时可从 `~/.claude` 中勾选该目录下的历史会话、选择新建会话，并配置 Provider 与模型档位；确认后项目进入列表。

## 当前问题

- 项目由 `groupByProject(sessions)` 按 `projectRoot` 推导；“最近项目”接口需要扫描最多 5000 条会话（`src/server/api/sessions.ts`）。
- 删除项目下全部会话后，项目分组消失（#1595）。
- 从侧边栏移除项目后，再次在该目录开会话也不会自动恢复（#480）。
- 项目不能增删改查，默认项目（Administrator）来源不明（#1566、#749）。
- 新建项目只能选择已有文件夹（#1202）。

这些问题的共同原因是：项目没有独立身份，只能作为会话的聚合结果存在。

## 提案

### 核心模型

- 项目是主体，一个项目目录下可以有多个会话。
- “选择项目”在交互中就是**选择目录**。
- 项目会话 = 添加时勾选的历史会话 + 之后在该目录新建的会话。
- 未勾选的历史会话不删除、不显示在项目下，之后可通过「导入历史会话」补入。

### 添加项目流程

1. 选择目录（原生目录选择器）。
2. 服务端按目录在 `~/.claude` 中查找历史会话：
   - 0 个：直接新建会话；
   - 1 个：默认勾选；
   - 多个：勾选列表（支持全选），可同时选择新建会话。
3. 配置环境：渠道/Provider 与 Anthropic 模型档位（main / opus / sonnet / haiku）。
4. 确认后写入项目记录，项目出现在列表，并打开所选或新建的会话。

### 管理

- 改名、置顶、拖拽排序、编辑环境配置。
- 移除项目只撤销登记，不删除会话文件；重新添加同一目录即可恢复。
- 0 会话项目保留，显示「新建会话」入口。
- 可选：每个项目单独开窗口。

### 选择与载入

- 新建会话默认项目：当前项目 → 最近使用 → 手动选择目录。
- 项目选择器只列已登记项目，搜索只做过滤。
- 侧边栏读取项目注册表；每个项目的会话沿用现有分页加载。
- 首次升级时询问是否导入历史目录（勾选列表），不导入则保持空列表。

## 数据模型（草案）

```ts
type ProjectRecord = {
  key: string                    // 规范化真实路径
  displayName: string
  root: string
  additionalDirectories: string[]
  sessionIds: string[]           // 添加时勾选的历史会话
  environment: {
    providerId?: string
    modelTiers: {
      main: string
      fable?: string
      haiku?: string
      sonnet?: string
      opus?: string
    }
  }
  order: number
  pinned: boolean
  createdAt: string
  lastUsedAt: string
  source: 'manual' | 'import'
}
```

存储建议扩展现有 `desktopUiPreferences`，复用其中的 `projectDisplayNames`、`projectAdditionalDirectories`、`projectOrder`、`pinnedProjects` 并做一次迁移。

## 兼容与迁移

- `desktopUiPreferences.schemaVersion` 7 → 8，提供向前迁移与旧 fixture。
- `hiddenProjects` 字段废弃，迁移为“移除”语义。
- 会话存储格式（jsonl）与 `~/.claude.json` 的 `ProjectConfig` 不变。
- 新旧客户端兼容：新增字段保持可选。

## 分期建议

- **M1**：项目注册表 + 空状态 + 添加目录 + 列表过滤 + 移除/改名/置顶 + schema 迁移。
- **M2**：添加时勾选 `~/.claude` 会话 + 环境配置（Provider + 模型档位）。
- **M3**：MCP、手机新建/定时任务、IM `/projects`、任务视图、全局搜索切到注册表；每项目独立窗口。

推荐 M1/M2 先以“注册表作为侧边栏过滤器”的方式实现，保留现有会话推导，降低对会话主链路的改动风险。

## 影响面（概要）

- 直接改动：`Sidebar.tsx`、`desktopUiPreferencesService.ts`、`projectDisplayNameStore.ts`、`sessionStore.ts`、`ProjectSessionList.tsx`、`ProjectEditorModal.tsx`、`RepositoryLaunchControls.tsx`。
- 行为受影响：MCP 项目聚合/共享、手机新建/定时任务、IM `/projects`、任务视图、全局搜索、归档视图。
- 不受影响：会话内容与存储、终端、文件树、Diff、内置浏览器、Computer Use、Provider/MCP 配置结构。

## 待讨论

1. 环境配置是选择一个已有渠道 profile，还是内联填写 Base URL / Key / 模型档位？
2. 模型档位是否暴露仓库现有的 `fable` 槽位？
3. 未登记目录的会话是否仍应出现在全局搜索/任务视图/MCP/IM？
4. 历史导入的默认勾选范围与“每项目独立窗口”的优先级。

## 参考

- NanmiCoder/cc-haha#1595 删除全部会话后保留项目
- NanmiCoder/cc-haha#480 移除项目后不自动恢复
- NanmiCoder/cc-haha#1566 项目概念与增删改查
- NanmiCoder/cc-haha#1202 新建项目只能选择已有文件夹
- NanmiCoder/cc-haha#749 新建会话默认项目路径
