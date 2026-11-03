import css from '../theme/globals.css?raw'

/**
 * The app-region an element computes under the real `globals.css`.
 *
 * jsdom drops `app-region` from computed style, so the cascade is resolved
 * here instead: every rule that declares `app-region` or its `-webkit-` alias
 * is matched with `Element.matches`, the most specific match wins and source
 * order breaks ties. In Chromium 148 the property is not inherited, so an
 * element no rule names reports nothing to Electron; that is `none` here.
 *
 * This proves which boxes report a rectangle, not where those rectangles land;
 * geometry still needs a real Chromium.
 */
export type AppRegion = 'drag' | 'no-drag' | 'none'

type Specificity = [number, number, number]
type RegionRule = { selector: string; specificity: Specificity; order: number; value: AppRegion }

const REGION_RULES = collectRegionRules(css)

export function resolveAppRegion(element: Element): AppRegion {
  let winner: RegionRule | null = null
  for (const rule of REGION_RULES) {
    if (!element.matches(rule.selector)) continue
    if (!winner || compareSpecificity(rule.specificity, winner.specificity) >= 0) winner = rule
  }
  return winner?.value ?? 'none'
}

function collectRegionRules(source: string): RegionRule[] {
  const rules: RegionRule[] = []
  const text = source.replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '')
  // Innermost blocks only: an at-rule's own `{` never closes on its selector.
  for (const match of text.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const prelude = match[1]!.trim()
    if (!prelude || prelude.startsWith('@')) continue
    let value: AppRegion | null = null
    for (const declaration of match[2]!.matchAll(/(?:^|[;\s])(?:-webkit-)?app-region\s*:\s*([\w-]+)/g)) {
      value = valueOf(declaration[1]!)
    }
    if (!value) continue
    for (const selector of splitTopLevel(prelude)) {
      rules.push({ selector, specificity: specificityOf(selector), order: rules.length, value })
    }
  }
  if (rules.length === 0) throw new Error('globals.css declares no app-region rules')
  return rules
}

// Chromium 148 (Electron 42): the CSS-wide keywords leave the element
// unreported, while every other keyword — `none` included — applies as no-drag.
function valueOf(keyword: string): AppRegion {
  if (keyword === 'drag') return 'drag'
  if (['initial', 'unset', 'inherit', 'revert', 'revert-layer'].includes(keyword)) return 'none'
  return 'no-drag'
}

function splitTopLevel(list: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let index = 0; index < list.length; index += 1) {
    const char = list[index]
    if (char === '(' || char === '[') depth += 1
    else if (char === ')' || char === ']') depth -= 1
    else if (char === ',' && depth === 0) {
      parts.push(list.slice(start, index).trim())
      start = index + 1
    }
  }
  parts.push(list.slice(start).trim())
  return parts.filter(Boolean)
}

function compareSpecificity(a: Specificity, b: Specificity) {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}

function maxSpecificity(list: string): Specificity {
  return splitTopLevel(list)
    .map(specificityOf)
    .reduce<Specificity>((best, next) => (compareSpecificity(next, best) > 0 ? next : best), [0, 0, 0])
}

function specificityOf(selector: string): Specificity {
  const total: Specificity = [0, 0, 0]
  const add = (part: Specificity) => {
    total[0] += part[0]
    total[1] += part[1]
    total[2] += part[2]
  }
  let index = 0
  const readName = () => {
    const start = index
    while (index < selector.length && /[\w-]|\\/.test(selector[index]!)) {
      index += selector[index] === '\\' ? 2 : 1
    }
    return selector.slice(start, index)
  }
  const readParenthesised = () => {
    let depth = 1
    const start = index + 1
    index += 1
    while (index < selector.length && depth > 0) {
      if (selector[index] === '(') depth += 1
      else if (selector[index] === ')') depth -= 1
      index += 1
    }
    return selector.slice(start, index - 1)
  }

  while (index < selector.length) {
    const char = selector[index]!
    if (char === '#') {
      index += 1
      readName()
      add([1, 0, 0])
    } else if (char === '.') {
      index += 1
      readName()
      add([0, 1, 0])
    } else if (char === '[') {
      index = selector.indexOf(']', index) + 1
      add([0, 1, 0])
    } else if (char === ':' && selector[index + 1] === ':') {
      index += 2
      readName()
      if (selector[index] === '(') readParenthesised()
      add([0, 0, 1])
    } else if (char === ':') {
      index += 1
      const name = readName()
      const args = selector[index] === '(' ? readParenthesised() : null
      if (name === 'is' || name === 'not' || name === 'has') add(maxSpecificity(args ?? ''))
      else if (name !== 'where') add([0, 1, 0])
    } else if (/[a-zA-Z]/.test(char)) {
      readName()
      add([0, 0, 1])
    } else {
      index += 1
    }
  }
  return total
}
