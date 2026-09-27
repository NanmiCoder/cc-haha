---
title: Practical guides: from goal to verification
nav_title: Guide overview
description: Five real tasks to practice with cc-haha, from understanding a project to scheduled work and phone access.
order: 0
---

# Practical guides: from goal to verification

You do not need to memorize every setting first. Pick a task you want to finish and follow its steps. Every guide has prerequisites, a prompt you can copy, and a way to check the result.

## Choose your task

| Your goal | Start here | What you practice |
|---|---|---|
| You inherited an unfamiliar codebase | [Understand a project in 10 minutes](./explore-project.md) | Select a folder, use Plan mode, check evidence |
| You can reproduce an error | [Fix a bug and check for regressions](./fix-bug.md) | Scope the change, test, review the diff |
| You want to add a web feature | [Build a feature and preview it](./ship-feature.md) | Implement in steps, preview, give line-level feedback |
| You want to check a repo daily | [Set up a daily code review](./daily-review.md) | Schedule a task, run it once, inspect logs |
| You need to leave your desk | [Continue a session on your phone](./phone-handoff.md) | Pair H5, check progress, respond remotely |

## A repeatable rhythm

1. **State the goal and boundary.** Say what success looks like, which folders are in scope, and what requires your approval.
2. **Ask for evidence.** Request the files inspected, commands actually run, test results, and a change list.
3. **Verify it yourself.** Review the diff in the workspace. For code changes, check `git status`, `git diff`, and the relevant tests on disk. A model's “done” message is not the final check.

Need to install or connect a model? Start with [your first session](../start/first-session.md). If you cannot find a control, use the [desktop feature map](../desktop/index.md).
