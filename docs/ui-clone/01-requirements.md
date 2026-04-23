# Claude Code Desktop App — 产品需求文档 (PRD)

## 一、项目概述

### 1.1 目标

复刻 Claude Code Desktop App 的桌面端 GUI 核心功能。聚焦于 **AI 对话交互**、**会话管理**、**定时任务** 和 **Agent Teams 可视化** 四大模块。

### 1.2 复刻技术栈

- **前端框架**: React 18 + TypeScript
- **UI 渲染**: 标准浏览器 DOM（替换 Ink 终端渲染）
- **桌面容器**: Electron 或 Tauri
- **样式方案**: TailwindCSS v4
- **状态管理**: Zustand

### 1.3 核心原则

- **CLI/UI 数据互通**: UI 读写与 CLI 完全相同的 JSONL/JSON 文件
- **非侵入性**: 不修改原始 CLI 源代码
- **聚焦核心**: 只做对话 + 会话 + 定时任务 + Agent Teams，不做 Search/Dispatch/Customize

---

## 二、页面清单

| 编号 | 页面 | 描述 | 优先级 |
|------|------|------|--------|
| P1 | 顶部标题栏 | macOS 窗口控件 + Code 标签 | P0 |
| P2 | 左侧边栏 | New session + Scheduled + 项目选择 + 会话列表 | P0 |
| P3 | 底部状态栏 | 用户信息 + 仓库信息 | P1 |
| P4 | Code 空状态页 | 吉祥物 + 输入框 | P0 |
| P5 | Code 活跃会话页 | 消息列表 + 输入区 + 工具调用 + Agent Teams 面板 | P0 |
| P6 | 权限模式选择器 | Ask/Auto/Plan/Bypass 下拉菜单 | P0 |
| P7 | 模型选择器 | 模型列表 + Effort 等级 | P0 |
| P8 | Scheduled 定时任务页 | 任务列表 + 空状态 | P1 |
| P9 | 新建定时任务模态框 | 创建定时任务表单 | P1 |

**已移除**: Search 搜索页、Dispatch 分发页、Customize 设置页（设置直接在输入框控件里完成）

---

## 三、功能需求

### 3.1 顶部标题栏 (P1)

- R-001: macOS 红绿灯按钮（关闭/最小化/全屏）
- R-002: 前进/后退导航箭头
- R-003: `Code` 标签居中显示（Chat/Cowork 预留位但暂不实现）
- R-004: 标题栏可拖拽移动窗口

---

### 3.2 左侧边栏 (P2)

#### 导航菜单

- R-005: 显示 `+ New session` 和 `Scheduled` 两个导航项
- R-006: 点击导航项切换主内容区
- R-007: 当前选中项高亮

#### 项目选择器

- R-008: `All projects ▾` 下拉选择器
- R-009: 可选择特定项目过滤会话列表

#### 会话列表

- R-010: 按时间分组（Today / Previous 7 Days / Older）
- R-011: 每项显示会话标题（首条消息摘要 或 自定义标题）
- R-012: 选中会话高亮，左侧圆点指示
- R-013: 支持搜索过滤
- R-014: 右键菜单：重命名、删除
- R-015: 点击切换到对应会话

**数据模型**:
```typescript
type Session = {
  id: string              // UUID v4
  title: string           // 首条消息摘要 或 customTitle
  createdAt: Date
  modifiedAt: Date
  messageCount: number
  projectPath: string     // 项目目录（sanitized）
}
```

---

### 3.3 底部状态栏 (P3)

- R-016: 用户头像 + 用户名 + 订阅等级（如 `Max plan`）
- R-017: Git 仓库名 + 分支名
- R-018: worktree 复选框
- R-019: Local / Remote 模式切换

---

### 3.4 Code 空状态页 (P4)

- R-020: 居中显示 Clawd 吉祥物（像素风橙色小动物）
- R-021: 底部输入框，圆角，placeholder 文本
- R-022: `+` 按钮（添加附件/上下文）
- R-023: 权限模式选择器（左下）
- R-024: 模型选择器（右下）
- R-025: 麦克风图标（语音输入，右侧）

---

### 3.5 Code 活跃会话页 (P5) — 核心页面

#### 3.5.1 会话标题栏

- R-026: 会话标题可点击修改
- R-027: `▷ Preview ▾` 按钮（右上）

#### 3.5.2 消息列表

- R-028: 用户消息 — 右对齐暖色气泡
- R-029: AI 文本 — 左对齐，Markdown 富文本
- R-030: AI 思考 — 可折叠灰色块
- R-031: 工具调用 — 可折叠块，显示工具名 + 摘要
- R-032: 系统消息 — 居中灰色
- R-033: 折叠区段 — `▸ Initialized your session`，内含子工具列表
- R-034: 上下文压缩分界线
- R-035: "N new messages" 跳转提示

**消息类型**:
```typescript
type MessageType =
  | 'user_text'          | 'user_image'
  | 'assistant_text'     | 'assistant_thinking'  | 'assistant_tool_use'
  | 'user_tool_result'   | 'system_text'         | 'system_error'
  | 'grouped_tool_use'   | 'collapsed_section'   | 'compact_boundary'
```

#### 3.5.3 Agent Teams 可视化

**功能描述**: 当对话中创建 Agent Teams 时，UI 需要展示每个 Team 成员的实时工作状态，等同于 CLI 终端中用 Shift+Up/Down 切换查看各成员 transcript 的体验。

- R-036: 底部 Team 状态栏 — 显示活跃的 Team 名称 + 成员数量
- R-037: 成员标签列表 — 每个 teammate 显示为可点击的标签（名称 + 颜色标识 + 状态指示）
- R-038: 点击成员标签 → 切换到该成员的 transcript 视图
- R-039: 成员 transcript 视图 — 独立的消息列表，展示该 agent 的完整对话
- R-040: 成员状态指示 — `running`（闪烁点）/ `completed`（绿勾）/ `failed`（红叉）
- R-041: 返回 Leader 视图按钮
- R-042: 后台任务通知 — 当 teammate 完成时在 Leader 视图中显示 `<task-notification>` 消息

**数据模型**:
```typescript
type TeamContext = {
  teamName: string
  isLeader: boolean
  teammates: Record<string, {
    name: string
    agentType?: string
    status: 'running' | 'completed' | 'failed' | 'idle'
    color: AgentColor   // red | blue | green | yellow | purple | orange | pink | cyan
    messageCount: number
  }>
}

// 视图状态
expandedView: 'none' | 'tasks' | 'teammates'
viewingAgentTaskId?: string  // 当前正在查看的 teammate transcript
```

**交互流程**:
```
Leader 视图（默认）
  ├─ 对话中 AI 调用 TeamCreate → 底部出现 Team 状态栏
  ├─ Team 成员开始工作 → 各标签显示 running 状态
  ├─ 点击成员标签 → 切换到该成员的 transcript
  │   ├─ 显示该 agent 的独立消息流
  │   ├─ 实时更新（工具调用、文本输出）
  │   └─ 点击 "← Back to Leader" 返回
  ├─ 成员完成 → 标签变为 completed + Leader 收到 task-notification
  └─ 所有成员完成 → Leader 综合结果
```

**源码参考**:
- `src/state/AppStateStore.ts` — `expandedView`, `viewingAgentTaskId`, `teamContext`
- `src/components/TeammateViewHeader.tsx` — 切换队友视图头部
- `src/components/CoordinatorAgentStatus.tsx` — 协调者状态面板
- `src/components/tasks/BackgroundTaskStatus.tsx` — 后台任务状态
- `src/state/selectors.ts` — `getViewedTeammateTask()`, `getActiveAgentForInput()`

#### 3.5.4 工具调用展示

- R-043: 单个工具调用 — 可折叠块（工具名 + 参数 + 结果）
- R-044: Agent 子任务 — `Agent  描述` 格式，带 Agent 颜色标识
- R-045: Bash 命令 — 命令文本高亮 + 可展开输出
- R-046: 文件编辑 — Diff 结构化展示（绿色添加/红色删除）
- R-047: 分组工具调用 — 连续同类工具合并为一组

#### 3.5.5 实时状态

- R-048: `✦ Crafting...` 闪烁动画 + 动态动词
- R-049: 计时器 + token 计数
- R-050: 停止生成按钮

#### 3.5.6 底部输入区

- R-051: 多行文本输入，自动扩展
- R-052: `+` 添加附件
- R-053: 权限模式指示器
- R-054: 模型选择器
- R-055: 停止按钮（AI 运行中）

---

### 3.6 权限模式选择器 (P6)

- R-056: 4 个选项的下拉菜单
- R-057: 每项显示图标 + 名称 + 描述
- R-058: 选中项 ✓ 标记
- R-059: 切换即时生效

| 选项 | 图标 | 描述 |
|------|------|------|
| Ask permissions | ⚙ | Always ask before making changes |
| Auto accept edits | `</>` | Automatically accept all file edits |
| Plan mode | 📋 | Create a plan before making changes |
| Bypass permissions | ⚠ | Accepts all permissions |

---

### 3.7 模型选择器 (P7)

- R-060: 模型列表（上部）+ Effort 等级（下部，分隔线分割）
- R-061: 模型 — 名称 + 描述 + ✓ 选中
- R-062: Effort — Low / Medium / High / Max + ✓ 选中

| 模型 | 描述 |
|------|------|
| Opus 4.7 | Most capable for ambitious work |
| Opus 4.7 1M | Most capable for ambitious work |
| Sonnet 4.6 | Most efficient for everyday tasks |
| Haiku 4.5 | Fastest for quick answers |

---

### 3.8 Scheduled 定时任务页 (P8)

- R-063: 页面标题 `Scheduled tasks`
- R-064: 空状态：时钟图标 + `No scheduled tasks yet.`
- R-065: `+ New task` 按钮（右上）
- R-066: 任务列表：名称 + 描述 + 频率 + 下次执行
- R-067: 每项支持编辑、删除

---

### 3.9 新建定时任务模态框 (P9)

- R-068: Info 横幅: `Local tasks only run while your computer is awake.`
- R-069: Name（必填）+ Description（必填）
- R-070: Prompt 多行输入
- R-071: Permissions + Model 选择器
- R-072: Select folder + worktree 复选框
- R-073: Frequency 下拉 + Time 时间选择
- R-074: Cancel / Create task 按钮

---

## 四、交互组件

### 4.1 权限请求对话框

- R-075: Bash 命令 — 显示命令内容
- R-076: 文件编辑 — 显示 diff
- R-077: 文件写入 — 显示路径
- R-078: 操作按钮：允许 / 拒绝 / 总是允许 / 总是拒绝

### 4.2 Markdown 渲染

- R-079: 标题、列表、粗体/斜体
- R-080: 代码块语法高亮
- R-081: 表格
- R-082: 文件路径可点击

### 4.3 Diff 展示

- R-083: 添加行绿色 / 删除行红色
- R-084: 行号 + 文件路径头部
- R-085: Word-level diff 高亮

### 4.4 通知

- R-086: Toast 通知（成功/错误/警告）
- R-087: 自动消失 + 队列

### 4.5 通用对话框

- R-088: 标题 + 内容 + 按钮
- R-089: ESC 关闭

---

## 五、数据模型

### 5.1 全局状态 (AppState)

```typescript
type AppState = {
  // 模型
  mainLoopModel: string | null
  effort: 'low' | 'medium' | 'high' | 'max'
  permissionMode: PermissionMode

  // 视图
  expandedView: 'none' | 'tasks' | 'teammates'
  viewingAgentTaskId?: string

  // 任务
  tasks: Record<string, TaskState>
  foregroundedTaskId?: string

  // 团队
  teamContext?: TeamContext

  // 通知
  notifications: { current: Notification | null; queue: Notification[] }
}
```

### 5.2 消息模型

```typescript
type Message = {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: ContentBlock[]
  timestamp: number
  model?: string
}

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: ImageSource }
  | { type: 'tool_use'; id: string; name: string; input: any }
  | { type: 'tool_result'; tool_use_id: string; content: any }
  | { type: 'thinking'; thinking: string }
```

---

## 六、导航模型

状态驱动（非 URL 路由）:

```
侧边栏: + New session → Code 空状态
         Scheduled → 定时任务页
         会话列表项 → Code 活跃会话页
                      ↓
                      expandedView = 'teammates' → Agent Teams 面板
                      viewingAgentTaskId → 切换到某个 teammate 的 transcript
```

---

## 七、实施路线图

### Phase 1: 基础框架
1. 项目脚手架 + 主题系统
2. 设计系统组件（Dialog, Select, Button）
3. App Shell 布局（标题栏 + 侧边栏 + 状态栏）
4. 全局状态管理

### Phase 2: 核心对话
5. Code 空状态页
6. 输入区域（文本 + 选择器）
7. 消息列表（用户 + AI 文本）
8. 权限 / 模型选择器
9. 加载状态

### Phase 3: 高级渲染
10. Markdown + 代码高亮
11. 工具调用展示
12. Diff 展示
13. 权限请求对话框

### Phase 4: Agent Teams
14. Team 状态栏 + 成员标签
15. Teammate transcript 视图切换
16. 后台任务通知

### Phase 5: 定时任务
17. Scheduled 页面 + 新建模态框

---

## 八、关键源码索引

| 功能 | 路径 |
|------|------|
| 全局状态 | `src/state/AppStateStore.ts` |
| 主屏幕 | `src/screens/REPL.tsx` |
| 布局 | `src/components/FullscreenLayout.tsx` |
| 输入 | `src/components/PromptInput/PromptInput.tsx` |
| 消息 | `src/components/Message.tsx`, `src/components/messages/` |
| 权限类型 | `src/types/permissions.ts` |
| 模型选择 | `src/components/ModelPicker.tsx` |
| 主题 | `src/utils/theme.ts` |
| 定时任务 | `src/utils/cronTasks.ts` |
| Agent Teams | `src/components/TeammateViewHeader.tsx`, `src/components/CoordinatorAgentStatus.tsx` |
| 后台任务 | `src/components/tasks/BackgroundTaskStatus.tsx` |
| Diff | `src/components/StructuredDiff.tsx` |
| 会话管理 | `src/components/LogSelector.tsx` |
| 服务端 API | `src/server/` |
