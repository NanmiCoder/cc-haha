---
title: Subagents
nav_title: Subagents
description: When to delegate, which agents ship built in, and how to write your own.
order: 3
---

# Subagents

A subagent is a copy of Claude sent off with one clearly scoped job. It works in its own context and reports back only the conclusion.

A subagent can keep an independent investigation's intermediate work in its own context, then return conclusions and evidence to the main conversation. Investigating a module's authentication flow can be delegated; finding call sites of `validateUser` usually takes one targeted search and does not need a subagent.

## When to delegate

- **An investigation that can stand on its own** — it requires multiple files and has a clear question, scope, and expected evidence.
- **Independent work that can run in parallel** — such as separate frontend and backend investigations. For edits, assign file ownership and let the main agent integrate and verify the result.
- **An independent review with a specific focus** — such as separate checks of permission boundaries and session recovery, instead of repeating an entire review without a distinct purpose.

Delegation also costs startup time, context transfer, and integration. The main agent should usually handle simple searches, small edits with a known location, or short tasks whose result is needed before anything else can proceed.

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

![Settings → Agents: the agent browser grouped by source](../../images/app/en/settings-agents.webp)

Open **Settings → Agents**. Three cards at the top show total agents, how many are active, and how many sources are in play. Below that, agents are grouped by source in a fixed order:

**User** → **Project** → **Local** → **Managed** → **Plugin** → **CLI arg** → **Built-in**

When two agents share a name, the higher source wins and the shadowed one is tagged "Overridden by X". Day to day, two groups matter:

- **User** — the ones you wrote, available in every project, stored in `~/.claude/agents/`.
- **Project** — scoped to the current project, stored in its `.claude/agents/`, shipped with the repo.

Click any row for its detail page: model, effort, tool scope, and the full system prompt. Built-in and plugin agents are read-only and show a lock pill instead of edit controls.

Hover a row in the list and its actions appear on the right: **Edit** and **Delete** for user and project agents, **Adjust model** for built-in ones. The same controls sit in the top-right of the detail page.

## Adjusting a Built-in Agent's Model

Built-in agents each pin a default model — `Explore` and `claude-code-guide` run on Haiku, `statusline-setup` on Sonnet — chosen for speed and cost. If you care more about their output quality, you can swap that out.

Click **Adjust model** on the built-in agent's row, or the same button in the top-right of its detail page. Only two things are editable:

- **Model** — Built-in default, Inherit from parent, the Haiku / Sonnet / Opus / Fable aliases, or a model configured for the current provider.
- **Reasoning effort** — Built-in default, or low / medium / high / xhigh / max.

The system prompt, tool scope, and color stay fixed by Claude Code.

:::tip
"Built-in default" and "Inherit from parent" are not the same thing. For `Explore`, the first is the Haiku it ships pinned to; the second follows whatever model your main conversation is using. To go back to how it shipped, pick "Built-in default" or click **Reset to built-in default**.
:::

The override is written to `builtInAgentOverrides` in `~/.claude/settings.json` and applies to every project. Resetting removes the entry entirely rather than leaving an empty shell behind in your config.

Agent configuration stores a model ID, not a provider. The picker lists models from the current provider. If you switch providers later, aliases resolve through the new provider's mapping, while a full model ID must also be supported by the new provider.

If you create a user agent with the same name (a hand-written file with `name: Explore`, say), it shadows the built-in one completely — changing the built-in's model then has no effect, and the dialog says so.

## Writing your own

![The Create Agent dialog: scope, model, effort, tools, system prompt](../../images/app/en/agent-create.webp)

Click **Create Agent** in the top right. The fields:

1. **Scope** — user or project. Choosing project asks you to confirm the target path.
2. **Name** — 1–64 lowercase letters, digits, hyphens, or underscores, e.g. `code-reviewer`. This is what the main agent calls it by.
3. **Description** — when the main agent should delegate to it. **This is the field that matters most**: it's what the main agent reads to decide whether to call this agent at all. Write it vaguely and the agent will never be used.
4. **System prompt** — its responsibilities, boundaries, and expected output.
5. **Model** — inherit from the main agent, choose a Haiku / Sonnet / Opus / Fable alias, or choose a model configured for the current provider. Simple repetitive work is faster and cheaper on Haiku.
6. **Effort** — inherit, or set low / medium / high / xhigh / max. Models that don't support a level downgrade or ignore it.
7. **Tools** — all tools, no tools, or a custom list. The custom picker groups built-in tools by read and search, modify files, execute commands, and workflow, with a free-text field below for MCP tool names or permission rules like `Bash(git:*)`.
8. **Color** — optional, purely for telling agents apart in the UI.

Saving writes a Markdown file into the matching directory and refreshes the current session. A failed refresh doesn't roll back the file — it still applies after a restart.

:::tip
Grant only the tools the job needs. An agent whose job is to read code and report back doesn't need Write or Bash. Narrow the permissions and you narrow how far it can go wrong.
:::

For the agent file format, source precedence, and inheritance rules, see [Agent internals](../internals/agent.md).
