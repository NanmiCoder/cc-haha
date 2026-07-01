import { describe, expect, it } from 'bun:test'
import { SKILL_CATALOG, getCatalogSkill } from './skillCatalog.js'

describe('SKILL_CATALOG', () => {
  it('has unique install names (no two entries collide on the same ~/.claude/skills/<name>/ dir)', () => {
    const seen = new Set<string>()
    for (const entry of SKILL_CATALOG) {
      expect(seen.has(entry.name)).toBe(false)
      seen.add(entry.name)
    }
  })

  it('every entry has the required identity fields and at least a SKILL.md', () => {
    for (const entry of SKILL_CATALOG) {
      expect(typeof entry.name).toBe('string')
      expect(entry.name.length).toBeGreaterThan(0)
      expect(typeof entry.displayName).toBe('string')
      expect(typeof entry.description).toBe('string')
      expect(typeof entry.category).toBe('string')
      expect(typeof entry.source).toBe('string')
      expect(entry.files['SKILL.md']?.length ?? 0).toBeGreaterThan(0)
    }
  })

  it('SKILL.md contents start with a frontmatter block matching the entry name', () => {
    // The desktop installer writes files verbatim to ~/.claude/skills/<name>/.
    // Claude Code reads name + description from the frontmatter, so a mismatch
    // between catalog entry.name and the SKILL.md `name:` would surface as a
    // confusing renamed skill on disk.
    for (const entry of SKILL_CATALOG) {
      const md = entry.files['SKILL.md'] ?? ''
      expect(md.startsWith('---')).toBe(true)
      const nameLine = md.match(/^name:\s*(\S+)/m)?.[1]
      expect(nameLine, `entry ${entry.name} SKILL.md frontmatter name`).toBeDefined()
    }
  })

  it('includes the three mattpocock skills with the expected categories', () => {
    const mattpocockEntries = SKILL_CATALOG.filter((s) =>
      s.name.startsWith('mattpocock-'),
    )
    const byName = Object.fromEntries(mattpocockEntries.map((e) => [e.name, e]))

    expect(byName['mattpocock-grilling']?.category).toBe('Productivity')
    expect(byName['mattpocock-tdd']?.category).toBe('Engineering')
    expect(byName['mattpocock-diagnosing-bugs']?.category).toBe('Engineering')

    // All three must point at the upstream MIT repo so the source attribution
    // shown in Settings → Skills stays accurate.
    for (const entry of mattpocockEntries) {
      expect(entry.source).toMatch(/mattpocock\/skills/)
      expect(entry.source).toMatch(/MIT/)
    }
  })

  it('mattpocock SKILL.md frontmatter names match the upstream repo (grilling/tdd/diagnosing-bugs)', () => {
    // Upstream uses unprefixed names (`name: tdd`); the catalog entry is
    // prefixed with `mattpocock-` to avoid clashing with any local skill the
    // user already has, but the SKILL.md installed must still use the upstream
    // name so /tdd, /grilling etc. work on disk.
    const grilling = getCatalogSkill('mattpocock-grilling')
    expect(grilling?.files['SKILL.md']).toMatch(/^name:\s*grilling/m)

    const tdd = getCatalogSkill('mattpocock-tdd')
    expect(tdd?.files['SKILL.md']).toMatch(/^name:\s*tdd/m)

    const diag = getCatalogSkill('mattpocock-diagnosing-bugs')
    expect(diag?.files['SKILL.md']).toMatch(/^name:\s*diagnosing-bugs/m)
  })
})
