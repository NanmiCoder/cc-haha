import { isDesktopScheduleAvailable } from '../../tools/ScheduledTaskTool/gate.js'
import { registerBundledSkill } from '../bundledSkills.js'

export function registerScheduleDesktopSkill(): void {
  registerBundledSkill({
    name: 'schedule',
    description: 'Create, edit, pause, delete, or inspect desktop scheduled tasks and their execution results.',
    whenToUse: 'When the user asks to continue later, set a reminder, schedule recurring work, or read scheduled task results.',
    argumentHint: '[task or question]',
    userInvocable: true,
    isEnabled: isDesktopScheduleAvailable,
    allowedTools: ['ScheduledTask'],
    async getPromptForCommand(args) {
      return [{ type: 'text', text: `Use the ScheduledTask tool to manage the desktop Scheduled Tasks page. First list current-session tasks to learn the current time, time zone, and existing tasks; avoid duplicates. If the request names another task, list with scope all and view the matching task. With no request, show existing tasks and ask what the user wants to schedule.
Default to continuing this conversation. Use new-session only when requested. Use an exact date/time with offset for one-time requests; ask when the intended time is ambiguous. Do not execute the future prompt now. Confirm only after the tool succeeds. Read a task before changing it and preserve unchanged settings. For result questions use runs, then run to read the actual output and status; follow truncation offsets if needed. Tasks only execute while the desktop app is running.

User request:
${args.trim()}` }]
    },
  })
}
