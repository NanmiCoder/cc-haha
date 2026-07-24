# CLI Reference

Claude Code Haha starts an interactive session by default. With `--print`, it can also run as a non-interactive agent in scripts, CI, or another program. The command in a source checkout is `./bin/claude-haha`; the installed executable name depends on the installation method.

```bash
./bin/claude-haha --help
```

`--help` is the source of truth for the installed version. This page explains common options by task instead of duplicating a complete help listing that would quickly become stale.

## Quick examples

```bash
# Start an interactive session in the current directory
./bin/claude-haha

# Start with an initial request
./bin/claude-haha "Explain how this repository starts"

# Return text and exit
./bin/claude-haha --print "Summarize the latest commit"

# Return one complete JSON result
./bin/claude-haha --print --output-format json "List the main modules"

# Continue the latest session in this directory
./bin/claude-haha --continue

# Resume a session but fork it to a new session ID
./bin/claude-haha --resume <session-id> --fork-session

# Work in a new Git worktree
./bin/claude-haha --worktree docs-refresh
```

## Understand the `--print` trust boundary first

`-p, --print` skips the workspace trust dialog. It can still load enabled user, project, and local settings. Hooks, MCP servers, tool permissions, and environment configuration in a trusted project can also affect execution.

Consequently:

- Run `--print`, `doctor`, and automation only in directories you trust.
- Before processing an unfamiliar repository, inspect `.claude/`, `.mcp.json`, plugins, and workspace instructions.
- `--dangerously-skip-permissions` bypasses every permission check. Use it only in a disposable, isolated sandbox with no network access.
- `--allow-dangerously-skip-permissions` only makes bypass mode selectable; it does not enable bypass by itself.
- In automation, explicitly limit tools, allowed directories, and budget.

## Non-interactive input and output

| Option | Description |
|--------|-------------|
| `-p, --print` | Process a request, write the result, and exit |
| `--output-format text` | Plain text; the default |
| `--output-format json` | One complete JSON result |
| `--output-format stream-json` | A stream of JSON events |
| `--input-format text` | Plain-text input; the default |
| `--input-format stream-json` | Receive a stream of JSON events on standard input |
| `--json-schema '<schema>'` | Require the final structured output to match a JSON Schema |
| `--include-partial-messages` | Include incremental message chunks in `stream-json` |
| `--include-hook-events` | Include hook lifecycle events in `stream-json` |
| `--replay-user-messages` | Echo streamed user messages to standard output as acknowledgements |
| `--no-session-persistence` | Do not save the non-interactive session |
| `--max-budget-usd <amount>` | Set the maximum API spend for `--print` |

Structured output example:

```bash
./bin/claude-haha --print \
  --output-format json \
  --json-schema '{"type":"object","properties":{"risk":{"type":"string"}},"required":["risk"]}' \
  "Review the current changes and return only the risk level"
```

Streaming output is an event protocol, not ordinary JSON split across lines. Consumers should dispatch on `type` and tolerate additional event fields.

## Sessions and workspaces

| Option | Description |
|--------|-------------|
| `-c, --continue` | Continue the latest session in the current directory |
| `-r, --resume [value]` | Resume by session ID; omit the value for the picker, or pass a search term |
| `--fork-session` | Create a new session ID when resuming |
| `--session-id <uuid>` | Use a specific session ID |
| `-n, --name <name>` | Set the name shown in the resume list and terminal title |
| `--from-pr [value]` | Resume a session linked to a PR number or URL |
| `--add-dir <paths...>` | Allow tools to access additional directories |
| `-w, --worktree [name]` | Create a Git worktree for the session |
| `--tmux` | Create a tmux session with `--worktree`; uses an iTerm2 pane when supported |

`--worktree` changes the local Git workspace layout. Check repository status first and provide an explicit name in automation.

## Models and context

| Option | Description |
|--------|-------------|
| `--model <model>` | Select a model alias or complete model ID |
| `--fallback-model <model>` | Use a fallback if the primary model is overloaded in `--print` mode |
| `--effort <level>` | Set reasoning effort, such as `low`, `medium`, `high`, `xhigh`, or `max` |
| `--agent <agent>` | Use a configured agent |
| `--agents '<json>'` | Define custom agents for this session |
| `--system-prompt <text>` | Replace the system prompt for this session |
| `--append-system-prompt <text>` | Append text to the default system prompt |
| `--file <specs...>` | Download file resources at startup as `file_id:relative_path` |
| `--bare` | Start a minimal runtime without hooks, LSP, plugin sync, auto-memory, or other automatic discovery |

`--bare` is not a less restricted mode. It reduces implicit context and credential sources, so the caller must explicitly provide prompts, directories, MCP configuration, settings, agents, or plugins.

## Tools and permissions

| Option | Description |
|--------|-------------|
| `--tools <tools...>` | Select built-in tools; `""` disables all tools and `default` uses the default set |
| `--allowed-tools <tools...>` | Allow matching tools, for example `Bash(git:*) Edit` |
| `--disallowed-tools <tools...>` | Deny matching tools |
| `--permission-mode <mode>` | Choose `default`, `acceptEdits`, `plan`, `dontAsk`, `bypassPermissions`, or `auto` |
| `--no-computer-use` | Do not load the Computer Use MCP for this session |
| `--chrome` / `--no-chrome` | Enable or disable Chrome integration |
| `--ide` | Connect automatically when exactly one valid IDE is available |

Deny rules and platform policy can still override allow rules. Production automation should select the smallest tool set instead of relying on approvals stored on a developer machine.

## Settings, MCP, and plugins

| Option | Description |
|--------|-------------|
| `--settings <file-or-json>` | Load an additional settings file or JSON string |
| `--setting-sources <sources>` | Select `user`, `project`, and `local` settings sources |
| `--mcp-config <configs...>` | Load MCP servers from JSON files or JSON strings |
| `--strict-mcp-config` | Ignore other MCP configuration and use only command-line entries |
| `--plugin-dir <path>` | Load a plugin directory for this session; repeat the option for multiple paths |
| `--disable-slash-commands` | Disable all skills |
| `-d, --debug [filter]` | Enable debug logging with optional category filtering |
| `--debug-file <path>` | Write debug logs to a file |

`--mcp-debug` is deprecated; use `--debug`.

## Subcommands

| Subcommand | Purpose |
|------------|---------|
| `agents` | List configured agents |
| `auth` | Manage authentication |
| `auto-mode` | Inspect the Auto mode classifier configuration |
| `doctor` | Check updater and runtime health |
| `install` | Install a selected native-build channel or version |
| `mcp` | Configure and manage MCP servers |
| `plugin` / `plugins` | Manage plugins |
| `setup-token` | Create a long-lived token for a Claude subscription |
| `update` / `upgrade` | Check for and install updates |

Each subcommand has separate help:

```bash
./bin/claude-haha mcp --help
./bin/claude-haha plugin --help
```

## Interactive commands

Enter `/help` in an interactive session to see the commands available in the current build. Commands such as `/commit` and `/review` come from the built-in command set. Skills and plugins can add commands dynamically, so do not rely on a fixed list in documentation.

If a command is missing, trust the current `/help` output first and check whether `--disable-slash-commands` was used.
