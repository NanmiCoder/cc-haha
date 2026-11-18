function plainText(value) {
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]/g, '')
    .trim()
}

function legacyHeadingText(tokens) {
  return tokens.map((token) => {
    if (typeof token.text === 'string') return plainText(token.text)
    if (Array.isArray(token.tokens)) return legacyHeadingText(token.tokens)
    return ''
  }).join('')
}

function inlineText(tokens) {
  return tokens.map((token) => {
    if (token.tokens) return inlineText(token.tokens)
    if (token.type === 'html') return ''
    return token.text || ''
  }).join('')
}

export function slugifyHeading(value) {
  return plainText(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
}

export function getDocHeading(tokens, content) {
  // Published fragment URLs used the old per-token trimming, including for inline code.
  const legacyText = legacyHeadingText(tokens) || plainText(content)
  return {
    text: inlineText(tokens).trim() || legacyText,
    baseSlug: slugifyHeading(legacyText) || 'section'
  }
}
