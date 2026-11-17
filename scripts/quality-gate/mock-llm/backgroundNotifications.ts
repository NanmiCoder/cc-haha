import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createQualityGateSandbox } from '../sandbox'
import { startMockLlmServer } from './server'
import type { MockReply } from './scriptedModel'

const guidance = 'Treat background task notifications as internal lifecycle updates'
const kickoff = 'BACKGROUND_NOTIFICATION_FIXTURE_KICKOFF'
const childPrompt = 'BACKGROUND_NOTIFICATION_FIXTURE_CHILD'
const reply = (text: string): MockReply => ({ kind: 'message', content: [{ type: 'text', text }], stopReason: 'end_turn' })

/** Real agents settle together; inspect their actual model input and persisted source. */
export async function runBackgroundNotificationScenario(rootDir: string, artifactDir: string) {
  mkdirSync(artifactDir, { recursive: true })
  const sandbox = createQualityGateSandbox({ label: 'background-notifications', seedProviders: false,
    source: { PATH: process.env.PATH, SHELL: process.env.SHELL, SYSTEMROOT: process.env.SYSTEMROOT } })
  const workDir = join(sandbox.home, 'project')
  mkdirSync(workDir, { recursive: true })
  let batchContent = ''
  const upstream = startMockLlmServer(request => {
    if (!request.tools?.some(tool => tool.name === 'Read')) return reply('Auxiliary fixture reply')
    const all = JSON.stringify(request.messages)
    const last = JSON.stringify(request.messages?.at(-1)?.content ?? '')
    if (all.includes(childPrompt) && !all.includes(kickoff)) return reply('Child verification result')
    if (last.includes('<task-notification>')) {
      batchContent = last
      return reply('Settled verification results incorporated.')
    }
    if (last.includes('tool_result')) return reply('Verification started in the background.')
    return { kind: 'message', content: ['alpha', 'beta'].map(name => ({ type: 'tool_use', id: `background-${name}`, name: 'Agent',
      input: { description: `Verify ${name}`, prompt: `${childPrompt} ${name}`, subagent_type: 'general-purpose', run_in_background: true } })), stopReason: 'tool_use' }
  })
  const child = Bun.spawn([process.execPath, '--no-env-file', '--preload', join(rootDir, 'preload.ts'), join(rootDir, 'src/entrypoints/cli.tsx'),
    '--print', '--model', 'mock-model', '--permission-mode', 'bypassPermissions', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'], {
    cwd: workDir, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: { ...sandbox.env, CALLER_DIR: workDir, CC_HAHA_SKIP_DOTENV: '1',
      ANTHROPIC_BASE_URL: upstream.url, ANTHROPIC_API_KEY: 'mock-api-key', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', CI: '1' },
  })
  const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  const timeout = setTimeout(() => child.kill(), 30_000)
  try {
    child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: kickoff } })}\n`)
    child.stdin.end()
    const [stdout, stderr] = await output
    const code = await child.exited
    writeFileSync(join(artifactDir, 'background-notifications.log'), `${stdout}\n${stderr}`)
    assert.equal(code, 0, stderr)
    assert.ok(batchContent.includes('Verify alpha') && batchContent.includes('Verify beta'), 'settled agents did not reach one follow-up')
    assert.equal(batchContent.split(guidance).length - 1, 1, 'the settled batch needs one shared internal-update instruction')
    assert.ok(batchContent.includes('Child verification result'), 'the instruction displaced the actual task result')
    assert.ok(batchContent.includes('Investigate failures that block the requested task'), 'blocking failures must remain actionable')
    assert.ok(batchContent.includes('Do not infer intentional cleanup from exit code 143 alone'), 'exit codes alone cannot prove cleanup')
    const events = stdout.split('\n').filter(Boolean).map(line => JSON.parse(line))
    assert.equal(events.filter(event => event.type === 'system' && event.subtype === 'task_notification').length, 2, 'SDK lifecycle terminals must remain exactly once')
    const transcripts = readdirSync(join(sandbox.configDir, 'projects'), { recursive: true })
      .filter((file): file is string => typeof file === 'string' && file.endsWith('.jsonl'))
      .map(file => readFileSync(join(sandbox.configDir, 'projects', file), 'utf8'))
    const batchEntry = transcripts.flatMap(text => text.split('\n').filter(Boolean).map(line => JSON.parse(line)))
      .find(entry => entry.type === 'user' && entry.isMeta && JSON.stringify(entry.message?.content).includes('Verify alpha') && JSON.stringify(entry.message?.content).includes('Verify beta'))
    assert.ok(batchEntry, 'the original notification batch was not persisted')
    assert.equal(batchEntry.origin?.kind, 'task-notification', 'the batch lost its internal provenance')
    assert.ok(!transcripts.some(text => text.includes(guidance)), 'model-only guidance leaked into persisted transcripts')
  } finally {
    clearTimeout(timeout)
    child.kill()
    await child.exited
    await output
    await upstream.stop()
    const mutations = sandbox.detectUserStateMutations()
    sandbox.cleanup()
    assert.deepEqual(mutations, [], 'lane mutated real user state')
  }
}
