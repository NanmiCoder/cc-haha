/**
 * NotificationService — 定时任务完成后通过 IM 渠道推送通知
 *
 * 直接调用 Telegram Bot API / 飞书 Open API（HTTP），不依赖 adapter sidecar
 * 或第三方 SDK，确保即使 adapter 进程未运行也能推送。
 */

import { adapterService, type AdapterFileConfig } from './adapterService.js'
import type { TaskRun } from './cronScheduler.js'
import type { TaskNotificationConfig } from './cronService.js'

// ─── Message formatting ──────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`
}

function statusEmoji(status: TaskRun['status']): string {
  switch (status) {
    case 'completed': return '✅'
    case 'failed': return '❌'
    case 'timeout': return '⏰'
    default: return 'ℹ️'
  }
}

function statusText(status: TaskRun['status']): string {
  switch (status) {
    case 'completed': return 'Completed'
    case 'failed': return 'Failed'
    case 'timeout': return 'Timeout'
    default: return status
  }
}

/**
 * Build the markdown notification body.
 * Shared between Telegram and Feishu — both support markdown.
 */
function buildMarkdown(run: TaskRun): string {
  const emoji = statusEmoji(run.status)
  const lines: string[] = []

  lines.push(`${emoji} **${run.taskName}**`)
  lines.push('')
  lines.push(`**Status**: ${statusText(run.status)}`)
  if (run.durationMs != null) {
    lines.push(`**Duration**: ${formatDuration(run.durationMs)}`)
  }

  if (run.status === 'failed' && run.error) {
    lines.push('')
    lines.push('**Error**:')
    const errorText = run.error.length > 500 ? run.error.slice(0, 500) + '…' : run.error
    lines.push(errorText)
  }

  if (run.output) {
    lines.push('')
    lines.push('**Result**:')
    const outputText = run.output.length > 2000 ? run.output.slice(0, 2000) + '…' : run.output
    lines.push(outputText)
  }

  return lines.join('\n')
}

// ─── Telegram ─────────────────────────────────────────────────────────────────

const TELEGRAM_API = 'https://api.telegram.org'
const TELEGRAM_TEXT_LIMIT = 4000

async function sendTelegram(
  botToken: string,
  chatId: number | string,
  text: string,
): Promise<void> {
  // Telegram message limit ~4096 chars; trim with margin
  const trimmed = text.length > TELEGRAM_TEXT_LIMIT
    ? text.slice(0, TELEGRAM_TEXT_LIMIT) + '…'
    : text

  const resp = await fetch(`${TELEGRAM_API}/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: trimmed,
      parse_mode: 'Markdown',
    }),
  })

  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    console.error(`[Notification] Telegram send failed (${resp.status}):`, body)
  }
}

// ─── Feishu ───────────────────────────────────────────────────────────────────

const FEISHU_API = 'https://open.feishu.cn/open-apis'

async function getFeishuTenantToken(appId: string, appSecret: string): Promise<string | null> {
  try {
    const resp = await fetch(`${FEISHU_API}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    })
    const data = await resp.json() as { tenant_access_token?: string; code?: number }
    if (data.code === 0 && data.tenant_access_token) {
      return data.tenant_access_token
    }
    console.error('[Notification] Feishu token failed:', data)
    return null
  } catch (err) {
    console.error('[Notification] Feishu token error:', err)
    return null
  }
}

/**
 * Get or create a P2P chat with a user (needed because Feishu send-message
 * requires a chat_id, and pairedUsers stores open_id).
 */
async function getFeishuChatId(
  token: string,
  userId: string,
): Promise<string | null> {
  try {
    const resp = await fetch(`${FEISHU_API}/im/v1/chats?user_id_type=open_id`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        chat_mode: 'p2p',
        user_id_type: 'open_id',
        user_id_list: [userId],
      }),
    })
    const data = await resp.json() as { code?: number; data?: { chat_id?: string } }
    if (data.code === 0 && data.data?.chat_id) {
      return data.data.chat_id
    }
    // Fallback: try sending with open_id directly using receive_id_type=open_id
    return null
  } catch (err) {
    console.error('[Notification] Feishu get chat_id error:', err)
    return null
  }
}

async function sendFeishu(
  token: string,
  userId: string,
  run: TaskRun,
): Promise<void> {
  const emoji = statusEmoji(run.status)
  const headerTemplate = run.status === 'completed' ? 'green' : 'red'
  const headerTitle = `${emoji} ${run.taskName}`

  // Meta line
  const metaLine = [
    `**Status**: ${statusText(run.status)}`,
    run.durationMs != null ? `**Duration**: ${formatDuration(run.durationMs)}` : '',
  ].filter(Boolean).join('　　')

  // Result / error content
  const bodyParts: string[] = []
  if (run.status === 'failed' && run.error) {
    const errorText = run.error.length > 500 ? run.error.slice(0, 500) + '…' : run.error
    bodyParts.push(`**Error**:\n${errorText}`)
  }
  if (run.output) {
    const outputText = run.output.length > 3000 ? run.output.slice(0, 3000) + '…' : run.output
    bodyParts.push(outputText)
  }

  // Schema 2.0 interactive card — renders markdown correctly
  const elements: Record<string, unknown>[] = [
    { tag: 'markdown', content: metaLine, text_align: 'left' },
  ]
  if (bodyParts.length > 0) {
    elements.push({ tag: 'hr' })
    elements.push({ tag: 'markdown', content: bodyParts.join('\n\n'), text_align: 'left' })
  }

  const card = {
    schema: '2.0',
    header: {
      template: headerTemplate,
      title: { tag: 'plain_text', content: headerTitle },
    },
    body: { elements },
  }

  const resp = await fetch(`${FEISHU_API}/im/v1/messages?receive_id_type=open_id`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      receive_id: userId,
      msg_type: 'interactive',
      content: JSON.stringify(card),
    }),
  })

  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    console.error(`[Notification] Feishu send failed (${resp.status}):`, body)
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function sendTaskNotification(
  run: TaskRun,
  notification: TaskNotificationConfig,
): Promise<void> {
  if (!notification.enabled || notification.channels.length === 0) return

  let config: AdapterFileConfig
  try {
    config = await adapterService.getRawConfig()
  } catch (err) {
    console.error('[Notification] Failed to read adapter config:', err)
    return
  }

  const markdown = buildMarkdown(run)

  for (const channel of notification.channels) {
    try {
      if (channel === 'telegram') {
        const botToken = config.telegram?.botToken
        if (!botToken) {
          console.warn('[Notification] Telegram botToken not configured, skipping')
          continue
        }
        const users = [
          ...(config.telegram?.pairedUsers ?? []),
          ...(config.telegram?.allowedUsers ?? []).map((id) => ({ userId: id })),
        ]
        for (const user of users) {
          await sendTelegram(botToken, user.userId, markdown)
        }
      }

      if (channel === 'feishu') {
        const appId = config.feishu?.appId
        const appSecret = config.feishu?.appSecret
        if (!appId || !appSecret) {
          console.warn('[Notification] Feishu credentials not configured, skipping')
          continue
        }
        const token = await getFeishuTenantToken(appId, appSecret)
        if (!token) continue

        const users = [
          ...(config.feishu?.pairedUsers ?? []),
          ...(config.feishu?.allowedUsers ?? []).map((id) => ({ userId: id })),
        ]
        for (const user of users) {
          await sendFeishu(token, String(user.userId), run)
        }
      }
    } catch (err) {
      console.error(`[Notification] ${channel} notification error:`, err)
    }
  }
}
