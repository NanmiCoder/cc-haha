import { splitMessage } from '../common/format.js'

/** Acknowledge chunks individually so retrying a terminal reply skips sent text. */
export async function sendDingTalkMarkdown(
  webhook: string,
  token: string,
  text: string,
  onChunkDelivered?: (remainingText: string) => void,
): Promise<void> {
  const chunks = splitMessage(text, 3500)
  for (let index = 0; index < chunks.length; index++) {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await fetch(webhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': token },
          body: JSON.stringify({ msgtype: 'markdown', markdown: { title: 'Claude Code', text: chunks[index] } }),
          signal: AbortSignal.timeout(15_000),
        })
        const body = await response.json().catch(() => null) as { errcode?: number | string; errmsg?: string } | null
        if (!response.ok || (body?.errcode !== 0 && body?.errcode !== '0')) {
          throw new Error(`DingTalk text delivery failed: ${response.status}${body?.errcode !== undefined ? ` (${body.errcode})` : ''}${body?.errmsg ? ` ${body.errmsg}` : ''}`)
        }
        break
      } catch (error) {
        if (attempt >= 2) throw error
        await new Promise(resolve => setTimeout(resolve, 100 * 2 ** attempt))
      }
    }
    onChunkDelivered?.(chunks.slice(index + 1).join('\n\n'))
  }
}
