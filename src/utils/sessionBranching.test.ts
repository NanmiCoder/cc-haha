import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { parseJSONL } from './json.js'
import { createSessionBranch } from './sessionBranching.js'

const tempDirs: string[] = []

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    await rm(dir, { recursive: true, force: true })
  }
})

describe('createSessionBranch with detachNativeSession', () => {
  test('branches linear transcripts without parentUuid links, strips nativeSessionId, and marks antigravityForkSeedPending', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'session-branching-agy-'))
    tempDirs.push(dir)
    const sourceSessionId = '11111111-1111-4111-8111-111111111111'
    const sourcePath = path.join(dir, `${sourceSessionId}.jsonl`)

    const u1 = '22222222-2222-4222-8222-222222222221'
    const a1 = '22222222-2222-4222-8222-222222222222'
    const u2 = '22222222-2222-4222-8222-222222222223'
    const a2 = '22222222-2222-4222-8222-222222222224'

    const lines = [
      JSON.stringify({
        type: 'session-meta',
        isMeta: true,
        workDir: '/repo/demo',
        runtimeProviderId: 'antigravity-acp',
        runtimeModelId: 'gemini-3.8-pro',
        effortLevel: 'high',
        permissionMode: 'acceptEdits',
        nativeSessionId: 'native-parent-1',
        timestamp: '2026-11-28T00:00:00.000Z',
      }),
      JSON.stringify({
        type: 'user',
        uuid: u1,
        sessionId: sourceSessionId,
        timestamp: '2026-11-28T00:00:01.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'First turn prompt' }] },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: a1,
        sessionId: sourceSessionId,
        timestamp: '2026-11-28T00:00:02.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'First turn reply' }] },
      }),
      JSON.stringify({
        type: 'user',
        uuid: u2,
        sessionId: sourceSessionId,
        timestamp: '2026-11-28T00:00:03.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'Second turn prompt' }] },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: a2,
        sessionId: sourceSessionId,
        timestamp: '2026-11-28T00:00:04.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Second turn reply' }] },
      }),
    ]
    await writeFile(sourcePath, `${lines.join('\n')}\n`, 'utf8')

    const branch = await createSessionBranch({
      sourceSessionId,
      sourceTranscriptPath: sourcePath,
      targetMessageId: a1,
      title: 'Checkpoint 1',
      sourceWorkDir: '/repo/demo',
      detachNativeSession: true,
    })

    const entries = parseJSONL<Record<string, unknown>>(await readFile(branch.forkPath))
    const metaEntries = entries.filter((entry) => entry.type === 'session-meta')
    expect(metaEntries.length).toBeGreaterThan(0)
    for (const meta of metaEntries) {
      expect(meta.nativeSessionId).toBeUndefined()
      expect(meta.antigravitySessionId).toBeUndefined()
    }
    const lastMeta = metaEntries.at(-1)!
    expect(lastMeta.runtimeProviderId).toBe('antigravity-acp')
    expect(lastMeta.runtimeModelId).toBe('gemini-3.8-pro')
    expect(lastMeta.effortLevel).toBe('high')
    expect(lastMeta.permissionMode).toBe('acceptEdits')
    expect(lastMeta.antigravityForkSeedPending).toBe(true)

    const messageEntries = entries.filter((entry) => entry.type === 'user' || entry.type === 'assistant')
    expect(messageEntries.map((entry) => entry.uuid)).toEqual([u1, a1])
    expect(messageEntries[0]!.parentUuid).toBeNull()
    expect(messageEntries[1]!.parentUuid).toBe(u1)
  })

  test('preserves inherited parentUuid turns plus newly appended linear turns on nested fork', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'session-branching-agy-nested-'))
    tempDirs.push(dir)
    const sourceSessionId = '33333333-3333-4333-8333-333333333333'
    const sourcePath = path.join(dir, `${sourceSessionId}.jsonl`)

    const u1 = '44444444-4444-4444-8444-444444444441'
    const a1 = '44444444-4444-4444-8444-444444444442'
    const u2 = '44444444-4444-4444-8444-444444444443'
    const a2 = '44444444-4444-4444-8444-444444444444'

    const lines = [
      JSON.stringify({
        type: 'session-meta',
        isMeta: true,
        workDir: '/repo/demo',
        runtimeProviderId: 'antigravity-acp',
        nativeSessionId: 'native-branch-1',
        antigravityForkSeedPending: false,
        timestamp: '2026-11-28T00:00:00.000Z',
      }),
      // Inherited turns carry parentUuid links from the first fork
      JSON.stringify({
        type: 'user',
        uuid: u1,
        parentUuid: null,
        sessionId: sourceSessionId,
        timestamp: '2026-11-28T00:00:01.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'Inherited turn' }] },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: a1,
        parentUuid: u1,
        sessionId: sourceSessionId,
        timestamp: '2026-11-28T00:00:02.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Inherited reply' }] },
      }),
      // Newly appended Antigravity turns omit parentUuid
      JSON.stringify({
        type: 'user',
        uuid: u2,
        sessionId: sourceSessionId,
        timestamp: '2026-11-28T00:00:03.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'Follow-up turn' }] },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: a2,
        sessionId: sourceSessionId,
        timestamp: '2026-11-28T00:00:04.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Follow-up reply' }] },
      }),
    ]
    await writeFile(sourcePath, `${lines.join('\n')}\n`, 'utf8')

    const nested = await createSessionBranch({
      sourceSessionId,
      sourceTranscriptPath: sourcePath,
      targetMessageId: a2,
      title: 'Nested Branch',
      sourceWorkDir: '/repo/demo',
      detachNativeSession: true,
    })

    const entries = parseJSONL<Record<string, unknown>>(await readFile(nested.forkPath))
    const messageEntries = entries.filter((entry) => entry.type === 'user' || entry.type === 'assistant')
    expect(messageEntries.map((entry) => entry.uuid)).toEqual([u1, a1, u2, a2])
    expect(messageEntries.map((entry) => entry.parentUuid)).toEqual([null, u1, a1, u2])
  })
})
