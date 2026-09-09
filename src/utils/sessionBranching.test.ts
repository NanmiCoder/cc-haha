import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inferSessionApiFormat } from '../server/services/sessionProtocolHistory.js'
import { createSessionBranch } from './sessionBranching.js'

describe('branch protocol inheritance', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    for (const directory of tempDirs.splice(0)) await rm(directory, { recursive: true, force: true })
  })

  async function branchFixture(options: {
    firstProvider?: string | null
    branchAtFirst?: boolean
    lock?: 'anthropic' | 'openai_responses'
  }) {
    const directory = await mkdtemp(join(tmpdir(), 'branch-protocol-'))
    tempDirs.push(directory)
    const sourceSessionId = crypto.randomUUID()
    const sourceTranscriptPath = join(directory, `${sourceSessionId}.jsonl`)
    let parentUuid: string | null = null
    let sequence = 0
    function message(type: 'user' | 'assistant', content: string) {
      const uuid = crypto.randomUUID()
      const result = {
        type, uuid, parentUuid, sessionId: sourceSessionId, isSidechain: false,
        timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, sequence++)).toISOString(),
        cwd: directory,
        message: { role: type, content },
      }
      parentUuid = uuid
      return result
    }
    const user = message('user', 'first prompt')
    const firstReply = message('assistant', 'first reply')
    const entries = [
      { type: 'session-meta', workDir: directory, unknownField: { preserve: true },
        ...(options.firstProvider !== undefined ? { runtimeProviderId: options.firstProvider } : {}) },
      user,
      firstReply,
      { type: 'session-meta', runtimeProviderId: 'openai-official', runtimeModelId: 'same-model-name' },
      message('user', 'later prompt'),
      message('assistant', 'later reply'),
      ...(options.lock ? [{ type: 'session-meta', sessionApiFormat: options.lock }] : []),
    ]
    const original = entries.map(entry => JSON.stringify(entry)).join('\n') + '\n'
    await writeFile(sourceTranscriptPath, original)
    const branch = await createSessionBranch({
      sourceSessionId, sourceTranscriptPath,
      ...(options.branchAtFirst ? { targetMessageId: firstReply.uuid } : {}),
    })
    const copied = (await readFile(branch.forkPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(await readFile(sourceTranscriptPath, 'utf8')).toBe(original)
    expect(copied.find(entry => entry.unknownField)?.unknownField).toEqual({ preserve: true })
    return copied
  }

  it('inherits the selected earlier protocol instead of a later provider selection', async () => {
    const entries = await branchFixture({ firstProvider: null, branchAtFirst: true })
    expect(inferSessionApiFormat(entries)).toBe('anthropic')
    expect(entries.some(entry => entry.type === 'session-meta' && entry.sessionApiFormat === 'anthropic')).toBe(true)
    expect(entries.filter(entry => entry.type === 'assistant')).toHaveLength(1)
  })

  it('preserves mixed legacy history instead of reclassifying every reply as the last protocol', async () => {
    const entries = await branchFixture({ firstProvider: null })
    expect(inferSessionApiFormat(entries)).toBe('mixed')
    expect(entries.some(entry => entry.type === 'session-meta' && entry.sessionApiFormat === 'mixed')).toBe(true)
  })

  it('preserves unknown legacy history instead of assigning a later known provider retroactively', async () => {
    const entries = await branchFixture({})
    expect(inferSessionApiFormat(entries)).toBe('unknown')
    expect(entries.some(entry => entry.type === 'session-meta' && entry.sessionApiFormat === 'unknown')).toBe(true)
  })

  it('keeps an explicit parent lock when branching at an earlier message', async () => {
    const entries = await branchFixture({ branchAtFirst: true, lock: 'openai_responses' })
    expect(inferSessionApiFormat(entries)).toBe('openai_responses')
  })
})
