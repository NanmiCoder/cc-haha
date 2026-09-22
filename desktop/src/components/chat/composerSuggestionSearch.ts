type SearchableSuggestion = { label: string, searchTerms?: string[], description?: string, contentMatch?: boolean }

/** Rank names ahead of descriptive matches while keeping ties in source order. */
export function rankComposerSuggestions<T extends SearchableSuggestion>(items: T[], query: string, limit = 8): T[] {
  const normalized = query.trim().toLocaleLowerCase().replace(/\\/g, '/')
  if (!normalized) return items.slice(0, limit)
  const words = normalized.split(/\s+/)
  return items.map((item, index) => {
    const names = [item.label, ...item.searchTerms ?? []].map(value => value.toLocaleLowerCase().replace(/\\/g, '/'))
    const description = item.description?.toLocaleLowerCase() ?? ''
    const score = names.some(name => name === normalized) ? 4
      : names.some(name => name.startsWith(normalized)) ? 3
        : names.some(name => name.includes(normalized)) ? 2
          : words.every(word => [...names, description].some(value => value.includes(word))) ? 1 : item.contentMatch ? 0.5 : 0
    return { item, index, score }
  }).filter(result => result.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit).map(result => result.item)
}
