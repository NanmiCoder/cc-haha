/**
 * Agent 团队成员之间（含队长）的消息以 `<teammate-message teammate_id="…">` 信封写进对方的
 * transcript。和桌面端一致：队长的主对话不把它当成用户发言；成员页才显示里面的正文，
 * 生命周期通知（空闲、请求关停等）的 JSON 不显示。
 */
const ENVELOPE = /<teammate-message\s+teammate_id="([^"]+)"[^>]*>\n?([\s\S]*?)\n?<\/teammate-message>/g
const LIFECYCLE = new Set([
  'shutdown_approved',
  'shutdown_rejected',
  'shutdown_request',
  'teammate_terminated',
  'idle_notification',
])

/** 只看完整的开闭标签：用户贴代码或讨论协议时提到标签名不算。 */
export function isTeammateEnvelope(text: string) {
  return text.includes('<teammate-message') && text.includes('</teammate-message>')
}

/** 信封里给人看的消息；不是信封返回 null，全是生命周期通知返回空数组。 */
export function teammateMessages(text: string): { from: string; text: string }[] | null {
  if (!isTeammateEnvelope(text)) return null
  const messages: { from: string; text: string }[] = []
  for (const match of text.matchAll(ENVELOPE)) {
    const content = match[2]?.trim()
    if (!content) continue
    if (content.startsWith('{') && content.endsWith('}')) {
      try {
        const body = JSON.parse(content) as { type?: unknown }
        if (typeof body.type === 'string' && LIFECYCLE.has(body.type)) continue
      } catch {
        // 长得像 JSON 的普通文字照常显示。
      }
    }
    messages.push({ from: match[1] ?? '', text: content })
  }
  return messages
}

/** team-lead 是队长；其余就是成员名。 */
export const teammateLabel = (from: string) => (from === 'team-lead' || from.startsWith('team-lead@') ? '队长' : from.split('@')[0] || from)
