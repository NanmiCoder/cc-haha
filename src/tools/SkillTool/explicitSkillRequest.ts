import type { Message } from '../../types/message.js'

/** Only the current human prompt can select skills; tool output and history cannot. */
export function isExplicitSkillRequest(messages: readonly Message[], name: string): boolean {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    if (message.type !== 'user' || message.isMeta) continue
    const content = message.message.content
    const text = typeof content === 'string' ? content : content
      .filter(block => block.type === 'text')
      .map(block => block.text).join('\n')
    // Tool-result messages are also role=user. They are never authorization.
    if (!text || (Array.isArray(content) && content.some(block => block.type === 'tool_result'))) continue
    if (text.includes(`Use the Skill tool with skill: ${JSON.stringify(name)} for this request.`)) return true
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(?:^|\\s)[/$]${escaped}(?=$|\\s|[,.!?，。！？])`).test(text)
  }
  return false
}
