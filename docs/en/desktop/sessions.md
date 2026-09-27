---
title: Sessions, permissions, and review
nav_title: Sessions
description: A session from first question to reviewed diff, and which button to press when Claude asks.
order: 1
---

# Sessions, permissions, and review

A session is one complete collaboration: you describe what you want, Claude reads files, runs commands, and edits code, and every step stays in the conversation where you can go back and check it. This page explains what each part of the session screen does.

## Starting a session

Click **New session** in the sidebar, or press `⌘N` (`Ctrl+N` on Windows and Linux). The empty session asks you for exactly one thing: a project directory. After that you can start typing — the model and permission mode come from your defaults in Settings.

Each session opens as a tab, and you can run many side by side. A dot on the tab means that session is still running; closing a running tab asks whether you want to **Keep running** or **Stop and close**.

The small line under the session title is metadata: project path, branch, model. A session is bound to one directory — to work on a different project, start a new session.

## Reading the conversation

![A release-notes conversation in the real project, with tool calls and the session list (Chinese interface)](../../images/app/en/session-main.webp)

Claude doesn't just reply with a paragraph. Several kinds of card appear along the way:

- **Tool cards** — reading files, searching, running commands. Consecutive operations of the same kind collapse into one line, like "Read 6 files" or "edited 3 files"; expand it to see the details. Skim them normally, open them when something goes wrong.
- **Thinking blocks** — the reasoning before it acts, labelled **Thinking** while it runs and **Thought** once done. Collapsed by default.
- **File edits** — shown as an inline diff right in the conversation, so you don't have to look anywhere else.
- **Claude needs your input** — when it's genuinely unsure it asks, with buttons for the likely answers plus a free-text box.

In a long conversation, `⌘F` opens find-in-page and jumps between matches in the current session. `⌘K` is global search across every session you've ever had.

## The permission prompt: which button?

In the default permission mode, Claude stops and asks before editing a file or running a risky command. The dialog previews the change, then offers three buttons:

- **Allow** — just this once. The same operation will ask again next time.
- **Allow for session** — stop asking for this kind of operation in this session. It resets when the session closes.
- **Deny** — don't run it. Claude gets the refusal and tries another approach.

When in doubt, pick **Allow** — being asked a few extra times costs nothing. If you can't tell what it's about to do, click **Show full input** to see the raw arguments.

### The five permission modes

![The five permission modes in the composer (Chinese interface)](../../images/app/en/permission-modes.webp)

The permission button in the composer toolbar sets the overall strictness:

| Mode | What it does |
|---|---|
| Ask permissions | Confirm file edits and higher-risk commands when CLI asks |
| Auto accept edits | Claude writes to disk without asking |
| Auto mode | Claude reviews tool calls and runs actions it considers safe |
| Plan mode | Architecture and reasoning only, no files |
| Bypass permissions | Full tool access for shell and file system |

**Auto mode** and **Bypass permissions** each require a one-time confirmation. In Plan mode Claude produces a plan without touching files; when it's done you get a "Ready to code?" prompt where you can approve the plan or send it back for changes.

The permission mode is locked while a turn is running and unlocks when the turn finishes.

:::warning
**Bypass permissions** hands over your shell and your entire file system. Use it only in an isolated environment you can restore.
:::

## Undoing a turn

After each turn that changes files, a card appears in the conversation reading "**{n} files changed**", listing every file that turn touched. It offers two actions:

- **Undo current turn** — roll back the latest reply and restore the files it changed.
- **Roll back to before this turn** — for older turns: rewind both the conversation and the files to that checkpoint.

Both ask for confirmation first, where you choose between rolling back **code and conversation together** or **the conversation only** (leaving the files on disk untouched).

For a text-only turn, or a failed turn that made no file changes, no empty file card is shown. A lightweight **Roll back conversation** action appears below the response instead. It rewinds the session to before that turn, refills the original prompt, and leaves files on disk untouched.

Checkpoints capture the files Claude changed through its editing tools. **Files written by shell commands are not checkpointed** — `npm install`, `rm`, or a command redirecting into a file cannot be undone. On such a turn the card and the confirmation name the tools that went unrecorded; undo still works, but it only restores the files it lists. Use git for anything you need a guaranteed way back from.

When a turn's file checkpoint is itself incomplete (a damaged session log, an unsafe path), the code cannot be restored and the confirmation offers only **Roll back conversation only** — the conversation can always be rewound.

## The Activity panel

The first button on the right of the tab bar opens the Activity panel, which lists everything running in parallel for this session:

- **Tasks** — the to-do list Claude maintains for itself, with "Task progress 3/7" at the top.
- **SubAgents** — the agents it delegated to. Open one to read its full transcript.
- **Background tasks** — commands and workflows running in the background; each can be stopped individually.
- **Team** — when an Agent Team is in play, one row per member, and you can message a member directly.

Tool activity from background subagents bubbles up here too, so you don't have to wait for one to finish to see what it's doing.

## What the composer can do

![The slash-command panel that opens when you type `/` (Chinese interface)](../../images/app/en/composer-slash.webp)

- **`/` slash commands** — type `/` for the command panel. `/status` for session state and usage, `/context` for context breakdown, `/compact` to compress, `/review` to review changes, `/commit`, `/memory` to open project memory, `/doctor` to open the diagnostics check.
- **`@` file and session references** — type `@` to search files and past sessions. Files are attached as paths; sessions appear as clickable references.
- **Attachments** — click `+`, drag files in, or paste a screenshot. Images, PDFs, and directories all work.
- **Context usage ring** — the small ring shows how much of the context window is used; hover it for used, free, and window size. When it fills up, run `/compact`.
- **Model and effort** — switch models at any time. Effort has five levels — low, medium, high, xhigh, max — and models that don't support a level ignore it.
- **Location** — shows the current project and branch. In a Git project you can switch branches here, or turn on **Isolated worktree** to keep an experiment off your main branch. See [Workspace](./workspace.md).

Enter sends and Shift+Enter inserts a newline by default; **Settings → General** can swap that to `Ctrl/Cmd+Enter`. `⌘.` stops the current generation.

## Referencing sessions and delegating work

Type `@`, select a past session, and explain what to reuse: for example, “Use the conclusions from @Login design to add a sign-out flow.” A reference does not copy the full history or generate a summary. Claude reads a page of the referenced conversation when needed and can request more pages. Click a reference in a message to open its source. Referencing a session does not message it or restart its work.

To work in parallel, ask: “Create two independent sessions: one to review the API and one to review the tests. Share findings and report back here.” Claude can use these tools:

| Tool | Purpose |
|---|---|
| `ListSessions` | Find existing sessions |
| `ReadSession` | Read conversation content in pages |
| `CreateSession` | Create an independent session and assign work |
| `SendSessionMessage` | Send a message to another session |
| `WaitSessions` | Wait for task status changes |

New sessions appear in the session list and can be opened for direct follow-up. The collaboration panel shows members and messages, with links to each conversation. Queued, accepted, and consumed messages represent delivery stages, not successful task completion.

Each collaboration group runs up to three worker sessions at a time; additional workers wait in the queue. The coordinating session does not count toward those three slots. Manual messages to queued workers follow the same limit: when all slots are occupied, the app asks you to retry later and keeps the original assignment queued. New workers in Git projects use separate worktrees. Outside Git, they use the specified directory, so simultaneous edits to the same file still need coordination. Include necessary background in each task prompt: new workers do not automatically inherit the coordinator’s full history.

**Stop group** cancels unconsumed messages and queued assignments, stops the whole group, and prevents completion reports from waking it automatically. To continue a member, open its session and send a new user message; this does not resume the entire group. The ordinary Stop button stops only the current session. Each session still applies its own permissions, and a peer message cannot grant approval on your behalf.

Collaboration is limited to local sessions managed by this desktop app. It does not connect to Claude Code or Codex sessions on other machines.

## Forking a conversation

Every past message has **Fork a new conversation**. It branches a new session from that point: everything before it is kept, everything after is up for grabs. Use it when you want to try a different approach without losing the thread you already have.
