---
title: Subagents
nav_title: Subagents
description: When to delegate, which agents ship built in, and how to write your own.
order: 3
---

# Subagents

A subagent is a copy of Claude sent off with one clearly scoped job. It works in its own context and reports back only the conclusion.

The point is that your main conversation doesn't get flooded. Ask "find every call site of `validateUser` in this repo" and, if the main agent searches itself, dozens of files end up in the context window. Delegate it and all that comes back is the list.

## When to delegate

- **Questions that require reading a lot of files** — finding usages, untangling dependencies, counting where a pattern occurs.
- **Independent work that can run in parallel** — frontend, backend, and tests at the same time.
- **The same thing from several angles** — several agents each reviewing the same code.

Conversely: if you already know the file and the line, just say so. No need for the detour.

Delegated agents appear under **SubAgents** in the Activity panel with their tool activity streaming live. Open one to read its full transcript and final result. Background agents work the same way — you don't have to wait for them to finish to see what they're doing.

## Built-in agents

Available without any setup:

| Name | What it's for |
|---|---|
| `general-purpose` | The catch-all. Researching complex questions, searching for code, multi-step tasks |
| `Explore` | Fast codebase exploration. Find files by pattern, search code by keyword, answer "how does this part work" |
| `Plan` | The architect. Designs an implementation strategy and returns step-by-step plans, critical files, and trade-offs |
| `claude-code-guide` | Answers questions about Claude Code, the Agent SDK, and the Claude API themselves |
| `verification` | Sign-off before you call it done. Runs builds, tests, and linters and returns PASS / FAIL / PARTIAL with evidence |
| `statusline-setup` | Configures the Claude Code status line |

You can name one directly ("use Explore to find…") or let Claude decide who to send.

## Seeing what's installed

![Settings → Agents: the agent browser grouped by source](../../images/app/settings-agents.webp)

Open **Settings → Agents**. Three cards at the top show total agents, how many are active, and how many sources are in play. Below that, agents are grouped by source in a fixed order:

**User** → **Project** → **Local** → **Managed** → **Plugin** → **CLI arg** → **Built-in**

When two agents share a name, the higher source wins and the shadowed one is tagged "Overridden by X". Day to day, two groups matter:

- **User** — the ones you wrote, available in every project, stored in `~/.claude/agents/`.
- **Project** — scoped to the current project, stored in its `.claude/agents/`, shipped with the repo.

Click any row for its detail page: model, effort, tool scope, and the full system prompt. Built-in and plugin agents are read-only and show a lock pill instead of edit controls.

## Writing your own

![The Create Agent dialog: scope, model, effort, tools, system prompt](../../images/app/agent-create.webp)

Click **Create Agent** in the top right. The fields:

1. **Scope** — user or project. Choosing project asks you to confirm the target path.
2. **Name** — 1–64 lowercase letters, digits, hyphens, or underscores, e.g. `code-reviewer`. This is what the main agent calls it by.
3. **Description** — when the main agent should delegate to it. **This is the field that matters most**: it's what the main agent reads to decide whether to call this agent at all. Write it vaguely and the agent will never be used.
4. **System prompt** — its responsibilities, boundaries, and expected output.
5. **Model** — inherit from the main agent, or pick Haiku / Sonnet / Opus / Fable, or enter a custom model ID. Simple repetitive work is faster and cheaper on Haiku.
6. **Effort** — inherit, or set low / medium / high / xhigh / max. Models that don't support a level downgrade or ignore it.
7. **Tools** — all tools, no tools, or a custom list. The custom picker groups built-in tools by read and search, modify files, execute commands, and workflow, with a free-text field below for MCP tool names or permission rules like `Bash(git:*)`.
8. **Color** — optional, purely for telling agents apart in the UI.

Saving writes a Markdown file into the matching directory and refreshes the current session. A failed refresh doesn't roll back the file — it still applies after a restart.

:::tip
Grant only the tools the job needs. An agent whose job is to read code and report back doesn't need Write or Bash. Narrow the permissions and you narrow how far it can go wrong.
:::

For the agent file format, source precedence, and inheritance rules, see [Agent internals](../internals/agent.md).
