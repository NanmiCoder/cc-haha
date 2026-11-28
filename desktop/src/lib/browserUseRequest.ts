import type { BrowserPreferredTarget } from '@/api/browserUse'

/**
 * The message wrapper behind the composer's Browser Use switch.
 *
 * Armed, the next message goes to the model with an instruction block in front
 * of it carrying the chosen target (`auto` | `workspace` | `chrome`), while
 * the bubble shows only what the user typed plus a read-only Browser pill. The
 * block has a tag of its own so a reloaded transcript, session title, and edit
 * draft can strip or recover it cleanly; its text is English on purpose, since
 * it talks to the model, not the user.
 */

const OPEN_TAG_PREFIX = '<browser-use-request'
const CLOSE_TAG = '</browser-use-request>'

const REQUEST_BLOCK =
  /<browser-use-request(?:\s+target="(auto|workspace|chrome)")?>[\s\S]*?<\/browser-use-request>\n*/

export function getBrowserUseRequestInstruction(
  target: BrowserPreferredTarget = 'auto',
): string {
  if (target === 'workspace') {
    return (
      'Use Browser Use (prefer target="workspace", the built-in Workspace Browser) for this request: ' +
      'observe with BrowserSnapshot, act in small steps with BrowserAct, and pause via BrowserTakeover ' +
      'for login, 2FA, CAPTCHA, or payment.'
    )
  }
  if (target === 'chrome') {
    return (
      'Use Browser Use (prefer target="chrome", the connected System Chrome browser) for this request: ' +
      'observe with BrowserSnapshot, act in small steps with BrowserAct, and pause via BrowserTakeover ' +
      'for login, 2FA, CAPTCHA, or payment.'
    )
  }
  return (
    'Use Browser Use for this request: use the native Browser* tools ' +
    '(BrowserTabs, BrowserNavigate, BrowserSnapshot, BrowserAct, BrowserInspect, BrowserTakeover) ' +
    'to handle web tasks, and pause via BrowserTakeover for login, 2FA, CAPTCHA, or payment.'
  )
}

export function withBrowserUseRequest(
  content: string,
  target: BrowserPreferredTarget = 'auto',
): string {
  const block = `<browser-use-request target="${target}">\n${getBrowserUseRequestInstruction(target)}\n${CLOSE_TAG}`
  return content ? `${block}\n\n${content}` : block
}

/** The user-facing text of a message, with the Browser Use block removed. */
export function stripBrowserUseRequest(text: string): {
  content: string
  requested: boolean
  target?: BrowserPreferredTarget
} {
  if (!text.includes(OPEN_TAG_PREFIX)) return { content: text, requested: false }
  const match = REQUEST_BLOCK.exec(text)
  if (!match) return { content: text, requested: false }
  const content = text.replace(REQUEST_BLOCK, '')
  const target = (match[1] as BrowserPreferredTarget | undefined) ?? 'auto'
  return { content, requested: true, target }
}
