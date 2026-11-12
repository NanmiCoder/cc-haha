import type { ElementMetadata } from '../preview-agent/metadata'
import type { EditDiff } from '../preview-agent/popover'

export type SelectionPayload = {
  pageUrl: string
  sourceHint?: string
  element: ElementMetadata
  change?: EditDiff & { description?: string }
  delivery?: 'send' | 'queue'
  draftItemId?: string
  selectionNumber?: number
  screenshot?: { dataUrl?: string; kind?: 'full' | 'viewport' | 'element' | 'region' }
}

export type SelectionDirectMessage = {
  modelText: string
  displayName: string
  note?: string
}

export type SelectionBatchItem = {
  id: string
  number: number
  payload: SelectionPayload
}

export type SelectionBatchMessage = {
  modelText: string
  items: Array<{
    number: number
    displayName: string
    note?: string
    selector: string
  }>
}

export const VISUAL_SELECTION_PROMPT_HEADER = 'Edit the local frontend according to the blue annotation numbered 1 in the screenshot.'
export const VISUAL_SELECTION_PROMPT_FOOTER = 'Locate elements by the numbered annotations in the screenshots first; use the selector only as a secondary hint.'
export const VISUAL_SELECTION_BATCH_PROMPT_HEADER = 'Apply the following batch of annotated local frontend edits in one pass. The blue number in each screenshot matches the element number below.'
export const VISUAL_SELECTION_TARGET_LABEL = 'Target element: '
export const VISUAL_SELECTION_SELECTOR_LABEL = 'Selector: '
export const VISUAL_SELECTION_NOTE_LABEL = 'User note:'

export function visualSelectionStartMarker(number: number): string {
  return `[Element ${number}]`
}

export function visualSelectionEndMarker(number: number): string {
  return `[End of element ${number}]`
}

/**
 * The selected element is referenced by the attached annotated screenshot
 * (the element is already circled there). This only produces the user's
 * request plus the concrete changes in plain words; selector / DOM path /
 * computed styles / page URL are **not** written into the composer, since that
 * DOM noise reads badly and the image already is the reference. Returns an
 * empty string when there is no description and no change, so the image goes
 * into the composer on its own.
 */
export function buildSelectionComposerText(p: SelectionPayload): string {
  const c = p.change
  const lines: string[] = []
  if (c?.description) lines.push(c.description)
  if (c?.text) lines.push(`- Text: "${c.text.from}" → "${c.text.to}"`)
  if (c?.color) lines.push(`- Text color: ${c.color.from} → ${c.color.to}`)
  if (c?.background) lines.push(`- Background: ${c.background.from} → ${c.background.to}`)
  if (c?.opacity) lines.push(`- Opacity: ${c.opacity.from} → ${c.opacity.to}`)
  if (c?.fontFamily) lines.push(`- Font: ${c.fontFamily.from} → ${c.fontFamily.to}`)
  return lines.join('\n')
}

const NO_NOTE_LINE = 'The user gave no extra note; infer the change from the selected element in the screenshot only.'

export function formatElementLabel(element: ElementMetadata): string {
  const tag = element.tag || 'element'
  return `<${tag}>`
}

export function buildSelectionDirectMessage(p: SelectionPayload): SelectionDirectMessage {
  const displayName = formatElementLabel(p.element)
  const note = buildSelectionComposerText(p)
  const lines = [
    VISUAL_SELECTION_PROMPT_HEADER,
    `${VISUAL_SELECTION_TARGET_LABEL}${displayName}`,
    `${VISUAL_SELECTION_SELECTOR_LABEL}${p.element.selector}`,
  ]

  if (p.element.nthPath) lines.push(`DOM path: ${p.element.nthPath}`)
  if (p.sourceHint) lines.push(`Page title: ${p.sourceHint}`)
  if (p.pageUrl) lines.push(`Page URL: ${p.pageUrl}`)
  if (p.element.text) lines.push(`Current text: ${p.element.text}`)
  if (note) {
    lines.push(VISUAL_SELECTION_NOTE_LABEL)
    lines.push(note)
  } else {
    lines.push(NO_NOTE_LINE)
  }
  lines.push(VISUAL_SELECTION_PROMPT_FOOTER)

  return {
    modelText: lines.join('\n'),
    displayName,
    note: note || undefined,
  }
}

export function buildSelectionBatchMessage(entries: SelectionBatchItem[]): SelectionBatchMessage {
  const items = entries.map((entry) => {
    const displayName = formatElementLabel(entry.payload.element)
    const note = buildSelectionComposerText(entry.payload) || undefined
    return {
      number: entry.number,
      displayName,
      note,
      selector: entry.payload.element.selector,
    }
  })
  const lines = [VISUAL_SELECTION_BATCH_PROMPT_HEADER]

  entries.forEach((entry, index) => {
    const item = items[index]!
    const payload = entry.payload
    lines.push('', visualSelectionStartMarker(entry.number))
    lines.push(`${VISUAL_SELECTION_TARGET_LABEL}${item.displayName}`)
    lines.push(`${VISUAL_SELECTION_SELECTOR_LABEL}${item.selector}`)
    if (payload.element.nthPath) lines.push(`DOM path: ${payload.element.nthPath}`)
    if (payload.sourceHint) lines.push(`Page title: ${payload.sourceHint}`)
    if (payload.pageUrl) lines.push(`Page URL: ${payload.pageUrl}`)
    if (payload.element.text) lines.push(`Current text: ${payload.element.text}`)
    if (item.note) {
      lines.push(VISUAL_SELECTION_NOTE_LABEL)
      lines.push(item.note)
    } else {
      lines.push(NO_NOTE_LINE)
    }
    lines.push(visualSelectionEndMarker(entry.number))
  })

  lines.push('', VISUAL_SELECTION_PROMPT_FOOTER)
  return { modelText: lines.join('\n'), items }
}
