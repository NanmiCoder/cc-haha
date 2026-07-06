export function formatMessageContent(content: unknown): string {
  if (typeof content === 'string') return content

  if (Array.isArray(content)) {
    const parts = content
      .map((part) => {
        if (typeof part === 'string') return part
        if (!part || typeof part !== 'object') return ''

        const record = part as Record<string, unknown>
        if (typeof record.text === 'string') return record.text
        if (typeof record.content === 'string') return record.content
        if (typeof record.name === 'string') return `[${record.name}]`
        if (typeof record.type === 'string') return `[${record.type}]`
        return ''
      })
      .filter(Boolean)

    if (parts.length > 0) return parts.join('\n')
  }

  if (content && typeof content === 'object') {
    const record = content as Record<string, unknown>
    if (typeof record.text === 'string') return record.text
    if (typeof record.content === 'string') return record.content
  }

  return JSON.stringify(content, null, 2)
}
