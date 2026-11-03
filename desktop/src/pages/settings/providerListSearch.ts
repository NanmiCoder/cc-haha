import { BUILT_IN_PROVIDER_IDS } from '../../constants/openaiOfficialProvider'

/**
 * Tabs and local search for the model-provider list.
 *
 * Plain data in, plain data out, so the rules can be tested without rendering
 * the provider panel.
 */

/** Saved providers configured with an API key, or the built-in sign-in providers. */
export type ProviderListTab = 'api' | 'official'

/** The search field appears once the list (saved plus built-in) is this long. */
export const PROVIDER_SEARCH_MIN_ITEMS = 6

export type ProviderSearchField = {
  value: string
  /** Shown on the card, so a hit there needs no explanation. */
  visible: boolean
  /** Names a field the card does not show, when it is why the entry matched. */
  label?: string
}

export type ProviderSearchMatch = {
  hiddenField: { label: string; value: string } | null
}

export type HighlightSegment = { text: string; match: boolean }

function isBuiltInProviderId(id: string): boolean {
  return (BUILT_IN_PROVIDER_IDS as readonly string[]).includes(id)
}

/** The tab holding the default provider. `null` is Claude Official. */
export function providerTabOf(activeId: string | null): ProviderListTab {
  return activeId === null || isBuiltInProviderId(activeId) ? 'official' : 'api'
}

/**
 * The tab the list opens on. Most people use API-key providers, so that tab,
 * unless the default is a sign-in provider someone switched to on purpose.
 * Claude Official (`null`) does not count: it is also the fallback a new
 * provider leaves in place, since adding one does not make it the default.
 */
export function initialProviderTab(activeId: string | null): ProviderListTab {
  return activeId !== null && isBuiltInProviderId(activeId) ? 'official' : 'api'
}

export function searchTerms(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean)
}

/**
 * Every term has to appear in some field. Returns null when the entry does not
 * match, and names the first hidden field that supplied a term no visible field
 * carries, so the card can say why it is in the results.
 */
export function matchProviderFields(fields: ProviderSearchField[], terms: string[]): ProviderSearchMatch | null {
  if (terms.length === 0) return { hiddenField: null }
  const lowered = fields.map((field) => ({ ...field, lower: field.value.toLowerCase() }))
  if (!terms.every((term) => lowered.some((field) => field.lower.includes(term)))) return null

  const missingFromVisible = terms.filter(
    (term) => !lowered.some((field) => field.visible && field.lower.includes(term)),
  )
  const hidden = lowered.find((field) =>
    !field.visible && field.label && missingFromVisible.some((term) => field.lower.includes(term)),
  )
  return { hiddenField: hidden?.label ? { label: hidden.label, value: hidden.value } : null }
}

/** Splits text into matched and unmatched runs for highlighting. */
export function highlightSegments(text: string, terms: string[]): HighlightSegment[] {
  const lower = text.toLowerCase()
  // A few characters change length when lowercased; offsets would then point at
  // the wrong letters, so such text is left unhighlighted.
  if (terms.length === 0 || !text || lower.length !== text.length) return [{ text, match: false }]

  const marked = new Array<boolean>(text.length).fill(false)
  for (const term of terms) {
    let at = lower.indexOf(term)
    while (at !== -1) {
      marked.fill(true, at, at + term.length)
      at = lower.indexOf(term, at + term.length)
    }
  }

  const segments: HighlightSegment[] = []
  for (let index = 0; index < text.length; index++) {
    const last = segments[segments.length - 1]
    if (last && last.match === marked[index]) last.text += text[index]
    else segments.push({ text: text[index]!, match: marked[index]! })
  }
  return segments
}
