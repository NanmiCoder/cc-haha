import { afterAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxedTestEnvironment } from '../../scripts/pr/test-environment.js'

// Memory prompts read settings and create the memory directory, so both live in a
// throwaway HOME / CLAUDE_CONFIG_DIR with an explicit auto-memory directory.
const originalEnv = { ...process.env }
const sandboxHome = mkdtempSync(join(tmpdir(), 'memdir-prompt-'))
for (const key of Object.keys(process.env)) delete process.env[key]
Object.assign(process.env, createSandboxedTestEnvironment(sandboxHome, {
  CLAUDE_COWORK_MEMORY_PATH_OVERRIDE: join(sandboxHome, 'memory'),
}, originalEnv))
const {
  buildCompactMemoryLines, buildMemoryLines, loadMemoryPrompt,
  DIR_EXISTS_GUIDANCE, ENTRYPOINT_NAME, MAX_ENTRYPOINT_LINES,
} = await import('./memdir.js')
const { MEMORY_FRONTMATTER_EXAMPLE, MEMORY_TYPES } = await import('./memoryTypes.js')
const { getAutoMemPath } = await import('./paths.js')
afterAll(() => {
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, originalEnv)
  rmSync(sandboxHome, { recursive: true, force: true })
})

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
const fixtureDir = '/fixture/memory/'
// The compact section must stay a small fraction of the ~12.8KB standard guide.
const COMPACT_MEMORY_BUDGET_BYTES = 700

describe('standard auto-memory prompt', () => {
  // Pinned before the lean compaction landed. Update only for an intentional
  // change to the standard prompt; the lean variant must never move these.
  test.each([
    ['two-step index', [], false, 'f3e746e226cd75736880277f4a4083d037f4e8178a98a17d79669697865fd8db'],
    ['skipped index', [], true, 'a893c0d88db379bddc5f0ff6a31452ad4e1964b28ad5e6477d49fca6b04254d7'],
    ['operator guidelines', ['FIXTURE_EXTRA_GUIDELINE'], false, 'c2deef94677d30819705b5fd9cdef6b43077b380b8e394d821bc44ac832699e4'],
  ] as const)('%s variant is byte-identical to the pinned baseline', (_, extra, skipIndex, hash) => {
    const text = buildMemoryLines('auto memory', fixtureDir, extra.length ? [...extra] : undefined, skipIndex).join('\n')
    expect(sha256(text)).toBe(hash)
  })
})

describe('compact auto-memory prompt (lean profile)', () => {
  const compact = (extra?: string[], skipIndex = false) => buildCompactMemoryLines(fixtureDir, extra, skipIndex).join('\n')

  test('keeps the standard directory, frontmatter and index conventions', () => {
    const text = compact()
    const standard = buildMemoryLines('auto memory', fixtureDir).join('\n')
    expect(text.startsWith('# auto memory\n')).toBe(true)
    for (const value of [fixtureDir, DIR_EXISTS_GUIDANCE, ENTRYPOINT_NAME, `after ${MAX_ENTRYPOINT_LINES}`, ...MEMORY_TYPES]) {
      expect(text).toContain(value)
    }
    // Field names come from the standard frontmatter example, so the two cannot drift.
    const keys = MEMORY_FRONTMATTER_EXAMPLE.flatMap(line => /^(\w+): /.exec(line)?.[1] ?? [])
    expect(keys).toEqual(['name', 'description', 'type'])
    for (const key of keys) expect(text).toContain(`\`${key}\``)
    // Same one-line index entry format as the standard two-step instructions.
    const entry = /`(- \[Title\]\(file\.md\)[^`]*)`/.exec(standard)?.[1]
    expect(entry).toBeDefined()
    expect(text).toContain(`\`${entry}\``)
  })

  test('writes only on explicit request and stays within budget without unavailable guidance', () => {
    const text = compact()
    expect(text).toContain('only when the user explicitly asks you to remember something')
    expect(text).toContain('To forget something, delete its file and index line.')
    for (const absent of [
      '## Types of memory', '<examples>', '## What NOT to save', '## When to access memories',
      '## Before recommending', 'Memory and other forms of persistence', 'Plan', 'tasks',
    ]) expect(text).not.toContain(absent)
    expect(Buffer.byteLength(text) - Buffer.byteLength(fixtureDir)).toBeLessThanOrEqual(COMPACT_MEMORY_BUDGET_BYTES)
  })

  test('drops only the index step when the index is skipped, and keeps operator guidelines', () => {
    const text = compact(['FIXTURE_EXTRA_GUIDELINE'], true)
    expect(text).not.toContain('- [Title](file.md)')
    expect(text).not.toContain('index line')
    expect(text).toContain('`type`')
    expect(text).toContain('only when the user explicitly asks you to remember something')
    expect(text.endsWith('FIXTURE_EXTRA_GUIDELINE')).toBe(true)
  })

  test('loadMemoryPrompt renders the compact variant only when asked', async () => {
    const memoryDir = getAutoMemPath()
    expect(memoryDir.startsWith(join(sandboxHome, 'memory'))).toBe(true)
    expect(await loadMemoryPrompt()).toBe(buildMemoryLines('auto memory', memoryDir).join('\n'))
    expect(await loadMemoryPrompt({ compact: true })).toBe(buildCompactMemoryLines(memoryDir).join('\n'))
    expect(existsSync(memoryDir)).toBe(true)

    process.env.CLAUDE_COWORK_MEMORY_EXTRA_GUIDELINES = 'FIXTURE_COWORK_POLICY'
    process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1'
    try {
      expect(await loadMemoryPrompt({ compact: true })).toBeNull()
      delete process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY
      expect(await loadMemoryPrompt({ compact: true })).toContain('FIXTURE_COWORK_POLICY')
    } finally {
      delete process.env.CLAUDE_COWORK_MEMORY_EXTRA_GUIDELINES
      delete process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY
    }
  })
})
