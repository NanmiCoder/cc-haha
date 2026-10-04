/**
 * Route-level contract for the trajectory (轨迹) ledger: bounded tail/older
 * pages, live appends validated by an opaque tail token, per-row detail by
 * byte locator, prompt snapshot rows from the sidecar, and a guard that the
 * chat `/messages` surface is unaffected.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { handleApiRequest } from '../router.js'
import { HISTORY_SEMANTIC_RECORD_BYTES, readBoundedHistoryPage } from '../services/boundedSessionHistory.js'
import { resetTrajectoryCachesForTests, turnsBefore } from '../services/trajectoryService.js'
import { isRealUserPrompt } from '../services/trajectoryProjection.js'
import { formatSessionCollaborationPrompt } from '../../utils/sessionCollaborationEnvelope.js'
import type { TrajectoryPage, TrajectoryRowDetail, TrajectorySnapshotBlob } from '../services/trajectoryTypes.js'

const SESSION_ID = '11111111-2222-3333-4444-555555555555'
const PROJECT_DIR = '-tmp-trajectory-http'

let tmpDir: string
let previousConfig: string | undefined

const transcriptPath = () => path.join(tmpDir, 'projects', PROJECT_DIR, `${SESSION_ID}.jsonl`)
const sessionDir = () => path.join(tmpDir, 'projects', PROJECT_DIR, SESSION_ID)
const sidecarPath = () => path.join(sessionDir(), 'prompt-snapshots.jsonl')

async function api(pathname: string): Promise<Response> {
  const url = new URL(pathname, 'http://localhost:3456')
  return handleApiRequest(new Request(url.toString(), { method: 'GET' }), url)
}

async function json<T>(pathname: string, status = 200): Promise<T> {
  const response = await api(pathname)
  const body = await response.json()
  expect({ status: response.status, body }).toMatchObject({ status })
  return body as T
}

const lines = (entries: unknown[]) => entries.map(entry => JSON.stringify(entry)).join('\n') + '\n'

async function writeJsonl(filePath: string, entries: unknown[]) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, lines(entries))
}

const prompt = (uuid: string, text: string, extra: Record<string, unknown> = {}) => ({
  parentUuid: null, isSidechain: false, type: 'user', uuid, timestamp: '2026-10-04T01:00:00.000Z',
  message: { role: 'user', content: text }, sessionId: SESSION_ID, ...extra,
})
const toolCall = (uuid: string, messageId: string, toolUseId: string, name = 'Bash', extra: Record<string, unknown> = {}) => ({
  type: 'assistant', uuid, timestamp: '2026-10-04T01:00:01.000Z', requestId: `req_${messageId}`,
  message: { role: 'assistant', id: messageId, model: 'claude-test', content: [{ type: 'tool_use', id: toolUseId, name, input: { command: 'ls' } }], usage: { input_tokens: 3, output_tokens: 4 } },
  ...extra,
})
const toolResult = (uuid: string, toolUseId: string, text: string, extra: Record<string, unknown> = {}) => ({
  type: 'user', uuid, timestamp: '2026-10-04T01:00:02.000Z',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }] }, ...extra,
})
const reply = (uuid: string, messageId: string, text: string, extra: Record<string, unknown> = {}) => ({
  type: 'assistant', uuid, timestamp: '2026-10-04T01:00:03.000Z',
  message: { role: 'assistant', id: messageId, model: 'claude-test', content: [{ type: 'text', text }] }, ...extra,
})

function baseTranscript() {
  return [
    { type: 'file-history-snapshot', messageId: 'm', snapshot: { messageId: 'm', trackedFileBackups: {}, timestamp: '2026-10-04T00:00:00Z' }, isSnapshotUpdate: false },
    prompt('u-1', 'Dispatch an agent'),
    { type: 'attachment', uuid: 'att-1', timestamp: '2026-10-04T01:00:00.500Z', attachment: { type: 'skill_listing', skillCount: 2, content: '- a\n- b', isInitial: true } },
    toolCall('a-1', 'msg_1', 'Agent:0', 'Agent'),
    toolResult('r-1', 'Agent:0', 'summary\nagentId: sub1 (use SendMessage)'),
    reply('a-2', 'msg_2', 'All done'),
  ]
}

beforeEach(async () => {
  previousConfig = process.env.CLAUDE_CONFIG_DIR
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-trajectory-http-'))
  process.env.CLAUDE_CONFIG_DIR = tmpDir
  resetTrajectoryCachesForTests()
})

afterEach(async () => {
  if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfig
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('GET /api/sessions/:id/trajectory', () => {
  it('returns the tail page with absolute turns, a tail token, and no snapshots when the sidecar is missing', async () => {
    await writeJsonl(transcriptPath(), baseTranscript())
    const body = await json<TrajectoryPage>(`/api/sessions/${SESSION_ID}/trajectory`)
    expect(body.rows.map(row => [row.id, row.kind, row.turn])).toEqual([
      ['u:u-1', 'user', 1],
      ['c:att-1', 'context', 1],
      ['a:msg_1', 'assistant', 1],
      ['t:Agent:0', 'tool', 1],
      ['a:msg_2', 'assistant', 1],
    ])
    expect(body.rows.find(row => row.id === 't:Agent:0')?.agentId).toBe('sub1')
    expect(body).toMatchObject({ turnBase: 0, olderCursor: null, historyComplete: true, omittedOversizedEntries: 0, snapshots: [] })
    expect(body.tailToken).toBeString()
    expect(body.sourceMissing).toBeUndefined()
  })

  it('pages older records with a cursor and keeps absolute turn numbers', async () => {
    const records: unknown[] = []
    for (let n = 0; n < 1100; n++) records.push(prompt(`p-${n}`, `prompt ${n}`))
    await writeJsonl(transcriptPath(), records)

    const tail = await json<TrajectoryPage>(`/api/sessions/${SESSION_ID}/trajectory`)
    expect(tail.rows).toHaveLength(1000)
    expect(tail.turnBase).toBe(100)
    expect(tail.rows[0]).toMatchObject({ id: 'u:p-100', turn: 101 })
    expect(tail.rows.at(-1)).toMatchObject({ id: 'u:p-1099', turn: 1100 })
    expect(tail.olderCursor).toBeString()

    const older = await json<TrajectoryPage>(`/api/sessions/${SESSION_ID}/trajectory?cursor=${tail.olderCursor}`)
    expect(older.rows).toHaveLength(100)
    expect(older.rows[0]).toMatchObject({ id: 'u:p-0', turn: 1 })
    expect(older.rows.at(-1)).toMatchObject({ id: 'u:p-99', turn: 100 })
    expect(older).toMatchObject({ turnBase: 0, olderCursor: null, tailToken: '' })
    expect(older.snapshots).toBeUndefined()
  })

  it('returns only appended rows after the tail token and rejects a rewritten transcript', async () => {
    await writeJsonl(transcriptPath(), baseTranscript())
    const tail = await json<TrajectoryPage>(`/api/sessions/${SESSION_ID}/trajectory`)

    const unchanged = await json<TrajectoryPage>(`/api/sessions/${SESSION_ID}/trajectory?after=${tail.tailToken}`)
    expect(unchanged.rows).toEqual([])
    expect(unchanged.turnBase).toBe(1)

    // A complete record plus a half-written one: only the complete line counts.
    await fs.appendFile(transcriptPath(), lines([prompt('u-2', 'second'), toolCall('a-3', 'msg_3', 'toolu_3')]) + '{"type":"user","uuid":"partial')
    const appended = await json<TrajectoryPage>(`/api/sessions/${SESSION_ID}/trajectory?after=${tail.tailToken}`)
    expect(appended.rows.map(row => [row.id, row.turn])).toEqual([['u:u-2', 2], ['a:msg_3', 2], ['t:toolu_3', 2]])
    expect(appended).toMatchObject({ turnBase: 1, olderCursor: null, snapshots: [] })

    // Finishing the partial line delivers it (and nothing older) on the next poll.
    await fs.appendFile(transcriptPath(), '-x","timestamp":"2026-10-04T02:00:00Z","message":{"role":"user","content":"third"}}\n')
    const next = await json<TrajectoryPage>(`/api/sessions/${SESSION_ID}/trajectory?after=${appended.tailToken}`)
    expect(next.rows.map(row => [row.id, row.turn])).toEqual([['u:partial-x', 3]])
    expect(next.turnBase).toBe(2)

    // Result of a tool whose call was on an earlier read arrives as a partial row.
    await fs.appendFile(transcriptPath(), lines([toolResult('r-3', 'toolu_3', 'listing')]))
    const result = await json<TrajectoryPage>(`/api/sessions/${SESSION_ID}/trajectory?after=${next.tailToken}`)
    expect(result.rows).toMatchObject([{ id: 't:toolu_3', partial: true, resultPreview: 'listing' }])

    // A burst beyond the live-append budget asks the client to reload the tail.
    await fs.appendFile(transcriptPath(), lines([reply('a-big', 'msg_big', 'b'.repeat(5 * 1024 * 1024))]))
    expect((await json<{ error: string }>(`/api/sessions/${SESSION_ID}/trajectory?after=${result.tailToken}`, 409)).error).toBe('TRAJECTORY_APPEND_TOO_LARGE')

    await fs.writeFile(transcriptPath(), lines([prompt('z-1', 'rewritten history that is long enough'), ...baseTranscript()]))
    const rewritten = await json<{ error: string }>(`/api/sessions/${SESSION_ID}/trajectory?after=${result.tailToken}`, 409)
    expect(rewritten.error).toBe('HISTORY_CHANGED')

    await fs.writeFile(transcriptPath(), lines([prompt('z-1', 'short')]))
    expect((await json<{ error: string }>(`/api/sessions/${SESSION_ID}/trajectory?after=${result.tailToken}`, 409)).error).toBe('HISTORY_CHANGED')
    expect((await json<{ error: string }>(`/api/sessions/${SESSION_ID}/trajectory?after=not-a-token`, 400)).error).toBe('BAD_REQUEST')
  })

  it('reads a subagent transcript by agentId and rejects traversal', async () => {
    await writeJsonl(transcriptPath(), baseTranscript())
    await writeJsonl(path.join(sessionDir(), 'subagents', 'agent-sub1.jsonl'), [
      prompt('s-1', 'Inspect alpha', { isSidechain: true, agentId: 'sub1' }),
      toolCall('s-2', 'msg_s', 'toolu_s', 'Read', { isSidechain: true }),
      toolResult('s-3', 'toolu_s', 'alpha', { isSidechain: true }),
    ])
    for (const agentId of ['sub1', 'agent-sub1']) {
      const body = await json<TrajectoryPage>(`/api/sessions/${SESSION_ID}/trajectory?agentId=${agentId}`)
      expect(body.rows.map(row => [row.id, row.turn])).toEqual([['u:s-1', 1], ['a:msg_s', 1], ['t:toolu_s', 1]])
    }
    const missing = await json<TrajectoryPage>(`/api/sessions/${SESSION_ID}/trajectory?agentId=nosuch`)
    expect(missing).toMatchObject({ rows: [], turnBase: 0, olderCursor: null, historyComplete: true, sourceMissing: true, snapshots: [] })
    expect(missing.tailToken).toBeString()

    for (const bad of ['..%2Fx', '..', 'a%2Fb', 'x.y']) {
      expect((await json<{ error: string }>(`/api/sessions/${SESSION_ID}/trajectory?agentId=${bad}`, 400)).error).toBe('BAD_REQUEST')
    }
    expect((await json<{ error: string }>(`/api/sessions/00000000-0000-0000-0000-000000000000/trajectory`, 404)).error).toBe('NOT_FOUND')
  })

  it('builds snapshot rows from the sidecar, filtering side queries and per scope', async () => {
    await writeJsonl(transcriptPath(), baseTranscript())
    const blob = (k: string, h: string, body: Record<string, unknown>) => ({ t: 'blob', k, h, ts: '2026-10-04T01:00:00Z', ...body })
    await fs.mkdir(sessionDir(), { recursive: true })
    await fs.writeFile(sidecarPath(), lines([
      blob('sys', '0000000000000001', { text: 'You are Claude Code.' }),
      blob('tools', '00000000000000a1', { json: [{ name: 'Bash' }] }),
      { t: 'req', ts: '2026-10-04T01:00:00.100Z', scope: 'main', sys: '0000000000000001', tools: '00000000000000a1', qs: 'sdk', model: 'm', toolCount: 1, sysChars: 20 },
      blob('ctx', '00000000000000c1', { json: { currentDate: 'Today is 2026-10-04' } }),
      { t: 'ctx', ts: '2026-10-04T01:00:00.200Z', scope: 'main', ctx: '00000000000000c1' },
      blob('sys', '0000000000000002', { text: 'Summarize the conversation.' }),
      { t: 'req', ts: '2026-10-04T01:00:00.300Z', scope: 'main', sys: '0000000000000002', tools: '00000000000000a1', qs: 'compact', model: 'm', toolCount: 1, sysChars: 27 },
      { t: 'req', ts: '2026-10-04T01:00:00.400Z', scope: 'main', sys: '0000000000000001', tools: '00000000000000a1', qs: 'sdk', model: 'm', toolCount: 1, sysChars: 20 },
      'not json at all',
      { t: 'future-kind', whatever: true },
      blob('tools', '00000000000000a2', { json: [{ name: 'Bash' }, { name: 'Read' }] }),
      blob('tools', '00000000000000a2', { json: 'duplicate blob is ignored' }),
      { t: 'req', ts: '2026-10-04T01:00:00.500Z', scope: 'main', sys: '0000000000000001', tools: '00000000000000a2', qs: 'repl_main_thread:outputStyle:Explanatory', model: 'm', toolCount: 2, sysChars: 20 },
      { t: 'req', ts: '2026-10-04T01:00:00.600Z', scope: 'sub1', sys: '0000000000000002', tools: '00000000000000a1', qs: 'agent:builtin', model: 'm', toolCount: 1, sysChars: 27 },
    ]).replace('"not json at all"', 'not json at all'))

    const body = await json<TrajectoryPage>(`/api/sessions/${SESSION_ID}/trajectory`)
    expect(body.snapshots!.map(row => [row.id, row.kind, row.snapshot?.change, row.turn, row.loc.length])).toEqual([
      ['s:main:0', 'system', 'initial', null, 0],
      ['s:main:1', 'context', 'context', null, 0],
      ['s:main:4', 'system', 'tools', null, 0],
    ])
    expect(body.snapshots![0]).toMatchObject({ ts: '2026-10-04T01:00:00.100Z', preview: 'system prompt (20 chars, 1 tools)', snapshot: { scope: 'main', sys: '0000000000000001', tools: '00000000000000a1', querySource: 'sdk', toolCount: 1 } })
    expect(body.snapshots![1]).toMatchObject({ label: 'user_context', snapshot: { ctx: '00000000000000c1' } })
    expect(body.snapshots![2]!.snapshot).toMatchObject({ tools: '00000000000000a2', prevTools: '00000000000000a1', prevSys: '0000000000000001', toolCount: 2 })

    const sub = await json<TrajectoryPage>(`/api/sessions/${SESSION_ID}/trajectory?agentId=sub1`)
    expect(sub.snapshots!.map(row => [row.id, row.snapshot?.change, row.snapshot?.sys])).toEqual([['s:sub1:0', 'initial', '0000000000000002']])

    const sys = await json<TrajectorySnapshotBlob>(`/api/sessions/${SESSION_ID}/trajectory/snapshots/0000000000000001`)
    expect(sys).toEqual({ hash: '0000000000000001', kind: 'sys', text: 'You are Claude Code.' })
    const tools = await json<TrajectorySnapshotBlob>(`/api/sessions/${SESSION_ID}/trajectory/snapshots/00000000000000a2`)
    expect(tools).toEqual({ hash: '00000000000000a2', kind: 'tools', json: [{ name: 'Bash' }, { name: 'Read' }] })
    expect((await json<{ error: string }>(`/api/sessions/${SESSION_ID}/trajectory/snapshots/ffffffffffffffff`, 404)).error).toBe('NOT_FOUND')
    expect((await json<{ error: string }>(`/api/sessions/${SESSION_ID}/trajectory/snapshots/..%2Fx`, 400)).error).toBe('BAD_REQUEST')

    // Appends to the sidecar are picked up incrementally on the next live read.
    await fs.appendFile(sidecarPath(), lines([{ t: 'req', ts: '2026-10-04T01:00:01Z', scope: 'main', sys: '0000000000000002', tools: '00000000000000a1', qs: 'sdk', model: 'm', toolCount: 1, sysChars: 27 }]))
    const live = await json<TrajectoryPage>(`/api/sessions/${SESSION_ID}/trajectory?after=${body.tailToken}`)
    expect(live.snapshots!.at(-1)).toMatchObject({ id: 's:main:5', snapshot: { change: 'system+tools', prevSys: '0000000000000001', prevTools: '00000000000000a2' } })
  })
})

describe('GET /api/sessions/:id/trajectory/rows/:rowId', () => {
  it('reads the full records of a row by locator and rejects mismatched or malformed locators', async () => {
    const big = 'y'.repeat(300 * 1024)
    await writeJsonl(transcriptPath(), [...baseTranscript(), toolCall('a-9', 'msg_9', 'toolu_9'), toolResult('r-9', 'toolu_9', big)])
    const body = await json<TrajectoryPage>(`/api/sessions/${SESSION_ID}/trajectory`)
    const tool = body.rows.find(row => row.id === 't:Agent:0')!
    const loc = tool.loc.map(([start, end]) => `${start}-${end}`).join(',')
    const rowPath = (id: string, value: string) => `/api/sessions/${SESSION_ID}/trajectory/rows/${encodeURIComponent(id)}?loc=${value}`

    const detail = await json<TrajectoryRowDetail>(rowPath('t:Agent:0', loc))
    expect(detail.rowId).toBe('t:Agent:0')
    expect(detail.truncated).toBe(false)
    expect(detail.entries.map(entry => entry.uuid)).toEqual(['a-1', 'r-1'])
    expect(JSON.stringify(detail.entries[1])).toContain('agentId: sub1')

    const bigRow = body.rows.find(row => row.id === 't:toolu_9')!
    const bigDetail = await json<TrajectoryRowDetail>(rowPath('t:toolu_9', bigRow.loc.map(([s, e]) => `${s}-${e}`).join(',')))
    expect(bigDetail.truncated).toBe(true)
    const content = ((bigDetail.entries[1]!.message as { content: Array<{ content: string }> }).content[0]!.content)
    expect(content.length).toBeGreaterThan(200 * 1024)
    expect(content.length).toBeLessThan(big.length)

    const userRow = body.rows.find(row => row.id === 'u:u-1')!
    const userLoc = `${userRow.loc[0]![0]}-${userRow.loc[0]![1]}`
    expect((await json<TrajectoryRowDetail>(rowPath('u:u-1', userLoc))).entries).toMatchObject([{ uuid: 'u-1' }])
    // Including the trailing newline is tolerated.
    expect((await json<TrajectoryRowDetail>(rowPath('u:u-1', `${userRow.loc[0]![0]}-${userRow.loc[0]![1] + 1}`))).entries).toHaveLength(1)

    expect((await json<{ error: string }>(rowPath('t:Agent:0', userLoc), 409)).error).toBe('TRAJECTORY_ROW_MISMATCH')
    expect((await json<{ error: string }>(rowPath('u:other', userLoc), 409)).error).toBe('TRAJECTORY_ROW_MISMATCH')
    expect((await json<{ error: string }>(rowPath('u:u-1', `${userRow.loc[0]![0] + 1}-${userRow.loc[0]![1]}`), 409)).error).toBe('TRAJECTORY_ROW_MISMATCH')

    const size = (await fs.stat(transcriptPath())).size
    for (const bad of [`${size}-${size + 10}`, '10-5', 'abc', '', `0-${9 * 1024 * 1024}`, Array.from({ length: 65 }, (_, n) => `${n}-${n + 1}`).join(',')]) {
      expect((await json<{ error: string }>(rowPath('u:u-1', bad), 400)).error).toBe('BAD_REQUEST')
    }
    expect((await json<{ error: string }>(rowPath('s:main:0', userLoc), 400)).error).toBe('BAD_REQUEST')
  })
})

describe('trajectory turn index', () => {
  async function bruteForce(filePath: string, offset: number): Promise<number> {
    const text = (await fs.readFile(filePath)).subarray(0, offset).toString('utf8')
    return text.split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(entry => entry.isSidechain !== true && isRealUserPrompt(entry)).length
  }

  it('scans incrementally after appends, matches a full scan at checkpoints, and rebuilds after a rewrite', async () => {
    const filler = 'z'.repeat(2048)
    const records: unknown[] = []
    for (let n = 0; n < 700; n++) {
      records.push(prompt(`t-${n}`, `prompt ${n}`))
      records.push(toolResult(`r-${n}`, `x-${n}`, filler))
      if (n % 7 === 0) records.push(prompt(`m-${n}`, 'injected', { isMeta: true }))
    }
    await writeJsonl(transcriptPath(), records)
    const file = transcriptPath()
    const size = (await fs.stat(file)).size
    expect(await turnsBefore(file, size)).toBe(700)

    const text = await fs.readFile(file, 'utf8')
    const offsets = [0, text.indexOf('"uuid":"t-300"'), text.indexOf('"uuid":"t-555"')].map(index => index <= 0 ? 0 : text.lastIndexOf('\n', index) + 1)
    for (const offset of offsets) expect(await turnsBefore(file, offset)).toBe(await bruteForce(file, offset))

    await fs.appendFile(file, lines([prompt('t-new', 'appended'), prompt('m-new', 'meta', { isMeta: true }), prompt('i-new', '[Request interrupted by user]')]))
    const grown = (await fs.stat(file)).size
    const incremental = await turnsBefore(file, grown)
    resetTrajectoryCachesForTests()
    expect(incremental).toBe(701)
    expect(await turnsBefore(file, grown)).toBe(incremental)

    await fs.writeFile(file, lines([prompt('only', 'one prompt'), reply('a', 'msg', 'done')]))
    expect(await turnsBefore(file, (await fs.stat(file)).size)).toBe(1)
  })
})

describe('trajectory review fixes', () => {
  // Real transcripts put uuid/timestamp after the message body, so an
  // oversized record's line head carries only its type and tool_use_id.
  const screenshotResult = (uuid: string, toolUseId: string, bytes: number) => ({
    parentUuid: null, isSidechain: false, type: 'user',
    message: { role: 'user', content: [{ tool_use_id: toolUseId, type: 'tool_result', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(bytes) } }] }] },
    uuid, timestamp: '2026-10-04T01:00:02.000Z',
  })

  it('attaches an oversized tool_result to its call and skips it in row detail', async () => {
    await writeJsonl(transcriptPath(), [
      prompt('u-1', 'take a screenshot'),
      toolCall('a-1', 'msg_1', 'toolu_big', 'computer'),
      screenshotResult('r-big', 'toolu_big', HISTORY_SEMANTIC_RECORD_BYTES + 64 * 1024),
      reply('a-2', 'msg_2', 'Looks fine'),
    ])
    const body = await json<TrajectoryPage>(`/api/sessions/${SESSION_ID}/trajectory`)
    expect(body.rows.map(row => row.id)).toEqual(['u:u-1', 'a:msg_1', 't:toolu_big', 'a:msg_2'])
    const tool = body.rows.find(row => row.id === 't:toolu_big')!
    expect(tool.loc).toHaveLength(2)
    const [resultStart, resultEnd] = tool.loc[1]!
    expect(tool.resultOmittedBytes).toBe(resultEnd - resultStart)
    expect(tool.resultOmittedBytes).toBeGreaterThan(HISTORY_SEMANTIC_RECORD_BYTES)
    expect(tool.resultTs).toBeUndefined()
    // Represented on its tool row, so not reported as a missing entry.
    expect(body).toMatchObject({ omittedOversizedEntries: 0, historyComplete: true })

    const rowPath = (id: string, loc: Array<[number, number]>) =>
      `/api/sessions/${SESSION_ID}/trajectory/rows/${encodeURIComponent(id)}?loc=${loc.map(([s, e]) => `${s}-${e}`).join(',')}`
    const detail = await json<TrajectoryRowDetail>(rowPath('t:toolu_big', tool.loc))
    expect(detail.entries.map(entry => entry.uuid)).toEqual(['a-1'])
    expect(detail.truncated).toBe(true)
    expect((await json<{ error: string }>(rowPath('t:toolu_other', [tool.loc[1]!]), 409)).error).toBe('TRAJECTORY_ROW_MISMATCH')
    expect((await json<{ error: string }>(rowPath('t:toolu_big', [[resultStart + 1, resultEnd]]), 409)).error).toBe('TRAJECTORY_ROW_MISMATCH')
  })

  it('reports oversized records with their line head in both read directions', async () => {
    // A (above the default 256 KiB page budget) ends the first page right at
    // the oversized record, so the newer cursor walks forward across it.
    await writeJsonl(transcriptPath(), [
      prompt('u-a', 'a'.repeat(300 * 1024)),
      screenshotResult('r-big', 'toolu_big', HISTORY_SEMANTIC_RECORD_BYTES + 1024),
      prompt('u-b', 'b'),
    ])
    const tail = await readBoundedHistoryPage(transcriptPath(), { captureOversized: true })
    expect(tail.entries.map(item => item.entry.uuid)).toEqual(['u-b'])
    expect(tail.oversized).toHaveLength(1)
    const [big] = tail.oversized!
    expect(big!.head.length).toBe(64 * 1024)
    expect(big!.head).toStartWith('{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_big"')
    expect(big!.byteEnd).toBe(tail.entries[0]!.byteStart - 1)
    expect(tail.page.omittedOversizedEntries).toBe(1)

    const older = await readBoundedHistoryPage(transcriptPath(), { cursor: tail.page.nextCursor!, captureOversized: true })
    expect(older.entries.map(item => item.entry.uuid)).toEqual(['u-a'])
    expect(older.oversized).toEqual([])
    const newer = await readBoundedHistoryPage(transcriptPath(), { cursor: older.page.previousCursor!, captureOversized: true })
    expect(newer.entries.map(item => item.entry.uuid)).toEqual(['u-b'])
    expect(newer.oversized).toEqual([big!])
    // Existing callers see the same page without the new field.
    expect((await readBoundedHistoryPage(transcriptPath())).oversized).toBeUndefined()
  })

  it('fills startTs for a response that opens a page or a live append', async () => {
    const records: unknown[] = [prompt('u-0', 'go', { timestamp: '2026-10-04T00:59:00.000Z' })]
    for (let n = 1; n <= 1000; n++) records.push(reply(`a-${n}`, `msg_${n}`, `step ${n}`))
    await writeJsonl(transcriptPath(), records)
    const tail = await json<TrajectoryPage>(`/api/sessions/${SESSION_ID}/trajectory`)
    expect(tail.rows).toHaveLength(1000)
    expect(tail.rows[0]).toMatchObject({ id: 'a:msg_1', partial: true, startTs: '2026-10-04T00:59:00.000Z' })

    await fs.appendFile(transcriptPath(), lines([reply('a-new', 'msg_new', 'later', { timestamp: '2026-10-04T01:00:09.000Z' })]))
    const appended = await json<TrajectoryPage>(`/api/sessions/${SESSION_ID}/trajectory?after=${tail.tailToken}`)
    expect(appended.rows).toMatchObject([{ id: 'a:msg_new', startTs: '2026-10-04T01:00:03.000Z' }])
  })

  it('pages image-heavy records by their projected cost instead of their raw size', async () => {
    const records: unknown[] = []
    for (let n = 0; n < 12; n++) {
      records.push(prompt(`img-${n}`, '', { message: { role: 'user', content: [{ type: 'text', text: `look ${n}` }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'B'.repeat(600 * 1024) } }] } }))
    }
    await writeJsonl(transcriptPath(), records)
    const tail = await json<TrajectoryPage>(`/api/sessions/${SESSION_ID}/trajectory`)
    expect(tail.rows.map(row => row.id)).toEqual(records.map((_, n) => `u:img-${n}`))
    expect(tail.rows[0]!.preview).toBe('look 0 [image]')
    expect(tail.olderCursor).toBeNull()
  })

  it('counts a delivered session message (persisted as isMeta) as a turn in pages and the turn index', async () => {
    const delivered = formatSessionCollaborationPrompt({ senderSessionId: 'sess-a', messageId: 'm1', text: 'Please rebase' })
    await writeJsonl(transcriptPath(), [
      prompt('u-1', 'first'),
      prompt('u-2', delivered, { isMeta: true, origin: { kind: 'channel', server: 'session-collaboration' } }),
      prompt('u-3', '<system-reminder>x</system-reminder>', { isMeta: true }),
      prompt('u-4', 'third'),
    ])
    const body = await json<TrajectoryPage>(`/api/sessions/${SESSION_ID}/trajectory`)
    expect(body.rows.map(row => [row.id, row.turn, row.label])).toEqual([
      ['u:u-1', 1, undefined], ['u:u-2', 2, 'session_message'], ['c:u-3', 2, 'meta'], ['u:u-4', 3, undefined],
    ])
    expect(await turnsBefore(transcriptPath(), (await fs.stat(transcriptPath())).size)).toBe(3)
  })
})

describe('chat /messages surface', () => {
  it('is unaffected by the trajectory routes (attachments stay out of chat history)', async () => {
    await writeJsonl(transcriptPath(), baseTranscript())
    await json<TrajectoryPage>(`/api/sessions/${SESSION_ID}/trajectory`)
    const body = await json<{ messages: Array<{ id: string; type: string }>; page: Record<string, unknown> }>(`/api/sessions/${SESSION_ID}/messages`)
    expect(body.messages.map(message => message.id)).not.toContain('att-1')
    expect(body.messages.map(message => [message.id, message.type])).toEqual([
      ['u-1', 'user'],
      ['a-1', 'tool_use'],
      ['r-1', 'tool_result'],
      ['a-2', 'assistant'],
    ])
    expect(body.page).toMatchObject({ hasMore: false, historyComplete: true })
  })
})
