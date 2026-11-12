---
title: Fix a bug and check for regressions
nav_title: Fix a bug
description: Give Claude reproduction steps, ask it to identify the cause and add a test, then review a focused fix.
order: 2
---

# Fix a bug and check for regressions

“The button is broken” is hard to verify. “Saving once creates two identical records” is reproducible. Give the input, expected behavior, and actual result so you can tell whether the fix works.

## Before you start

- Use a Git project and note any changes already present. Select **Ask permissions** so you can review edits and commands.
- Reproduce the issue once yourself. Write down the steps, error message, and affected page or command.
- If you only want a proposal first, investigate in [Plan mode](../desktop/sessions.md), then start an implementation turn.

## Steps

1. Start a session in the affected project. Replace the bracketed text with your actual observations.

```text
Fix this reproducible issue:
Steps: [for example, open the task list and click Save once]
Expected: [for example, exactly one task is added]
Actual: [for example, two identical tasks appear]
Environment or error: [browser, OS, log; write “none yet” if unknown]

First identify the cause and show me the evidence. Then add a regression test that reproduces this issue and make the smallest practical fix.
Do not refactor unrelated files. Explain the purpose of any command you need to run.
When done, list changed files, tests actually run and their results, and any remaining unverified risk.
```

2. Read the tool cards and permission prompts. Confirm Claude is reading the right project and changing relevant files before allowing an action. Open **Show full input** for a command you do not understand.
3. After the turn, open **Workspace → Changed files** and inspect every diff. Add a line comment if needed, such as “Cover empty input here”; the comment and its location go back to the composer.
4. Reproduce the original steps locally and run the project's relevant tests. Check `git status` and `git diff` for unrelated changes.

## Expected result

Claude should show the cause and supporting evidence, a test covering the original problem, and the result after the fix. A statement that a test “should pass” is not evidence it ran; check the command record.

## Acceptance and common snags

- The original steps now produce the expected behavior; the regression test passes after the fix and targets the affected behavior.
- No test framework? Ask for the project's existing verification method. Avoid adding a whole framework for a small fix without good reason.
- Session rollback only restores files captured through editing tools; files generated or changed by shell commands might remain. Verify the final disk state with Git. See [session rollback](../desktop/sessions.md).

Next, try [building and previewing a feature](./ship-feature.md).
