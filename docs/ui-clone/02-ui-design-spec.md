# Claude Code Desktop App — UI 设计规范

> 本文档面向设计图生成，包含完整的配色方案、布局尺寸、组件规格和页面交互逻辑。
> 可直接用于 AI 设计工具或设计师参考。

---

## 一、设计风格概述

### 1.1 整体风格

- **设计语言**: 现代简约，暖色调，类 Notion/Linear 风格
- **背景色**: 白色/米白色为主，非纯白（偏暖）
- **圆角**: 大圆角风格（8-12px），卡片和输入框更大（12-16px）
- **阴影**: 微妙的阴影，仅用于浮层和下拉菜单
- **字体**: 系统字体栈（-apple-system, SF Pro, Segoe UI, Inter）
- **图标风格**: 线条图标，1.5px 线宽，圆角端点
- **品牌色**: 橙色 `rgb(215,119,87)` — Claude 品牌橙

### 1.2 吉祥物 (Clawd)

- 像素风格小动物（类似小螃蟹/外星生物）
- 主体颜色: `rgb(215,119,87)` (Claude 橙)
- 8bit 像素风格，大约 64x64px 像素尺寸
- 两个黑色方形眼睛
- 四条短腿
- 背景: 透明或 `rgb(0,0,0)` (clawd_background)

---

## 二、配色方案

### 2.1 Light 主题（默认主题，截图使用的主题）

#### 品牌与核心色

| Token | 色值 | 用途 |
|-------|------|------|
| `claude` | `rgb(215,119,87)` | 品牌橙，主色调，吉祥物颜色 |
| `claudeShimmer` | `rgb(245,149,117)` | 品牌橙浅色，闪烁动画 |
| `permission` | `rgb(87,105,247)` | 权限蓝，权限模式标识 |
| `permissionShimmer` | `rgb(137,155,255)` | 权限蓝浅色 |
| `autoAccept` | `rgb(135,0,255)` | 自动接受紫，Auto 模式标识 |
| `planMode` | `rgb(0,102,102)` | 计划模式青，Plan 模式标识 |
| `fastMode` | `rgb(255,106,0)` | 快速模式橙 |

#### 文本色

| Token | 色值 | 用途 |
|-------|------|------|
| `text` | `rgb(0,0,0)` | 主文本（黑色） |
| `inverseText` | `rgb(255,255,255)` | 反色文本（白色） |
| `inactive` | `rgb(102,102,102)` | 不活跃文本（深灰） |
| `subtle` | `rgb(175,175,175)` | 次要文本（浅灰） |
| `suggestion` | `rgb(87,105,247)` | 建议文本（蓝紫） |

#### 语义色

| Token | 色值 | 用途 |
|-------|------|------|
| `success` | `rgb(44,122,57)` | 成功（绿色） |
| `error` | `rgb(171,43,63)` | 错误（红色） |
| `warning` | `rgb(150,108,30)` | 警告（琥珀色） |
| `merged` | `rgb(135,0,255)` | 已合并（紫色） |

#### Diff 色

| Token | 色值 | 用途 |
|-------|------|------|
| `diffAdded` | `rgb(105,219,124)` | 添加行背景（浅绿） |
| `diffRemoved` | `rgb(255,168,180)` | 删除行背景（浅红） |
| `diffAddedDimmed` | `rgb(199,225,203)` | 添加行弱化（极浅绿） |
| `diffRemovedDimmed` | `rgb(253,210,216)` | 删除行弱化（极浅红） |
| `diffAddedWord` | `rgb(47,157,68)` | 添加的单词（中绿） |
| `diffRemovedWord` | `rgb(209,69,75)` | 删除的单词（中红） |

#### 背景色

| Token | 色值 | 用途 |
|-------|------|------|
| `userMessageBackground` | `rgb(240,240,240)` | 用户消息气泡背景 |
| `userMessageBackgroundHover` | `rgb(252,252,252)` | 用户消息悬停 |
| `messageActionsBackground` | `rgb(232,236,244)` | 消息操作栏背景 |
| `bashMessageBackgroundColor` | `rgb(250,245,250)` | Bash 命令背景 |
| `memoryBackgroundColor` | `rgb(230,245,250)` | 记忆块背景 |
| `selectionBg` | `rgb(180,213,255)` | 文本选中背景 |

#### 边框色

| Token | 色值 | 用途 |
|-------|------|------|
| `promptBorder` | `rgb(153,153,153)` | 输入框边框 |
| `promptBorderShimmer` | `rgb(183,183,183)` | 输入框边框闪烁 |
| `bashBorder` | `rgb(255,0,135)` | Bash 块边框（粉色） |

#### Agent 专用色

| Token | 色值 |
|-------|------|
| `red` | `rgb(220,38,38)` |
| `blue` | `rgb(37,99,235)` |
| `green` | `rgb(22,163,74)` |
| `yellow` | `rgb(202,138,4)` |
| `purple` | `rgb(147,51,234)` |
| `orange` | `rgb(234,88,12)` |
| `pink` | `rgb(219,39,119)` |
| `cyan` | `rgb(8,145,178)` |

#### 其他

| Token | 色值 | 用途 |
|-------|------|------|
| `rate_limit_fill` | `rgb(87,105,247)` | 速率限制进度条填充 |
| `rate_limit_empty` | `rgb(39,47,111)` | 速率限制进度条空白 |
| `briefLabelYou` | `rgb(37,99,235)` | 用户标签蓝 |
| `briefLabelClaude` | `rgb(215,119,87)` | Claude 标签橙 |

---

### 2.2 Dark 主题

#### 品牌与核心色

| Token | 色值 | 用途 |
|-------|------|------|
| `claude` | `rgb(215,119,87)` | 品牌橙（同 Light） |
| `claudeShimmer` | `rgb(235,159,127)` | 品牌橙浅色 |
| `permission` | `rgb(177,185,249)` | 权限蓝紫 |
| `autoAccept` | `rgb(175,135,255)` | 自动接受紫 |
| `planMode` | `rgb(72,150,140)` | 计划模式青绿 |
| `fastMode` | `rgb(255,120,20)` | 快速模式橙 |

#### 文本色

| Token | 色值 |
|-------|------|
| `text` | `rgb(255,255,255)` |
| `inverseText` | `rgb(0,0,0)` |
| `inactive` | `rgb(153,153,153)` |
| `subtle` | `rgb(80,80,80)` |
| `suggestion` | `rgb(177,185,249)` |

#### 语义色

| Token | 色值 |
|-------|------|
| `success` | `rgb(78,186,101)` |
| `error` | `rgb(255,107,128)` |
| `warning` | `rgb(255,193,7)` |

#### 背景色

| Token | 色值 |
|-------|------|
| `userMessageBackground` | `rgb(55,55,55)` |
| `userMessageBackgroundHover` | `rgb(70,70,70)` |
| `messageActionsBackground` | `rgb(44,50,62)` |
| `bashMessageBackgroundColor` | `rgb(65,60,65)` |
| `memoryBackgroundColor` | `rgb(55,65,70)` |
| `selectionBg` | `rgb(38,79,120)` |

#### Diff 色

| Token | 色值 |
|-------|------|
| `diffAdded` | `rgb(34,92,43)` |
| `diffRemoved` | `rgb(122,41,54)` |
| `diffAddedWord` | `rgb(56,166,96)` |
| `diffRemovedWord` | `rgb(179,89,107)` |

---

### 2.3 应用 UI 表面色（从截图提取）

截图中使用的 Light 主题 UI 表面色:

| 区域 | 颜色 | 说明 |
|------|------|------|
| 应用背景 | `#FFFFFF` | 纯白 |
| 侧边栏背景 | `#FAF9F7` | 暖白/米白 |
| 侧边栏选中项 | `#F0EDE8` | 暖灰 |
| 导航项悬停 | `#F5F3EF` | 极浅暖灰 |
| 主内容区背景 | `#FFFFFF` | 纯白 |
| 输入框背景 | `#FFFFFF` | 纯白 |
| 输入框边框 | `#E5E3DE` | 浅灰 |
| 输入框圆角 | `16px` | 大圆角 |
| 分隔线 | `#E5E3DE` | 浅灰 |
| 状态栏背景 | `#FAF9F7` | 暖白 |
| 按钮背景(主要) | `#3D3D3D` | 深灰/黑色 |
| 按钮文字(主要) | `#FFFFFF` | 白色 |
| 按钮背景(次要) | `#FFFFFF` | 白色 |
| 按钮边框(次要) | `#E5E3DE` | 浅灰 |
| 下拉菜单背景 | `#FFFFFF` | 白色 |
| 下拉菜单阴影 | `0 4px 12px rgba(0,0,0,0.1)` | 微妙阴影 |
| 用户消息气泡 | `#F5F0E8` | 暖米色 |
| Info 横幅背景 | `#F5F3EF` | 浅暖灰 |

---

## 三、排版规范

### 3.1 字体栈

```css
--font-family-sans: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Inter, Roboto, "Helvetica Neue", Arial, sans-serif;
--font-family-mono: "SF Mono", "JetBrains Mono", "Fira Code", Menlo, Monaco, "Courier New", monospace;
```

### 3.2 字号层级

| 层级 | 字号 | 行高 | 字重 | 用途 |
|------|------|------|------|------|
| H1 | 24px | 32px | 700 (Bold) | 页面标题（如 "Scheduled tasks"） |
| H2 | 18px | 24px | 600 (SemiBold) | 区段标题 |
| H3 | 16px | 22px | 600 | 对话框标题、组件标题 |
| Body | 14px | 20px | 400 (Regular) | 正文文本 |
| Small | 13px | 18px | 400 | 次要文本、时间戳 |
| Caption | 12px | 16px | 400 | 标签、描述、提示文本 |
| Tiny | 11px | 14px | 500 (Medium) | Badge、状态标签 |
| Code | 13px | 18px | 400 | 代码块内文本 |

### 3.3 文本颜色层级

| 层级 | Light 色值 | Dark 色值 | 用途 |
|------|-----------|----------|------|
| Primary | `#000000` | `#FFFFFF` | 标题、正文 |
| Secondary | `#666666` | `#999999` | 次要信息 |
| Tertiary | `#AFAFAF` | `#505050` | 占位符、禁用 |
| Accent | `rgb(87,105,247)` | `rgb(177,185,249)` | 链接、强调 |
| Brand | `rgb(215,119,87)` | `rgb(215,119,87)` | 品牌元素 |

---

## 四、布局规格

### 4.1 整体布局

```
┌───────────────────────────────────────────────────────────┐
│                    Title Bar (40px)                        │
├─────────────┬─────────────────────────────────────────────┤
│             │                                             │
│  Sidebar    │         Main Content Area                   │
│  (280px)    │         (flex: 1)                           │
│             │                                             │
│             │                                             │
│             │                                             │
│             │                                             │
│             │                                             │
│             │                                             │
├─────────────┴─────────────────────────────────────────────┤
│                  Status Bar (36px)                         │
└───────────────────────────────────────────────────────────┘
```

| 区域 | 尺寸 | 说明 |
|------|------|------|
| Title Bar | 高 40px | 固定，不可滚动 |
| Sidebar | 宽 280px | 固定宽度，可调整（最小 240px，最大 400px） |
| Main Content | flex: 1 | 自适应填充剩余空间 |
| Status Bar | 高 36px | 固定，常驻底部 |
| 最小窗口尺寸 | 900 x 600px | |
| 推荐窗口尺寸 | 1280 x 800px | |

### 4.2 间距系统

| Token | 值 | 用途 |
|-------|-----|------|
| `space-1` | 4px | 最小间距 |
| `space-2` | 8px | 紧凑间距 |
| `space-3` | 12px | 标准间距 |
| `space-4` | 16px | 舒适间距 |
| `space-5` | 20px | 区块间距 |
| `space-6` | 24px | 大区块间距 |
| `space-8` | 32px | 区段间距 |
| `space-10` | 40px | 页面边距 |

### 4.3 圆角规范

| 元素 | 圆角 |
|------|------|
| 按钮 | 8px |
| 输入框 | 12px |
| 对话输入框 | 16px |
| 卡片/面板 | 12px |
| 下拉菜单 | 12px |
| 模态框 | 16px |
| Avatar | 50% (圆形) |
| Badge | 4px |
| Tooltip | 8px |

---

## 五、组件设计规格

### 5.1 Title Bar（标题栏）

```
┌─────────────────────────────────────────────────────┐
│ ● ● ●   ← →   │     Chat    Cowork   [Code]  │    │
└─────────────────────────────────────────────────────┘
```

| 元素 | 规格 |
|------|------|
| 高度 | 40px |
| 背景 | 白色 `#FFFFFF` |
| 底部分隔线 | 1px solid `#E5E3DE` |
| 红绿灯按钮 | 左偏移 12px，垂直居中 |
| 红绿灯尺寸 | 12px 圆形，间距 8px |
| 导航箭头 | 尺寸 20px，灰色 `#666666`，hover 变深 |
| 标签页 | 居中对齐 |
| 标签页字号 | 14px, 字重 500 |
| 活跃标签 | 背景 `#F0EDE8`，圆角 8px，padding 6px 12px |
| 非活跃标签 | 无背景，色 `#666666` |
| 标签间距 | 4px |

---

### 5.2 Sidebar（侧边栏）

```
┌──────────────┐
│ + New session │ ← 导航项
│ ⏰ Scheduled  │
│              │
│ All projects ▾│ ← 项目过滤
│ ─────────────│
│ Today        │ ← 时间分组标题
│  ○ Session 1 │ ← 会话项
│  ● Session 2 │ ← 选中项
│              │
│ Previous 7d  │
│  ○ Session 3 │
└──────────────┘
```

| 元素 | 规格 |
|------|------|
| 宽度 | 280px |
| 背景 | `#FAF9F7` (暖白) |
| 右侧分隔线 | 1px solid `#E5E3DE` |
| 内边距 | 上下 12px，左右 12px |
| 导航项高度 | 36px |
| 导航项 padding | 8px 12px |
| 导航项字号 | 14px |
| 导航项图标 | 18px，与文字间距 10px |
| 导航项悬停 | 背景 `#F5F3EF`，圆角 8px |
| 导航项选中 | 背景 `#F0EDE8`，字重 500 |
| 项目过滤器高度 | 32px |
| 分组标题 | 12px, 字重 600, 色 `#999999`, uppercase |
| 分组标题上边距 | 16px |
| 会话项高度 | 36px |
| 会话项 padding | 8px 12px 8px 20px |
| 选中指示器 | 左侧 4px 宽圆形点，色 `#000000` |
| 选中背景 | `#F0EDE8` |

---

### 5.3 Status Bar（状态栏）

```
┌──────────────────────────────────────────────────────────────┐
│ [N] nanmi  │  ⬇ ⇅  │  🐙 Repo/name  🔀 main  □worktree  Local▾ │
│ Max plan   │       │                                          │
└──────────────────────────────────────────────────────────────┘
```

| 元素 | 规格 |
|------|------|
| 高度 | 36px |
| 背景 | `#FAF9F7` |
| 顶部分隔线 | 1px solid `#E5E3DE` |
| 内边距 | 0 12px |
| 用户 Avatar | 28px 圆形 |
| 用户名字号 | 13px, 字重 500 |
| 订阅标签 | 11px, 色 `#999999` |
| 仓库名 | 13px, 带 GitHub 图标 |
| 分支名 | 13px, 带分支图标 |
| Worktree 复选框 | 14px |
| Local/Remote | 13px 下拉，带 ▾ |
| 分隔符 | 1px solid `#E5E3DE`，垂直 |

---

### 5.4 对话输入框

```
┌─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─┐
│                                                      │
│  🐙 (Clawd 吉祥物)                                   │
│                                                      │
│  ┌────────────────────────────────────────────────┐  │
│  │ Find a small todo in the codebase and do it    │  │
│  │                                                │  │
│  │ ┌─────────────────┐           ┌──────────────┐│  │
│  │ │+ ⚙ Ask perms ▾  │           │Opus 4.7 1M ▾ 🎤││
│  │ └─────────────────┘           └──────────────┘│  │
│  └────────────────────────────────────────────────┘  │
└─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─┘
```

| 元素 | 规格 |
|------|------|
| 输入框外边距 | 水平 auto（居中），最大宽度 720px |
| 输入框圆角 | 16px |
| 输入框边框 | 1px solid `#E5E3DE` |
| 输入框 focus 边框 | 1px solid `#999999` |
| 输入框 padding | 16px 16px 48px 16px |
| placeholder 色 | `#AFAFAF` |
| placeholder 字号 | 14px |
| 底部工具栏高度 | 36px |
| 底部工具栏 padding | 0 8px |
| `+` 按钮 | 24px, 圆角 6px, hover 背景 `#F5F3EF` |
| 权限选择器 | 字号 13px, 左对齐 |
| 权限图标 | 16px |
| 模型选择器 | 字号 13px, 右对齐 |
| 麦克风图标 | 20px, 最右侧 |

---

### 5.5 权限模式下拉菜单

```
┌──────────────────────────────────────┐
│ ⚙ Ask permissions               ✓   │
│   Always ask before making changes   │
│──────────────────────────────────────│
│ </> Auto accept edits                │
│   Automatically accept all file edits│
│──────────────────────────────────────│
│ 📋 Plan mode                         │
│   Create a plan before making changes│
│──────────────────────────────────────│
│ ⚠ Bypass permissions                │
│   Accepts all permissions            │
└──────────────────────────────────────┘
```

| 元素 | 规格 |
|------|------|
| 宽度 | 320px |
| 背景 | `#FFFFFF` |
| 圆角 | 12px |
| 阴影 | `0 4px 16px rgba(0,0,0,0.12)` |
| 边框 | 1px solid `#E5E3DE` |
| 选项高度 | 56px |
| 选项 padding | 12px 16px |
| 选项标题 | 14px, 字重 500, 色 `#000000` |
| 选项描述 | 12px, 色 `#999999` |
| 选项图标 | 18px, 左侧 |
| ✓ 标记 | 右侧, 色 `#000000` |
| 选项间分隔线 | 1px solid `#F0EDE8` |
| 选项 hover | 背景 `#F5F3EF` |

---

### 5.6 模型选择器下拉菜单

```
┌──────────────────────────────────┐
│ Opus 4.7                         │
│  Most capable for ambitious work │
│──────────────────────────────────│
│ Opus 4.7 1M                  ✓   │
│  Most capable for ambitious work │
│──────────────────────────────────│
│ Sonnet 4.6                       │
│  Most efficient for everyday...  │
│──────────────────────────────────│
│ Haiku 4.5                        │
│  Fastest for quick answers       │
│══════════════════════════════════│
│ Effort                           │
│──────────────────────────────────│
│ Low                              │
│ Medium                       ✓   │
│ High                             │
│ Max                              │
└──────────────────────────────────┘
```

| 元素 | 规格 |
|------|------|
| 宽度 | 300px |
| 背景 | `#FFFFFF` |
| 圆角 | 12px |
| 阴影 | `0 4px 16px rgba(0,0,0,0.12)` |
| 模型项高度 | 52px |
| 模型名字号 | 14px, 字重 500 |
| 模型描述字号 | 12px, 色 `#999999` |
| 分隔线(模型/Effort) | 1px solid `#E5E3DE` |
| "Effort" 标签 | 12px, 字重 600, 色 `#999999` |
| Effort 项高度 | 36px |
| Effort 字号 | 14px |
| ✓ 标记 | 右侧, 色 `#000000` |

---

### 5.7 消息气泡

#### 用户消息

```
                              ┌──────────────────────┐
                              │ 分析下这个项目        │
                              └──────────────────────┘
```

| 属性 | 规格 |
|------|------|
| 对齐 | 右对齐 |
| 背景 | `#F5F0E8` (暖米色) |
| 圆角 | 16px（左上 16px，右上 4px，右下 16px，左下 16px） |
| 最大宽度 | 70% 容器宽度 |
| 字号 | 14px |
| 字色 | `#000000` |
| padding | 10px 14px |
| margin-bottom | 12px |

#### AI 回复消息

| 属性 | 规格 |
|------|------|
| 对齐 | 左对齐 |
| 背景 | 无（透明） |
| 最大宽度 | 100% |
| 字号 | 14px |
| 字色 | `#000000` |
| padding | 0 16px |
| margin-bottom | 16px |
| Markdown | 使用标准 Markdown 渲染 |

---

### 5.8 折叠区段

```
┌──────────────────────────────────────────────────┐
│ ▸ Initialized your session                       │
│     Ran a hook on session startup                │
│     { "hookSpecificOutput": { ...               │
│                                                  │
│ ▸ 探索配置和基础设施                                │
│ │   Agent  探索项目整体结构                        │
│ │   Bash · 3 tool calls                          │
│ │   Agent  探索核心业务代码                        │
│ │   Bash · 2 tool calls                          │
│ │   Agent  探索配置和基础设施                      │
└──────────────────────────────────────────────────┘
```

| 元素 | 规格 |
|------|------|
| 折叠标题 | 14px, 字重 500 |
| 折叠图标 | ▸ (收起) / ▾ (展开), 12px |
| 左侧竖线 | 2px 宽, 色 `#E5E3DE` |
| 子项缩进 | 24px |
| `Agent` 标签 | 12px, 字重 500, 背景 `#F0EDE8`, 圆角 4px, padding 2px 6px |
| `Bash · N tool calls` 标签 | 12px, 色 `#666666` |
| 子项间距 | 4px |
| 区段间距 | 8px |

---

### 5.9 加载状态

```
  ✦ Crafting...                    13s · ↓ 531 tokens
```

| 元素 | 规格 |
|------|------|
| ✦ 图标 | 16px, 色 `rgb(215,119,87)`, 闪烁动画 |
| 状态文本 | 14px, 色 `rgb(215,119,87)`, 字重 500 |
| 计时器 | 13px, 色 `#999999` |
| Token 计数 | 13px, 色 `#999999` |
| 闪烁周期 | 1.5s ease-in-out |

---

### 5.10 Agent Teams 面板

当对话中创建 Agent Teams 时，消息列表下方出现 Team 状态栏和成员标签。

```
┌──────────────────────────────────────────────────────────┐
│ [消息列表...]                                            │
│                                                          │
│ ▸ Team: ui-backend-dev (3 members)                      │
│ ┌──────────────────────────────────────────────────────┐ │
│ │ ● session-dev    ● config-dev     ○ features-dev     │ │
│ │   running          completed        running          │ │
│ └──────────────────────────────────────────────────────┘ │
│                                                          │
│ ─────── Viewing: session-dev transcript ──────────      │
│                                                          │
│  [该成员的独立消息流]                                      │
│  > 正在读取 sessionStorage.ts...                          │
│  Agent  探索会话存储                                      │
│  Bash · 2 tool calls                                     │
│                                                          │
│  [← Back to Leader]                                      │
└──────────────────────────────────────────────────────────┘
```

| 元素 | 规格 |
|------|------|
| Team 状态栏高度 | 32px |
| Team 状态栏背景 | `#F5F3EF` |
| Team 名称 | 13px, 字重 600 |
| 成员数量 | 13px, 色 `#999999` |
| 成员标签容器 | flex row, gap 8px, padding 8px 12px |
| 成员标签 | 圆角 6px, padding 4px 10px, 字号 12px, 字重 500 |
| 成员标签背景(默认) | `#F0EDE8` |
| 成员标签背景(选中) | Agent 专用色（半透明 15%） |
| 成员标签边框(选中) | 2px solid Agent 专用色 |
| 状态指示器 | 左侧 6px 圆点 |
| Running 指示器 | 色 `rgb(202,138,4)` (黄), 闪烁动画 |
| Completed 指示器 | 色 `rgb(44,122,57)` (绿), 实心 |
| Failed 指示器 | 色 `rgb(171,43,63)` (红), 实心 |
| Idle 指示器 | 色 `#CCCCCC` (灰), 空心 |
| 分隔线("Viewing...") | 1px solid `#E5E3DE`, 上下 8px margin |
| "Viewing" 标签 | 12px, 色 `#999999`, 居中 |
| Back 按钮 | 13px, 色 `rgb(87,105,247)`, 左对齐, cursor pointer |
| Teammate transcript | 与主消息列表相同的渲染规则 |

**Agent 颜色分配** (来自 `src/utils/theme.ts`):

| 颜色名 | Light 色值 | 用于标签边框和背景色 |
|--------|-----------|---------------------|
| red | `rgb(220,38,38)` | 第 1 个 agent |
| blue | `rgb(37,99,235)` | 第 2 个 agent |
| green | `rgb(22,163,74)` | 第 3 个 agent |
| yellow | `rgb(202,138,4)` | 第 4 个 agent |
| purple | `rgb(147,51,234)` | 第 5 个 agent |
| orange | `rgb(234,88,12)` | 第 6 个 agent |
| pink | `rgb(219,39,119)` | 第 7 个 agent |
| cyan | `rgb(8,145,178)` | 第 8 个 agent |

---

### 5.11 Scheduled 页面

```
┌──────────────────────────────────────────┐
│  Scheduled tasks              [+ New task]│
│                                          │
│  Run tasks on a schedule or whenever     │
│  you need them. Type /schedule in any    │
│  existing session to set one up.         │
│                                          │
│              ┌─────┐                     │
│              │ ⏰  │                     │
│              └─────┘                     │
│         No scheduled tasks yet.          │
└──────────────────────────────────────────┘
```

| 元素 | 规格 |
|------|------|
| 页面 padding | 32px 40px |
| 标题字号 | 24px, 字重 700 |
| 描述字号 | 14px, 色 `#666666` |
| 空状态图标 | 48px, 居中 |
| 空状态文本 | 14px, 色 `#999999`, 居中 |
| `+ New task` 按钮 | 背景 `#3D3D3D`, 色 `#FFFFFF`, 圆角 8px, padding 8px 16px |

---

### 5.12 New Scheduled Task 模态框

```
┌──────────────────────────────────────────────┐
│  New scheduled task                          │
│                                              │
│  ┌──────────────────────────────────────┐    │
│  │ ℹ Local tasks only run while your    │    │
│  │   computer is awake.                 │    │
│  └──────────────────────────────────────┘    │
│                                              │
│  Name *                                      │
│  ┌──────────────────────────────────────┐    │
│  │ daily-code-review                    │    │
│  └──────────────────────────────────────┘    │
│                                              │
│  Description *                               │
│  ┌──────────────────────────────────────┐    │
│  │ Review yesterday's commits...        │    │
│  └──────────────────────────────────────┘    │
│                                              │
│  ┌──────────────────────────────────────┐    │
│  │ Look at the commits from the last    │    │
│  │ 24 hours. Summarize what changed,    │    │
│  │ call out any risky patterns...       │    │
│  │                                      │    │
│  │ ⚙ Ask permissions ▾   Opus 4.7 1M ▾ │    │
│  │ [📁 Select folder]        □worktree  │    │
│  └──────────────────────────────────────┘    │
│                                              │
│  Frequency                                   │
│  ┌──────────────────────────────────────┐    │
│  │ Daily                            ▾   │    │
│  └──────────────────────────────────────┘    │
│  ┌─────────┐                                 │
│  │  09:00  │                                 │
│  └─────────┘                                 │
│  Scheduled tasks use a randomized delay...   │
│                                              │
│           [Cancel]  [Create task]             │
└──────────────────────────────────────────────┘
```

| 元素 | 规格 |
|------|------|
| 模态框宽度 | 560px |
| 模态框圆角 | 16px |
| 模态框阴影 | `0 8px 32px rgba(0,0,0,0.15)` |
| 遮罩层 | `rgba(0,0,0,0.5)` |
| 模态框 padding | 24px |
| 标题字号 | 20px, 字重 700 |
| Info 横幅 | 背景 `#F5F3EF`, 圆角 8px, padding 12px 16px |
| Info 图标 | ℹ, 16px, 色 `#666666` |
| Label 字号 | 14px, 字重 500 |
| 必填标记 | `*`, 色 `#E53E3E` |
| 输入框 | 高 40px, 圆角 8px, 边框 1px `#E5E3DE` |
| Prompt 输入框 | 最小高 120px, 圆角 12px |
| 频率下拉 | 高 40px |
| 时间选择器 | 宽 80px, 高 36px, 圆角 8px, 边框 1px `#E5E3DE` |
| 注释文本 | 12px, 色 `#999999` |
| Cancel 按钮 | 背景 `#FFFFFF`, 边框 1px `#E5E3DE`, 色 `#000000` |
| Create task 按钮 | 背景 `#3D3D3D`, 色 `#FFFFFF` |
| 按钮间距 | 8px |
| 按钮 padding | 8px 20px |
| 按钮圆角 | 8px |

---

### 5.13 活跃会话标题栏

```
  Analyze project structure and codebase ▾        ▷ Preview ▾
```

| 元素 | 规格 |
|------|------|
| 标题字号 | 14px, 字重 500 |
| 标题色 | `#000000` |
| ▾ 图标 | 12px, 色 `#999999` |
| Preview 按钮 | 字号 13px, 边框 1px `#E5E3DE`, 圆角 6px, padding 4px 10px |
| 区域高度 | 44px |
| 底部分隔线 | 1px solid `#F0EDE8` |

---

## 六、交互状态规范

### 6.1 按钮状态

| 状态 | 主要按钮 | 次要按钮 |
|------|----------|----------|
| 默认 | bg `#3D3D3D`, fg `#FFFFFF` | bg `#FFFFFF`, border `#E5E3DE` |
| Hover | bg `#2D2D2D` | bg `#F5F3EF` |
| Active | bg `#1D1D1D` | bg `#E5E3DE` |
| Disabled | bg `#D0D0D0`, fg `#999999` | bg `#F5F3EF`, fg `#CCCCCC` |
| Loading | 显示 spinner，文字不变 | 同上 |

### 6.2 输入框状态

| 状态 | 规格 |
|------|------|
| 默认 | border `#E5E3DE` |
| Focus | border `#999999`, box-shadow `0 0 0 3px rgba(153,153,153,0.1)` |
| Error | border `rgb(171,43,63)`, box-shadow `0 0 0 3px rgba(171,43,63,0.1)` |
| Disabled | bg `#F5F3EF`, border `#E5E3DE`, 文字色 `#CCCCCC` |

### 6.3 导航项状态

| 状态 | 规格 |
|------|------|
| 默认 | 透明背景, 色 `#666666` |
| Hover | bg `#F5F3EF`, 色 `#000000` |
| Active/选中 | bg `#F0EDE8`, 色 `#000000`, 字重 500 |

### 6.4 下拉菜单项状态

| 状态 | 规格 |
|------|------|
| 默认 | 透明背景 |
| Hover | bg `#F5F3EF` |
| 选中 | 右侧 ✓ 标记, 色 `#000000` |

### 6.5 会话列表项状态

| 状态 | 规格 |
|------|------|
| 默认 | 透明背景 |
| Hover | bg `#F5F3EF` |
| 选中 | bg `#F0EDE8`, 左侧实心圆点 |

---

## 七、动画规范

### 7.1 过渡动画

| 动画 | 属性 | 时长 | 缓动 |
|------|------|------|------|
| 按钮悬停 | background-color | 150ms | ease |
| 导航项切换 | background-color | 200ms | ease-out |
| 下拉菜单展开 | opacity + transform(Y) | 200ms | ease-out |
| 下拉菜单收起 | opacity + transform(Y) | 150ms | ease-in |
| 模态框弹出 | opacity + scale | 250ms | cubic-bezier(0.16,1,0.3,1) |
| 模态框关闭 | opacity + scale | 200ms | ease-in |
| 折叠/展开 | height | 200ms | ease-out |
| 遮罩层 | opacity | 200ms | ease |

### 7.2 特效动画

| 动画 | 描述 |
|------|------|
| Clawd 吉祥物 | 像素眨眼动画，间隔 3-5s |
| ✦ 闪烁 | opacity 0.4 ↔ 1.0，周期 1.5s |
| Spinner | 旋转 360°，周期 1s，linear |
| Shimmer | 品牌色 ↔ shimmer 色，周期 2s，ease-in-out |

---

## 八、页面交互流程

### 8.1 新会话流程

```
用户点击 "New session"
  → 侧边栏选中 "New session"
  → 主内容区显示 Code 空状态页
  → 用户在输入框输入 prompt
  → 按 Enter 发送
  → 创建新会话，侧边栏添加会话项
  → 主内容区切换到活跃会话页
  → 显示用户消息气泡
  → 显示 AI 加载状态 (✦ Crafting...)
  → AI 回复逐步流式渲染
  → 工具调用时显示折叠块
  → 需要权限时弹出权限请求对话框
  → 用户批准/拒绝 → 继续/终止工具执行
```

### 8.2 定时任务创建流程

```
用户点击侧边栏 "Scheduled"
  → 主内容区显示 Scheduled 页面
  → 用户点击 "+ New task"
  → 弹出 "New scheduled task" 模态框
  → 填写 Name, Description, Prompt, 选择 Frequency/Time
  → 选择权限模式和模型
  → 点击 "Create task"
  → 模态框关闭
  → 任务列表中显示新任务
```

### 8.3 权限模式切换流程

```
用户点击权限模式图标 (⚙)
  → 展开下拉菜单
  → 用户选择新模式（如 "Plan mode"）
  → 下拉菜单关闭
  → 权限图标更新为新模式图标 (📋)
  → 如果选择 "Bypass permissions"，弹出安全确认对话框
  → 用户确认后切换
```

### 8.4 模型切换流程

```
用户点击模型名称 (Opus 4.7 1M)
  → 展开下拉菜单（模型列表 + Effort 等级）
  → 用户选择新模型
  → 或调整 Effort 等级
  → 下拉菜单关闭
  → 模型选择器显示更新
  → 后续对话使用新模型
```

### 8.5 会话切换流程

```
用户在侧边栏点击历史会话
  → 该会话高亮选中
  → 主内容区加载该会话的消息历史
  → 滚动到最新消息
  → 输入框恢复为空/上次未发送的草稿
```

### 8.6 Agent Teams 流程

```
对话中 AI 调用 TeamCreate
  → 消息列表下方出现 Team 状态栏
  → 显示 Team 名称 + 成员标签列表
  → 各成员标签显示 ● running（黄色闪烁）

用户点击某个成员标签
  → 消息列表切换到该成员的 transcript
  → 显示 "Viewing: {name} transcript" 分隔线
  → 实时渲染该 agent 的消息流（工具调用、文本）
  → 底部显示 "← Back to Leader" 按钮

成员完成任务
  → 对应标签变为 ● completed（绿色实心）
  → Leader 视图收到 task-notification 消息

用户点击 "← Back to Leader"
  → 返回 Leader 的主对话流
  → Team 状态栏依然可见
```

---

## 九、响应式适配

### 9.1 窗口尺寸断点

| 断点 | 宽度 | 布局变化 |
|------|------|----------|
| 紧凑 | < 900px | 侧边栏可折叠，浮层显示 |
| 标准 | 900-1440px | 侧边栏固定 280px |
| 宽屏 | > 1440px | 侧边栏可拉宽至 400px |

### 9.2 侧边栏折叠

- 窗口 < 900px 时，侧边栏默认折叠
- 可通过汉堡菜单图标展开
- 展开时覆盖在主内容区上方
- 点击主内容区或按 ESC 关闭

---

## 十、图标清单

| 用途 | 图标 | 说明 |
|------|------|------|
| New session | `+` | 加号，创建新会话 |
| Scheduled | ⏰ | 时钟 |
| Ask permissions | ⚙ | 齿轮 |
| Auto accept | `</>` | 代码符号 |
| Plan mode | 📋 | 剪贴板 |
| Bypass | ⚠ | 警告三角 |
| 添加附件 | `+` | 圆形加号 |
| 语音输入 | 🎤 | 麦克风 |
| 停止生成 | ⏹ | 方形停止 |
| 折叠 | ▸ | 右三角 |
| 展开 | ▾ | 下三角 |
| GitHub | 🐙 | GitHub logo |
| Git 分支 | 🔀 | 分支图标 |
| 前进 | → | 右箭头 |
| 后退 | ← | 左箭头 |
| 选中 | ✓ | 勾选 |
| 信息 | ℹ | 圆形 i |
| Agent Running | ● | 6px 圆点，闪烁 |
| Agent Completed | ● | 6px 实心绿点 |
| Agent Failed | ● | 6px 实心红点 |
| Back to Leader | ← | 左箭头 + 文本 |
