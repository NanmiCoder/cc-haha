import { z } from 'zod/v4'

const tabIdSchema = z.string().min(1).max(200)
const targetSelectorSchema = z.enum(['auto', 'workspace', 'chrome'])

/**
 * Flat action step schema intentionally avoids `z.discriminatedUnion` / `oneOf`
 * so multi-provider JSON Schema projections (including Gemini's
 * `parametersJsonSchema`) stay flat and 100% compatible.
 * Matches `FlatActionStep` in `src/services/browserUse/types.ts`.
 */
export const flatActionStepSchema = z.strictObject({
  action: z
    .enum([
      'click',
      'dblclick',
      'fill',
      'type',
      'press',
      'select',
      'hover',
      'scroll',
      'wait',
      'dialog',
    ])
    .describe('Browser interaction verb to execute.'),
  ref: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe('Snapshot element ref (e.g. "@e4") from the most recent BrowserSnapshot.'),
  text: z
    .string()
    .max(32_000)
    .optional()
    .describe('Text to enter for fill/type actions.'),
  key: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe('Keyboard key name for press action (e.g. "Enter", "Tab", "Escape", "ArrowDown").'),
  value: z
    .string()
    .max(4096)
    .optional()
    .describe('Option value or label for select action.'),
  clear: z
    .boolean()
    .optional()
    .describe('Clear existing field text before typing (default true for fill).'),
  submit: z
    .boolean()
    .optional()
    .describe('Press Enter after typing/filling.'),
  button: z
    .enum(['left', 'right', 'middle'])
    .optional()
    .describe('Mouse button for click/dblclick (default "left").'),
  modifiers: z
    .array(z.enum(['Alt', 'Control', 'Meta', 'Shift']))
    .max(4)
    .optional()
    .describe('Optional modifier keys held during click/press.'),
  deltaX: z
    .number()
    .int()
    .min(-10_000)
    .max(10_000)
    .optional()
    .describe('Horizontal scroll delta in pixels.'),
  deltaY: z
    .number()
    .int()
    .min(-10_000)
    .max(10_000)
    .optional()
    .describe('Vertical scroll delta in pixels.'),
  direction: z
    .enum(['up', 'down', 'left', 'right'])
    .optional()
    .describe('Scroll direction for scroll action (default "down").'),
  amount: z
    .number()
    .int()
    .min(1)
    .max(10_000)
    .optional()
    .describe('Scroll distance in pixels for scroll action.'),
  ms: z
    .number()
    .int()
    .min(0)
    .max(15_000)
    .optional()
    .describe('Duration in milliseconds for wait action (capped at 15000ms).'),
  waitForText: z
    .string()
    .max(500)
    .optional()
    .describe('Optional visible text to wait for during a wait step.'),
  waitForSelector: z
    .string()
    .max(500)
    .optional()
    .describe('Optional CSS selector to wait for during a wait step.'),
  accept: z
    .boolean()
    .optional()
    .describe('For dialog action: true to accept, false to dismiss.'),
  promptText: z
    .string()
    .max(4096)
    .optional()
    .describe('Prompt input text when accepting a JS prompt() dialog.'),
  sensitive: z
    .boolean()
    .optional()
    .describe('Mark entered text as sensitive so UI activity logs mask it as ••••••.'),
  label: z
    .string()
    .max(200)
    .optional()
    .describe('Short human-readable description of the target element (e.g. "Submit Order").'),
})

export const browserTabsSchema = z.strictObject({
  action: z
    .enum(['list', 'open', 'focus', 'close'])
    .describe('Tab operation to perform.'),
  tabId: tabIdSchema
    .optional()
    .describe('Target tab ID for focus or close actions.'),
  url: z
    .string()
    .max(4096)
    .optional()
    .describe('Optional http/https URL when opening a new tab.'),
  target: targetSelectorSchema
    .optional()
    .describe('Browser surface preference: "auto", "workspace", or "chrome".'),
})

export const browserNavigateSchema = z.strictObject({
  action: z
    .enum(['goto', 'back', 'forward', 'reload'])
    .optional()
    .describe('Navigation action (defaults to "goto" when url is provided).'),
  url: z
    .string()
    .min(1)
    .max(4096)
    .optional()
    .describe('Destination http:// or https:// URL for goto.'),
  tabId: tabIdSchema
    .optional()
    .describe('Target tab ID (defaults to this session active tab).'),
  target: targetSelectorSchema
    .optional()
    .describe('Browser surface preference: "auto", "workspace", or "chrome".'),
  waitUntil: z
    .enum(['load', 'domcontentloaded', 'none'])
    .optional()
    .describe('Page load readiness condition.'),
  timeoutMs: z
    .number()
    .int()
    .min(1_000)
    .max(60_000)
    .optional()
    .describe('Optional navigation timeout in milliseconds.'),
})

export const browserSnapshotSchema = z.strictObject({
  tabId: tabIdSchema
    .optional()
    .describe('Target tab ID (defaults to this session active tab).'),
  target: targetSelectorSchema
    .optional()
    .describe('Browser surface preference: "auto", "workspace", or "chrome".'),
  diff: z
    .boolean()
    .optional()
    .describe('Return a compact diff against the previous snapshot of this tab.'),
  screenshot: z
    .boolean()
    .optional()
    .describe('Include a compressed viewport screenshot image alongside the AX snapshot.'),
  screenshotFormat: z
    .enum(['jpeg', 'png'])
    .optional()
    .describe('Screenshot image format when screenshot is true (default "jpeg").'),
  includeNonInteractive: z
    .boolean()
    .optional()
    .describe('Include non-interactive structural nodes in addition to interactive @eN elements.'),
  maxNodes: z
    .number()
    .int()
    .min(20)
    .max(2000)
    .optional()
    .describe('Optional cap on serialized snapshot nodes.'),
})

export const browserActSchema = z.strictObject({
  tabId: tabIdSchema
    .optional()
    .describe('Target tab ID (defaults to this session active tab).'),
  target: targetSelectorSchema
    .optional()
    .describe('Browser surface preference: "auto", "workspace", or "chrome".'),
  steps: z
    .array(flatActionStepSchema)
    .min(1)
    .max(10)
    .describe('Ordered batch of 1 to 10 flat browser steps; halts immediately on error, navigation, JS dialog, or takeover.'),
  stopOnNavigation: z
    .boolean()
    .optional()
    .describe('Stop remaining steps if a step triggers page navigation (default true).'),
  autoTakeoverOnSensitive: z
    .boolean()
    .optional()
    .describe('Automatically request user takeover if a step encounters CAPTCHA, payment, or sensitive auth gates (default true).'),
})

export const browserInspectSchema = z.strictObject({
  kind: z
    .enum(['console', 'network', 'text', 'html', 'eval'])
    .describe('Inspection mode: console logs, network requests, visible text, HTML snippet, or bounded JS eval.'),
  tabId: tabIdSchema
    .optional()
    .describe('Target tab ID (defaults to this session active tab).'),
  target: targetSelectorSchema
    .optional()
    .describe('Browser surface preference: "auto", "workspace", or "chrome".'),
  selector: z
    .string()
    .max(500)
    .optional()
    .describe('Optional CSS selector for text/html inspection.'),
  expression: z
    .string()
    .max(4000)
    .optional()
    .describe('JavaScript expression for kind="eval".'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe('Maximum entries to return for console/network logs.'),
  maxChars: z
    .number()
    .int()
    .min(200)
    .max(50_000)
    .optional()
    .describe('Optional character cap for returned text/html/eval content.'),
})

export const browserTakeoverSchema = z.strictObject({
  reason: z
    .enum([
      'captcha',
      'login',
      'two_factor',
      'payment',
      'destructive',
      'permission',
      'user_requested',
      'manual',
      'other',
    ])
    .describe('Structured category explaining why human takeover is required.'),
  message: z
    .string()
    .min(1)
    .max(1000)
    .describe('Clear, human-readable explanation of what the user needs to complete in the browser before clicking Resume.'),
  tabId: tabIdSchema
    .optional()
    .describe('Target tab ID (defaults to this session active tab).'),
  target: targetSelectorSchema
    .optional()
    .describe('Browser surface preference: "auto", "workspace", or "chrome".'),
})

export type FlatActionStepInput = z.infer<typeof flatActionStepSchema>
export type BrowserTabsInput = z.infer<typeof browserTabsSchema>
export type BrowserNavigateInput = z.infer<typeof browserNavigateSchema>
export type BrowserSnapshotInput = z.infer<typeof browserSnapshotSchema>
export type BrowserActInput = z.infer<typeof browserActSchema>
export type BrowserInspectInput = z.infer<typeof browserInspectSchema>
export type BrowserTakeoverInput = z.infer<typeof browserTakeoverSchema>

export const BROWSER_USE_TOOL_NAMES = [
  'BrowserTabs',
  'BrowserNavigate',
  'BrowserSnapshot',
  'BrowserAct',
  'BrowserInspect',
  'BrowserTakeover',
] as const

export type BrowserUseToolName = (typeof BROWSER_USE_TOOL_NAMES)[number]
