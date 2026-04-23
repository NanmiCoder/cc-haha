/**
 * Parse task run output into displayable text.
 *
 * The output may be in one of two formats:
 *
 * 1. **Extracted text** (new runs) — The server's `extractAssistantText` has
 *    already parsed the raw NDJSON and stored only the AI's text response.
 *    This is plain text / markdown that should be returned as-is.
 *
 * 2. **Raw NDJSON** (old runs before the server-side extraction was added) —
 *    Each line is a JSON object from the CLI's stream-json output. We parse
 *    these and extract assistant text blocks + result messages.
 *
 * Detection: if at least one line parses as JSON with a recognized `type`
 * field, treat as NDJSON. Otherwise return as-is.
 */
export function parseRunOutput(raw: string): string {
  if (!raw || !raw.trim()) return ''

  const lines = raw.trim().split('\n')

  // Quick check: does this look like NDJSON? (first non-empty line starts with '{')
  const firstLine = lines.find((l) => l.trim())
  if (!firstLine || !firstLine.trim().startsWith('{')) {
    // Already extracted plain text — return as-is
    return raw.trim()
  }

  // Try to parse as NDJSON (legacy format)
  const textParts: string[] = []
  let anyRecognized = false

  for (const line of lines) {
    if (!line.trim()) continue

    let parsed: any
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }

    const type = parsed?.type

    if (type === 'assistant') {
      anyRecognized = true
      const content = parsed?.message?.content
      if (!Array.isArray(content)) continue
      for (const block of content) {
        if (block.type === 'text' && block.text?.trim()) {
          textParts.push(block.text.trim())
        }
      }
    }

    if (type === 'result') {
      anyRecognized = true
      const result = parsed?.result
      if (typeof result === 'string' && result.trim()) {
        textParts.push(result.trim())
      } else if (result?.message?.trim()) {
        textParts.push(result.message.trim())
      }
    }

    if (type === 'system' || type === 'user') {
      anyRecognized = true
      // Skip these — not useful to display
    }
  }

  // If we recognized NDJSON structure, return extracted text
  if (anyRecognized) {
    return textParts.join('\n\n')
  }

  // Fallback: the JSON lines didn't have recognized types — return raw
  return raw.trim()
}
