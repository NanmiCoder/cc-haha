import { registerBundledSkill } from '../bundledSkills.js'

const SCREENSHOT_PROMPT = `# /screenshot — capture the screen, an app window, or a region

Take a screenshot when the user wants you to *look at* something on their machine, or when you need to verify visual output (a layout, a chart, a desktop app, an external dialog) that is not reachable via Read/WebFetch.

## When to use this skill

- User says: "look at <App>", "see what my screen shows", "check what the dialog says", "compare this to the design"
- You're debugging a UI bug and need ground truth pixels
- A tool produced an image artifact and the user wants you to inspect it visually

**Do not use** if a more targeted tool fits:
- Browser pages → use \`mcp__chrome-devtools__take_screenshot\` (it gives you an a11y snapshot too)
- Figma designs → use the Figma / Pencil MCP screenshot tool
- This app's own UI → use \`mcp__layout-editor__layout_get_preview_image\`

This skill is the **fallback for whole-system or non-browser desktop apps**, and the entry point when the user hasn't told you which target to capture.

## Tool selection by target

| Target | Tool to call |
|--------|-------------|
| A specific desktop application window | \`mcp__computer-use__screenshot\` after \`mcp__computer-use__request_access\` for that app |
| The entire current display | \`mcp__computer-use__screenshot\` (returns the active display) |
| A small UI region | \`mcp__computer-use__zoom\` after a full screenshot — coordinates refer to the **last full-screen screenshot** |
| Saving the file for the user | Pass \`save_to_disk: true\` and surface the returned path |

## Workflow

1. **Decide the target**. If the user didn't say, ask which app or display, unless context makes it obvious (the only running editor, the front-most window they just mentioned).
2. **Request access if needed**. \`mcp__computer-use__request_access\` is required before the first capture in a session, and again whenever you need an app you didn't previously list. Provide a one-sentence \`reason\` describing the visual task.
3. **Take the screenshot**. Default to a full-screen capture so the user (and you) can see context. If you only need a small region for inspection, take the full screenshot first, then call \`zoom\` with a tight rectangle.
4. **Read it**. The screenshot returns inline as an image — describe what you see *and* point to the exact region that answers the user's question. If text is small, zoom rather than guessing.
5. **Save only when asked**. If the user wants the file, set \`save_to_disk: true\` and report the path. Don't dump screenshots to disk for your own inspection.

## Multi-display

If the system has more than one monitor, the screenshot tool tells you which one it captured and lists the others by name. Use \`switch_display\` only if the target is on a non-primary monitor — don't switch back and forth speculatively.

## After looking

State what you observed in plain language *first*, then take action (fix the layout, answer the question, file the bug). The screenshot is evidence; the user wants the conclusion.

## Privacy

Screenshots can include private content (chat windows, notifications, password fields). Don't echo the entire frame contents into chat — describe what's relevant. Don't keep screenshots around longer than the immediate task.
`

export function registerScreenshotSkill(): void {
  registerBundledSkill({
    name: 'screenshot',
    description:
      'Capture the screen, a specific app window, or a zoomed region — fallback when no targeted screenshot tool fits.',
    userInvocable: true,
    async getPromptForCommand(args) {
      let prompt = SCREENSHOT_PROMPT
      if (args) {
        prompt += `\n\n## Capture target / focus\n\n${args}`
      }
      return [{ type: 'text', text: prompt }]
    },
  })
}
