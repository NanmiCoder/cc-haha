/**
 * Scenarios recorded against a real model and replayed in CI.
 *
 * A runner drives the desktop protocol exactly as the live lane does, so the
 * same code runs against DeepSeek while recording and against the cassette in
 * CI. Prompts induce behaviour rather than script it; `requires` lists what the
 * recorded traffic must actually contain (thinking, fragmented tool input, the
 * tools used), so a recording in which the model took a shortcut is rejected
 * instead of committed.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'

import { LIVE_SCENARIO_RUNNERS, type LiveContext, type LiveScenarioRunner } from '../agent-flow/live'
import type { SessionSocket } from '../agent-flow/execute'
import type { ApiFormat } from './wire'

export type ReplayRequirements = {
  thinking?: boolean
  fragmentedToolInput?: boolean
  toolsUsed?: string[]
  /** Some single response called more than one tool. */
  parallelToolCalls?: boolean
  /** Some tool call failed and its error went back to the model. */
  toolError?: boolean
  /** At least this many agent loops (main, subagents, teammates) called the model. */
  agentLoops?: number
}

/** The lane passes `sessionIds` to learn which sessions a scenario created, in order. */
export type ReplayContext = LiveContext & { sessionIds?: string[] }

export type ReplayScenario = {
  id: string
  title: string
  format: ApiFormat
  requires: ReplayRequirements
  /** Provider settings for this scenario only, e.g. a small auto-compact window. */
  providerOverrides?: Record<string, unknown>
  /**
   * Saved provider to record with instead of the format's default, for a
   * capability the default model lacks (images need the vision variant).
   */
  recordProvider?: string
  /**
   * `recorded` replays model latency and stream timing as recorded. Only for
   * scenarios whose message interleaving depends on it (an agent team).
   */
  replayPacing?: 'compressed' | 'recorded'
  run: LiveScenarioRunner
}

const FIXTURE = join(import.meta.dir, '../agent-flow/fixtures/workspace')

/**
 * Each scenario gets its own copy of the fixture, so a replay starts from the
 * same disk state as its recording even when it runs alone with `--only`.
 */
function scenarioWorkRoot(ctx: LiveContext, id: string) {
  const dir = join(ctx.workRoot, id)
  mkdirSync(dir, { recursive: true })
  cpSync(FIXTURE, dir, { recursive: true })
  return dir
}

function inDirectory(ctx: ReplayContext, workRoot: string): ReplayContext {
  return {
    ...ctx,
    workRoot,
    async createSession() {
      const response = await fetch(`${ctx.baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workDir: workRoot }),
      })
      if (!response.ok) throw new Error(`session create failed: ${response.status}`)
      const body = await response.json() as { id?: string; sessionId?: string }
      const id = body.id ?? body.sessionId
      if (!id) throw new Error(`session create returned no id: ${JSON.stringify(body)}`)
      ctx.sessionIds?.push(id)
      return id
    },
  }
}

/** Sends a prompt and allows every permission request until the turn completes. */
async function driveAllowingTools(ctx: LiveContext, socket: SessionSocket, prompt: string) {
  const start = socket.messages.length
  socket.send({ type: 'user_message', content: prompt })
  let cursor = start
  const deadline = Date.now() + ctx.stepTimeoutMs
  while (Date.now() < deadline) {
    while (cursor < socket.messages.length) {
      const message = socket.messages[cursor]!
      cursor += 1
      if (message.type === 'permission_request') {
        socket.send({ type: 'permission_response', requestId: message.requestId, allowed: true, rule: 'agent-replay' })
      }
      if (message.type === 'message_complete') return socket.messages.slice(start)
      if (message.type === 'error') throw new Error(`turn failed: ${JSON.stringify(message).slice(0, 400)}`)
    }
    await Bun.sleep(25)
  }
  throw new Error(`turn did not complete; saw ${socket.messages.slice(start).map((m) => m.type).join(', ')}`)
}

function streamedText(frames: ReadonlyArray<{ type: string; text?: unknown }>) {
  return frames.filter((frame) => frame.type === 'content_delta').map((frame) => String(frame.text ?? '')).join('')
}

/** One of the live lane's runners; `scenario()` gives it the scenario's own work dir. */
function liveRunner(name: string): LiveScenarioRunner {
  const runner = LIVE_SCENARIO_RUNNERS[name]
  if (!runner) throw new Error(`no live runner ${name}`)
  return runner
}

const multiTool: LiveScenarioRunner = async (ctx) => {
  const socket = await ctx.openSocket(await ctx.createSession())
  const target = join(ctx.workRoot, 'src', 'marker.txt')
  writeFileSync(target, 'status: REPLAY_MARKER\n')
  try {
    ctx.pinRuntime(socket)
    const frames = await driveAllowingTools(ctx, socket, [
      'Do these four steps in order, one tool call per step:',
      '1. Use the Grep tool to find which file under src/ contains the word REPLAY_MARKER.',
      '2. Use the Read tool to read that file.',
      '3. Use the Edit tool to replace REPLAY_MARKER with REPLAY_DONE in that file.',
      '4. Use the Bash tool to run: cat src/marker.txt',
      'Then reply with the single word FINISHED.',
    ].join('\n'))
    const content = readFileSync(target, 'utf8')
    if (!content.includes('REPLAY_DONE') || content.includes('REPLAY_MARKER')) {
      throw new Error(`the edit did not land on disk: ${JSON.stringify(content)}`)
    }
    const toolNames = frames.filter((frame) => frame.type === 'tool_use_complete').map((frame) => String((frame as { toolName?: unknown }).toolName ?? ''))
    for (const name of ['Grep', 'Read', 'Edit', 'Bash']) {
      if (!toolNames.includes(name)) throw new Error(`the turn never ran ${name}; ran ${toolNames.join(', ') || 'no tools'}`)
    }
  } finally {
    socket.close()
  }
}

const thinkingText: LiveScenarioRunner = async (ctx) => {
  const socket = await ctx.openSocket(await ctx.createSession())
  try {
    ctx.pinRuntime(socket)
    const frames = await driveAllowingTools(ctx, socket, 'Think it through step by step before answering: a shelf holds 17 rows of 23 books. How many books is that? Answer with the number only.')
    if (!frames.some((frame) => frame.type === 'thinking')) {
      throw new Error(`no thinking reached the client; saw ${[...new Set(frames.map((frame) => frame.type))].join(', ')}`)
    }
    if (!streamedText(frames).includes('391')) throw new Error(`the answer did not stream: ${JSON.stringify(streamedText(frames).slice(0, 200))}`)
  } finally {
    socket.close()
  }
}

const compactAndContinue: LiveScenarioRunner = async (ctx) => {
  const socket = await ctx.openSocket(await ctx.createSession())
  try {
    ctx.pinRuntime(socket)
    await driveAllowingTools(ctx, socket, 'Remember this code word for later: HERON-42. Reply with one short sentence.')
    const compactStart = socket.messages.length
    socket.send({ type: 'user_message', content: '/compact' })
    await socket.waitFor((m) => m.type === 'system_notification' && m.subtype === 'compact_boundary', ctx.stepTimeoutMs, 'compact boundary', compactStart)
    await socket.waitFor((m) => m.type === 'message_complete', ctx.stepTimeoutMs, 'compact completion', compactStart)
    const after = await driveAllowingTools(ctx, socket, 'What was the code word? Reply with the code word only.')
    if (!streamedText(after).includes('HERON-42')) {
      throw new Error(`the code word did not survive compaction: ${JSON.stringify(streamedText(after).slice(0, 200))}`)
    }
  } finally {
    socket.close()
  }
}

/**
 * Shared with the desktop UI smoke (`desktop-smoke/replay.ts`): the protocol
 * replay proves the agent loop, the UI smoke replays the same cassette through
 * the real desktop app and clicks the real Allow button.
 */
export const DESKTOP_REPLAY_SCENARIO_ID = 'replay-desktop-write'
export const DESKTOP_REPLAY_FILE = 'ui-replay.txt'
export const DESKTOP_REPLAY_CONTENT = 'REPLAYED THROUGH THE UI'
export const DESKTOP_REPLAY_PROMPT = `Use your file writing tool to create a file called ${DESKTOP_REPLAY_FILE} in the current directory whose entire contents are exactly: ${DESKTOP_REPLAY_CONTENT}. After the file is written, reply with the single word DONE.`

const desktopWrite: LiveScenarioRunner = async (ctx) => {
  const socket = await ctx.openSocket(await ctx.createSession())
  const target = join(ctx.workRoot, DESKTOP_REPLAY_FILE)
  try {
    ctx.pinRuntime(socket)
    const frames = await driveAllowingTools(ctx, socket, DESKTOP_REPLAY_PROMPT)
    if (!existsSync(target) || readFileSync(target, 'utf8').trim() !== DESKTOP_REPLAY_CONTENT) {
      throw new Error(`the approved write did not land: ${existsSync(target) ? JSON.stringify(readFileSync(target, 'utf8')) : 'missing'}`)
    }
    if (!streamedText(frames).includes('DONE')) throw new Error(`the reply after the write did not stream: ${JSON.stringify(streamedText(frames).slice(0, 200))}`)
  } finally {
    socket.close()
  }
}

function toolNamesRun(frames: ReadonlyArray<{ type: string }>) {
  return frames.filter((frame) => frame.type === 'tool_use_complete').map((frame) => String((frame as { toolName?: unknown }).toolName ?? ''))
}

/** Deterministic filler prose, so a long conversation has real weight without randomness. */
function fillerDocument(title: string, paragraphs: number) {
  const subjects = ['The indexer', 'The scheduler', 'The cache layer', 'The sync worker', 'The audit trail', 'The retry queue']
  const verbs = ['records', 'reconciles', 'batches', 'validates', 'compacts', 'replays']
  const objects = ['session events', 'tool results', 'workspace snapshots', 'provider responses', 'permission decisions', 'usage counters']
  const lines = [`# ${title}`, '']
  for (let i = 0; i < paragraphs; i += 1) {
    lines.push(`## Part ${i + 1}`, '', Array.from({ length: 6 }, (_, j) => {
      const k = i * 6 + j
      return `${subjects[k % subjects.length]} ${verbs[(k * 5) % verbs.length]} ${objects[(k * 7) % objects.length]} in step ${k + 1}, keeping ordering stable across restarts.`
    }).join(' '), '')
  }
  return lines.join('\n')
}

/** Several turns in one session reading large files, so a small window compacts on its own. */
const longConversationAutoCompact: LiveScenarioRunner = async (ctx) => {
  for (const part of [1, 2, 3]) writeFileSync(join(ctx.workRoot, 'src', `part-${part}.md`), fillerDocument(`Design notes part ${part}`, 40))
  const socket = await ctx.openSocket(await ctx.createSession())
  try {
    ctx.pinRuntime(socket)
    const start = socket.messages.length
    await driveAllowingTools(ctx, socket, 'Remember this code word for later: OTTER-7. Reply with one short sentence.')
    for (const part of [1, 2, 3]) {
      await driveAllowingTools(ctx, socket, `Use the Read tool to read src/part-${part}.md in full, then summarize it in one sentence.`)
    }
    const answer = await driveAllowingTools(ctx, socket, 'What was the code word I gave you at the very start? Reply with the code word only.')
    const compacted = socket.messages.slice(start).some((m) => m.type === 'system_notification' && m.subtype === 'compact_boundary')
    if (!compacted) throw new Error('the conversation never compacted on its own')
    if (!streamedText(answer).includes('OTTER-7')) throw new Error(`the code word did not survive auto-compaction: ${JSON.stringify(streamedText(answer).slice(0, 200))}`)
  } finally {
    socket.close()
  }
}

const subagentCount: LiveScenarioRunner = async (ctx) => {
  writeFileSync(join(ctx.workRoot, 'src', 'alpha.md'), '# Alpha\n')
  writeFileSync(join(ctx.workRoot, 'src', 'beta.md'), '# Beta\n')
  const socket = await ctx.openSocket(await ctx.createSession())
  try {
    ctx.pinRuntime(socket)
    const frames = await driveAllowingTools(ctx, socket, 'Use the Agent tool to launch exactly one general-purpose subagent with this task: "Use the Glob tool to list every .md file under src/ and report how many there are." Do not look at the files yourself. When the subagent returns, reply with just the number.')
    if (!toolNamesRun(frames).includes('Agent')) throw new Error(`no subagent was launched; ran ${toolNamesRun(frames).join(', ') || 'no tools'}`)
    if (!streamedText(frames).includes('3')) throw new Error(`the subagent's count did not come back: ${JSON.stringify(streamedText(frames).slice(-200))}`)
  } finally {
    socket.close()
  }
}

const parallelReads: LiveScenarioRunner = async (ctx) => {
  writeFileSync(join(ctx.workRoot, 'src', 'extra.md'), 'Kestrel is the codename of the extra module.\n')
  const socket = await ctx.openSocket(await ctx.createSession())
  try {
    ctx.pinRuntime(socket)
    const frames = await driveAllowingTools(ctx, socket, 'In a single response, call the Read tool three times in parallel, on package.json, src/notes.md and src/extra.md, before doing anything else. Then reply with one line per file giving its name and what it is about.')
    const reads = toolNamesRun(frames).filter((name) => name === 'Read')
    if (reads.length < 3) throw new Error(`expected three Read calls, saw ${reads.length}`)
    if (!streamedText(frames).includes('Kestrel')) throw new Error('the reply does not reflect the third file')
  } finally {
    socket.close()
  }
}

const toolErrorRecovery: LiveScenarioRunner = async (ctx) => {
  const config = join(ctx.workRoot, 'src', 'config.txt')
  writeFileSync(config, 'name=replay\nmode=alpha\n')
  const socket = await ctx.openSocket(await ctx.createSession())
  try {
    ctx.pinRuntime(socket)
    await driveAllowingTools(ctx, socket, [
      'Follow these steps exactly:',
      "1. Without reading it first, use the Edit tool on src/config.txt to replace the exact text 'mode=beta' with 'mode=gamma'.",
      '2. That edit will fail because the file says something else. When it fails, use the Read tool on src/config.txt, then use the Edit tool to change the mode line that is actually there to mode=gamma.',
      '3. Use the Bash tool to run: cat src/missing-file.txt (it will fail), then use the Bash tool to run: cat src/config.txt',
      'Then reply with the single word DONE.',
    ].join(' '))
    const content = readFileSync(config, 'utf8')
    if (!content.includes('mode=gamma') || content.includes('mode=alpha')) throw new Error(`the model did not recover from the failed edit: ${JSON.stringify(content)}`)
  } finally {
    socket.close()
  }
}

const largeToolOutput: LiveScenarioRunner = async (ctx) => {
  const lines = Array.from({ length: 800 }, (_, i) => i === 437 ? 'line 438: ERROR_CODE=E4217 while flushing the journal' : `line ${i + 1}: status=ok latency=${(i * 37) % 900}ms`)
  writeFileSync(join(ctx.workRoot, 'src', 'big.log'), `${lines.join('\n')}\n`)
  const socket = await ctx.openSocket(await ctx.createSession())
  try {
    ctx.pinRuntime(socket)
    const frames = await driveAllowingTools(ctx, socket, 'Use the Bash tool to run exactly: cat src/big.log (no grep, head, tail or other filter). Then tell me the value of ERROR_CODE that appears in the output. Reply with the code only.')
    if (!toolNamesRun(frames).includes('Bash')) throw new Error('the log was never printed')
    if (!streamedText(frames).includes('E4217')) throw new Error(`the error code was not found in the large output: ${JSON.stringify(streamedText(frames).slice(0, 200))}`)
  } finally {
    socket.close()
  }
}

const chineseTurn: LiveScenarioRunner = async (ctx) => {
  const socket = await ctx.openSocket(await ctx.createSession())
  try {
    ctx.pinRuntime(socket)
    const frames = await driveAllowingTools(ctx, socket, '请先用 Read 工具读取 src/notes.md，然后用一句中文告诉我这个文件是做什么用的。')
    if (!toolNamesRun(frames).includes('Read')) throw new Error('the file was never read')
    if (!/[一-鿿]/.test(streamedText(frames))) throw new Error(`the reply is not in Chinese: ${JSON.stringify(streamedText(frames).slice(0, 200))}`)
  } finally {
    socket.close()
  }
}

const INVENTORY_MCP = join(import.meta.dir, 'fixtures', 'inventory-mcp.ts')

/** Approves project MCP servers in the sandbox's user settings, keeping whatever else is there. */
function approveProjectMcpServers(configDir: string) {
  const path = join(configDir, 'settings.json')
  let settings: Record<string, unknown> = {}
  try { settings = JSON.parse(readFileSync(path, 'utf8')) } catch { /* none yet */ }
  writeFileSync(path, `${JSON.stringify({ ...settings, enableAllProjectMcpServers: true }, null, 2)}\n`)
}

const mcpTool: LiveScenarioRunner = async (ctx) => {
  writeFileSync(join(ctx.workRoot, '.mcp.json'), `${JSON.stringify({ mcpServers: { inventory: { command: 'bun', args: [INVENTORY_MCP] } } }, null, 2)}\n`)
  approveProjectMcpServers(ctx.configDir)
  const socket = await ctx.openSocket(await ctx.createSession())
  try {
    ctx.pinRuntime(socket)
    const frames = await driveAllowingTools(ctx, socket, 'Use the inventory MCP server\'s lookup_sku tool to look up SKU K-204, then tell me how many units are in stock. Reply with the number only.')
    const used = toolNamesRun(frames)
    if (!used.some((name) => name.startsWith('mcp__inventory__'))) throw new Error(`the MCP tool was never called; ran ${used.join(', ') || 'no tools'}`)
    if (!streamedText(frames).includes('17')) throw new Error(`the MCP result did not reach the reply: ${JSON.stringify(streamedText(frames).slice(0, 200))}`)
  } finally {
    socket.close()
  }
}

const parallelSubagents: LiveScenarioRunner = async (ctx) => {
  writeFileSync(join(ctx.workRoot, 'src', 'alpha.md'), '# Alpha\n')
  writeFileSync(join(ctx.workRoot, 'src', 'beta.md'), '# Beta\n')
  const socket = await ctx.openSocket(await ctx.createSession())
  try {
    ctx.pinRuntime(socket)
    const frames = await driveAllowingTools(ctx, socket, [
      'In a single response, use the Agent tool twice in parallel to launch two general-purpose subagents:',
      'subagent one: "Use the Glob tool to list every .md file under src/ and report how many there are."',
      'subagent two: "Use the Read tool to read package.json and report the value of its name field."',
      'Do not look at the files yourself. When both return, reply in the form: <count> files, name <name>.',
    ].join(' '))
    const agents = toolNamesRun(frames).filter((name) => name === 'Agent')
    if (agents.length < 2) throw new Error(`expected two subagents, saw ${agents.length}`)
    const text = streamedText(frames)
    if (!text.includes('3') || !text.includes('agent-flow-fixture')) throw new Error(`both subagent results did not come back: ${JSON.stringify(text.slice(-200))}`)
  } finally {
    socket.close()
  }
}

/** A solid-colour PNG, built here so the fixture needs no binary file. */
function solidPng(width: number, height: number, [r, g, b]: [number, number, number]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (bytes: Uint8Array) => {
    let c = 0xffffffff
    for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length)
    const view = new DataView(out.buffer)
    view.setUint32(0, data.length)
    out.set(new TextEncoder().encode(type), 4)
    out.set(data, 8)
    view.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)))
    return out
  }
  const header = new Uint8Array(13)
  const headerView = new DataView(header.buffer)
  headerView.setUint32(0, width)
  headerView.setUint32(4, height)
  header.set([8, 2, 0, 0, 0], 8)
  const rows = new Uint8Array(height * (1 + width * 3))
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) rows.set([r, g, b], y * (1 + width * 3) + 1 + x * 3)
  }
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', new Uint8Array(deflateSync(rows))), chunk('IEND', new Uint8Array())]
  const png = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) { png.set(part, offset); offset += part.length }
  return Buffer.from(png).toString('base64')
}

/**
 * An image attachment. Whatever the provider does with it (answers, rejects it
 * and the app retries without it) is what gets recorded and replayed; the
 * check is only that the turn ends with a reply instead of hanging or failing.
 */
const imageAttachment: LiveScenarioRunner = async (ctx) => {
  const socket = await ctx.openSocket(await ctx.createSession())
  try {
    ctx.pinRuntime(socket)
    const start = socket.messages.length
    socket.send({
      type: 'user_message',
      content: 'Look at the attached image and answer at once, without deliberating: what is its main colour? Reply with one word.',
      attachments: [{ type: 'image', name: 'swatch.png', mimeType: 'image/png', data: solidPng(48, 48, [220, 30, 30]) }],
    })
    await socket.waitFor((m) => m.type === 'message_complete', ctx.stepTimeoutMs, 'message_complete', start)
    const frames = socket.messages.slice(start)
    const error = frames.find((m) => m.type === 'error')
    if (error) throw new Error(`the image turn failed: ${JSON.stringify(error).slice(0, 500)}`)
    if (!streamedText(frames).trim()) throw new Error(`no reply to the image turn; saw ${frames.map((m) => m.type).join(', ')}`)
  } finally {
    socket.close()
  }
}

/**
 * Agent Teams end to end: the lead plans a two-member team, the plan is
 * approved through the same endpoint the desktop plan card uses, the members
 * run as their own CLI processes, and their results reach the lead. The second
 * task depends on the first, so the members run one after the other.
 */
const agentTeam: LiveScenarioRunner = async (ctx) => {
  writeFileSync(join(ctx.workRoot, 'src', 'inventory.csv'), 'sku,units\nK-204,17\nM-310,240\nQ-118,5\n')
  const sessionId = await ctx.createSession()
  const socket = await ctx.openSocket(sessionId)
  try {
    ctx.pinRuntime(socket)
    const start = socket.messages.length
    socket.send({
      type: 'user_message',
      content: [
        'Use the TeamPlan tool to propose an agent team of exactly two members for this job, then wait for approval.',
        'Member "counter": read src/inventory.csv and send the total number of units to member "reporter".',
        'Member "reporter": its task depends on counter\'s task; write the total it receives into a file called total.txt in the current directory, containing only the number.',
        'Keep both member prompts short. When both tasks are done, shut both members down, then reply with the total.',
      ].join(' '),
    })
    let plan: { state?: string; planId?: string; incarnationId?: string; revision?: number; teamName?: string } | null = null
    const planDeadline = Date.now() + ctx.stepTimeoutMs
    let cursor = start
    while (Date.now() < planDeadline) {
      while (cursor < socket.messages.length) {
        const message = socket.messages[cursor]!
        cursor += 1
        if (message.type === 'permission_request') socket.send({ type: 'permission_response', requestId: message.requestId, allowed: true, rule: 'agent-replay' })
      }
      const response = await fetch(`${ctx.baseUrl}/api/teams/session/${encodeURIComponent(sessionId)}/plan`)
      if (response.ok) {
        plan = (await response.json() as { plan: typeof plan }).plan
        if (plan?.state === 'review_pending') break
      }
      await Bun.sleep(500)
    }
    if (plan?.state !== 'review_pending' || !plan.teamName) throw new Error(`the lead never proposed a team plan (plan: ${JSON.stringify(plan)?.slice(0, 300)})`)
    const approved = await fetch(`${ctx.baseUrl}/api/teams/${encodeURIComponent(plan.teamName)}/plan/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, planId: plan.planId, incarnationId: plan.incarnationId, expectedRevision: plan.revision, requestId: 'agent-replay-approve' }),
    })
    if (!approved.ok) throw new Error(`approving the plan failed: ${approved.status} ${await approved.text()}`)
    // Done means the whole team wound down, not just that the file appeared:
    // the lead keeps working (and asking for permissions) after that, and a
    // replay runs far faster than the recording did, so stopping on the file
    // alone leaves the lead's later requests unmade.
    const total = join(ctx.workRoot, 'total.txt')
    const teamConfig = join(ctx.configDir, 'teams', plan.teamName, 'config.json')
    const membersDone = () => {
      if (!existsSync(teamConfig)) return true
      const members = (JSON.parse(readFileSync(teamConfig, 'utf8')) as { members?: Array<{ name?: string; terminated?: boolean }> }).members ?? []
      return members.filter((member) => member.name !== 'team-lead').every((member) => member.terminated === true)
    }
    const deadline = Date.now() + ctx.stepTimeoutMs * 2
    let quietSince = Date.now()
    let seen = socket.messages.length
    while (Date.now() < deadline) {
      while (cursor < socket.messages.length) {
        const message = socket.messages[cursor]!
        cursor += 1
        if (message.type === 'permission_request') socket.send({ type: 'permission_response', requestId: message.requestId, allowed: true, rule: 'agent-replay' })
      }
      if (socket.messages.length !== seen) {
        seen = socket.messages.length
        quietSince = Date.now()
      }
      const leadIdle = socket.messages.at(-1)?.type !== 'permission_request' && socket.messages.slice(start).some((m) => m.type === 'message_complete')
      const fileDone = existsSync(total) && readFileSync(total, 'utf8').includes('262')
      if (fileDone && membersDone() && leadIdle && Date.now() - quietSince > 2_000) break
      await Bun.sleep(250)
    }
    if (!existsSync(total) || !readFileSync(total, 'utf8').includes('262')) throw new Error('the team never wrote total.txt with 262')
    if (!membersDone()) throw new Error('the team members were never shut down')
  } finally {
    socket.close()
  }
}

function inOwnDirectory(id: string, runner: LiveScenarioRunner): LiveScenarioRunner {
  return async (ctx) => runner(inDirectory(ctx, scenarioWorkRoot(ctx, id)))
}

function scenario(id: string, title: string, format: ApiFormat, requires: ReplayRequirements, runner: LiveScenarioRunner, options: { providerOverrides?: Record<string, unknown>; recordProvider?: string; replayPacing?: 'compressed' | 'recorded' } = {}): ReplayScenario {
  return { id, title, format, requires, ...options, run: inOwnDirectory(id, runner) }
}

export const REPLAY_SCENARIOS: readonly ReplayScenario[] = [
  scenario('replay-first-turn', 'A recorded first turn streams through the real CLI', 'anthropic', {}, liveRunner('live-first-turn')),
  scenario('replay-thinking', 'Recorded thinking reaches the client before the answer', 'anthropic', { thinking: true }, thinkingText),
  scenario('replay-multi-tool', 'Grep, Read, Edit and Bash run in one turn from recorded tool calls', 'anthropic', { fragmentedToolInput: true, toolsUsed: ['Grep', 'Read', 'Edit', 'Bash'] }, multiTool),
  scenario('replay-permission-deny', 'A denied write stays off disk and the turn still ends', 'anthropic', { toolsUsed: ['Write'] }, liveRunner('live-permission-deny')),
  scenario('replay-interrupt', 'Stopping a recorded long answer closes the upstream stream', 'anthropic', {}, liveRunner('live-interrupt')),
  scenario('replay-compact', '/compact on a real conversation keeps what the next turn needs', 'anthropic', {}, compactAndContinue),
  scenario(DESKTOP_REPLAY_SCENARIO_ID, 'An approved write and the reply after it (also replayed through the desktop UI)', 'anthropic', { toolsUsed: ['Write'] }, desktopWrite),
  scenario('replay-openai-first-turn', 'An OpenAI Chat provider answers through the server proxy', 'openai_chat', {}, liveRunner('live-first-turn')),
  scenario('replay-long-auto-compact', 'A long conversation compacts on its own and keeps what the last turn needs', 'anthropic', { toolsUsed: ['Read'] }, longConversationAutoCompact, { providerOverrides: { autoCompactWindow: 70_000 } }),
  scenario('replay-subagent', 'A subagent runs its own tool loop and its result reaches the main agent', 'anthropic', { agentLoops: 2, toolsUsed: ['Agent', 'Glob'] }, subagentCount),
  scenario('replay-parallel-tools', 'One reply calls several tools at once and all their results return', 'anthropic', { parallelToolCalls: true, toolsUsed: ['Read'] }, parallelReads),
  scenario('replay-tool-error-recovery', 'Failed Edit and Bash calls go back to the model, which recovers', 'anthropic', { toolError: true, toolsUsed: ['Edit', 'Read', 'Bash'] }, toolErrorRecovery),
  scenario('replay-large-tool-output', 'A large command output reaches the model and it finds the one line that matters', 'anthropic', { toolsUsed: ['Bash'] }, largeToolOutput),
  scenario('replay-chinese', 'A Chinese prompt, a tool call, and a Chinese reply', 'anthropic', { toolsUsed: ['Read'] }, chineseTurn),
  scenario('replay-mcp-tool', 'A project MCP server\'s tool is called and its result reaches the reply', 'anthropic', {}, mcpTool),
  scenario('replay-parallel-subagents', 'Two subagents run their own loops at once and both results return', 'anthropic', { agentLoops: 3, toolsUsed: ['Agent'] }, parallelSubagents),
  scenario('replay-image', 'An image attachment reaches a vision model and its answer streams back', 'anthropic', {}, imageAttachment, { recordProvider: 'DeepSeek-demo演示' }),
  scenario('replay-agent-team', 'A planned two-member agent team is approved, runs, and reports back', 'anthropic', { agentLoops: 3, toolsUsed: ['TeamPlan'] }, agentTeam, { replayPacing: 'recorded' }),
  scenario('replay-openai-multi-tool', 'Tool calls stream through the OpenAI Chat proxy and run', 'openai_chat', { fragmentedToolInput: true, toolsUsed: ['Grep', 'Read', 'Edit', 'Bash'] }, multiTool),
  scenario('replay-openai-thinking', 'Reasoning from an OpenAI Chat provider reaches the client as thinking', 'openai_chat', { thinking: true }, thinkingText),
  scenario('replay-openai-interrupt', 'Stopping an OpenAI Chat stream through the proxy closes it', 'openai_chat', {}, liveRunner('live-interrupt')),
]

export function selectScenarios(only: string[]): ReplayScenario[] {
  if (only.length === 0) return [...REPLAY_SCENARIOS]
  const selected = REPLAY_SCENARIOS.filter((entry) => only.includes(entry.id))
  const unknown = only.filter((id) => !REPLAY_SCENARIOS.some((entry) => entry.id === id))
  if (unknown.length > 0) throw new Error(`unknown replay scenario(s): ${unknown.join(', ')}`)
  return selected
}
