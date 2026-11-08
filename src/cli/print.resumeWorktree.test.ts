import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxedTestEnvironment } from '../../scripts/pr/test-environment.js'
import { sanitizePath } from '../utils/sessionStoragePortable.js'

const CLI = join(import.meta.dir, '..', '..', 'bin', 'claude-haha')

function completion() {
  const events = [
    { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ]
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

// A session that ran EnterWorktree mid-session: the conversation stays in the
// project folder of the directory it started in, and its last worktree-state
// record points at the worktree it was working in.
async function resumeAfterEnterWorktree(options: { worktreeExists: boolean }) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'print-resume-worktree-')))
  const repo = join(home, 'repo')
  const worktree = join(repo, '.claude', 'worktrees', 'feature-x')
  await mkdir(options.worktreeExists ? worktree : repo, { recursive: true })
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
    return new Response(completion(), { headers: { 'content-type': 'text/event-stream' } })
  } })
  const env = createSandboxedTestEnvironment(home, {
    NODE_ENV: 'production', CI: '1', CC_HAHA_SKIP_DOTENV: '1', CALLER_DIR: repo,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
    ANTHROPIC_API_KEY: 'fixture-key', ANTHROPIC_BASE_URL: server.url.origin,
    ANTHROPIC_MODEL: 'claude-sonnet-4-5',
  })
  try {
    const sessionId = crypto.randomUUID()
    const projectsDir = join(env.CLAUDE_CONFIG_DIR!, 'projects')
    const transcript = join(projectsDir, sanitizePath(repo), `${sessionId}.jsonl`)
    await mkdir(join(projectsDir, sanitizePath(repo)), { recursive: true })
    const prompt = crypto.randomUUID()
    const base = { sessionId, version: '9.9.9', timestamp: new Date().toISOString(), isSidechain: false, userType: 'external' }
    await writeFile(transcript, [
      { ...base, type: 'user', uuid: prompt, parentUuid: null, cwd: repo, message: { role: 'user', content: 'enter a worktree' } },
      { type: 'worktree-state', sessionId, worktreeSession: { originalCwd: repo, worktreePath: worktree, worktreeName: 'feature-x', worktreeBranch: 'worktree-feature-x', originalBranch: 'main', sessionId } },
      { ...base, type: 'assistant', uuid: crypto.randomUUID(), parentUuid: prompt, cwd: worktree, message: { id: 'msg_prior', role: 'assistant', model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'Working in the worktree now.' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n')

    // The arguments the desktop server passes when it restarts a session.
    const child = Bun.spawn([CLI, '--bare', '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--resume', sessionId],
      { cwd: repo, env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
    child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: 'FOLLOW-UP' } }) + '\n')
    child.stdin.end()
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    const events = stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    const worktreeTranscript = join(projectsDir, sanitizePath(worktree), `${sessionId}.jsonl`)
    return {
      code, stderr, events, repo, worktree,
      transcriptText: await readFile(transcript, 'utf8'),
      wroteWorktreeTranscript: await stat(worktreeTranscript).then(() => true, () => false),
    }
  } finally {
    server.stop(true)
    await rm(home, { recursive: true, force: true })
  }
}

test('a resumed session goes back into the worktree it entered mid-session', async () => {
  const run = await resumeAfterEnterWorktree({ worktreeExists: true })
  expect({ code: run.code, stderr: run.stderr }).toEqual({ code: 0, stderr: '' })
  expect(run.events.find(event => event.type === 'system' && event.subtype === 'init')?.cwd).toBe(run.worktree)
  // The conversation keeps growing in the transcript it already has.
  expect(run.transcriptText).toContain('FOLLOW-UP')
  expect(run.wroteWorktreeTranscript).toBe(false)
}, 30_000)

test('a resumed session whose worktree is gone stays where it was started', async () => {
  const run = await resumeAfterEnterWorktree({ worktreeExists: false })
  expect({ code: run.code, stderr: run.stderr }).toEqual({ code: 0, stderr: '' })
  expect(run.events.find(event => event.type === 'system' && event.subtype === 'init')?.cwd).toBe(run.repo)
  expect(run.transcriptText).toContain('FOLLOW-UP')
  // The next resume must not try to enter the missing directory again.
  const states = run.transcriptText.trim().split('\n').map(line => JSON.parse(line)).filter(row => row.type === 'worktree-state')
  expect(states.at(-1)?.worktreeSession).toBeNull()
}, 30_000)
