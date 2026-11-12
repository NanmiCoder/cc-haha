---
title: Build a feature and preview the page
nav_title: Build a web feature
description: Turn a web request into verifiable steps, preview the page, and give precise diff feedback.
order: 3
---

# Build a feature and preview the page

“The code is written” and “the page works” are two separate checks. This example adds search to an existing list; replace it with your own web feature if you prefer.

## Before you start

- Use a web project you can already run locally. Know its start command and local URL.
- For an experiment, choose an [isolated worktree](../desktop/workspace.md) in the composer **run location**. Note uncommitted changes in your original folder; they are not copied into the worktree.
- Keep **Ask permissions** so you can inspect file edits and server commands.

## Steps

1. Send the request in a project session. Replace the list, field, and commands with your project's details.

```text
Add a search field to [the task list page]. Filter by [title] without case sensitivity as I type. Clearing the field shows every item again. Show a clear empty state when nothing matches.
First find the existing list component and tests, then tell me which files you plan to change. Follow the project's existing styles and test conventions. Do not change unrelated pages.
When finished, run relevant tests and tell me the local preview command, expected URL, and what you actually verified.
```

2. Review permission prompts and inline diffs. If Claude proposes installing dependencies or a broad redesign, ask why before proceeding.
3. Start the development server following the project's instructions. Switch the right [workspace](../desktop/workspace.md) to **Browser** and open the local URL, such as `http://localhost:3000`. Use the port printed by your server.
4. Try three states: the original list, a query with results, and a query without results. The workspace browser's **Screenshot** button can send the current page back to the session; **Select element** can send a specific element's position and screenshot.
5. If something fails, comment on the relevant diff line or send reproduction steps in the session. Ask Claude to fix that issue only. Repeat the three checks and inspect `git diff`.

## Expected result

The list updates as you type, resets when cleared, and shows an empty state for no matches. Relevant tests pass and the workspace shows the expected file changes.

## Acceptance and common snags

- Do not rely on a screenshot alone: type, erase, and rapidly change a query yourself.
- If the page will not load, confirm the development server is still running and its address and port match the terminal output.
- Screenshot and Select element send the page state to Claude. Check for personal data before capturing or sharing a signed-in page.
- Review worktree changes and decide how to keep them before the temporary workspace is cleaned up; do not treat it as a backup.
