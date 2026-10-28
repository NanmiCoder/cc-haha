const REDACTED = '[REDACTED]'

function isQuote(char: string | undefined): boolean {
  return char === '"' || char === "'" || char === '`'
}

/** Shared only by adapter/host diagnostics and their export boundary. */
export function isSensitiveDiagnosticKey(key: string): boolean {
  return /(?:appid|apikey|token|secret|password|authorization|cookie|oauth)$/i.test(key.replace(/[^a-z0-9]/gi, ''))
}

function quotedEnd(text: string, start: number): number {
  const quote = text[start]
  for (let index = start + 1; index < text.length; index++) {
    if (text[index] === '\\') index++
    else if (text[index] === quote) return index + 1
  }
  return text.length
}

function decodeQuoted(text: string): string {
  if (text[0] === '"') {
    try { return JSON.parse(text) as string } catch { /* Node inspect also permits literal newlines. */ }
  }
  return text.slice(1, -1).replace(/\\([\\'"/bfnrt]|u[0-9a-f]{4})/gi, (_, escape: string) => {
    if (escape.startsWith('u')) return String.fromCharCode(Number.parseInt(escape.slice(1), 16))
    return ({ b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' } as Record<string, string>)[escape] ?? escape
  })
}

function valueEnd(text: string, start: number): number {
  if (isQuote(text[start])) {
    let end = quotedEnd(text, start)
    // Node inspect splits long multiline strings into quoted concatenations.
    let continuation: RegExpMatchArray | null
    while ((continuation = text.slice(end).match(/^\s*\+\s*(['"`])/))) {
      end = quotedEnd(text, end + continuation[0].length - 1)
    }
    return end
  }
  if (text[start] === '{' || text[start] === '[') {
    const stack: string[] = []
    for (let index = start; index < text.length; index++) {
      const char = text[index]
      if (isQuote(char)) index = quotedEnd(text, index) - 1
      else if (char === '{' || char === '[') stack.push(char)
      else if (char === '}' || char === ']') {
        stack.pop()
        if (!stack.length) return index + 1
      }
    }
    return text.length
  }
  return start + (text.slice(start).match(/^[^\s,;}&\]"']+/)?.[0].length ?? 0)
}

/**
 * Scan log text as key/value tokens, including Node inspect output. Decode
 * quoted string values recursively so JSON embedded in Axios config.data is
 * covered without treating escaped quotes as field/value boundaries.
 * Redact before callers flatten newlines or truncate the diagnostic.
 */
export function redactDiagnosticText(text: string, depth = 0): string {
  if (depth > 8) return REDACTED
  let result = ''
  let index = 0
  while (index < text.length) {
    const start = index
    // Apostrophes in prose (Can't, users') are not string delimiters.
    const quoted = isQuote(text[index]) && !(text[index] === "'" && /[\p{L}\p{N}]/u.test(text[index - 1] ?? ''))
    const word = quoted ? undefined : text.slice(index).match(/^[a-z0-9_-]+/i)?.[0]
    if (!quoted && !word) {
      result += text[index++]
      continue
    }
    index = quoted ? quotedEnd(text, index) : index + word!.length
    const token = text.slice(start, index)
    const key = quoted ? decodeQuoted(token) : token
    const separator = text.slice(index).match(/^\s*[:=]\s*/)?.[0]
    if (separator && isSensitiveDiagnosticKey(key)) {
      index += separator.length
      const header = key.replace(/[^a-z]/gi, '').toLowerCase()
      // Only raw HTTP header text needs line-wide removal. JSON/inspect values
      // and our marker have their own boundaries, including after the host
      // flattens newlines and the file is scanned again on append or export.
      const structured = /^(?:[\[{]|(?:null|true|false)(?=[ \t]*(?:[,}\]\r\n]|$)))/.test(text.slice(index))
      if (!quoted && separator.includes(':') && !isQuote(text[index]) && !structured
        && (header.endsWith('cookie') || (header.endsWith('authorization') && !/^(?:Bearer|Basic)\s+/i.test(text.slice(index))))) {
        const newline = text.slice(index).search(/[\r\n]/)
        index = newline < 0 ? text.length : index + newline
        result += token + separator + REDACTED
        continue
      }
      // Retain the auth scheme, but never its credential (including Basic).
      const scheme = text.slice(index).match(/^(?:Bearer|Basic)\s+/i)?.[0] ?? ''
      index += scheme.length
      const end = valueEnd(text, index)
      const quote = isQuote(text[index]) ? text[index] : quoted ? '"' : ''
      result += token + separator + scheme + quote + REDACTED + quote
      index = end
    } else if (quoted) {
      const decoded = decodeQuoted(token)
      const sanitized = redactDiagnosticText(decoded, depth + 1)
      // JSON encoding is also valid in Node inspect text. Preserve unchanged
      // strings exactly so paths and stack frames retain their original form.
      result += sanitized === decoded ? token : JSON.stringify(sanitized)
    } else {
      result += token
    }
  }
  return result.replace(/\b(Bearer\s+)(?!\[REDACTED\])[^\s,;"'}\]]+/gi, '$1[REDACTED]')
}
