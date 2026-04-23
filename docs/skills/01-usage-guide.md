# Claude Code Skills 系统 — 使用指南

> Skills 是 Claude Code 的扩展能力引擎，让你用 Markdown 文件定义专属的自动化工作流。

<p align="center">
<a href="#一什么是-skills">Skills 是什么</a> · <a href="#二六种-skill-来源">六种来源</a> · <a href="#三skill-定义格式">定义格式</a> · <a href="#四调用方式">调用方式</a> · <a href="#五执行上下文">执行上下文</a> · <a href="#六条件激活">条件激活</a> · <a href="#七权限控制">权限控制</a> · <a href="#八快速参考">快速参考</a>
</p>

![Skills 系统概览](./images/01-skills-overview.png)

---

## 一、什么是 Skills？

Skills 是 Claude Code 的**可扩展能力插件系统**。每个 Skill 是一个 Markdown 文件（含 YAML frontmatter），定义了一段专门的提示词和行为配置，让 Claude 在特定场景下执行专业化的工作流。

核心能力：

| 能力 | 说明 |
|------|------|
| 专业化工作流 | 定义代码审查、TDD、调试等标准流程 |
| 工具权限控制 | 限制 Skill 只能使用指定的工具 |
| 模型切换 | 为不同 Skill 指定不同的模型 |
| 执行隔离 | Fork 模式在子代理中独立运行 |
| 条件激活 | 只在操作特定文件时才激活 |
| Hook 注入 | Skill 调用时自动注册生命周期钩子 |

---

## 二、六种 Skill 来源

![Skill 来源类型](./images/02-skill-sources.png)

Claude Code 从 6 个不同来源加载 Skills，按优先级从高到低：

### 1. Bundled（内置 Skills）

编译到 CLI 二进制中，所有用户可用。以 TypeScript 定义，通过 `registerBundledSkill()` 注册。

**当前内置 Skills：**

| Skill | 说明 | 特殊条件 |
|-------|------|----------|
| `/verify` | 验证代码变更 | — |
| `/debug` | 调试助手 | — |
| `/simplify` | 代码简化审查 | — |
| `/remember` | 记忆管理 | 需启用 auto-memory |
| `/batch` | 批量处理 | — |
| `/stuck` | 卡住时求助 | — |
| `/skillify` | 创建新 Skill | — |
| `/keybindings` | 自定义快捷键 | — |
| `/loop` | 定时循环任务 | AGENT_TRIGGERS 特性门控 |
| `/schedule` | 远程代理调度 | AGENT_TRIGGERS_REMOTE 特性门控 |
| `/claude-api` | Claude API 集成 | BUILDING_CLAUDE_APPS 特性门控 |
| `/dream` | 自动记忆整理 | KAIROS 特性门控 |

### 2. Managed（策略管理 Skills）

由组织策略控制，存放在 `<managed-path>/.claude/skills/`，适用于企业部署。

### 3. User（用户 Skills）

用户个人定义，存放在 `~/.claude/skills/`。

```
~/.claude/skills/
├── my-review/
│   └── SKILL.md          ← 主 Skill 文件
├── deploy-check/
│   └── SKILL.md
└── ...
```

### 4. Project（项目 Skills）

项目级别定义，存放在 `.claude/skills/`，可提交到版本控制。

```
your-project/
└── .claude/
    └── skills/
        ├── lint-fix/
        │   └── SKILL.md
        └── test-runner/
            └── SKILL.md
```

### 5. Plugin（插件 Skills）

由已安装的插件提供。插件通过 manifest 的 `skillsPath` / `skillsPaths` 声明 Skills 目录。

命名格式：`{pluginName}:{skillName}`

```
例如：superpowers:code-reviewer
      superpowers:brainstorming
```

### 6. MCP（MCP 服务器 Skills）

由连接的 MCP 服务器提供，命名格式：`mcp__server-name__prompt-name`。

**安全限制**：MCP Skills 为远程不受信来源，**禁止执行** `!`...`` 内联 shell 命令。

---

## 三、Skill 定义格式

### 目录结构

每个 Skill 是一个目录，包含一个 `SKILL.md` 文件：

```
skill-name/
└── SKILL.md    ← 文件名必须是 SKILL.md（大小写不敏感）
```

### Frontmatter 完整字段

```yaml
---
name: 我的技能                    # 显示名称（可选，默认用目录名）
description: 这个技能做什么         # 描述（必填，缺少时自动从内容提取）
when_to_use: 什么时候该用这个技能   # 使用场景说明（可选）
version: 1.0.0                   # 版本号（可选）

# ── 调用控制 ──
user-invocable: true             # 用户能否通过 /skill-name 调用（默认 true）
disable-model-invocation: false  # 禁止模型通过 Skill tool 调用（可选）
argument-hint: "<文件路径>"       # 参数提示（可选）

# ── 执行配置 ──
context: inline                  # 执行上下文：inline（默认）或 fork（子代理）
agent: general-purpose           # fork 时使用的代理类型（可选）
model: sonnet                    # 模型覆盖：haiku / sonnet / opus / inherit（可选）
effort: high                     # 思考力度：low / medium / high / max（可选）
allowed-tools: "Bash, Read"      # 允许使用的工具（逗号分隔或 YAML 列表）
shell: bash                      # Shell 类型：bash（默认）或 powershell

# ── 条件激活 ──
paths: "src/**/*.ts, test/**/*.ts"  # Glob 模式，只在匹配文件被操作时激活

# ── 生命周期 Hook ──
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - command: "echo 'Before bash'"
          once: true              # 仅执行一次
---

# Skill 正文内容

这里是 Markdown 格式的提示词，Claude 调用此 Skill 时会看到这些内容。

支持的特殊语法：
- `${CLAUDE_SKILL_DIR}` — 展开为 Skill 所在目录
- `${CLAUDE_SESSION_ID}` — 展开为当前会话 ID
- `$ARGUMENTS` / `${ARG1}` — 参数替换
- !`shell command` — 内联 Shell 命令执行
```

### Frontmatter 字段速查表

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `name` | string | 目录名 | 显示名称覆盖 |
| `description` | string | 自动提取 | Skill 简述 |
| `when_to_use` | string | — | 使用场景描述 |
| `user-invocable` | boolean | true | 用户能否输入 /name 调用 |
| `disable-model-invocation` | boolean | false | 禁止模型调用 |
| `context` | `inline` \| `fork` | inline | 执行上下文 |
| `agent` | string | general-purpose | fork 时代理类型 |
| `model` | string | 继承 | 模型覆盖（haiku/sonnet/opus） |
| `effort` | string \| int | — | 思考力度 |
| `allowed-tools` | string \| list | 全部 | 允许工具白名单 |
| `paths` | string \| list | — | 条件激活 Glob 模式 |
| `shell` | `bash` \| `powershell` | bash | Shell 命令类型 |
| `hooks` | object | — | 生命周期 Hook 配置 |
| `argument-hint` | string | — | 参数提示文本 |
| `version` | string | — | 版本号 |

---

## 四、调用方式

![Skill 调用流程](./images/03-skill-invocation.png)

### 方式一：用户斜杠命令

直接在终端输入 `/skill-name`：

```
> /commit
> /review-pr 123
> /verify
```

**前提**：Skill 的 `user-invocable` 必须为 `true`。

### 方式二：模型自动调用

Claude 在对话中识别到合适的 Skill 时，通过 SkillTool 自动调用：

```
用户：帮我审查一下这段代码
Claude：[通过 SkillTool 调用 superpowers:code-reviewer]
```

**前提**：Skill 的 `disable-model-invocation` 不能为 `true`。

### 方式三：嵌套调用

一个 Skill 执行过程中可以触发另一个 Skill：

```
/verify → 内部调用 → /simplify
```

遥测中通过 `invocation_trigger: 'nested-skill'` 追踪。

### 调用优先级

当同名 Skill 存在于多个来源时，按以下顺序解析（先匹配先用）：

```
1. Bundled（内置）      ← 最高优先级
2. Built-in Plugin（内置插件）
3. Skill Dirs（用户/项目目录）
4. Workflow Commands
5. Plugin Commands（插件命令）
6. Plugin Skills（插件技能）
7. Built-in Commands（内建命令）  ← 最低优先级
```

---

## 五、执行上下文

### Inline 模式（默认）

Skill 内容**展开到当前对话**中，Claude 直接看到提示词并在同一上下文中执行。

```yaml
context: inline   # 默认值，可省略
```

**特点：**
- 共享父对话的 token 预算
- 可以访问对话历史上下文
- `allowedTools` 限制当前轮次可用工具
- `model` 覆盖当前轮次使用的模型

### Fork 模式（子代理）

Skill 在**隔离的子代理**中运行，拥有独立的 token 预算和上下文。

```yaml
context: fork
agent: general-purpose   # 可选，指定代理类型
```

**特点：**
- 独立的 token 预算，不消耗父对话额度
- 隔离的对话上下文
- 可指定不同的 agent 类型（如 `Bash`、`general-purpose`）
- 执行完成后提取结果返回父对话
- 支持进度汇报（`onProgress` 回调）

### 两种模式对比

| 特性 | Inline | Fork |
|------|--------|------|
| Token 预算 | 共享父对话 | 独立预算 |
| 上下文访问 | 完整对话历史 | 仅 Skill 提示词 |
| 结果返回 | 直接在对话中 | 提取文本嵌入 tool_result |
| 适用场景 | 简短指导、扩展上下文 | 长任务、独立运算 |
| 工具限制 | contextModifier 修改 | modifiedGetAppState |

---

## 六、条件激活

Skill 可以通过 `paths` frontmatter 实现**按需激活**，只在操作匹配文件时才对模型可见。

### 配置方式

```yaml
---
name: TypeScript 修复
description: 修复 TypeScript 类型错误
paths: "src/**/*.ts, test/**/*.ts"
---
```

### 工作原理

```
1. 启动时加载所有 Skill
2. 带 paths 的 Skill 存入 conditionalSkills Map（不暴露给模型）
3. 当用户操作文件时（Read/Write/Edit）
4. activateConditionalSkillsForPaths() 用 ignore 库匹配
5. 匹配成功 → 移入 dynamicSkills Map → 模型可见
6. 一旦激活，在会话内持续有效
```

### 动态发现

除了条件激活，Skills 还支持**运行时发现**：

```
1. 用户操作某个深层目录中的文件
2. discoverSkillDirsForPaths() 从文件路径向上遍历
3. 寻找 .claude/skills/ 目录（不超过 cwd）
4. 跳过 .gitignore 忽略的目录
5. 发现新目录 → addSkillDirectories() → 加载并注册
```

---

## 七、权限控制

### 自动允许

如果 Skill 只包含"安全属性"（无 `allowedTools`、无 `hooks`、无 `fork`），将**自动获准**执行，无需用户确认。

### 手动确认

包含工具限制、Hook 或 fork 执行的 Skill，首次调用时会提示用户：

```
Execute skill: my-custom-skill
Allow? (y)es / (n)o / (a)lways allow / (d)eny
```

### 权限规则

| 规则类型 | 格式 | 说明 |
|----------|------|------|
| 精确允许 | `Skill:commit` | 允许执行 commit Skill |
| 前缀允许 | `Skill:review:*` | 允许所有 review: 前缀的 Skill |
| 精确拒绝 | `Skill:dangerous` 设为 deny | 拒绝执行 |
| 前缀拒绝 | `Skill:untrusted:*` 设为 deny | 拒绝所有 untrusted: 前缀 |

**处理顺序：** deny 规则 → allow 规则 → 安全属性检查 → 询问用户

---

## 八、快速参考

### 创建一个 Skill

```bash
# 1. 创建目录
mkdir -p ~/.claude/skills/my-skill

# 2. 创建 SKILL.md
cat > ~/.claude/skills/my-skill/SKILL.md << 'EOF'
---
name: 我的技能
description: 一个示例 Skill
user-invocable: true
---

# 技能内容

你好，这是我的自定义 Skill。
EOF
```

### 常用操作

| 操作 | 方法 |
|------|------|
| 创建 Skill | `~/.claude/skills/<name>/SKILL.md` |
| 项目级 Skill | `.claude/skills/<name>/SKILL.md` |
| 调用 Skill | 终端输入 `/skill-name` |
| 查看可用 Skills | 终端输入 `/skills` |
| 用 AI 创建 Skill | `/skillify` |
| 限制工具 | frontmatter 添加 `allowed-tools` |
| Fork 执行 | frontmatter 添加 `context: fork` |
| 条件激活 | frontmatter 添加 `paths: "src/**"` |

### Skill 可用性矩阵

| 来源 | 用户可调用 | 模型可调用 | 支持 Fork | 支持 Hook |
|------|-----------|-----------|----------|----------|
| Bundled | 依定义 | 依定义 | 是 | 是 |
| Managed | 是 | 是 | 是 | 是 |
| User | 是（默认） | 是 | 是 | 是 |
| Project | 是（默认） | 是 | 是 | 是 |
| Plugin | 依配置 | 依配置 | 是 | 是 |
| MCP | 依配置 | 依配置 | 是 | 否（安全限制） |
