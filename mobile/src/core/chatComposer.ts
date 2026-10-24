import type { AttachmentRef } from '../../../src/server/ws/events'
import type { ChatItem, ClientMessage, Host } from './types'

export type ComposerAttachment = AttachmentRef & {
  id: string
  uri?: string
  bytes: number
}
export type SkillCommand = {
  name: string
  description: string
  kind: 'skill' | 'command'
}
const teamBlock =
  '<agent-team-request>\nUse an Agent Team for this request: create a team, split the goal below into tasks with clear owners, and coordinate the teammates until the goal is done.\n</agent-team-request>'
export const attachmentOnlyPlaceholder = (text: string) =>
  text === 'Please analyze the attached files.' ||
  text === 'Please analyze the attached image.'
export function visibleMessageText(text: string) {
  return text.replace(
    /<agent-team-request>[\s\S]*?<\/agent-team-request>\n*/,
    ''
  )
}
// Same generated formats as desktop/src/stores/chatStore.ts. These are only
// consumed with a real history image or an optimistic image attachment.
const simpleImageSource = /^\[Image source: (.+)\]$/
const detailedImageSource =
  /^\[Image: source: (.+?)(?:, original \d+x\d+, displayed at \d+x\d+\. Multiply coordinates by \d+(?:\.\d+)? to map to original image\.)?\]$/
const imageResizeMetadata =
  /^\[Image: original \d+x\d+, displayed at \d+x\d+\. Multiply coordinates by \d+(?:\.\d+)? to map to original image\.\]$/
export function parseImageMetadata(
  text: string
): { path?: string } | undefined {
  const line = text.trim()
  const path =
    line.match(simpleImageSource)?.[1] ?? line.match(detailedImageSource)?.[1]
  return path
    ? { path }
    : imageResizeMetadata.test(line)
      ? {}
      : undefined
}
export function attachmentName(path: string) {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  const name = normalized.split('/').pop() || path
  return normalized.includes('/uploads/')
    ? name.replace(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}-/i, '')
    : name
}
/** Only remove the server-appended suffix, bounded by known image count. */
export function restoreImageReplay(text: string, imageCount: number) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const metadata: { path?: string }[] = []
  while (imageCount > metadata.length && lines.length) {
    const parsed = parseImageMetadata(lines[lines.length - 1])
    if (!parsed) break
    metadata.unshift(parsed)
    lines.pop()
  }
  return {
    text: metadata.length ? lines.join('\n').trim() : text,
    metadata,
  }
}
export function applyImageMetadata(
  attachments: AttachmentRef[],
  metadata: { path?: string }[]
): AttachmentRef[] {
  let imageIndex = 0
  return attachments.map((attachment) => {
    if (attachment.type !== 'image') return attachment
    const path = metadata[imageIndex++]?.path
    return path
      ? { ...attachment, path, name: attachment.name || attachmentName(path) }
      : attachment
  })
}
/** Desktop transcripts prefix uploaded materials with quoted @file references. */
export function restoreFileReferences(text: string): {
  text: string
  attachments: AttachmentRef[]
} {
  let remaining = text
  const attachments: AttachmentRef[] = []
  while (true) {
    const match = remaining.match(/^@"([^"]+)"\s*/)
    if (!match) break
    const path = match[1]
    const name = attachmentName(path)
    attachments.push({
      type: /\.(?:png|jpe?g|gif|webp)$/i.test(name) ? 'image' : 'file',
      name,
      path,
    })
    remaining = remaining.slice(match[0].length)
  }
  return {
    text: attachments.length && attachmentOnlyPlaceholder(remaining.trim()) ? '' : remaining,
    attachments,
  }
}
export function buildComposerMessage(
  text: string,
  attachments: ComposerAttachment[],
  team: boolean
): Extract<ClientMessage, { type: 'user_message' }> {
  const content = text.trim()
  if (!content && !attachments.length)
    throw new Error('请先写下消息或添加材料。')
  return {
    type: 'user_message',
    content: team ? `${teamBlock}${content ? `\n\n${content}` : ''}` : content,
    ...(attachments.length
      ? {
          attachments: attachments.map(
            ({ type, name, data, mimeType, path }) => ({
              type,
              name,
              data,
              mimeType,
              ...(path ? { path } : {}),
            })
          ),
        }
      : {}),
  }
}
export function validateMessageSize(
  message: ClientMessage,
  auth: Host['auth']
) {
  const bytes = new TextEncoder().encode(JSON.stringify(message)).length
  const limit = auth === 'remote' ? 1024 * 1024 : 8 * 1024 * 1024
  if (bytes >= limit)
    throw new Error(
      auth === 'remote'
        ? '材料超过远程连接的 1 MB 限制，请减少附件或改用局域网。'
        : '材料总量超过 8 MB，请拆分发送。'
    )
}
export function attachmentFromBase64(input: {
  name: string
  base64: string
  mimeType: string
  uri?: string
}): ComposerAttachment {
  const data = input.base64.replace(/^data:[^;,]*;base64,/, '')
  if (!data || !/^[A-Za-z0-9+/]*={0,2}$/.test(data))
    throw new Error('没有读取到有效的附件内容，请重新选择。')
  const image = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(
    input.mimeType
  )
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    type: image ? 'image' : 'file',
    name: input.name,
    mimeType: input.mimeType,
    data,
    uri: input.uri,
    bytes:
      Math.floor(data.length * 0.75) -
      (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0),
  }
}
export function persistedMessageId(item: ChatItem): string | null {
  return item.sourceMessageId && !item.pending && !item.parentToolUseId
    ? item.sourceMessageId
    : null
}
export function withSkill(text: string, skill: SkillCommand): string {
  if (!skill.name.trim() || /[\r\n\s]/.test(skill.name))
    throw new Error('电脑返回的技能名称无效。')
  return `/${skill.name.replace(/^\//, '')}${text.trim() ? ` ${text.trim()}` : ' '}`
}
