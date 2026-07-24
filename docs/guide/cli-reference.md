# CLI 参考

Claude Code Haha 默认启动交互式会话，也可以用 `--print` 作为脚本、CI 或其他程序中的非交互式 Agent。源码仓库中的命令是 `./bin/claude-haha`；安装后的可执行文件名称以安装方式为准。

```bash
./bin/claude-haha --help
```

`--help` 是当前版本参数的最终依据。本页按任务解释最常用的参数，避免复制一份很快过期的完整帮助输出。

## 快速示例

```bash
# 在当前目录开始交互式会话
./bin/claude-haha

# 带着第一条需求进入会话
./bin/claude-haha "解释这个仓库的启动路径"

# 返回一段文本后退出
./bin/claude-haha --print "总结最近一次提交"

# 返回一个完整 JSON 结果
./bin/claude-haha --print --output-format json "列出主要模块"

# 继续当前目录最近的会话
./bin/claude-haha --continue

# 恢复指定会话，同时创建新的会话分支
./bin/claude-haha --resume <session-id> --fork-session

# 在新 Git worktree 中工作
./bin/claude-haha --worktree docs-refresh
```

## 先理解 `--print` 的安全边界

`-p, --print` 会跳过工作区信任对话框。它仍会读取启用的用户、项目和本地设置；可信项目中的 hooks、MCP、工具权限和环境配置也可能影响运行。

因此：

- 只在你信任的目录中运行 `--print`、`doctor` 和自动化任务。
- 处理陌生仓库时，先检查 `.claude/`、`.mcp.json`、插件和工作区说明。
- `--dangerously-skip-permissions` 会绕过所有权限检查，只适合无网络、可丢弃的隔离沙箱。
- `--allow-dangerously-skip-permissions` 只是允许会话选择绕过模式，并不会自动开启它。
- 自动化中明确限制 `--tools`、`--allowed-tools`、预算和可访问目录。

## 非交互输入与输出

| 参数 | 说明 |
|------|------|
| `-p, --print` | 处理请求，输出结果并退出 |
| `--output-format text` | 纯文本；默认格式 |
| `--output-format json` | 单个完整 JSON 结果 |
| `--output-format stream-json` | 持续输出 JSON 事件 |
| `--input-format text` | 普通文本输入；默认格式 |
| `--input-format stream-json` | 从标准输入持续接收 JSON 事件 |
| `--json-schema '<schema>'` | 要求最终结构化输出符合 JSON Schema |
| `--include-partial-messages` | 在 `stream-json` 中包含增量消息片段 |
| `--include-hook-events` | 在 `stream-json` 中包含 hook 生命周期事件 |
| `--replay-user-messages` | 流式输入输出时，把用户消息重新发到标准输出作为确认 |
| `--no-session-persistence` | 非交互运行后不保存会话 |
| `--max-budget-usd <amount>` | 为 `--print` 设置最高 API 费用 |

结构化输出示例：

```bash
./bin/claude-haha --print \
  --output-format json \
  --json-schema '{"type":"object","properties":{"risk":{"type":"string"}},"required":["risk"]}' \
  "审查当前改动，只返回风险级别"
```

流式输出是事件协议，不等同于把普通 JSON 拆成多行。消费端应按 `type` 处理事件，并允许新事件字段出现。

## 会话与工作区

| 参数 | 说明 |
|------|------|
| `-c, --continue` | 继续当前目录最近一次会话 |
| `-r, --resume [value]` | 按会话 ID 恢复；省略值时打开选择器，也可传搜索词 |
| `--fork-session` | 恢复时创建新会话 ID，不覆盖原会话路径 |
| `--session-id <uuid>` | 指定本次会话 ID |
| `-n, --name <name>` | 设置在恢复列表和终端标题中显示的名称 |
| `--from-pr [value]` | 按 PR 编号或 URL 恢复关联会话 |
| `--add-dir <paths...>` | 额外允许工具访问的目录 |
| `-w, --worktree [name]` | 为会话创建 Git worktree |
| `--tmux` | 与 `--worktree` 配合创建 tmux 会话；受支持时使用 iTerm2 pane |

`--worktree` 会改变本地 Git 工作区布局。运行前先确认仓库状态，并在自动化中提供明确名称。

## 模型与上下文

| 参数 | 说明 |
|------|------|
| `--model <model>` | 使用模型别名或完整模型 ID |
| `--fallback-model <model>` | `--print` 模式下主模型过载时使用备用模型 |
| `--effort <level>` | 设置推理投入，如 `low`、`medium`、`high`、`xhigh` 或 `max` |
| `--agent <agent>` | 使用已配置的 Agent |
| `--agents '<json>'` | 为本次会话定义自定义 Agent |
| `--system-prompt <text>` | 替换本次会话的 system prompt |
| `--append-system-prompt <text>` | 在默认 system prompt 后追加内容 |
| `--file <specs...>` | 启动时下载文件资源，格式为 `file_id:relative_path` |
| `--bare` | 启动最小运行时，跳过 hooks、LSP、插件同步、自动记忆等自动发现能力 |

`--bare` 不是“更宽松”的模式。它减少隐式上下文和凭据来源，调用方需要显式提供 prompts、目录、MCP、设置、Agents 或插件。

## 工具与权限

| 参数 | 说明 |
|------|------|
| `--tools <tools...>` | 指定可用的内置工具；`""` 禁用全部，`default` 使用默认集合 |
| `--allowed-tools <tools...>` | 允许匹配的工具，例如 `Bash(git:*) Edit` |
| `--disallowed-tools <tools...>` | 拒绝匹配的工具 |
| `--permission-mode <mode>` | 选择 `default`、`acceptEdits`、`plan`、`dontAsk`、`bypassPermissions` 或 `auto` |
| `--no-computer-use` | 本次会话不加载 Computer Use MCP |
| `--chrome` / `--no-chrome` | 开启或关闭 Chrome 集成 |
| `--ide` | 只有一个有效 IDE 时自动连接 |

拒绝规则和平台策略仍可能覆盖允许规则。生产自动化应使用最小工具集，而不是依赖一次人工批准后的本机状态。

## 设置、MCP 与插件

| 参数 | 说明 |
|------|------|
| `--settings <file-or-json>` | 加载额外的设置文件或 JSON 字符串 |
| `--setting-sources <sources>` | 选择 `user`、`project`、`local` 设置来源 |
| `--mcp-config <configs...>` | 从 JSON 文件或 JSON 字符串加载 MCP 服务 |
| `--strict-mcp-config` | 忽略其他 MCP 配置，只使用命令行指定的配置 |
| `--plugin-dir <path>` | 为本次会话加载插件目录；多个目录要重复传参 |
| `--disable-slash-commands` | 禁用所有 Skills |
| `-d, --debug [filter]` | 开启调试日志，可按分类筛选 |
| `--debug-file <path>` | 把调试日志写入指定文件 |

`--mcp-debug` 已弃用，请使用 `--debug`。

## 子命令

| 子命令 | 用途 |
|--------|------|
| `agents` | 列出已配置的 Agents |
| `auth` | 管理认证 |
| `auto-mode` | 查看 Auto mode 分类器配置 |
| `doctor` | 检查更新器和运行环境健康状态 |
| `install` | 安装指定渠道或版本的原生构建 |
| `mcp` | 配置和管理 MCP 服务 |
| `plugin` / `plugins` | 管理插件 |
| `setup-token` | 为 Claude 订阅创建长期认证 Token |
| `update` / `upgrade` | 检查并安装更新 |

每个子命令都有独立帮助：

```bash
./bin/claude-haha mcp --help
./bin/claude-haha plugin --help
```

## 交互式命令

交互会话中输入 `/help` 查看当前可用命令。`/commit`、`/review` 等命令来自内置命令集；Skills 和插件也能动态加入命令，所以不要依赖文档中的固定清单。

如果命令不存在，先以 `/help` 的当前输出为准，并检查是否使用了 `--disable-slash-commands`。
