import { afterEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { appendFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import {
  appendFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { openLocalIndexDatabase } from './database.js'
import { createSessionIndex, type SessionIndex } from './sessionIndex.js'
import {
  SESSION_SUMMARY_PARSER_VERSION,
  MAX_PROJECTION_RECORD_BYTES,
  MAX_PROJECTION_RECORDS,
  createSessionProjector,
  type SessionSourceCandidate,
} from './sessionProjector.js'
import { verifySourceFingerprint } from './sourceFingerprint.js'

const tempDirs: string[] = []
const exactFileTime = new Date(1_700_000_000_000)

async function createTempDir(label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `cc-haha-${label}-`))
  tempDirs.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(directory =>
    rm(directory, { recursive: true, force: true }),
  ))
})

function line(entry: Record<string, unknown> | string): string {
  return `${typeof entry === 'string' ? entry : JSON.stringify(entry)}\n`
}

function user(title: string, timestamp: string): Record<string, unknown> {
  return {
    type: 'user',
    message: { role: 'user', content: title },
    timestamp,
  }
}

function assistant(timestamp: string): Record<string, unknown> {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: 'reply' },
    timestamp,
  }
}

async function createCandidate(options: {
  root: string
  projectPath: string
  sessionId: string
  content: string
  fileTime?: Date
}): Promise<SessionSourceCandidate> {
  const path = join(options.root, 'projects', options.projectPath, `${options.sessionId}.jsonl`)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, options.content)
  if (options.fileTime) await utimes(path, options.fileTime, options.fileTime)
  const snapshot = await stat(path)
  return {
    path,
    sessionId: options.sessionId,
    projectPath: options.projectPath,
    fallbackCreatedAt: snapshot.birthtime.toISOString(),
    fallbackModifiedAt: snapshot.mtime.toISOString(),
    fallbackWorkDir: `/decoded/${options.projectPath}`,
    modifiedAtMs: snapshot.mtimeMs,
  }
}

async function sourceHash(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

describe('session projector', () => {
  it('rebuilds a v7 cached runtime selection to clear effort omitted by its replacement', async () => {
    const root = await createTempDir('projector-runtime-effort')
    const database = openLocalIndexDatabase({ path: join(root, 'index.sqlite') })
    const index = createSessionIndex(database)
    const candidate = await createCandidate({
      root, projectPath: '-repo', sessionId: 'runtime-replacement',
      content: [
        { type: 'session-meta', runtimeProviderId: 'old-provider', runtimeModelId: 'old-model', effortLevel: 'high' },
        user('Existing conversation', '2026-01-01T00:00:00Z'),
        { type: 'session-meta', runtimeProviderId: 'new-provider', runtimeModelId: 'new-model' },
      ].map(line).join(''),
    })
    try {
      const original = await readFile(candidate.path, 'utf8')
      await createSessionProjector({ database, index, scope: root, parserVersion: 7 }).projectSource(candidate)
      // Reproduce the cached summary written by the v7 reducer.
      database.write(operation => operation.run(
        'UPDATE sessions SET effort_level = ? WHERE session_id = ?', 'high', candidate.sessionId,
      ))
      expect(index.listSessions().sessions[0]?.effortLevel).toBe('high')
      const restarted = createSessionProjector({ database, index, scope: root })
      expect(await restarted.projectSource(candidate)).toMatchObject({ kind: 'indexed', action: 'rebuild' })
      expect(index.listSessions().sessions[0]).toMatchObject({ runtimeProviderId: 'new-provider', runtimeModelId: 'new-model' })
      expect(index.listSessions().sessions[0]?.effortLevel).toBeUndefined()
      expect(await readFile(candidate.path, 'utf8')).toBe(original)
    } finally {
      database.close()
    }
  })

  it('stores explicit Fast false in the index after previously enabled OAuth metadata', async () => {
    const root = await createTempDir('projector-fast-mode')
    const database = openLocalIndexDatabase({ path: join(root, 'index.sqlite') })
    const index = createSessionIndex(database)
    const candidate = await createCandidate({
      root, projectPath: '-repo', sessionId: 'fast-mode',
      content: [
        { type: 'session-meta', runtimeProviderId: 'openai-official', runtimeModelId: 'unknown-model', openAIFastMode: true },
        user('Existing conversation', '2026-01-01T00:00:00Z'),
        { type: 'session-meta', openAIFastMode: false },
      ].map(line).join(''),
    })
    try {
      await createSessionProjector({ database, index, scope: root }).projectSource(candidate)
      expect(index.getSession(candidate.sessionId)?.openAIFastMode).toBe(false)
      expect(index.listSessions().sessions[0]?.openAIFastMode).toBe(false)
      expect(index.getProjectionSeed(candidate.path)?.summary.openAIFastMode).toBe(false)
    } finally {
      database.close()
    }
  })

  it('persists an immediate title patch without waiting for transcript reprojection', async () => {
    const root = await createTempDir('projector-title-patch')
    const databasePath = join(root, 'index.sqlite')
    const placeholder = await createCandidate({
      root,
      projectPath: '-repo-placeholder',
      sessionId: 'titled-child',
      content: line(user('Initial child title', '2026-01-01T00:00:00Z')),
    })
    const moved = await createCandidate({
      root,
      projectPath: '-repo-worktree',
      sessionId: 'titled-child',
      content: line(user('Initial child title', '2026-01-01T00:00:01Z')),
    })
    const database = openLocalIndexDatabase({ path: databasePath })
    const index = createSessionIndex(database)
    try {
      const projector = createSessionProjector({ database, index, scope: root })
      expect((await projector.projectSource(placeholder)).kind).toBe('indexed')
      expect((await projector.projectSource(moved)).kind).toBe('indexed')
      await appendFile(moved.path, line({
        type: 'custom-title',
        customTitle: '最终子会话标题',
      }))

      expect(index.updateSessionTitle?.(moved.sessionId, '最终子会话标题')).toBe(true)
    } finally {
      database.close()
    }

    const restarted = openLocalIndexDatabase({ path: databasePath })
    try {
      const sessions = createSessionIndex(restarted).listSessions().sessions
      expect(sessions).toHaveLength(2)
      expect(sessions.every(session => session.title === '最终子会话标题')).toBe(true)
    } finally {
      restarted.close()
    }
  })

  it('indexes a Read-tool image record larger than the buffer threshold without concatenating it', async () => {
    const root = await createTempDir('projector-record-budget')
    // A Read-tool image result stores its base64 twice, which is how real
    // transcripts end up with single lines above 8 MiB.
    const base64 = 'A'.repeat(MAX_PROJECTION_RECORD_BYTES / 2 + 1024)
    const prompt = line(user('Look at this screenshot', '2026-01-01T00:00:00Z'))
    const image = line({
      parentUuid: 'u-prompt',
      isSidechain: false,
      type: 'user',
      message: {
        role: 'user',
        content: [{
          tool_use_id: 'toolu_1',
          type: 'tool_result',
          content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } }],
        }],
      },
      toolUseResult: { type: 'image', file: { base64, type: 'image/png', originalSize: base64.length } },
      uuid: 'u-image',
      timestamp: '2026-01-01T00:00:01Z',
    })
    const reply = line(assistant('2026-01-01T00:00:02Z'))
    expect(Buffer.byteLength(image)).toBeGreaterThan(MAX_PROJECTION_RECORD_BYTES)
    const candidate = await createCandidate({ root, projectPath: '-repo', sessionId: 'large', content: prompt + image + reply })
    const before = await sourceHash(candidate.path)
    const database = openLocalIndexDatabase({ path: join(root, 'index.sqlite') })
    const index = createSessionIndex(database)
    try {
      const projector = createSessionProjector({ database, index, scope: root })
      const result = await projector.projectSource(candidate)
      expect(result).toMatchObject({ kind: 'indexed', action: 'full' })
      if (result.kind !== 'indexed') throw new Error('expected an indexed result')
      expect(result.projection.summary).toMatchObject({
        title: 'Look at this screenshot',
        messageCount: 3,
        modifiedAt: '2026-01-01T00:00:02Z',
      })
      expect(result.projection.indexedBytes).toBe(Buffer.byteLength(prompt + image + reply))
      expect(result.projection.malformedLineCount).toBe(0)
      expect(result.work.maxBufferedBytes).toBeLessThanOrEqual(MAX_PROJECTION_RECORD_BYTES + 2 * 1024 * 1024)
      const locators = index.getSessionEntryLocators(candidate.path)!.entries
      expect(locators).toHaveLength(3)
      expect(locators[1]).toMatchObject({
        jsonlLine: 2,
        byteStart: Buffer.byteLength(prompt),
        byteLength: Buffer.byteLength(image),
        entryType: 'user',
        messageId: 'u-image',
        role: 'user',
        timestamp: '2026-01-01T00:00:01Z',
      })
      expect(locators[2]).toMatchObject({ byteStart: Buffer.byteLength(prompt + image), entryType: 'assistant' })
      expect(index.getSource(candidate.path)).toMatchObject({ state: 'ready', parserVersion: SESSION_SUMMARY_PARSER_VERSION })
      expect(await sourceHash(candidate.path)).toBe(before)
    } finally { database.close() }
  })

  it('titles an oversized first prompt from its preview, like a small one', async () => {
    const root = await createTempDir('projector-record-title')
    const candidate = await createCandidate({ root, projectPath: '-repo', sessionId: 'large-title', content: line(user('x'.repeat(MAX_PROJECTION_RECORD_BYTES + 1), '2026-01-01T00:00:00Z')) })
    const database = openLocalIndexDatabase({ path: join(root, 'index.sqlite') })
    try {
      const projector = createSessionProjector({ database, index: createSessionIndex(database), scope: root })
      const result = await projector.projectSource(candidate)
      expect(result).toMatchObject({ kind: 'indexed', projection: { summary: { title: `${'x'.repeat(80)}...`, messageCount: 1 } } })
    } finally { database.close() }
  })

  const skeletonPadding = 'p'.repeat(12_000)
  const skeletonTranscript: Array<Record<string, unknown> | string> = [
    { type: 'session-meta', workDir: '/work', permissionMode: 'plan', runtimeProviderId: 'provider', runtimeModelId: 'model-x', effortLevel: 'high', timestamp: '2026-01-01T00:00:00Z', padding: skeletonPadding },
    { type: 'worktree-state', worktreeSession: { worktreePath: '/work/.claude/worktrees/a', worktreeName: 'a', originalCwd: '/work' }, timestamp: '2026-01-01T00:00:01Z' },
    { type: 'user', cwd: '/work/cwd', version: '2.1.0', sessionId: 'parity', repository: { repoRoot: '/work' }, message: { role: 'user', content: [{ type: 'text', text: `Fix the bug ${'t'.repeat(6_000)}` }] }, uuid: 'u1', timestamp: '2026-01-01T00:00:03Z' },
    {
      type: 'assistant',
      version: '2.1.0',
      sessionId: 'parity',
      requestId: 'req_1',
      uuid: 'a1',
      timestamp: '2026-01-01T00:00:04Z',
      message: {
        id: 'msg_1',
        role: 'assistant',
        model: 'claude-sonnet-5-5',
        content: [
          { type: 'tool_use', id: 't1', name: 'Skill', input: { skill: 'review', args: skeletonPadding } },
          { type: 'tool_use', id: 't2', name: 'Bash', input: { command: `echo 2-shotted by me ${'c'.repeat(100)}`, description: skeletonPadding } },
          { type: 'tool_use', id: 't3', name: 'Write', input: { file_path: '/work/a.ts', content: skeletonPadding } },
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          cache_read_input_tokens: 5,
          cache_creation: { ephemeral_5m_input_tokens: 1, ephemeral_1h_input_tokens: 2 },
          server_tool_use: { web_search_requests: 1 },
          speed: 'fast',
          iterations: [{ type: 'advisor_message', model: 'claude-opus-5-5', input_tokens: 3, output_tokens: 4 }],
        },
      },
    },
    // Same message id under another request: billed separately only when the
    // requestId survives into the dedupe key.
    { type: 'assistant', version: '2.1.0', sessionId: 'parity', requestId: 'req_2', uuid: 'a2', timestamp: '2026-01-01T00:00:04.500Z', message: { id: 'msg_1', role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'again' }], usage: { input_tokens: 100, output_tokens: 200 } } },
    { type: 'user', parent_tool_use_id: 't3', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't3', content: skeletonPadding }] }, toolUseResult: { stdout: skeletonPadding }, uuid: 'u2', timestamp: '2026-01-01T00:00:05Z' },
    { type: 'assistant', forkedFrom: { sessionId: 'parent', messageUuid: 'm0' }, sessionId: 'parity', version: '2.1.0', requestId: 'req_0', uuid: 'a0', timestamp: '2026-01-01T00:00:06Z', message: { id: 'msg_0', role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'forked' }], usage: { input_tokens: 1, output_tokens: 1 } } },
    { type: 'speculation-accept', timeSavedMs: 1234, timestamp: '2026-01-01T00:00:07Z' },
    { type: 'assistant', isSidechain: true, message: { role: 'assistant', content: 'side' }, uuid: 'sc', timestamp: '2026-01-01T00:00:08Z' },
    { type: 'user', isMeta: true, message: { role: 'user', content: 'meta' }, uuid: 'm', timestamp: '2026-01-01T00:00:09Z' },
    { type: 'user', entrypoint: 'claude-desktop-team-worker', message: { role: 'user', content: 'worker' }, uuid: 'w', timestamp: '2026-01-01T00:00:10Z' },
    '[1,2,3]',
    '"a bare string"',
  ]

  const withoutSessionMeta = skeletonTranscript.filter(record => typeof record === 'string' || record.type !== 'session-meta')
  it.each([
    ['an AI title', [...skeletonTranscript, { type: 'ai-title', aiTitle: 'AI named it' }], { title: 'AI named it', permissionMode: 'plan', effortLevel: 'high', workDir: '/work' }],
    ['a /goal title', [{ type: 'system', subtype: 'local_command', content: '<command-name>/goal</command-name><command-args>ship the fix</command-args>', timestamp: '2026-01-01T00:00:02Z', padding: skeletonPadding }, ...skeletonTranscript], { title: '/goal ship the fix' }],
    ['a custom title', [...skeletonTranscript, { type: 'custom-title', customTitle: 'Named by hand', padding: skeletonPadding }], { title: 'Named by hand' }],
    ['the first prompt', skeletonTranscript, { title: `Fix the bug ${'t'.repeat(68)}...`, modifiedAt: '2026-01-01T00:00:10Z' }],
    // Without session metadata the workspace falls back to the entries' cwd.
    ['a cwd-only workspace', withoutSessionMeta, { workDir: '/work/cwd' }],
    // A later meta prompt must not move the semantic modification time.
    ['a trailing meta prompt', [...skeletonTranscript, { type: 'user', isMeta: true, message: { role: 'user', content: 'meta later' }, uuid: 'm2', timestamp: '2026-01-01T00:00:59Z', padding: skeletonPadding }], { modifiedAt: '2026-01-01T00:00:10Z' }],
  ] as const)('projects streamed skeletons exactly like fully parsed records (%s)', async (_label, records, expectedSummary) => {
    const root = await createTempDir('projector-skeleton-parity')
    const candidate = await createCandidate({ root, projectPath: '-repo', sessionId: 'parity', content: records.map(line).join('') })
    const project = async (label: string, recordStreamingThresholdBytes?: number) => {
      const database = openLocalIndexDatabase({ path: join(root, `${label}.sqlite`) })
      const index = createSessionIndex(database)
      try {
        const projector = createSessionProjector({ database, index, scope: root, recordStreamingThresholdBytes })
        const result = await projector.projectSource(candidate)
        if (result.kind !== 'indexed') throw new Error(`expected an indexed result, got ${result.kind}`)
        return {
          projection: result.projection,
          locators: index.getSessionEntryLocators(candidate.path)!.entries,
          maxBufferedBytes: result.work.maxBufferedBytes,
        }
      } finally { database.close() }
    }

    const parsed = await project('parsed')
    const streamed = await project('streamed', 1)
    expect(parsed.projection.summary).toMatchObject({ isTeamWorker: true, ...expectedSummary })
    expect(parsed.projection.activity?.models.find(model => model.model === 'claude-sonnet-5-5')?.inputTokens).toBe(110)
    expect(parsed.projection.activity?.models.some(model => model.model === 'claude-opus-5-5')).toBe(true)
    expect(parsed.projection.activity?.skills).toEqual([expect.objectContaining({ name: 'review' })])
    expect(parsed.projection.activity?.shotCount).toBe(2)
    expect(parsed.projection.activity?.speculationTimeSavedMs).toBe(1234)
    expect(streamed.projection).toEqual(parsed.projection)
    expect(streamed.locators).toEqual(parsed.locators)
    expect(streamed.maxBufferedBytes).toBeLessThan(parsed.maxBufferedBytes)
  })

  it('counts an invalid or blank oversized line exactly like a buffered one', async () => {
    const root = await createTempDir('projector-skeleton-malformed')
    const content = [
      line(user('Before', '2026-01-01T00:00:00Z')),
      '{"type":"user","message":{"role":"user","content":"trailing comma"},}\n',
      `${JSON.stringify(user('one', '2026-01-01T00:00:01Z'))}${JSON.stringify(user('two', '2026-01-01T00:00:02Z'))}\n`,
      `${' '.repeat(64)}\n`,
      line(user('After', '2026-01-01T00:00:03Z')),
    ].join('')
    const candidate = await createCandidate({ root, projectPath: '-repo', sessionId: 'malformed', content })
    const project = async (label: string, recordStreamingThresholdBytes?: number) => {
      const database = openLocalIndexDatabase({ path: join(root, `${label}.sqlite`) })
      const index = createSessionIndex(database)
      try {
        const projector = createSessionProjector({ database, index, scope: root, recordStreamingThresholdBytes })
        const result = await projector.projectSource(candidate)
        if (result.kind !== 'indexed') throw new Error(`expected an indexed result, got ${result.kind}`)
        return { projection: result.projection, locators: index.getSessionEntryLocators(candidate.path)!.entries }
      } finally { database.close() }
    }

    const parsed = await project('parsed')
    const streamed = await project('streamed', 1)
    expect(parsed.projection.malformedLineCount).toBe(2)
    expect(parsed.locators.map(locator => locator.jsonlLine)).toEqual([1, 5])
    expect(streamed).toEqual(parsed)
  })

  it('counts an unterminated oversized tail and reads it again once its newline arrives', async () => {
    const root = await createTempDir('projector-skeleton-tail')
    const first = line(user('First', '2026-01-01T00:00:00Z'))
    const tail = line(user(`Second ${'y'.repeat(4_000)}`, '2026-01-01T00:00:01Z'))
    const candidate = await createCandidate({ root, projectPath: '-repo', sessionId: 'tail', content: first + tail.slice(0, -10) })
    const database = openLocalIndexDatabase({ path: join(root, 'index.sqlite') })
    const index = createSessionIndex(database)
    try {
      const projector = createSessionProjector({ database, index, scope: root, recordStreamingThresholdBytes: 256 })
      const pending = await projector.projectSource(candidate)
      expect(pending).toMatchObject({
        kind: 'indexed',
        projection: {
          indexedBytes: Buffer.byteLength(first),
          pendingTailBytes: Buffer.byteLength(tail) - 10,
          summary: { messageCount: 1 },
        },
      })
      if (pending.kind !== 'indexed') throw new Error('expected an indexed result')
      expect(pending.work.maxBufferedBytes).toBeLessThan(1024)
      expect(index.getSource(candidate.path)).toMatchObject({ state: 'pending' })

      await appendFile(candidate.path, tail.slice(-10))
      const completed = await projector.projectSource(candidate)
      expect(completed).toMatchObject({
        kind: 'indexed',
        action: 'append',
        projection: { indexedBytes: Buffer.byteLength(first + tail), pendingTailBytes: 0, summary: { messageCount: 2 } },
      })
      expect(index.getSessionEntryLocators(candidate.path)!.entries[1]).toMatchObject({
        byteStart: Buffer.byteLength(first),
        byteLength: Buffer.byteLength(tail),
      })
    } finally { database.close() }
  })

  it('still rejects an oversized record whose retained metadata breaks the budget', async () => {
    const root = await createTempDir('projector-skeleton-metadata')
    const candidate = await createCandidate({
      root,
      projectPath: '-repo',
      sessionId: 'long-uuid',
      content: line({ ...user('Title', '2026-01-01T00:00:00Z'), uuid: 'u'.repeat(4097) }),
    })
    const database = openLocalIndexDatabase({ path: join(root, 'index.sqlite') })
    try {
      const projector = createSessionProjector({ database, index: createSessionIndex(database), scope: root, recordStreamingThresholdBytes: 1 })
      await expect(projector.projectSource(candidate)).rejects.toMatchObject({ code: 'LOCAL_INDEX_SOURCE_LIMIT' })
    } finally { database.close() }
  })

  it('projects oversized subagent activity records', async () => {
    const root = await createTempDir('projector-skeleton-activity')
    const content = [
      line(user('Delegated task', '2026-01-01T00:00:00Z')),
      line({
        type: 'assistant',
        uuid: 'a1',
        requestId: 'req_1',
        timestamp: '2026-01-01T00:00:01Z',
        message: {
          id: 'msg_1',
          role: 'assistant',
          model: 'claude-sonnet-5-5',
          content: [{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: '/a', content: 'w'.repeat(4_000) } }],
          usage: { input_tokens: 7, output_tokens: 9 },
        },
      }),
    ].join('')
    const candidate = await createCandidate({ root, projectPath: '-repo/parent/subagents', sessionId: 'agent-1', content })
    const project = async (label: string, recordStreamingThresholdBytes?: number) => {
      const database = openLocalIndexDatabase({ path: join(root, `${label}.sqlite`) })
      try {
        const projector = createSessionProjector({ database, index: createSessionIndex(database), scope: root, recordStreamingThresholdBytes })
        const result = await projector.projectActivitySource(candidate)
        if (result.kind !== 'indexed') throw new Error(`expected an indexed result, got ${result.kind}`)
        return result.projection.activity
      } finally { database.close() }
    }

    const parsed = await project('parsed')
    expect(parsed?.tools).toEqual([expect.objectContaining({ name: 'Write', count: 1 })])
    expect(await project('streamed', 256)).toEqual(parsed)
  })

  it('bounds locator and reducer growth for arbitrarily many tiny records', async () => {
    const root = await createTempDir('projector-count-budget')
    const candidate = await createCandidate({ root, projectPath: '-repo', sessionId: 'many', content: line({ type: 'unknown' }).repeat(MAX_PROJECTION_RECORDS + 1) })
    const database = openLocalIndexDatabase({ path: join(root, 'index.sqlite') })
    try {
      const projector = createSessionProjector({ database, index: createSessionIndex(database), scope: root })
      await expect(projector.projectSource(candidate)).rejects.toMatchObject({ code: 'LOCAL_INDEX_SOURCE_LIMIT' })
    } finally { database.close() }
  })

  it('keeps the record budget across incremental appends', async () => {
    const root = await createTempDir('projector-append-budget')
    const item = line({ type: 'unknown' })
    const candidate = await createCandidate({ root, projectPath: '-repo', sessionId: 'append', content: item.repeat(MAX_PROJECTION_RECORDS) })
    const database = openLocalIndexDatabase({ path: join(root, 'index.sqlite') })
    try {
      const projector = createSessionProjector({ database, index: createSessionIndex(database), scope: root })
      expect((await projector.projectSource(candidate)).kind).toBe('indexed')
      await appendFile(candidate.path, item)
      await expect(projector.projectSource(candidate)).rejects.toMatchObject({ code: 'LOCAL_INDEX_SOURCE_LIMIT' })
    } finally { database.close() }
  })

  it('fully builds without changing JSONL and preserves malformed/pending semantics', async () => {
    const root = await createTempDir('projector-full')
    const candidate = await createCandidate({
      root,
      projectPath: '-repo-a',
      sessionId: 'same-id',
      content: [
        line(user('First title', '2026-01-01T00:00:00.000Z')),
        line('{malformed}'),
        line(assistant('2026-01-01T00:01:00.000Z')),
        '{"type":"assistant"',
      ].join(''),
    })
    const beforeHash = await sourceHash(candidate.path)
    const database = openLocalIndexDatabase({ path: join(root, 'index.sqlite') })
    const index = createSessionIndex(database)
    const projector = createSessionProjector({
      database,
      index,
      scope: root,
    })

    try {
      const result = await projector.projectSource(candidate, {
        discovered: 1,
        indexed: 1,
      })

      expect(result).toMatchObject({
        kind: 'indexed',
        action: 'full',
        projection: {
          summary: {
            title: 'First title',
            messageCount: 2,
            modifiedAt: '2026-01-01T00:01:00.000Z',
          },
          malformedLineCount: 1,
        },
      })
      expect(result.kind === 'indexed' && result.projection.pendingTailBytes).toBeGreaterThan(0)
      expect(index.listSessions()).toMatchObject({
        total: 1,
        sessions: [{
          id: 'same-id',
          projectPath: '-repo-a',
          title: 'First title',
          messageCount: 2,
          transcriptPath: candidate.path,
        }],
      })
      expect(index.getSource(candidate.path)).toMatchObject({
        path: candidate.path,
        state: 'pending',
      })
      expect(await sourceHash(candidate.path)).toBe(beforeHash)
    } finally {
      database.close()
    }
  })

  it('refreshes stale discovery fallback times from the fingerprinted source snapshot', async () => {
    const root = await createTempDir('projector-fresh-fallback')
    const candidate = await createCandidate({
      root,
      projectPath: '-repo-a',
      sessionId: 'fresh-fallback',
      content: line({ type: 'session-meta', workDir: '/before' }),
    })
    const staleModifiedAt = candidate.fallbackModifiedAt
    await writeFile(
      candidate.path,
      line({ type: 'session-meta', workDir: '/after' }),
    )
    const forcedModifiedAt = new Date('2025-05-06T07:08:09.000Z')
    await utimes(candidate.path, forcedModifiedAt, forcedModifiedAt)
    const projectionSnapshot = await stat(candidate.path)
    const database = openLocalIndexDatabase({ path: join(root, 'index.sqlite') })
    const index = createSessionIndex(database)
    const projector = createSessionProjector({ database, index, scope: root })

    try {
      expect(projectionSnapshot.mtime.toISOString()).not.toBe(staleModifiedAt)
      expect(await projector.projectSource(candidate)).toMatchObject({
        kind: 'indexed',
        action: 'full',
        projection: {
          summary: {
            createdAt: projectionSnapshot.birthtime.toISOString(),
            modifiedAt: projectionSnapshot.mtime.toISOString(),
          },
        },
      })
      expect(index.listSessions().sessions[0]).toMatchObject({
        createdAt: projectionSnapshot.birthtime.toISOString(),
        modifiedAt: projectionSnapshot.mtime.toISOString(),
      })
    } finally {
      database.close()
    }
  })

  it('incrementally consumes a prior pending tail and only updates that source', async () => {
    const root = await createTempDir('projector-append')
    const first = await createCandidate({
      root,
      projectPath: '-repo-a',
      sessionId: 'first',
      content: `${line(user('First', '2026-01-01T00:00:00.000Z'))}{"type":"assistant"`,
    })
    const untouched = await createCandidate({
      root,
      projectPath: '-repo-b',
      sessionId: 'untouched',
      content: line(user('Untouched', '2026-01-01T00:02:00.000Z')),
    })
    const database = openLocalIndexDatabase({ path: join(root, 'index.sqlite') })
    const index = createSessionIndex(database)
    const projector = createSessionProjector({ database, index, scope: root })

    try {
      await projector.projectSource(first)
      await projector.projectSource(untouched)
      const untouchedSource = index.getSource(untouched.path)
      await appendFile(
        first.path,
        `,"message":{"role":"assistant","content":"done"},"timestamp":"2026-01-01T00:03:00.000Z"}\n`,
      )

      const result = await projector.projectSource(first)

      expect(result).toMatchObject({
        kind: 'indexed',
        action: 'append',
        projection: {
          summary: { messageCount: 2 },
          pendingTailBytes: 0,
        },
      })
      expect(index.getSource(untouched.path)).toEqual(untouchedSource)
    } finally {
      database.close()
    }
  })

  it('rebuilds an append when the prior summary depended on the file mtime fallback', async () => {
    const root = await createTempDir('projector-append-fallback')
    const candidate = await createCandidate({
      root,
      projectPath: '-repo-a',
      sessionId: 'append-fallback',
      content: line({ type: 'session-meta', workDir: '/before' }),
    })
    const database = openLocalIndexDatabase({ path: join(root, 'index.sqlite') })
    const index = createSessionIndex(database)
    const projector = createSessionProjector({ database, index, scope: root })

    try {
      expect(await projector.projectSource(candidate)).toMatchObject({
        kind: 'indexed',
        action: 'full',
      })
      await appendFile(candidate.path, line({ type: 'session-meta', workDir: '/after' }))
      const appendedSnapshot = await stat(candidate.path)

      expect(await projector.projectSource(candidate)).toMatchObject({
        kind: 'indexed',
        action: 'rebuild',
        projection: {
          summary: {
            modifiedAt: appendedSnapshot.mtime.toISOString(),
            workDir: '/after',
          },
        },
      })
    } finally {
      database.close()
    }
  })

  it('rebuilds one source for rewrites, parser changes, and missing reducer state after restart', async () => {
    const root = await createTempDir('projector-rebuild')
    const candidate = await createCandidate({
      root,
      projectPath: '-repo-a',
      sessionId: 'first',
      content: line(user('Original', '2026-01-01T00:00:00.000Z')),
    })
    const database = openLocalIndexDatabase({ path: join(root, 'index.sqlite') })
    const index = createSessionIndex(database)
    const firstProcess = createSessionProjector({ database, index, scope: root })

    try {
      await firstProcess.projectSource(candidate)
      await writeFile(
        candidate.path,
        line(user('Replacement', '2026-01-02T00:00:00.000Z')),
      )
      expect(await firstProcess.projectSource(candidate)).toMatchObject({
        kind: 'indexed',
        action: 'rebuild',
        projection: { summary: { title: 'Replacement', messageCount: 1 } },
      })

      const parserUpgrade = createSessionProjector({
        database,
        index,
        scope: root,
        parserVersion: SESSION_SUMMARY_PARSER_VERSION + 1,
      })
      expect(await parserUpgrade.projectSource(candidate)).toMatchObject({
        kind: 'indexed',
        action: 'rebuild',
      })

      const restartedProcess = createSessionProjector({
        database,
        index,
        scope: root,
        parserVersion: SESSION_SUMMARY_PARSER_VERSION + 1,
      })
      await appendFile(candidate.path, line(assistant('2026-01-02T00:01:00.000Z')))
      expect(await restartedProcess.projectSource(candidate)).toMatchObject({
        kind: 'indexed',
        action: 'rebuild',
        projection: { summary: { title: 'Replacement', messageCount: 2 } },
      })
    } finally {
      database.close()
    }
  })

  it('rebuilds a v5 cached session and ignores retained protocol metadata after rollback', async () => {
    const root = await createTempDir('projector-protocol-rollback')
    const content = line({ type: 'session-meta', sessionApiFormat: 'unknown' }) +
      line(user('Existing conversation', '2026-01-01T00:00:00.000Z')) +
      line(assistant('2026-01-01T00:01:00.000Z'))
    const candidate = await createCandidate({
      root,
      projectPath: '-repo-a',
      sessionId: 'existing',
      content,
    })
    const database = openLocalIndexDatabase({ path: join(root, 'index.sqlite') })
    const index = createSessionIndex(database)
    try {
      const oldParser = createSessionProjector({ database, index, scope: root, parserVersion: 5 })
      await oldParser.projectSource(candidate)
      database.write(operation => operation.run(
        "UPDATE sessions SET session_api_format = 'unknown' WHERE transcript_path = ?",
        candidate.path,
      ))
      const projector = createSessionProjector({ database, index, scope: root })
      const result = await projector.projectSource(candidate)
      expect(result).toMatchObject({
        kind: 'indexed',
        action: 'rebuild',
        projection: { summary: { title: 'Existing conversation', messageCount: 2 } },
      })
      if (result.kind !== 'indexed') throw new Error('Expected rebuilt session')
      expect(result.projection.summary).not.toHaveProperty('sessionApiFormat')
      expect(database.read(operation => operation.get<{ parser_version: number }>(
        'SELECT parser_version FROM source_files WHERE path = ?', candidate.path,
      )?.parser_version)).toBe(SESSION_SUMMARY_PARSER_VERSION)
      expect(database.read(operation => operation.get<{ session_api_format: string }>(
        'SELECT session_api_format FROM sessions WHERE transcript_path = ?', candidate.path,
      )?.session_api_format)).toBe('unknown')
      expect(await readFile(candidate.path, 'utf8')).toBe(content)
    } finally {
      database.close()
    }
  })

  it('keeps duplicate ids distinct and queries project-filtered deterministic pages', async () => {
    const root = await createTempDir('projector-query')
    const database = openLocalIndexDatabase({ path: join(root, 'index.sqlite') })
    const index = createSessionIndex(database)
    const projector = createSessionProjector({ database, index, scope: root })
    const candidates = [
      await createCandidate({
        root,
        projectPath: '-repo-b',
        sessionId: 'duplicate',
        content: line(user('B', '2026-01-01T00:00:00.000Z')),
      }),
      await createCandidate({
        root,
        projectPath: '-repo-a',
        sessionId: 'duplicate',
        content: line(user('A', '2026-01-01T01:00:00.000+01:00')),
      }),
      await createCandidate({
        root,
        projectPath: '-repo-a',
        sessionId: 'later',
        content: line(user('Later', '2026-01-02T00:00:00.000Z')),
      }),
      await createCandidate({
        root,
        projectPath: '-repo-c',
        sessionId: 'timezone-later',
        content: line(user('Timezone later', '2026-01-01T00:30:00.000Z')),
      }),
    ]

    try {
      for (const candidate of candidates) await projector.projectSource(candidate)

      expect(index.listSessions().sessions.map(item => [item.id, item.projectPath])).toEqual([
        ['later', '-repo-a'],
        ['timezone-later', '-repo-c'],
        ['duplicate', '-repo-a'],
        ['duplicate', '-repo-b'],
      ])
      expect(index.listSessions({ project: '-repo-a', limit: 1, offset: 1 })).toMatchObject({
        total: 2,
        sessions: [{ id: 'duplicate', title: 'A' }],
      })
      expect(index.findSearchCandidates?.({
        project: '-repo-a',
        modifiedAfterMs: Date.parse('2026-01-02T00:00:00.000Z'),
        modifiedBeforeMs: Date.parse('2026-01-02T23:59:59.999Z'),
      })).toEqual([{
        transcriptPath: candidates[2]!.path,
        id: 'later',
        title: 'Later',
        modifiedAt: '2026-01-02T00:00:00.000Z',
        projectPath: '-repo-a',
        workDir: '/decoded/-repo-a',
      }])
      expect(index.findSessionFiles('duplicate')).toEqual([
        { filePath: candidates[1]!.path, projectDir: '-repo-a' },
        { filePath: candidates[0]!.path, projectDir: '-repo-b' },
      ])
    } finally {
      database.close()
    }
  })

  it('round-trips absent, explicit-null, and string runtime provider metadata', async () => {
    const root = await createTempDir('projector-provider-presence')
    const database = openLocalIndexDatabase({ path: join(root, 'index.sqlite') })
    const index = createSessionIndex(database)
    const projector = createSessionProjector({ database, index, scope: root })
    const candidates = [
      await createCandidate({
        root,
        projectPath: '-repo-a',
        sessionId: 'absent',
        content: line(user('Absent', '2026-01-01T00:00:00.000Z')),
      }),
      await createCandidate({
        root,
        projectPath: '-repo-a',
        sessionId: 'explicit-null',
        content: line({
          type: 'session-meta',
          runtimeProviderId: null,
          timestamp: '2026-01-01T00:01:00.000Z',
        }),
      }),
      await createCandidate({
        root,
        projectPath: '-repo-a',
        sessionId: 'string',
        content: line({
          type: 'session-meta',
          runtimeProviderId: 'provider-a',
          timestamp: '2026-01-01T00:02:00.000Z',
        }),
      }),
    ]

    try {
      for (const candidate of candidates) await projector.projectSource(candidate)
      const byId = new Map(index.listSessions({ limit: 10 }).sessions.map(row => [row.id, row]))

      expect(Object.hasOwn(byId.get('absent')!, 'runtimeProviderId')).toBe(false)
      expect(Object.hasOwn(byId.get('explicit-null')!, 'runtimeProviderId')).toBe(true)
      expect(byId.get('explicit-null')!.runtimeProviderId).toBeNull()
      expect(byId.get('string')!.runtimeProviderId).toBe('provider-a')
    } finally {
      database.close()
    }
  })

  it('removes only a confirmed missing source projection', async () => {
    const root = await createTempDir('projector-delete')
    const candidate = await createCandidate({
      root,
      projectPath: '-repo-a',
      sessionId: 'deleted',
      content: line(user('Delete me', '2026-01-01T00:00:00.000Z')),
    })
    const database = openLocalIndexDatabase({ path: join(root, 'index.sqlite') })
    const index = createSessionIndex(database)
    const projector = createSessionProjector({ database, index, scope: root })

    try {
      await projector.projectSource(candidate)
      await rm(candidate.path)

      expect(await projector.deleteSource(candidate.path)).toEqual({ kind: 'deleted' })
      expect(index.listSessions()).toEqual({ sessions: [], total: 0 })
      expect(index.getSource(candidate.path)).toBeNull()
    } finally {
      database.close()
    }
  })

  it('retains all derived rows when a missing source is recreated before delete BEGIN', async () => {
    const root = await createTempDir('projector-delete-recreate')
    const canonical = line(user('Keep me', '2026-01-01T00:00:00.000Z'))
    const candidate = await createCandidate({
      root,
      projectPath: '-repo-a',
      sessionId: 'delete-recreate',
      content: canonical,
    })
    const database = openLocalIndexDatabase({ path: join(root, 'index.sqlite') })
    const index = createSessionIndex(database)
    const initialProjector = createSessionProjector({ database, index, scope: root })

    try {
      await initialProjector.projectSource(candidate, { discovered: 1, indexed: 1 })
      const sourceBefore = index.getSource(candidate.path)
      const sessionsBefore = index.listSessions()
      const backfillBefore = index.getBackfillState(root)
      await rm(candidate.path)
      let recreated = false
      const deleteProjector = createSessionProjector({
        database,
        index,
        scope: root,
        fileIo: {
          openReadonly(path, flags) {
            return open(path, flags)
          },
          async statPath(path) {
            try {
              return await stat(path)
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !recreated) {
                recreated = true
                await writeFile(path, canonical)
              }
              throw error
            }
          },
        },
      })

      expect(await deleteProjector.deleteSource(candidate.path, {
        discovered: 1,
        indexed: 1,
      })).toEqual({ kind: 'retry', reason: 'changed-during-read' })
      expect(recreated).toBe(true)
      expect(index.getSource(candidate.path)).toEqual(sourceBefore)
      expect(index.listSessions()).toEqual(sessionsBefore)
      expect(index.getBackfillState(root)).toEqual(backfillBefore)
      expect(await readFile(candidate.path, 'utf8')).toBe(canonical)
    } finally {
      database.close()
    }
  })

  it('uses progress or COUNT(*) without materializing all source rows per projection', async () => {
    const root = await createTempDir('projector-source-count')
    const database = openLocalIndexDatabase({ path: join(root, 'index.sqlite') })
    const realIndex = createSessionIndex(database)
    let listSourcesCalls = 0
    let countSourcesCalls = 0
    const index: SessionIndex = {
      ...realIndex,
      listSources() {
        listSourcesCalls += 1
        return realIndex.listSources()
      },
      countSources() {
        countSourcesCalls += 1
        return realIndex.countSources()
      },
    }
    const progressed = await createCandidate({
      root,
      projectPath: '-repo-a',
      sessionId: 'progressed',
      content: line(user('Progressed', '2026-01-01T00:00:00.000Z')),
    })
    const independent = await createCandidate({
      root,
      projectPath: '-repo-b',
      sessionId: 'independent',
      content: line(user('Independent', '2026-01-01T00:01:00.000Z')),
    })
    const projector = createSessionProjector({ database, index, scope: root })

    try {
      await projector.projectSource(progressed, { discovered: 1, indexed: 1 })
      await projector.projectSource(progressed, { discovered: 1, indexed: 1 })
      await rm(progressed.path)
      await projector.deleteSource(progressed.path, { discovered: 1, indexed: 1 })
      expect(listSourcesCalls).toBe(0)
      expect(countSourcesCalls).toBe(0)

      await projector.projectSource(independent)
      expect(listSourcesCalls).toBe(0)
      expect(countSourcesCalls).toBeGreaterThan(0)
      expect(realIndex.countSources()).toBe(1)
    } finally {
      database.close()
    }
  })

  it('does not write any row when commit-time verification sees a changed source', async () => {
    const root = await createTempDir('projector-rollback')
    const candidate = await createCandidate({
      root,
      projectPath: '-repo-a',
      sessionId: 'race',
      content: line(user('Before', '2026-01-01T00:00:00.000Z')),
    })
    const database = openLocalIndexDatabase({ path: join(root, 'index.sqlite') })
    const index = createSessionIndex(database)
    let changed = false
    const projector = createSessionProjector({
      database,
      index,
      scope: root,
      verifyFingerprint: async (options) => {
        if (!changed) {
          changed = true
          await appendFile(candidate.path, line(assistant('2026-01-01T00:01:00.000Z')))
        }
        return verifySourceFingerprint(options)
      },
    })

    try {
      expect(await projector.projectSource(candidate)).toEqual({
        kind: 'retry',
        reason: 'changed-during-read',
      })
      expect(index.listSessions()).toEqual({ sessions: [], total: 0 })
      expect(index.getSource(candidate.path)).toBeNull()
      expect(index.getBackfillState(root)).toBeNull()
    } finally {
      database.close()
    }
  })

  it('rolls back source, session, and backfill rows when SQL projection work fails mid-transaction', async () => {
    const root = await createTempDir('projector-sql-rollback')
    const candidate = await createCandidate({
      root,
      projectPath: '-repo-a',
      sessionId: 'sql-race',
      content: line(user('Atomic', '2026-01-01T00:00:00.000Z')),
    })
    const database = openLocalIndexDatabase({ path: join(root, 'index.sqlite') })
    const index = createSessionIndex(database)
    const projector = createSessionProjector({
      database,
      index,
      scope: root,
      beforeSessionUpsert: () => {
        throw new Error('injected-session-upsert-failure')
      },
    })

    try {
      await expect(projector.projectSource(candidate)).rejects.toThrow(
        'injected-session-upsert-failure',
      )
      expect(index.getSource(candidate.path)).toBeNull()
      expect(index.listSessions()).toEqual({ sessions: [], total: 0 })
      expect(index.getBackfillState(root)).toBeNull()
    } finally {
      database.close()
    }
  })

  it('rolls back all rows when the source changes inside the short write transaction', async () => {
    const root = await createTempDir('projector-commit-guard')
    const candidate = await createCandidate({
      root,
      projectPath: '-repo-a',
      sessionId: 'commit-race',
      content: line(user('Atomic', '2026-01-01T00:00:00.000Z')),
    })
    const database = openLocalIndexDatabase({ path: join(root, 'index.sqlite') })
    const index = createSessionIndex(database)
    let changed = false
    const projector = createSessionProjector({
      database,
      index,
      scope: root,
      beforeSessionUpsert: () => {
        if (changed) return
        changed = true
        appendFileSync(candidate.path, line(assistant('2026-01-01T00:01:00.000Z')))
      },
    })

    try {
      expect(await projector.projectSource(candidate)).toEqual({
        kind: 'retry',
        reason: 'changed-during-read',
      })
      expect(index.getSource(candidate.path)).toBeNull()
      expect(index.listSessions()).toEqual({ sessions: [], total: 0 })
      expect(index.getBackfillState(root)).toBeNull()
    } finally {
      database.close()
    }
  })

  it('rolls back all rows when an equal-length rewrite restores mtime inside the transaction', async () => {
    const root = await createTempDir('projector-commit-ctime-guard')
    const beforeContent = line(user('Before', '2026-01-01T00:00:00.000Z'))
    const afterContent = line(user('Forged', '2026-01-01T00:00:00.000Z'))
    expect(afterContent.length).toBe(beforeContent.length)
    const candidate = await createCandidate({
      root,
      projectPath: '-repo-a',
      sessionId: 'commit-ctime-race',
      content: beforeContent,
      fileTime: exactFileTime,
    })
    const originalSnapshot = await stat(candidate.path)
    const database = openLocalIndexDatabase({ path: join(root, 'index.sqlite') })
    const index = createSessionIndex(database)
    let changed = false
    const projector = createSessionProjector({
      database,
      index,
      scope: root,
      beforeSessionUpsert: () => {
        if (changed) return
        changed = true
        writeFileSync(candidate.path, afterContent)
        utimesSync(
          candidate.path,
          exactFileTime,
          exactFileTime,
        )
      },
    })

    try {
      expect(await projector.projectSource(candidate)).toEqual({
        kind: 'retry',
        reason: 'changed-during-read',
      })
      const rewrittenSnapshot = statSync(candidate.path)
      expect(changed).toBe(true)
      expect(rewrittenSnapshot.size).toBe(originalSnapshot.size)
      expect(rewrittenSnapshot.mtimeMs).toBe(originalSnapshot.mtimeMs)
      expect(rewrittenSnapshot.ctimeMs).not.toBe(originalSnapshot.ctimeMs)
      expect(await readFile(candidate.path, 'utf8')).toBe(afterContent)
      expect(index.getSource(candidate.path)).toBeNull()
      expect(index.listSessions()).toEqual({ sessions: [], total: 0 })
      expect(index.getBackfillState(root)).toBeNull()
    } finally {
      database.close()
    }
  })

  it('rolls back activity rows when an equal-length rewrite restores mtime inside the transaction', async () => {
    const root = await createTempDir('projector-activity-commit-ctime-guard')
    const beforeContent = line(user('Before', '2026-01-01T00:00:00.000Z'))
    const afterContent = line(user('Forged', '2026-01-01T00:00:00.000Z'))
    expect(afterContent.length).toBe(beforeContent.length)
    const candidate = await createCandidate({
      root,
      projectPath: '-repo-a',
      sessionId: 'activity-commit-ctime-race',
      content: beforeContent,
      fileTime: exactFileTime,
    })
    const originalSnapshot = await stat(candidate.path)
    const database = openLocalIndexDatabase({ path: join(root, 'index.sqlite') })
    const index = createSessionIndex(database)
    let changed = false
    const projector = createSessionProjector({
      database,
      index,
      scope: root,
      syncStat: (path) => {
        if (!changed) {
          changed = true
          writeFileSync(path, afterContent)
          utimesSync(
            path,
            exactFileTime,
            exactFileTime,
          )
        }
        return statSync(path)
      },
    })

    try {
      expect(await projector.projectActivitySource(candidate)).toEqual({
        kind: 'retry',
        reason: 'changed-during-read',
      })
      const rewrittenSnapshot = statSync(candidate.path)
      expect(changed).toBe(true)
      expect(rewrittenSnapshot.size).toBe(originalSnapshot.size)
      expect(rewrittenSnapshot.mtimeMs).toBe(originalSnapshot.mtimeMs)
      expect(rewrittenSnapshot.ctimeMs).not.toBe(originalSnapshot.ctimeMs)
      expect(await readFile(candidate.path, 'utf8')).toBe(afterContent)
      expect(index.getActivitySource(candidate.path)).toBeNull()
    } finally {
      database.close()
    }
  })

  it.each(['after verify', 'inside transaction'] as const)(
    'generation fencing prevents an old projector commit %s',
    async (cancelAt) => {
      const root = await createTempDir(`projector-generation-${cancelAt.replace(' ', '-')}`)
      const candidate = await createCandidate({
        root,
        projectPath: '-repo-a',
        sessionId: 'old-generation',
        content: line(user('Old generation', '2026-01-01T00:00:00.000Z')),
      })
      const database = openLocalIndexDatabase({ path: join(root, 'index.sqlite') })
      const index = createSessionIndex(database)
      let active = true
      const projector = createSessionProjector({
        database,
        index,
        scope: root,
        canCommit: () => active,
        ...(cancelAt === 'after verify'
          ? {
            verifyFingerprint: async (options) => {
              const result = await verifySourceFingerprint(options)
              active = false
              return result
            },
          }
          : {
            beforeSessionUpsert: () => {
              active = false
            },
          }),
      })

      try {
        expect(await projector.projectSource(candidate)).toMatchObject({ kind: 'retry' })
        expect(index.getSource(candidate.path)).toBeNull()
        expect(index.listSessions()).toEqual({ sessions: [], total: 0 })
        expect(index.getBackfillState(root)).toBeNull()
      } finally {
        database.close()
      }
    },
  )

  it('opens sources read-only, closes the handle, and bounds reducer batches', async () => {
    const root = await createTempDir('projector-streaming')
    const content = Array.from({ length: 1_200 }, (_, index) => line(user(
      `${index.toString().padStart(4, '0')}-${'x'.repeat(1_800)}`,
      new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    ))).join('')
    const candidate = await createCandidate({
      root,
      projectPath: '-repo-a',
      sessionId: 'streaming',
      content,
    })
    const database = openLocalIndexDatabase({ path: join(root, 'index.sqlite') })
    const index = createSessionIndex(database)
    const flags: string[] = []
    let closeCount = 0
    const projector = createSessionProjector({
      database,
      index,
      scope: root,
      fileIo: {
        async openReadonly(path, flag) {
          flags.push(flag)
          const handle = await open(path, flag)
          return {
            stat: () => handle.stat(),
            read: (buffer, offset, length, position) =>
              handle.read(buffer, offset, length, position),
            async close() {
              closeCount += 1
              await handle.close()
            },
          }
        },
        statPath: path => stat(path),
      },
    })

    try {
      const result = await projector.projectSource(candidate)

      expect(result).toMatchObject({ kind: 'indexed', action: 'full' })
      expect(result.kind === 'indexed' && result.work.maxBufferedChunks).toBeLessThanOrEqual(256)
      expect(result.kind === 'indexed' && result.work.maxBufferedBytes).toBeLessThan(1_100_000)
      expect(flags.length).toBeGreaterThanOrEqual(4)
      expect(flags.every(flag => flag === 'r')).toBe(true)
      expect(closeCount).toBe(flags.length)
    } finally {
      database.close()
    }
  })
  it('rejects oversized retained identities while accepting large discarded bodies', async () => {
    const root = await createTempDir('metadata-budget')
    const candidate = await createCandidate({ root, projectPath: '-repo-a', sessionId: 'metadata',
      content: line({ ...user('x'.repeat(2 * 1024 * 1024), '2026-01-01T00:00:00.000Z'), uuid: 'ordinary' }),
    })
    const database = openLocalIndexDatabase({ path: join(root, 'index.sqlite') })
    const index = createSessionIndex(database)
    const projector = createSessionProjector({ database, index, scope: root })
    try {
      expect(await projector.projectSource(candidate)).toMatchObject({ kind: 'indexed' })
      await appendFile(candidate.path, line({ ...user('small', '2026-01-01T00:00:01.000Z'), uuid: 'x'.repeat(4097) }))
      await expect(projector.projectSource(candidate)).rejects.toMatchObject({ code: 'LOCAL_INDEX_SOURCE_LIMIT' })
    } finally { database.close() }
  })

  it('enforces aggregate retained metadata across appended windows', async () => {
    const root = await createTempDir('metadata-total-budget')
    const record = (index: number) => line({ ...user('small', '2026-01-01T00:00:00.000Z'), uuid: `${index}:` + 'x'.repeat(3000) })
    const candidate = await createCandidate({ root, projectPath: '-repo-a', sessionId: 'metadata-total',
      content: Array.from({ length: 3000 }, (_, index) => record(index)).join(''),
    })
    const database = openLocalIndexDatabase({ path: join(root, 'index.sqlite') })
    const index = createSessionIndex(database)
    const projector = createSessionProjector({ database, index, scope: root })
    try {
      expect(await projector.projectSource(candidate)).toMatchObject({ kind: 'indexed' })
      await appendFile(candidate.path, Array.from({ length: 3000 }, (_, index) => record(index + 3000)).join(''))
      await expect(projector.projectSource(candidate)).rejects.toMatchObject({ code: 'LOCAL_INDEX_SOURCE_LIMIT' })
    } finally { database.close() }
  })

})

it('excludes desktop team workers from sidebar pages while retaining indexed transcript lookup', async () => {
  const root = await createTempDir('team-worker-sidebar')
  const database = openLocalIndexDatabase({ path: join(root, 'index.sqlite') })
  const index = createSessionIndex(database)
  try {
    const projector = createSessionProjector({ database, index, scope: root })
    const worker = await createCandidate({ root, projectPath: '-repo', sessionId: 'worker-session', content: line({ ...user('worker work', '2026-01-03T00:00:00Z'), entrypoint: 'claude-desktop-team-worker', teamName: 'team', agentName: 'worker' }) })
    const ordinary = await createCandidate({ root, projectPath: '-repo', sessionId: 'ordinary-session', content: line({ ...user('ordinary', '2026-01-02T00:00:00Z'), teamName: 'team', agentName: 'legacy-agent' }) })
    const sibling = await createCandidate({ root, projectPath: '-repo', sessionId: 'sibling-session', content: line({ ...user('sibling', '2026-01-01T00:00:00Z'), entrypoint: 'claude-desktop' }) })
    for (const candidate of [worker, ordinary, sibling]) await projector.projectSource(candidate)
    expect(index.listSessions({ limit: 1 }).sessions.map(item => item.id)).toEqual(['ordinary-session'])
    expect(index.listSessions({ project: '-repo', limit: 1, offset: 1 }).sessions.map(item => item.id)).toEqual(['sibling-session'])
    expect(index.listSessions().total).toBe(2)
    expect(index.findSessionFiles('worker-session')).toHaveLength(1)
    expect(index.getSession?.('worker-session')?.id).toBe('worker-session')
  } finally { database.close() }
})
