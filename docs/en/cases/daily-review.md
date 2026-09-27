---
title: Set up a daily code review
nav_title: Daily review
description: Create a scheduled task that reports findings, run it immediately, and inspect the result in the logs.
order: 4
---

# Set up a daily code review

If you want a quick look at yesterday's changes when you open your computer, save a review prompt as a scheduled task. Run it manually first, then let it repeat on workdays.

## Before you start

- Connect a model and choose a project whose Git history you can inspect.
- The desktop app must be open and the computer awake. Missed runs are not replayed; [scheduled tasks](../desktop/schedule.md) run locally.
- Scheduled tasks use **full permissions**. Choose the narrowest practical working directory and read the prompt below. For an isolated trial, enable the task's worktree option.

## Steps

1. Open **Scheduled → ＋ New task** in the sidebar. Name it `daily-code-review` and describe it as “Review commits from the last 24 hours on workdays.”
2. Set the repository as **working directory**, choose a configured model, and set frequency to **workdays** at a time when your computer is normally on. Leave notifications off for the first run; turn on desktop or messaging notifications after you trust the output.
3. Paste the prompt. For the first trial, you can change “last 24 hours” to a range you know contains a commit.

```text
Review only commits in this repository from the last 24 hours. Do not edit files, commit code, or install dependencies.
List the commits you actually found first. If there are none, say “no commits to review.”
For each possible issue give the file and line, the trigger, the impact, and a way to verify it. Do not list issues without evidence.
End with three lines: scope reviewed, number of findings, and the one thing I should handle first.
If you cannot read Git history or run a check, state why. Never call a check “passed” if you did not run it.
```

4. Save and click **Run now** on the task card. Open **Logs**, read the status and summary, then use **View full conversation** to verify the actual commands and findings.
5. If the report is vague, edit the prompt to name the directories or risks that matter, and run it again. Leave the task enabled once the result is useful.

## Expected result

The first run leaves a status and full session in the logs. The report should cite traceable findings, explicitly say there were no commits, or say it found no issues. “Code quality looks good” alone is not verifiable.

## Acceptance and common snags

- Check that cited commits belong to the intended repo and time range. Open one cited file to verify the location and finding.
- If nothing runs, check that the app is open, the computer awake, the task enabled, and the scheduled time correct.
- “Review only” is a prompt instruction, not a permission boundary. Full permissions still apply. Keep the working directory narrow, consider an isolated worktree, and inspect the full first run.
- Frequent runs increase model use; start with once a day. The [scheduled task reference](../desktop/schedule.md) explains every field and log action.
