export type DiffLine = { type: 'same' | 'add' | 'remove'; text: string }

const MAX_LCS_CELLS = 4_000_000

/**
 * Line diff for system prompt revisions. Common prefix/suffix are trimmed
 * first (prompt updates usually touch one region), then an LCS runs on the
 * changed middle. A middle too large for the cell budget degrades to "all
 * removed, all added", which is still correct, just less precise.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split('\n')
  const b = after.split('\n')
  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++
  let suffix = 0
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) suffix++

  const head: DiffLine[] = a.slice(0, prefix).map((text) => ({ type: 'same', text }))
  const tail: DiffLine[] = a.slice(a.length - suffix).map((text) => ({ type: 'same', text }))
  const midA = a.slice(prefix, a.length - suffix)
  const midB = b.slice(prefix, b.length - suffix)

  if (midA.length * midB.length > MAX_LCS_CELLS) {
    return [
      ...head,
      ...midA.map((text): DiffLine => ({ type: 'remove', text })),
      ...midB.map((text): DiffLine => ({ type: 'add', text })),
      ...tail,
    ]
  }

  const rows = midA.length
  const cols = midB.length
  const table = new Uint32Array((rows + 1) * (cols + 1))
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      table[i * (cols + 1) + j] = midA[i] === midB[j]
        ? table[(i + 1) * (cols + 1) + j + 1]! + 1
        : Math.max(table[(i + 1) * (cols + 1) + j]!, table[i * (cols + 1) + j + 1]!)
    }
  }
  const middle: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < rows && j < cols) {
    if (midA[i] === midB[j]) {
      middle.push({ type: 'same', text: midA[i]! })
      i++
      j++
    } else if (table[(i + 1) * (cols + 1) + j]! >= table[i * (cols + 1) + j + 1]!) {
      middle.push({ type: 'remove', text: midA[i]! })
      i++
    } else {
      middle.push({ type: 'add', text: midB[j]! })
      j++
    }
  }
  while (i < rows) middle.push({ type: 'remove', text: midA[i++]! })
  while (j < cols) middle.push({ type: 'add', text: midB[j++]! })
  return [...head, ...middle, ...tail]
}

export type ToolCatalogEntry = { name: string; description?: string; input_schema?: unknown }

export type ToolCatalogDiff = { added: string[]; removed: string[]; changed: string[] }

export function diffToolCatalogs(before: readonly ToolCatalogEntry[], after: readonly ToolCatalogEntry[]): ToolCatalogDiff {
  const previous = new Map(before.map((tool) => [tool.name, JSON.stringify(tool)]))
  const next = new Map(after.map((tool) => [tool.name, JSON.stringify(tool)]))
  const added: string[] = []
  const removed: string[] = []
  const changed: string[] = []
  for (const [name, value] of next) {
    const old = previous.get(name)
    if (old === undefined) added.push(name)
    else if (old !== value) changed.push(name)
  }
  for (const name of previous.keys()) if (!next.has(name)) removed.push(name)
  return { added, removed, changed }
}
