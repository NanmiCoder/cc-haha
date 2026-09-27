export function queryTerms(query) {
  return [...new Set(query.trim().toLowerCase().split(/\s+/).filter(Boolean))]
}

function score(entry, terms) {
  const title = entry.t.toLowerCase()
  const description = (entry.d || '').toLowerCase()
  const body = (entry.x || '').toLowerCase()
  let total = 0
  for (const term of terms) {
    if (title.includes(term)) total += title.startsWith(term) ? 12 : 8
    else if (description.includes(term)) total += 4
    else if (body.includes(term)) total += 2
    else return 0
  }
  return total
}

function excerpt(entry, terms) {
  const body = entry.x || ''
  if (!body) return entry.d || ''
  const lower = body.toLowerCase()
  const at = terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0).sort((a, b) => a - b)[0]
  if (at === undefined) return entry.d || body.slice(0, 110)
  const start = Math.max(0, at - 40)
  const end = Math.min(body.length, start + 120)
  return `${start > 0 ? '…' : ''}${body.slice(start, end).trim()}${end < body.length ? '…' : ''}`
}

export function searchEntries(index, locale, terms, limit = 12) {
  if (!index || terms.length === 0) return { results: [], total: 0 }
  const matches = index
    .filter((entry) => entry.l === locale)
    .map((entry) => ({ entry, value: score(entry, terms) }))
    .filter((item) => item.value > 0)
    .sort((left, right) => right.value - left.value)
  return {
    total: matches.length,
    results: matches.slice(0, limit).map(({ entry }) => ({
      excerpt: excerpt(entry, terms), path: entry.p, section: entry.s, title: entry.t
    }))
  }
}

// Match literal strings rather than interpreting user input as a regular expression.
export function highlightParts(text, terms) {
  const lower = text.toLowerCase()
  const ranges = terms.filter(Boolean).flatMap((term) => {
    const matches = []
    let at = lower.indexOf(term)
    while (at >= 0) {
      matches.push([at, at + term.length])
      at = lower.indexOf(term, at + term.length)
    }
    return matches
  }).sort((a, b) => a[0] - b[0])
  const merged = []
  for (const range of ranges) {
    const previous = merged.at(-1)
    if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1])
    else merged.push([...range])
  }
  const parts = []
  let position = 0
  for (const [start, end] of merged) {
    if (position < start) parts.push({ text: text.slice(position, start), match: false })
    parts.push({ text: text.slice(start, end), match: true })
    position = end
  }
  if (position < text.length) parts.push({ text: text.slice(position), match: false })
  return parts
}

export function shouldOpenSearchResult(key, target) {
  return key === 'Enter' && (target?.getAttribute('role') === 'combobox' || target?.getAttribute('role') === 'option')
}
