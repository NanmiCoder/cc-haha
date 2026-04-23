# Claude Code 记忆系统文档

> 完整的记忆系统使用指南和实现原理文档

---

## 📚 文档目录

### [01-usage-guide.md](./01-usage-guide.md) — 使用指南

面向用户的完整使用手册，涵盖：

- **四种记忆类型**：User（用户画像）、Feedback（行为反馈）、Project（项目动态）、Reference（外部引用）
- **四种触发方式**：自动提取、显式请求、`/memory` 命令、`/remember` 命令
- **存储格式**：YAML frontmatter + Markdown 内容
- **管理操作**：遗忘、忽略、手动编辑、禁用、自定义目录
- **生命周期**：从学习到注入，新鲜度管理

**适合人群**：所有 Claude Code 用户

---

### [02-implementation.md](./02-implementation.md) — 实现原理

面向开发者的技术深度解析，涵盖：

- **5 大核心模块**：路径解析、提示词构建、记忆扫描、智能检索、自动提取
- **路径解析系统**：优先级链、安全校验、启用条件
- **系统提示词注入**：`loadMemoryPrompt()` → `buildMemoryLines()`，MEMORY.md 截断策略
- **自动记忆提取**：分叉代理、互斥机制、工具权限、合并机制
- **智能检索**：`scanMemoryFiles()` → Sonnet 选择 → 新鲜度警告
- **代理记忆**：三级作用域（user/project/local）
- **团队记忆同步**：Pull/Push API、合并语义
- **完整数据流**：从会话启动到上下文注入

**适合人群**：贡献者、架构师、想深入了解实现的开发者

---

### [03-autodream.md](./03-autodream.md) — AutoDream 记忆整合

Claude 的"做梦"机制——后台静默整合记忆的深度解析，涵盖：

- **核心概念**：像人类睡眠整理记忆一样，定期回顾多个会话整合知识
- **五重门控**：功能开关 → 时间门控(24h) → 扫描节流(10min) → 会话门控(5个) → 锁门控
- **四阶段流程**：Orient（定向）→ Gather（收集）→ Consolidate（整合）→ Prune（修剪）
- **安全限制**：Bash 只读、写操作仅限记忆目录、PID 锁文件互斥
- **UI 展示**：底部 "dreaming" 标签、Shift+Down 详情对话框、完成通知
- **配置控制**：settings.json 本地开关 + GrowthBook 远程 feature flag
- **与 extractMemories 对比**：白天记笔记 vs 睡觉整理笔记本

**适合人群**：贡献者、架构师、对 Claude 自动化记忆管理感兴趣的开发者

---

## 🖼️ 配图说明

所有配图采用深色背景（#1a1a2e）+ Anthropic 品牌橙铜色（#D97757）风格，与 Claude Code 官方文档一致。

| 图片 | 说明 | 尺寸 |
|------|------|------|
| `01-memory-overview.png` | 记忆系统概览 — 四层架构（触发/类型/存储/检索） | 632 KB |
| `02-memory-types.png` | 四种记忆类型 — 2x2 网格展示 User/Feedback/Project/Reference | 507 KB |
| `03-memory-trigger.png` | 记忆触发流程 — 从对话到存储的四种路径 | 474 KB |
| `04-memory-lifecycle.png` | 记忆生命周期 — 完整循环流程 + 新鲜度判断 | 1.0 MB |
| `05-architecture-overview.png` | 实现架构总览 — 5 个核心模块 + 辅助模块 | 3.5 MB |
| `06-path-resolution.png` | 路径解析流程 — 三层优先级 + 安全校验 | 1.0 MB |
| `07-prompt-injection.png` | 提示词注入流程 — loadMemoryPrompt 分发逻辑 | 1.1 MB |
| `08-auto-extraction.png` | 自动提取流程 — 分叉代理完整流程 | 1.2 MB |
| `09-memory-retrieval.png` | 智能检索流程 — Sonnet 选择 + 新鲜度管理 | 816 KB |
| `10-agent-memory.png` | 代理记忆作用域 — 三级嵌套结构 | 523 KB |
| `11-autodream-overview.png` | AutoDream 概览 — 做梦机制的核心架构与人类睡眠类比 | 777 KB |
| `12-autodream-trigger.png` | AutoDream 触发流程 — 五重门控检查链 | 493 KB |
| `13-autodream-phases.png` | AutoDream 四阶段 — Orient/Gather/Consolidate/Prune | 602 KB |

---

## 🚀 快速开始

### 用户

1. 阅读 [使用指南](./01-usage-guide.md)
2. 了解四种记忆类型和触发方式
3. 尝试 `/memory` 和 `/remember` 命令

### 开发者

1. 阅读 [实现原理](./02-implementation.md)
2. 查看源码位置：
   - `src/memdir/paths.ts` — 路径解析
   - `src/memdir/memdir.ts` — 提示词构建
   - `src/memdir/memoryScan.ts` — 记忆扫描
   - `src/memdir/findRelevantMemories.ts` — 智能检索
   - `src/services/extractMemories/` — 自动提取
3. 理解数据流和模块交互

---

## 📝 核心概念速查

| 概念 | 说明 |
|------|------|
| **MEMORY.md** | 索引文件，始终加载到上下文（最多 200 行 / 25KB） |
| **主题文件** | `*.md` 文件，包含 frontmatter + 内容 |
| **自动提取** | 每次回复后后台运行，分叉代理分析对话 |
| **AutoDream** | 每 24h + 5 个会话后，后台整合/去重/修剪全部记忆 |
| **智能检索** | Sonnet 模型从所有记忆中选择最多 5 个相关的 |
| **新鲜度** | ≤1 天无警告，>1 天附带陈旧警告 |
| **分叉代理** | 共享提示词缓存，限制工具权限，最多 5 turns |
| **三级作用域** | 代理记忆：user（全局）> project（项目）> local（本地） |

---

## 🔗 相关资源

- [Claude Code Haha 主页](/)
- [记忆系统源码](https://github.com/NanmiCoder/cc-haha/tree/main/src/memdir/)
- [自动提取服务](https://github.com/NanmiCoder/cc-haha/tree/main/src/services/extractMemories/)
- [AutoDream 服务](https://github.com/NanmiCoder/cc-haha/tree/main/src/services/autoDream/)
- [DreamTask 任务](https://github.com/NanmiCoder/cc-haha/tree/main/src/tasks/DreamTask/)
- [GitHub Issues](https://github.com/NanmiCoder/cc-haha/issues)
