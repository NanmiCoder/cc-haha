/**
 * Unit tests for SearchService.searchSessions — global session full-text search.
 *
 * Builds throwaway ~/.claude/projects/<dir>/<uuid>.jsonl fixtures under a temp
 * CLAUDE_CONFIG_DIR and exercises the two-phase (ripgrep → parse/clean) engine.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { SearchService } from '../services/searchService.js'

let tmpDir: string
let service: SearchService

async function setupTmpConfigDir(): Promise<void> {
  tmpDir = path.join(
    os.tmpdir(),
    `cc-search-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  await fs.mkdir(path.join(tmpDir, 'projects'), { recursive: true })
  process.env.CLAUDE_CONFIG_DIR = tmpDir
}

async function cleanupTmpDir(): Promise<void> {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
  delete process.env.CLAUDE_CONFIG_DIR
}

/** Write a JSONL session file. Entries may be objects (serialized) or raw strings (for malformed-line tests). */
async function writeSessionFile(
  projectDir: string,
  sessionId: string,
  entries: Array<Record<string, unknown> | string>,
): Promise<string> {
  const dir = path.join(tmpDir, 'projects', projectDir)
  await fs.mkdir(dir, { recursive: true })
  const filePath = path.join(dir, `${sessionId}.jsonl`)
  const content =
    entries.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n') + '\n'
  await fs.writeFile(filePath, content, 'utf-8')
  return filePath
}

beforeEach(async () => {
  await setupTmpConfigDir()
  service = new SearchService()
})

afterEach(cleanupTmpDir)

describe('SearchService.searchSessions', () => {
  it('matches user message text and returns role=user with correct highlights', async () => {
    await writeSessionFile('proj-a', 'session-1', [
      {
        type: 'user',
        uuid: 'u1',
        timestamp: '2026-06-01T00:00:00.000Z',
        message: { role: 'user', content: 'please implement global search feature' },
      },
    ])

    const { results } = await service.searchSessions('global search')
    expect(results).toHaveLength(1)
    expect(results[0].sessionId).toBe('session-1')
    expect(results[0].projectPath).toBe('proj-a')

    const m = results[0].matches[0]
    expect(m.role).toBe('user')
    expect(m.messageId).toBe('u1')
    expect(m.lineNumber).toBe(1)
    expect(m.snippet.slice(m.highlights[0].start, m.highlights[0].end).toLowerCase()).toBe(
      'global search',
    )
  })

  it('matches assistant text blocks and returns role=assistant', async () => {
    await writeSessionFile('proj-a', 'session-2', [
      {
        type: 'assistant',
        uuid: 'a1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'I recommend ripgrep for this' }] },
      },
    ])

    const { results } = await service.searchSessions('ripgrep')
    expect(results).toHaveLength(1)
    expect(results[0].matches[0].role).toBe('assistant')
  })

  it('matches Chinese content with correct highlight slicing', async () => {
    await writeSessionFile('proj-a', 'session-3', [
      { type: 'user', message: { role: 'user', content: '帮我做一个全文搜索功能' } },
    ])

    const { results } = await service.searchSessions('全文搜索')
    expect(results).toHaveLength(1)
    const m = results[0].matches[0]
    expect(m.snippet.slice(m.highlights[0].start, m.highlights[0].end)).toBe('全文搜索')
  })

  it('searches only user/assistant text, ignoring tool_use and tool_result blocks', async () => {
    await writeSessionFile('proj-a', 'session-4', [
      {
        type: 'assistant',
        uuid: 'a2',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'running the command now' },
            { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'rg zzytoolmarker --json' } },
          ],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'zzytoolmarker found in 3 files' }],
        },
      },
    ])

    // 'zzytoolmarker' only lives in tool_use input + tool_result content → must NOT match.
    const tool = await service.searchSessions('zzytoolmarker')
    expect(tool.results).toHaveLength(0)

    // The assistant's natural-language text is searchable.
    const text = await service.searchSessions('running the command')
    expect(text.results).toHaveLength(1)
    expect(text.results[0].matches[0].role).toBe('assistant')
  })

  it('drops ripgrep false positives that only hit JSON structure (keys/uuids)', async () => {
    await writeSessionFile('proj-a', 'session-5', [
      { type: 'user', uuid: 'assistant-like-uuid', message: { role: 'user', content: 'hello world' } },
    ])

    // 'content' is a JSON key, never part of the readable text 'hello world'.
    const noise = await service.searchSessions('content')
    expect(noise.results).toHaveLength(0)

    const real = await service.searchSessions('hello world')
    expect(real.results).toHaveLength(1)
  })

  it('skips internal command breadcrumb entries', async () => {
    await writeSessionFile('proj-a', 'session-6', [
      { type: 'user', message: { role: 'user', content: '<command-name>deploy</command-name> magicword' } },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: '<command-message>agent</command-message> magicword' }],
        },
      },
    ])

    const { results } = await service.searchSessions('magicword')
    expect(results).toHaveLength(0)
  })

  it('resolves the real session title (custom-title wins) instead of the UUID', async () => {
    await writeSessionFile('proj-a', 'titled-session', [
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'discuss searchword topic' } },
      { type: 'ai-title', aiTitle: 'AI Generated Title', sessionId: 'titled-session' },
      { type: 'custom-title', customTitle: 'My Custom Title', sessionId: 'titled-session' },
    ])

    const { results } = await service.searchSessions('searchword')
    expect(results[0].title).toBe('My Custom Title')
    expect(results[0].title).not.toBe('titled-session')
  })

  it('falls back to the AI title when there is no custom title', async () => {
    await writeSessionFile('proj-a', 'ai-titled', [
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'another searchword here' } },
      { type: 'ai-title', aiTitle: 'Smart Title', sessionId: 'ai-titled' },
    ])

    const { results } = await service.searchSessions('another searchword')
    expect(results[0].title).toBe('Smart Title')
  })

  it('windows snippets for very long lines', async () => {
    const filler = 'x'.repeat(50_000)
    await writeSessionFile('proj-a', 'session-8', [
      { type: 'user', message: { role: 'user', content: `${filler} NEEDLEWORD ${filler}` } },
    ])

    const { results } = await service.searchSessions('NEEDLEWORD')
    expect(results).toHaveLength(1)
    const m = results[0].matches[0]
    expect(m.snippet.length).toBeLessThan(600)
    expect(m.snippet).toContain('…')
    expect(m.snippet.slice(m.highlights[0].start, m.highlights[0].end)).toBe('NEEDLEWORD')
  })

  it('caps matches per session but reports the full matchCount', async () => {
    const entries = Array.from({ length: 8 }, (_, i) => ({
      type: 'user',
      uuid: `u${i}`,
      message: { role: 'user', content: `repeatword occurrence number ${i}` },
    }))
    await writeSessionFile('proj-a', 'session-9', entries)

    const { results } = await service.searchSessions('repeatword', { matchesPerSession: 3 })
    expect(results[0].matchCount).toBe(8)
    expect(results[0].matches).toHaveLength(3)
  })

  it('orders sessions by most-recently modified first', async () => {
    const older = await writeSessionFile('proj-a', 'older', [
      { type: 'user', message: { role: 'user', content: 'sortword in older' } },
    ])
    await writeSessionFile('proj-b', 'newer', [
      { type: 'user', message: { role: 'user', content: 'sortword in newer' } },
    ])
    const past = new Date(Date.now() - 60_000)
    await fs.utimes(older, past, past)

    const { results } = await service.searchSessions('sortword')
    expect(results.map((r) => r.sessionId)).toEqual(['newer', 'older'])
  })

  it('skips malformed/half-written lines without crashing', async () => {
    await writeSessionFile('proj-a', 'session-11', [
      { type: 'user', message: { role: 'user', content: 'valid brokenmarker line' } },
      '{ this is not valid json brokenmarker',
    ])

    const { results } = await service.searchSessions('brokenmarker')
    expect(results).toHaveLength(1)
    expect(results[0].matchCount).toBe(1)
  })

  it('throws on empty or whitespace-only query', async () => {
    await expect(service.searchSessions('')).rejects.toThrow()
    await expect(service.searchSessions('   ')).rejects.toThrow()
  })

  it('falls back to a JS scan when ripgrep is unavailable', async () => {
    await writeSessionFile('proj-a', 'session-13', [
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'fallbackword works fine' } },
    ])
    ;(service as unknown as { commandExists: () => Promise<boolean> }).commandExists = async () => false

    const { results } = await service.searchSessions('fallbackword')
    expect(results).toHaveLength(1)
    expect(results[0].matches[0].role).toBe('user')
    expect(results[0].matches[0].snippet).toContain('fallbackword')
  })

  it('returns empty when the projects dir does not exist', async () => {
    await fs.rm(path.join(tmpDir, 'projects'), { recursive: true, force: true })
    const { results, truncated } = await service.searchSessions('anything')
    expect(results).toEqual([])
    expect(truncated).toBe(false)
  })
})
