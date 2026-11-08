import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionService } from './sessionService.js'

const sessionId = '90662085-722d-42b3-b9c1-4342ca05ff66'
const environmentKeys = ['CLAUDE_CONFIG_DIR', 'CC_HAHA_LOCAL_INDEX', 'HOME', 'USERPROFILE'] as const
let directory: string
let transcript: string
let service: SessionService
let previous: Record<string, string | undefined>

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'session-message-identity-'))
  previous = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]))
  process.env.CLAUDE_CONFIG_DIR = directory
  process.env.CC_HAHA_LOCAL_INDEX = 'off'
  process.env.HOME = directory
  process.env.USERPROFILE = directory
  const project = join(directory, 'projects', 'fixture')
  await mkdir(project, { recursive: true })
  transcript = join(project, `${sessionId}.jsonl`)
  service = new SessionService()
})

afterEach(async () => {
  for (const key of environmentKeys) {
    if (previous[key] === undefined) delete process.env[key]
    else process.env[key] = previous[key]
  }
  await rm(directory, { recursive: true, force: true })
})

const entry = (uuid: string | undefined, role: 'user' | 'assistant', content: unknown, parentUuid: string | null = null) => ({
  type: role,
  uuid,
  parentUuid,
  message: { role, content },
  sessionId,
  timestamp: '2026-11-07T00:00:00.000Z',
})

async function seed(entries: unknown[]) {
  await writeFile(transcript, entries.map(value => JSON.stringify(value)).join('\n') + '\n')
}

test('history projects repeated transcript UUIDs once before they become duplicate desktop row keys', async () => {
  const entries: unknown[] = [entry('prompt', 'user', 'Read the files one by one')]
  const expectedIds = ['prompt']
  for (let index = 1; index <= 4; index++) {
    const body = entry(`body-${index}`, 'assistant', [{ type: 'text', text: `Read page ${index}; continue with the next page` }])
    entries.push(
      body,
      body,
      entry(`call-${index}`, 'assistant', [{ type: 'tool_use', id: `bash-${index}`, name: 'Bash', input: { command: `sleep 10 && cat page-${index}.txt` } }]),
      entry(`result-${index}`, 'user', [{ type: 'tool_result', tool_use_id: `bash-${index}`, content: `Page ${index}` }]),
    )
    expectedIds.push(`body-${index}`, `call-${index}`, `result-${index}`)
  }
  await seed(entries)
  const original = await readFile(transcript, 'utf8')

  const messages = await service.getSessionMessages(sessionId, { includeSubagents: false })
  expect(messages.map(message => message.id)).toEqual(expectedIds)
  expect((await service.getSessionHistory(sessionId)).messages.map(message => message.id)).toEqual(expectedIds)
  expect((await service.getSessionHistoryPage(sessionId, { full: true })).messages.map(message => message.id)).toEqual(expectedIds)
  expect(await readFile(transcript, 'utf8')).toBe(original)
})

test('duplicate identity uses the latest record for both its message and sidechain ownership', async () => {
  await seed([
    entry('owner', 'assistant', [{ type: 'tool_use', id: 'old-agent-tool', name: 'Agent', input: {} }]),
    entry('child', 'assistant', [{ type: 'text', text: 'Child answer' }], 'owner'),
    entry('reply', 'assistant', [{ type: 'text', text: 'Partial answer' }]),
    entry('owner', 'assistant', [{ type: 'tool_use', id: 'new-agent-tool', name: 'Agent', input: {} }]),
    { ...entry('child', 'assistant', [{ type: 'text', text: 'Child answer' }], 'owner'), isSidechain: true },
    entry('reply', 'assistant', [{ type: 'text', text: 'Completed answer' }]),
  ])

  const messages = await service.getSessionMessages(sessionId, { includeSubagents: false })
  expect(messages.map(message => message.id)).toEqual(['owner', 'child', 'reply'])
  expect(messages[0]?.content).toEqual([{ type: 'tool_use', id: 'new-agent-tool', name: 'Agent', input: {} }])
  expect(messages[1]?.parentToolUseId).toBe('new-agent-tool')
  expect(messages[2]?.content).toEqual([{ type: 'text', text: 'Completed answer' }])
})

test('equal text with distinct or missing transcript UUIDs remains separate conversation messages', async () => {
  await seed([
    entry('first', 'assistant', 'Read the next page'),
    entry('second', 'assistant', 'Read the next page'),
    entry(undefined, 'assistant', 'Read the next page'),
    entry(undefined, 'assistant', 'Read the next page'),
  ])

  const messages = await service.getSessionMessages(sessionId, { includeSubagents: false })
  expect(messages).toHaveLength(4)
  expect(new Set(messages.map(message => message.id)).size).toBe(4)
  expect(messages.map(message => message.content)).toEqual(Array(4).fill('Read the next page'))
})
