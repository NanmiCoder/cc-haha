import type { ApiClient } from './client'

export type BrowserPreferredTarget = 'auto' | 'workspace' | 'chrome'

export type ComposerBrowserUseConfig = {
  enabled: boolean
  preferredTarget: BrowserPreferredTarget
  consentAcceptedAt?: string
}

const OPEN_TAG_PREFIX = '<browser-use-request'
const CLOSE_TAG = '</browser-use-request>'
const REQUEST_BLOCK =
  /<browser-use-request(?:\s+target="(auto|workspace|chrome)")?>[\s\S]*?<\/browser-use-request>\n*/

export function normalizeBrowserTarget(value: unknown): BrowserPreferredTarget {
  return value === 'workspace' || value === 'chrome' ? value : 'auto'
}

export function browserTargetLabel(target: BrowserPreferredTarget): string {
  if (target === 'workspace') return '工作区'
  if (target === 'chrome') return 'Chrome'
  return '自动'
}

export function browserUsePillLabel(target: BrowserPreferredTarget): string {
  return `浏览器 · ${browserTargetLabel(target)}`
}

export function getBrowserUseRequestInstruction(
  target: BrowserPreferredTarget = 'auto'
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
  target: BrowserPreferredTarget = 'auto'
): string {
  const block = `<browser-use-request target="${target}">\n${getBrowserUseRequestInstruction(target)}\n${CLOSE_TAG}`
  return content ? `${block}\n\n${content}` : block
}

export function stripBrowserUseRequest(text: string): {
  content: string
  requested: boolean
  target?: BrowserPreferredTarget
} {
  if (!text.includes(OPEN_TAG_PREFIX)) return { content: text, requested: false }
  const match = REQUEST_BLOCK.exec(text)
  if (!match) return { content: text, requested: false }
  return {
    content: text.replace(REQUEST_BLOCK, ''),
    requested: true,
    target: normalizeBrowserTarget(match[1]),
  }
}

function normalizeConfig(value: {
  enabled?: unknown
  preferredTarget?: unknown
  consentAcceptedAt?: unknown
}): ComposerBrowserUseConfig {
  return {
    enabled: value.enabled === true,
    preferredTarget: normalizeBrowserTarget(value.preferredTarget),
    ...(typeof value.consentAcceptedAt === 'string' && value.consentAcceptedAt
      ? { consentAcceptedAt: value.consentAcceptedAt }
      : {}),
  }
}

export async function loadComposerBrowserUse(
  client: ApiClient,
  signal: AbortSignal
): Promise<ComposerBrowserUseConfig> {
  const data = await client.get<Record<string, unknown>>(
    '/api/browser-use/config',
    { signal }
  )
  return normalizeConfig(data)
}

export async function enableComposerBrowserUse(
  client: ApiClient
): Promise<ComposerBrowserUseConfig> {
  const data = await client.request<Record<string, unknown>>(
    '/api/browser-use/config',
    {
      method: 'PUT',
      body: {
        enabled: true,
        consentAcceptedAt: new Date().toISOString(),
      },
    }
  )
  return normalizeConfig(data)
}

export async function setComposerBrowserUseTarget(
  client: ApiClient,
  preferredTarget: BrowserPreferredTarget
): Promise<ComposerBrowserUseConfig> {
  const data = await client.request<Record<string, unknown>>(
    '/api/browser-use/config',
    {
      method: 'PUT',
      body: { preferredTarget },
    }
  )
  return normalizeConfig(data)
}
