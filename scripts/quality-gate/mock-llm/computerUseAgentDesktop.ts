import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createQualityGateSandbox } from '../sandbox'
import { startMockLlmServer } from './server'
import type { MockReply, MockRequest } from './scriptedModel'

const TOOL = 'mcp__computer-use__desktop'
const textReply = (text: string): MockReply => ({ kind: 'message', content: [{ type: 'text', text }], stopReason: 'end_turn' })
type NativeCall = { event: string; pid: number; command: string; args: string[]; session?: string; agent?: string; headed: boolean; cwd: string; stateRoot: string; inheritedSession?: string }
type ResultBlock = { tool_use_id?: string; is_error?: boolean; content?: unknown }

function toolResult(request: MockRequest, id: string): ResultBlock | undefined {
  return request.messages?.flatMap(message => Array.isArray(message.content) ? message.content : [])
    .find(block => block.type === 'tool_result' && block.tool_use_id === id)
}

function resultData(block: ResultBlock | undefined): any {
  const content = block?.content
  const text = typeof content === 'string' ? content : Array.isArray(content)
    ? content.filter(item => item.type === 'text').map(item => item.text).join('\n') : ''
  return JSON.parse(text)
}

/** Real CLI, agent loop, MCP binding and subprocess bridge; only the desktop is a fixture. */
export async function runComputerUseAgentDesktopScenario(rootDir: string, artifactDir: string) {
  mkdirSync(artifactDir, { recursive: true })
  const sandbox = createQualityGateSandbox({
    label: 'computer-use-agent-desktop', seedProviders: false,
    sourceConfigDir: join(artifactDir, 'unused-user-config'),
    source: { PATH: process.env.PATH, SHELL: process.env.SHELL, SYSTEMROOT: process.env.SYSTEMROOT },
  })
  const workDir = join(sandbox.home, 'project')
  const appRoot = join(sandbox.home, 'app')
  const binaries = join(appRoot, 'src-tauri', 'binaries')
  const log = join(sandbox.configDir, 'agent-desktop-native.ndjson')
  const platform = process.platform === 'win32' ? 'win32' : 'linux'
  mkdirSync(workDir, { recursive: true })
  mkdirSync(binaries, { recursive: true })
  mkdirSync(join(sandbox.configDir, 'cc-haha'), { recursive: true })
  writeFileSync(join(sandbox.configDir, 'cc-haha', 'computer-use-config.json'), JSON.stringify({ enabled: true }))
  const executable = join(binaries, platform === 'win32' ? 'agent-desktop.exe' : 'agent-desktop')
  try {
    const build = await Bun.build({
      entrypoints: [join(rootDir, 'scripts/quality-gate/mock-llm/computerUseAgentDesktopNative.ts')],
      target: 'bun', minify: true, compile: { outfile: executable },
    })
    assert.ok(build.success, `could not compile native fixture: ${build.logs.join('\n')}`)
    if (process.platform === 'darwin') {
      const stripped = Bun.spawn(['/usr/bin/codesign', '--remove-signature', executable], { stdout: 'ignore', stderr: 'ignore' })
      await stripped.exited
      const signed = Bun.spawn(['/usr/bin/codesign', '--force', '--sign', '-', executable], { stdout: 'ignore', stderr: 'pipe' })
      const [exitCode, diagnostic] = await Promise.all([signed.exited, new Response(signed.stderr).text()])
      assert.equal(exitCode, 0, `could not sign disposable native fixture: ${diagnostic}`)
    }
  } catch (error) {
    sandbox.cleanup()
    throw error
  }
  const calls = (): NativeCall[] => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
  const evidence: Record<string, unknown> = { platform, nativeBoundary: 'compiled fixture; no desktop API' }
  const seenTools = new Set<string>()
  const errors: string[] = []
  let phase: 'operate' | 'cancel' | 'recover' | 'shutdown' = 'operate'
  let expectedExitCode = 0
  const use = (id: string, command: string, args: string[]): MockReply => ({
    kind: 'message', content: [{ type: 'tool_use', id, name: TOOL, input: { command, args } }], stopReason: 'tool_use',
  })
  const upstream = startMockLlmServer(request => {
    if (!request.tools?.some(tool => tool.name === 'Read')) return textReply('Mock auxiliary reply')
    for (const tool of request.tools) if (tool.name) seenTools.add(tool.name)
    try {
      assert.ok(request.tools.some(tool => tool.name === TOOL), 'native desktop tool missing from real MCP inventory')
      if (phase === 'cancel') return use('native_wait_cancel', 'wait', ['100000'])
      if (phase === 'shutdown') return use('native_wait_shutdown', 'wait', ['100001'])
      if (phase === 'recover') {
        const observed = toolResult(request, 'native_recovered_snapshot')
        if (!observed) return use('native_recovered_snapshot', 'snapshot', ['--app', 'Fixture'])
        assert.equal(resultData(observed).data.tree.children[0].name, 'Saved')
        evidence.recoveryObserved = true
        return textReply('NATIVE_DESKTOP_RECOVERED')
      }
      const before = toolResult(request, 'native_observe_before')
      if (!before) return use('native_observe_before', 'snapshot', ['--app', 'Fixture', '-i'])
      const ref = resultData(before).data.tree.children[0].ref_id
      assert.equal(ref, '@sbefore:e1')
      if (!toolResult(request, 'native_click')) return use('native_click', 'click', [ref])
      const after = toolResult(request, 'native_observe_after')
      if (!after) return use('native_observe_after', 'snapshot', ['--app', 'Fixture', '-i'])
      assert.equal(resultData(after).data.tree.children[0].name, 'Saved')
      evidence.observedButtonChange = true
      const stale = toolResult(request, 'native_stale')
      if (!stale) return use('native_stale', 'click', [ref])
      assert.equal(stale.is_error, true)
      assert.equal(resultData(stale).error.code, 'STALE_REF')
      evidence.nativeErrorPreserved = true
      return textReply('NATIVE_DESKTOP_VERIFIED')
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
      return textReply('NATIVE_DESKTOP_ASSERTION_FAILED')
    }
  })
  const proc = Bun.spawn([
    process.execPath, '--no-env-file', '--preload', join(rootDir, 'preload.ts'),
    '--preload', join(rootDir, 'scripts/quality-gate/mock-llm/computerUseAgentDesktopFixture.ts'),
    join(rootDir, 'src/entrypoints/cli.tsx'), '--print', '--model', 'mock-model',
    '--permission-mode', 'bypassPermissions', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
  ], {
    cwd: workDir, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    env: { ...sandbox.env, CALLER_DIR: workDir, CC_HAHA_SKIP_DOTENV: '1', CLAUDE_APP_ROOT: appRoot,
      ANTHROPIC_BASE_URL: upstream.url, ANTHROPIC_API_KEY: 'mock-api-key',
      MOCK_AGENT_DESKTOP_PLATFORM: platform, MOCK_AGENT_DESKTOP_LOG: log,
      MOCK_AGENT_DESKTOP_CWD: workDir,
      AGENT_DESKTOP_SESSION: 'foreign-session-must-be-cleared',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', CI: '1', MCP_TIMEOUT: '3000' },
  })
  let stdout = ''
  let stderr = ''
  let results = 0
  const drains = Promise.all([
    (async () => {
      const decoder = new TextDecoder()
      let pending = ''
      for await (const chunk of proc.stdout) {
        const text = decoder.decode(chunk, { stream: true })
        stdout += text
        pending += text
        for (;;) {
          const at = pending.indexOf('\n')
          if (at < 0) break
          const line = pending.slice(0, at)
          pending = pending.slice(at + 1)
          try { if (JSON.parse(line).type === 'result') results++ } catch {}
        }
      }
    })(),
    (async () => { stderr = await new Response(proc.stderr).text() })(),
  ])
  const waitFor = async (predicate: () => boolean, description: string) => {
    const deadline = Date.now() + 45_000
    while (!predicate() && proc.exitCode === null && Date.now() < deadline) await Bun.sleep(20)
    assert.ok(predicate(), `${description}: ${stderr}\n${stdout.slice(-8000)}`)
  }
  const send = async (value: unknown) => { proc.stdin.write(`${JSON.stringify(value)}\n`); await proc.stdin.flush() }
  const turn = async (name: string) => send({ type: 'user', message: { role: 'user', content: name }, parent_tool_use_id: null, session_id: '' })
  const killTimer = setTimeout(() => proc.kill('SIGKILL'), 120_000)
  try {
    await turn('Use the native desktop to save the fixture, observe it, and report a stale ref error.')
    await waitFor(() => results >= 1, 'native observe-act-verify turn did not complete')
    assert.deepEqual(errors, [])
    assert.equal(evidence.observedButtonChange, true)
    assert.equal(evidence.nativeErrorPreserved, true)
    phase = 'cancel'
    const beforeCancel = results
    await turn('Start the native desktop wait; I will interrupt it.')
    await waitFor(() => calls().some(call => call.event === 'waiting'), 'native subprocess never started waiting')
    const waitingPid = calls().find(call => call.event === 'waiting')!.pid
    await send({ type: 'control_request', request_id: 'native-desktop-interrupt', request: { subtype: 'interrupt' } })
    await waitFor(() => results > beforeCancel, 'CLI did not finish the interrupted turn')
    await waitFor(() => {
      try { process.kill(waitingPid, 0); return false } catch { return true }
    }, 'interrupted native subprocess survived')
    evidence.cancelledSubprocessReaped = true
    phase = 'recover'
    const beforeRecovery = results
    await turn('Observe the fixture after cancellation and report whether the button remains Saved.')
    await waitFor(() => results > beforeRecovery, 'native desktop did not recover after interruption')
    assert.deepEqual(errors, [])
    assert.equal(evidence.recoveryObserved, true)
    await waitFor(() => !existsSync(join(sandbox.configDir, 'computer-use.lock')), 'turn cleanup retained the desktop lock')
    const dispatched = calls().filter(call => call.event === 'dispatch')
    assert.equal(dispatched.filter(call => call.command === 'session' && call.args[0] === 'start').length, 1)
    assert.equal(dispatched.filter(call => call.command === 'click').length, 2, 'stale error must not auto-replay the click')
    assert.equal(dispatched.filter(call => call.command === 'wait').length, 1)
    for (const call of dispatched) {
      assert.ok(call.stateRoot.startsWith(sandbox.configDir))
      const teardown = call.command === 'cursor-overlay' && call.args[0] === 'disable'
      assert.equal(realpathSync(call.cwd), realpathSync(teardown ? call.stateRoot : workDir))
      assert.equal(call.inheritedSession, undefined, 'native bridge inherited an external session override')
      assert.equal(call.headed, false)
      if (['snapshot', 'click', 'wait'].includes(call.command)) {
        assert.equal(call.session, 'fixture-native-session')
        assert.ok(call.agent)
      }
    }
    assert.ok(dispatched.some(call => call.command === 'cursor-overlay' && call.args[0] === 'disable'))
    assert.ok(seenTools.has(TOOL))
    assert.ok(!seenTools.has('mcp__computer-use__screenshot'))
    assert.ok(!seenTools.has('mcp__computer-use__js'))
    if (process.platform !== 'win32') {
      phase = 'shutdown'
      await turn('Start another native wait so I can close the CLI while it is running.')
      await waitFor(() => calls().some(call => call.event === 'waiting' && call.args[0] === '100001'), 'shutdown fixture did not start')
      expectedExitCode = 143
      proc.kill('SIGTERM')
      await waitFor(() => proc.exitCode !== null, 'CLI did not finish native shutdown')
    }
  } finally {
    if (proc.exitCode === null) proc.stdin.end()
    const exitTimer = setTimeout(() => proc.kill('SIGKILL'), 10_000)
    let exitCode: number
    try { exitCode = await proc.exited; await drains } finally { clearTimeout(exitTimer); clearTimeout(killTimer) }
    for (const call of calls().filter(call => call.event === 'waiting')) {
      try { process.kill(call.pid, 'SIGKILL') } catch {}
    }
    evidence.cliExitCode = exitCode
    evidence.shutdownEndedNativeSession = calls().some(call => call.command === 'session' && call.args[0] === 'end')
    if (phase === 'shutdown') {
      const all = calls()
      evidence.shutdownReleasedInputBeforeEnd = all.findIndex(call => call.event === 'input-released') >= 0
        && all.findIndex(call => call.command === 'session' && call.args[0] === 'end') > all.findIndex(call => call.event === 'input-released')
    }
    writeFileSync(join(artifactDir, 'cli.log'), `${stdout}\n${stderr}`)
    writeFileSync(join(artifactDir, 'evidence.json'), `${JSON.stringify({ ...evidence, errors, tools: [...seenTools], calls: calls() }, null, 2)}\n`)
    await upstream.stop()
    const mutations = sandbox.detectUserStateMutations()
    sandbox.cleanup()
    assert.deepEqual(mutations, [], 'native mock lane mutated protected user state')
    assert.equal(exitCode, expectedExitCode, 'native mock CLI did not shut down cleanly')
    assert.equal(evidence.shutdownEndedNativeSession, true, 'CLI shutdown did not end its native desktop session')
    if (phase === 'shutdown') assert.equal(evidence.shutdownReleasedInputBeforeEnd, true, 'session teardown ran before input release')
  }
}
