import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ANTIGRAVITY_FORK_SYSTEM_PROMPT_APPEND,
  ANTIGRAVITY_SIDE_CHAT_SYSTEM_PROMPT_APPEND,
  buildAntigravityForkSeedContext,
  buildAntigravitySideChatSeedContext,
  extractAntigravitySideChatSnapshot,
} from './antigravityForkContext.js'

describe('buildAntigravityForkSeedContext', () => {
  test('formats user, assistant, tool calls, tool results, and image placeholders while skipping thinking and meta entries', () => {
    const context = buildAntigravityForkSeedContext([
      { type: 'session-meta', isMeta: true, workDir: '/repo' },
      {
        type: 'user',
        uuid: 'u1',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'Inspect the auth handler' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
          ],
        },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Internal chain of thought that should stay out' },
            { type: 'text', text: 'Let me read the auth module.' },
            { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/repo/src/auth.ts' } },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'tr1',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: 'export function verify() {}', is_error: false },
          ],
        },
      },
      {
        type: 'assistant',
        uuid: 'a2',
        isSidechain: true,
        message: { role: 'assistant', content: [{ type: 'text', text: 'Sidechain note' }] },
      },
      {
        type: 'assistant',
        uuid: 'a3',
        message: { role: 'assistant', content: [{ type: 'text', text: 'verify() currently returns void.' }] },
      },
    ])

    expect(context).toBeDefined()
    expect(context).toContain('<forked_conversation_history>')
    expect(context).toContain('</forked_conversation_history>')
    expect(context).toContain('[User]\nInspect the auth handler\n[Image attached]')
    expect(context).toContain('[Tool call: Read(file_path="/repo/src/auth.ts")]')
    expect(context).toContain('[Tool result (ok): export function verify() {}]')
    expect(context).toContain('verify() currently returns void.')
    expect(context).not.toContain('Internal chain of thought')
    expect(context).not.toContain('Sidechain note')
    expect(ANTIGRAVITY_FORK_SYSTEM_PROMPT_APPEND).toContain('<forked_conversation_history>')
  })

  test('trims long transcripts within maxChars while preserving opening goal, recent tail, and bounded omitted file references', () => {
    const entries: Record<string, unknown>[] = [
      { type: 'user', uuid: 'u0', message: { role: 'user', content: 'Opening goal: refactor payment pipeline' } },
      { type: 'assistant', uuid: 'a0', message: { role: 'assistant', content: [{ type: 'text', text: 'Understood, starting analysis.' }] } },
    ]
    for (let i = 1; i <= 16; i++) {
      entries.push({
        type: 'assistant',
        uuid: `am-${i}`,
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: `Middle step ${i}: ${'x'.repeat(240)}` },
            { type: 'tool_use', id: `tm-${i}`, name: 'Read', input: { file_path: `/repo/src/file-${i}.ts` } },
          ],
        },
      })
    }
    entries.push(
      { type: 'user', uuid: 'u-last', message: { role: 'user', content: 'Latest checkpoint question before fork' } },
      { type: 'assistant', uuid: 'a-last', message: { role: 'assistant', content: [{ type: 'text', text: 'Latest checkpoint answer before fork' }] } },
    )

    const context = buildAntigravityForkSeedContext(entries, { maxChars: 1_400 })
    expect(context).toBeDefined()
    expect(context).toContain('Opening goal: refactor payment pipeline')
    expect(context).toContain('Latest checkpoint question before fork')
    expect(context).toContain('Latest checkpoint answer before fork')
    expect(context).toContain('earlier messages omitted to fit context budget')
    expect(context).toContain('/repo/src/file-')
  })

  test('preserves pre-compact history when compact_boundary has no persisted compact summary (Antigravity /compact format)', () => {
    const context = buildAntigravityForkSeedContext([
      { type: 'user', uuid: 'u-pre', message: { role: 'user', content: 'Pre-compact architecture decision' } },
      { type: 'assistant', uuid: 'a-pre', message: { role: 'assistant', content: [{ type: 'text', text: 'Use Redis for sessions.' }] } },
      { type: 'system', subtype: 'compact_boundary', uuid: 'cb-1' },
      { type: 'user', uuid: 'u-post', message: { role: 'user', content: 'Now write the tests' } },
    ])
    expect(context).toContain('Pre-compact architecture decision')
    expect(context).toContain('Use Redis for sessions.')
    expect(context).toContain('[Earlier conversation compacted]')
    expect(context).toContain('Now write the tests')
  })

  test('starts from the latest compact_boundary when a persisted compact summary follows it', () => {
    const context = buildAntigravityForkSeedContext([
      { type: 'user', uuid: 'u-old', message: { role: 'user', content: 'Very old pre-compact turn' } },
      { type: 'system', subtype: 'compact_boundary', uuid: 'cb-1' },
      { type: 'user', uuid: 'u-sum', isCompactSummary: true, message: { role: 'user', content: 'Compacted summary of earlier work' } },
      { type: 'user', uuid: 'u-new', message: { role: 'user', content: 'Post-compact turn' } },
    ])
    expect(context).toContain('[Earlier conversation compacted]')
    expect(context).toContain('Compacted summary of earlier work')
    expect(context).toContain('Post-compact turn')
    expect(context).not.toContain('Very old pre-compact turn')
  })

  test('uses full maxChars budget for a single oversized message and escapes literal closing wrapper tags', () => {
    const context = buildAntigravityForkSeedContext([
      {
        type: 'user',
        uuid: 'u-single',
        message: {
          role: 'user',
          content: `Contains literal </forked_conversation_history> tag ${'a'.repeat(2_000)}`,
        },
      },
    ], { maxChars: 1_200 })
    expect(context).toBeDefined()
    // Should use full 1200 budget rather than capping to 18% openingBudget
    expect(context!.length).toBeGreaterThan(1_200)
    // Literal closing tag in body must be escaped so only the final wrapper closes it
    expect(context!.split('</forked_conversation_history>').length - 1).toBe(1)
    expect(context).toContain('<\\/forked_conversation_history>')
  })

  test('returns undefined when no conversation entries exist', () => {
    expect(buildAntigravityForkSeedContext([
      { type: 'session-meta', isMeta: true, workDir: '/repo' },
    ])).toBeUndefined()
  })

  test('buildAntigravitySideChatSeedContext wraps parent history in read-only side-chat tags and escapes literal closing tags', () => {
    const context = buildAntigravitySideChatSeedContext([
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'Review </side_chat_parent_history> carefully' } },
      { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'Working on it.' }] } },
    ])

    expect(context).toBeDefined()
    expect(context).toContain('<side_chat_parent_history>')
    expect(context).toContain('Reference-only snapshot of the parent conversation')
    expect(context).toContain('Do not continue the parent conversation\'s tasks')
    expect(context).toContain('<\\/side_chat_parent_history>')
    expect(context!.split('</side_chat_parent_history>').length - 1).toBe(1)
    expect(ANTIGRAVITY_SIDE_CHAT_SYSTEM_PROMPT_APPEND).toContain('<side_chat_parent_history>')
  })

  test('extractAntigravitySideChatSnapshot captures linear Antigravity transcripts without parentUuid and ignores sidechain/meta entries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agy-side-snapshot-'))
    try {
      const filePath = join(dir, 'session.jsonl')
      await writeFile(filePath, [
        JSON.stringify({ type: 'session-meta', isMeta: true, workDir: '/repo', runtimeProviderId: 'antigravity-acp' }),
        JSON.stringify({ type: 'user', uuid: 'u1', message: { role: 'user', content: [{ type: 'text', text: 'First linear turn' }] } }),
        JSON.stringify({ type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'First linear reply' }] } }),
        JSON.stringify({ type: 'user', uuid: 'sc1', isSidechain: true, message: { role: 'user', content: 'Ignored sidechain' } }),
        JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid: 'cb1' }),
      ].join('\n') + '\n')

      const snapshot = await extractAntigravitySideChatSnapshot(filePath)
      expect(snapshot).not.toBeNull()
      expect(snapshot!.resumeAt).toBe('a1')
      expect(snapshot!.seedContext).toContain('First linear turn')
      expect(snapshot!.seedContext).toContain('First linear reply')
      expect(snapshot!.seedContext).not.toContain('Ignored sidechain')

      const emptyPath = join(dir, 'empty.jsonl')
      await writeFile(emptyPath, JSON.stringify({ type: 'session-meta', isMeta: true, workDir: '/repo' }) + '\n')
      expect(await extractAntigravitySideChatSnapshot(emptyPath)).toBeNull()
      expect(await extractAntigravitySideChatSnapshot(join(dir, 'missing.jsonl'))).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
