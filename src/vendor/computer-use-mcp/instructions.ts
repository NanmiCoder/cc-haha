/**
 * Server-level guidance handed to the model at MCP initialize.
 *
 * WHY THIS EXISTS
 * ---------------
 * We shipped ten well-described tools and no strategy, and it showed. Across
 * three recorded real-machine sessions on the same task the model:
 *   - called `list_apps` first just to look up an identifier it could have
 *     passed straight to `get_app_state`;
 *   - kept clicking element handles in an app whose accessibility tree is a
 *     bare shell, never switching to the screenshot coordinates it already had;
 *   - repeated one identical failing action many times without changing tactic;
 *   - inserted its own waits between an action and the next state read;
 *   - and finally abandoned the toolset for `osascript` and Python.
 *
 * This is our operating guidance for the native JavaScript and semantic tools.
 * The facade follows the inspected official native App API; it does not expose
 * the official browser provider or general Node runtime.
 * The bundled skill is the enabled product entry point; this export also serves
 * hosts and tests that consume the guidance directly.
 *
 * Keep this SHORT and behavioural. Every line should change what the model does
 * at a specific decision point — this text is paid for on every session, and a
 * paragraph the model cannot act on is pure cost.
 */
/** Shared with the bundled skill so both entry points teach the same observation boundary. */
export const COMPUTER_USE_BATCHING_GUIDANCE = `## Persistent JavaScript and known actions

Prefer \`js({code})\` for native app work. Start with
\`var app = await cua.getApp("App Name")\`: it displays initial AX state and, once
per session, App API guidance. Variables, App bindings, calculations, loops, and
top-level await work across cells. Do not force one model round trip per click.
Await every action. In a stable canvas, after observing the actual coordinates,
one cell can perform known drags and inspect their result:

\`\`\`javascript
for (const x of [240, 280]) await app.drag([x, 320], [x + 1, 320])
await app.getAXStateAndScreenshot()
\`\`\`

Use \`app.getAXState()\` for text, \`app.getScreenshot()\` for an image, or
\`app.getAXStateAndScreenshot()\` for both. \`{emit:false}\` returns data without
displaying it; use \`nodeRepl.write(value)\` or \`await nodeRepl.emitImage(bytes)\`
when needed. These methods select output; all still use the same native capture.
Use copied \`gN:id\` handles for element actions. Integer indices map only to
observed handles; after image-only capture, call
\`app.getAXState({disableDiffing:true})\` before using integers again.

Batch only while prerequisite state remains known. An unfamiliar menu, dialog,
navigation, changed layout, or any error requires you to stop and re-observe.
A click may do nothing in some canvas apps; after inspecting that result, a short
0–1 pixel drag can be an alternative. Inspect before repeating the strategy.
Do not add a fixed sleep before observing, or blindly replay a partial batch.

When a task explicitly needs a delay, await
\`new Promise(resolve => setTimeout(resolve, milliseconds))\`.
\`setTimeout\`/\`clearTimeout\` and \`setInterval\`/\`clearInterval\` are available
with numeric handles. Timers belong to the current cell and are cleared when it
ends; do not schedule actions to run after the cell returns.

Each JS cell allows 256 native calls, 256 KiB of code, and 128 output blocks up
to 16 MiB. \`timeout_ms\` defaults to 30000 and cannot exceed 60000. Ordinary
script errors retain bindings. Timeout, cancellation, and \`js_reset\` discard
them: select the app again, observe, and account for actions that already ran.
Browser/DOM APIs, imports, Node, filesystem, and networking are unavailable.

Only \`js\` and \`js_reset\` are advertised on macOS. The older semantic tools and
\`sequence\` remain compatibility interfaces for existing clients; use the App
methods above in this session.
`.trim()

export const COMPUTER_USE_INSTRUCTIONS = `
Operate macOS apps through the accessibility engine. Read this before your first action.

## Loop

1. Use \`js\` to bind an app with \`cua.getApp("App Name")\` and read its initial
   AX state. Request \`app.getScreenshot()\` when visual information is needed.
2. Perform known actions in the same JS session, then observe at a decision point.
3. Inspect state and screenshots before choosing further actions.

${COMPUTER_USE_BATCHING_GUIDANCE}

Do not add a fixed sleep before an observation. The observation path waits
for UI changes when needed. Read its result before deciding whether more context
is necessary.

## Naming the app

Pass the app name directly to \`cua.getApp\` — display name, bundle identifier,
or full path all work. Do NOT call \`cua.listApps()\` just to look up an identifier.
If a call fails by display name, retry the same call with the bundle
identifier before investigating anything else. Use \`cua.listApps()\` only when you
genuinely cannot name the app.

## Choosing between element handles and coordinates

Prefer \`app.click("gN:id")\` when the control is
actually in the tree: it targets the element directly and survives window movement.

Switch to \`[x,y]\` read off the screenshot when either is true:
  - the tree does not contain what you need (many Chromium/Electron apps expose
    only their window frame and menu bar — AX state says so explicitly when
    it detects this), or
  - element actions run but the UI does not change.

Coordinates are read off the returned screenshot in its own pixel space; pass them
as-is. Do not convert them.

## Telling whether an action worked

Awaiting a JS action or receiving a standalone dispatch receipt means the action
was dispatched, NOT that it had the intended effect. Inspect a fresh observation
from the JS App to know.

Judge success from the screenshot as well as the AX text. An empty AX diff does
not mean a Chromium/CEF interface stayed unchanged. If two consecutive screenshots
leave the relevant UI unchanged, the approach is wrong.
Change something real: switch from element handle to coordinates, target a
different element, re-read the full tree with \`app.getAXState({disableDiffing:true})\`, or take a
different route through the UI. Repeating the same call a third time never helps.

If you cannot make progress after a few genuinely different attempts, say so and
report what you observed. Do not fall back to \`osascript\`, AppleScript, System
Events, or shell scripting to drive the UI — those paths are unavailable and will
waste the user's time.

## Tool notes

- \`app.getAXState()\` returns a diff against the previous read by default. Pass
  \`{disableDiffing:true}\` when you need the full tree — for example after acting on a
  screenshot alone, or when the diff has left you unsure of the current state.
- \`app.performSecondaryAction(element,action)\` only accepts an action actually listed for that
  element in the tree. Do not guess action names.
- \`app.pressKey\` and \`app.typeText\` are delivered to the named app, so they cannot
  trigger global system shortcuts.
- If \`app.typeText\` does not visually change a Chromium/CEF field, use
  \`app.paste(text,{format:"text"})\`; it restores the user's prior clipboard.
  If paste times out after dispatch, treat the result as unknown and call
  \`app.getAXStateAndScreenshot()\` after rebinding before retrying, because the target may have consumed it late.
- \`app.pressKey\` uses xdotool key names: "a", "Return", "Tab", "Up", "super+c".
- \`app.selectText\` works inside editable elements; use \`prefix\`/\`suffix\` to
  disambiguate repeated matches.
`.trim()
