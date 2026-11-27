import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const MOBILE_ROOT = join(import.meta.dir, '../..')
const SRC_ROOT = join(MOBILE_ROOT, 'src')
const INDEX_HTML = join(MOBILE_ROOT, 'public/index.html')

const FORBIDDEN_PATTERNS: readonly { label: string; regex: RegExp }[] = [
  { label: 'legacy warm shadow rgba(28,25,23,...)', regex: /rgba\(\s*28\s*,\s*25\s*,\s*23\b/gi },
  { label: 'legacy warm shadow rgba(20,19,17,...)', regex: /rgba\(\s*20\s*,\s*19\s*,\s*17\b/gi },
  { label: 'legacy warm hex #FAF9F7', regex: /#FAF9F7\b/gi },
  { label: 'legacy warm hex #EEECE7', regex: /#EEECE7\b/gi },
  { label: 'legacy warm hex #F7F6F3', regex: /#F7F6F3\b/gi },
  { label: 'legacy warm hex #1B1A18', regex: /#1B1A18\b/gi },
  { label: 'legacy warm hex #22211F', regex: /#22211F\b/gi },
  { label: 'legacy warm hex #272522', regex: /#272522\b/gi },
  { label: 'legacy terracotta hex #C25934', regex: /#C25934\b/gi },
  { label: 'legacy terracotta hex #E07A52', regex: /#E07A52\b/gi },
  { label: 'legacy warm ink hex #EDEAE4', regex: /#EDEAE4\b/gi },
  { label: 'legacy warm dark hex #121110', regex: /#121110\b/gi },
  { label: 'legacy warm dark hex #1D1C1A', regex: /#1D1C1A\b/gi },
]

function collectSourceFiles(dir: string): string[] {
  const results: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue
      results.push(...collectSourceFiles(full))
      continue
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue
    if (/\.test\.(ts|tsx)$/.test(entry.name)) continue
    results.push(full)
  }
  return results
}

describe('Mobile & H5 V6C Pure Neutral static design-system guardrails', () => {
  test('mobile/src production files and mobile/public/index.html contain no legacy Direction C warm shadows or hexes', () => {
    const files = [...collectSourceFiles(SRC_ROOT), INDEX_HTML]
    const violations: string[] = []

    for (const filePath of files) {
      const content = readFileSync(filePath, 'utf8')
      const lines = content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        for (const { label, regex } of FORBIDDEN_PATTERNS) {
          regex.lastIndex = 0
          if (regex.test(line)) {
            const rel = relative(MOBILE_ROOT, filePath)
            violations.push(`${rel}:${i + 1} matched ${label}`)
          }
        }
      }
    }

    expect(violations).toEqual([])
  })
})
