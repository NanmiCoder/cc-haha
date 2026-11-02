---
title: Scheduled tasks
nav_title: Scheduled tasks
description: Schedule a conversation to continue later, edit recurring plans, and read actual execution results.
order: 5
---

# Scheduled tasks

Save instructions to run at a specified time. A task can continue an existing chat or open a new chat on each run. Task cards in chat and the **Scheduled** sidebar page manage the same plans.

## Create from chat or the task page

In a standard desktop conversation, describe the work and time:

```text
Tomorrow at 9 am Beijing time, continue reviewing yesterday's commits in this chat. Report only evidence-backed findings.
Review this project every weekday at 9 am, opening a new chat each time.
```

You can also use the built-in `/schedule`, for example `/schedule show this chat's scheduled tasks`. No additional skill installation is required. A successful creation produces a task card with the name, schedule, and status. Choose **Open task** to edit it. A task is created only after a successful result.

Alternatively, open **Scheduled → + New task** in the sidebar. Tasks created there default to opening a new chat each time; tasks created in conversation default to continuing that conversation.

:::warning
Tasks run locally and require the desktop app to be open and the computer awake. If a new task misses its time, it catches up once when the app resumes and the target chat is idle. Recurring tasks do not replay every interval missed while offline. Older independent cron tasks retain their previous behavior and do not catch up missed triggers.
:::

## Time and execution location

- **Name, description, and instructions** — use a recognizable name; description is optional. Specify the work and expected output. A task that opens a new chat especially needs self-contained instructions.
- **Repeat** — once, every N minutes, every N hours, daily, weekdays, specific days, monthly, or a custom five-field cron expression (minute, hour, day, month, weekday).
- **One-time date and time zone** — choose **Once**, then enter the date, time, and time zone, such as `Asia/Shanghai`. Recurring plans also use the saved time zone. Check the displayed time before saving. A one-time task stops firing automatically after its run ends; its history remains available.
- **Continue a chat** — select a target under **Run in**. The task uses that chat's model, permissions, and workspace; scheduling does not grant it full permissions. Execution waits while the chat is busy.
- **Open a new chat each time** — each run gets an independent conversation. Configure its model, workspace, and optional isolated worktree. Tasks created from a chat inherit default runtime settings from their source chat. For tasks created independently on the task page, check the model, directory, and permissions shown in the editor.
- **Independent task (existing settings)** — upgrades preserve older tasks' standalone execution. They are not automatically attached to a chat. Their previous full-permissions setting remains unchanged; you can explicitly change the execution mode to continue a chat or open new chats.

The working directory is the starting location, not a file-access sandbox. An isolated worktree separates the Git working copy; it is not a permission boundary.

## Cards and markers in chat

- Creating, viewing, or updating a task produces a chat card. Cards and the task list share the same editor for instructions, timing, notification preferences, pause, and resume. Delete tasks from the task list menu.
- Chats with attached plans show a clock in the sidebar. Hover to see the task count, next run, or paused state. Completed one-time tasks and deleted tasks no longer appear as active plans.
- When a task fires, the chat shows a dedicated **Sent by scheduled task** introduction with its name and time. Select it to open the task. This provenance remains visible after reopening the conversation.
- Deleting a task preserves its previous chat card and execution records. It prevents future runs and does not undo completed actions.

## Read execution results

**Logs** on the task page shows running, completed, failed, or timed-out runs and their duration. Read the output summary, or choose **View full conversation** when a session is linked. **Run now** executes immediately and can perform the same real actions as a scheduled trigger.

You can also ask in chat:

```text
List my scheduled tasks.
Read the latest result for daily-code-review. If it failed, explain why.
The last result was truncated; read the remaining output.
```

The assistant reads saved execution records and output rather than inferring a result from the task instructions. A running task or an empty history is not proof of success. Long output can be read in further pages. Results remain queryable from retained execution records after a plan is deleted.

## Notification preferences

Enable notifications, choose desktop or configured messaging channels, and select:

| Preference | Behavior |
| --- | --- |
| Important updates | Notify for meaningful changes, completion, failure, or required user action; unchanged checks can stay silent |
| Every completed run | Notify after every run ends, including failures |
| Failures only | Notify on failure or timeout |
| Off | Send no task notifications; results remain available in chat and logs |

Tasks created in conversation default to **Important updates** and desktop notifications. Explicit requests to disable them are preserved. Desktop notifications still require **Settings → General → System Notifications** and OS permission. See [Phone (H5) and IM](./remote.md) for messaging-channel setup. Older tasks retain their existing notification settings.

## Practical tips

1. Trial a narrowly defined task and inspect its output before choosing a repeat frequency.
2. Trialing a one-time task performs real work too. **Run now** is not a side-effect-free preview.
3. Frequent runs increase model use. Start routine reviews at once a day.
4. If a task fails, its target chat is deleted, or its workspace is unavailable, inspect the logs before retrying to avoid repeating completed external actions.
