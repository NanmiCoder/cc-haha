import { afterEach, beforeEach, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { getClaudeTempDir } from '../../utils/permissions/filesystem.js'
import { sanitizePath } from '../../utils/sessionStoragePortable.js'
import { isLocalAccessAuthorized } from '../localAccessAuth.js'

const token = 'background-output-test-only'
let directory: string
let sessionId: string
let outputPath: string
let transcriptPath: string
let baseUrl: string
let server: ReturnType<typeof Bun.serve> | undefined
let previous: Record<string, string | undefined>

beforeEach(async () => {
  previous = Object.fromEntries(['HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_TMPDIR', 'CC_HAHA_LOCAL_ACCESS_TOKEN'].map(key => [key, process.env[key]]))
  directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'background-output-route-')))
  process.env.HOME = path.join(directory, 'home')
  await fs.mkdir(process.env.HOME)
  process.env.CLAUDE_CONFIG_DIR = path.join(directory, 'config')
  process.env.CLAUDE_CODE_TMPDIR = directory
  process.env.CC_HAHA_LOCAL_ACCESS_TOKEN = token
  getClaudeTempDir.cache.clear?.()
  const work = path.join(directory, 'work')
  await fs.mkdir(work)
  sessionId = crypto.randomUUID()
  const project = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', sanitizePath(work))
  await fs.mkdir(project, { recursive: true })
  outputPath = path.join(getClaudeTempDir(), sanitizePath(work), sessionId, 'tasks', 'shell-task.output')
  await fs.mkdir(path.dirname(outputPath), { recursive: true })
  await fs.writeFile(outputPath, 'HTTP server listening on 127.0.0.1:3111\n')
  const rows = [
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'shell-use', name: 'Bash', input: { command: 'bun run server.ts', run_in_background: true } }] } },
    { type: 'user', toolUseResult: { backgroundTaskId: 'shell-task', stdout: '', stderr: '' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'shell-use', content: `Command running in background with ID: shell-task. Output is being written to: ${outputPath}` }] } },
  ]
  transcriptPath = path.join(project, `${sessionId}.jsonl`)
  await fs.writeFile(transcriptPath, rows.map(row => JSON.stringify({ ...row, cwd: work, sessionId, uuid: crypto.randomUUID(), timestamp: '2026-10-24T00:00:00Z' })).join('\n') + '\n')
  const { handleApiRequest } = await import('../router.js')
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    if (!isLocalAccessAuthorized(request)) return new Response(null, { status: 401 })
    return handleApiRequest(request, new URL(request.url))
  } })
  baseUrl = `http://127.0.0.1:${server.port}`
})

afterEach(async () => {
  server?.stop(true)
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  getClaudeTempDir.cache.clear?.()
  await fs.rm(directory, { recursive: true, force: true })
})

function request(taskId = 'shell-task', options: { method?: string; auth?: boolean; query?: string; session?: string } = {}) {
  return fetch(`${baseUrl}/api/sessions/${options.session ?? sessionId}/background-tasks/${encodeURIComponent(taskId)}/output${options.query ?? ''}`, {
    method: options.method ?? 'GET',
    headers: options.auth === false ? {} : { Authorization: `Bearer ${token}` },
  })
}

test('reads already-written output of a running Bash task without waiting for a terminal notification', async () => {
  const response = await request()
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ taskId: 'shell-task', state: 'available', text: 'HTTP server listening on 127.0.0.1:3111\n', truncated: false })
})

test('keeps authentication, task/session ownership, path-free query and method boundaries', async () => {
  expect((await request('shell-task', { auth: false })).status).toBe(401)
  expect((await request('shell-task', { method: 'POST' })).status).toBe(405)
  expect((await request('shell-task', { query: '?path=/tmp/settings.json' })).status).toBe(400)
  expect((await request('../settings')).status).toBe(400)
  expect((await request('unknown-task')).status).toBe(404)
  expect((await request('shell-task', { session: crypto.randomUUID() })).status).toBe(404)
  const response = await request()
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(JSON.stringify(await response.json())).not.toContain(outputPath)
})

test('reports a missing or empty output file without inventing success or stdout', async () => {
  await fs.writeFile(outputPath, '')
  expect(await (await request()).json()).toMatchObject({ state: 'empty', text: '', totalBytes: 0 })
  await fs.unlink(outputPath)
  expect(await (await request()).json()).toMatchObject({ state: 'missing', text: '', totalBytes: 0 })
})

test('the real route preserves the official original output location when transcript cwd changed', async () => {
  const rows = (await fs.readFile(transcriptPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  for (const row of rows) row.cwd = path.join(row.cwd, 'nested-worktree')
  // Also exceed ordinary display-preview limits: the location is CLI metadata at the end.
  rows[1].message.content[0].content = 'earlier stdout\n'.repeat(2000) + rows[1].message.content[0].content
  await fs.writeFile(transcriptPath, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
  expect(await (await request()).json()).toMatchObject({ state: 'available', text: 'HTTP server listening on 127.0.0.1:3111\n' })
})

test('the real route does not turn an errored Bash result into valid task ownership', async () => {
  const rows = (await fs.readFile(transcriptPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  rows[1].message.content[0].is_error = true
  await fs.writeFile(transcriptPath, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
  expect((await request()).status).toBe(404)
})

test('a terminal shell older than the display page still exposes the shell reader in the task list', async () => {
  const rows = Array.from({ length: 220 }, (_, i) => ({ type: 'user', uuid: crypto.randomUUID(), timestamp: `2026-10-24T00:01:${String(i % 60).padStart(2, '0')}Z`, message: { role: 'user', content: `ordinary fixture message ${i}` } }))
  await fs.appendFile(transcriptPath, rows.map(row => JSON.stringify(row)).join('\n') + '\n' + JSON.stringify({ type: 'user', uuid: crypto.randomUUID(), timestamp: '2026-10-24T00:10:00Z', message: { role: 'user', content: '<task-notification>\n<task-id>shell-task</task-id>\n<tool-use-id>shell-use</tool-use-id>\n<status>completed</status>\n<summary>Command ended</summary>\n</task-notification>' } }) + '\n')
  const response = await fetch(`${baseUrl}/api/sessions/${sessionId}/background-tasks`, { headers: { Authorization: `Bearer ${token}` } })
  const value = await response.json() as { tasks: Record<string, unknown>[] }
  expect(value.tasks.find(task => task.taskId === 'shell-task')).toMatchObject({ taskType: 'local_bash', status: 'completed' })
  expect(await (await request()).json()).toMatchObject({ state: 'available', text: 'HTTP server listening on 127.0.0.1:3111\n' })
})
