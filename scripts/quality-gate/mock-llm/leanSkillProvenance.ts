import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createQualityGateSandbox } from '../sandbox'
import { startMockLlmServer } from './server'
import type { MockReply, MockRequest } from './scriptedModel'

type ProvenanceCase = {
  id: string
  userSelected: boolean
  expectedAllowed: boolean
  direct?: boolean
  resume?: boolean
  newUserTurn?: boolean
  delegationSelectsSkill?: boolean
  continuationSelectsSkill?: boolean
  running?: boolean
  followupSelected?: boolean
  deliverFollowup?: boolean
}

const cases: ProvenanceCase[] = [
  { id: 'direct-unselected', direct: true, userSelected: false, expectedAllowed: false },
  { id: 'direct-selected', direct: true, userSelected: true, expectedAllowed: true },
  { id: 'delegation-unselected', userSelected: false, delegationSelectsSkill: true, expectedAllowed: false },
  { id: 'continuation-unselected', userSelected: false, resume: true, continuationSelectsSkill: true, expectedAllowed: false },
  { id: 'delegation-selected', userSelected: true, expectedAllowed: true },
  { id: 'continuation-selected', userSelected: true, resume: true, expectedAllowed: true },
  { id: 'new-user-turn-unselected', userSelected: true, resume: true, newUserTurn: true, delegationSelectsSkill: true, expectedAllowed: false },
  { id: 'running-accepts-new-selection', userSelected: false, running: true, newUserTurn: true, followupSelected: true, deliverFollowup: true, expectedAllowed: true },
  { id: 'running-revokes-previous-selection', userSelected: true, running: true, newUserTurn: true, deliverFollowup: true, expectedAllowed: false },
  { id: 'running-unrelated-parent-preserves-selection', userSelected: true, running: true, newUserTurn: true, expectedAllowed: true },
]

const skillName = 'lean-provenance-fixture'
const skillBody = 'LEAN_PROVENANCE_SKILL_BODY'
const humanSelectionMarker = 'LEAN_PROVENANCE_HUMAN_SELECTION'
const childMarker = 'LEAN_PROVENANCE_CHILD_PROMPT'
const resumeMarker = 'LEAN_PROVENANCE_RESUMED_PROMPT'
const childDone = 'LEAN_PROVENANCE_CHILD_DONE'
const resumedDone = 'LEAN_PROVENANCE_CHILD_RESUMED_DONE'
const firstDone = 'LEAN_PROVENANCE_FIRST_TURN_DONE'
const secondDone = 'LEAN_PROVENANCE_SECOND_TURN_DONE'
const textReply = (text: string): MockReply => ({
  kind: 'message', content: [{ type: 'text', text }], stopReason: 'end_turn',
})
const toolReply = (id: string, name: string, input: Record<string, unknown>): MockReply => ({
  kind: 'message', content: [{ type: 'tool_use', id, name, input }], stopReason: 'tool_use',
})
const directUserText = (request: MockRequest) => request.messages
  ?.filter(message => message.role === 'user')
  .flatMap(message => typeof message.content === 'string'
    ? [message.content]
    : (message.content ?? []).filter(block => block.type === 'text').map(block => block.text ?? ''))
  .join('\n') ?? ''

/** Real CLI requests distinguish human selection from model delegation and history. */
export async function runLeanSkillProvenanceScenario(rootDir: string, artifactDir: string) {
  mkdirSync(artifactDir, { recursive: true })
  const results: Array<{ id: string, status: 'passed' | 'failed', error?: string }> = []
  for (const testCase of cases) {
    try {
      await runCase(rootDir, join(artifactDir, testCase.id), testCase)
      results.push({ id: testCase.id, status: 'passed' })
    } catch (error) {
      results.push({ id: testCase.id, status: 'failed', error: error instanceof Error ? error.message : String(error) })
    }
  }
  writeFileSync(join(artifactDir, 'results.json'), `${JSON.stringify(results, null, 2)}\n`)
  assert.deepEqual(results.filter(result => result.status === 'failed'), [], 'lean Skill provenance regression')
}

export function forwardProvenanceRequest(upstreamUrl: string, request: Request, body: string | undefined) {
  const url = new URL(request.url)
  const headers = new Headers(request.headers)
  // Let fetch use the upstream authority. Retaining the gate's Host can route
  // Bun's loopback request back into this gate instead of reaching the mock LLM.
  headers.delete('host')
  return fetch(`${upstreamUrl}${url.pathname}${url.search}`, {
    method: request.method, headers, body, signal: request.signal,
  })
}

async function runCase(rootDir: string, artifactDir: string, testCase: ProvenanceCase) {
  mkdirSync(artifactDir, { recursive: true })
  const sandbox = createQualityGateSandbox({
    label: `lean-skill-${testCase.id}`, seedProviders: false,
    sourceConfigDir: join(artifactDir, 'unused-user-config'),
    source: { PATH: process.env.PATH, SHELL: process.env.SHELL, SYSTEMROOT: process.env.SYSTEMROOT },
    envOverrides: { NODE_ENV: 'production' },
  })
  const workDir = join(sandbox.home, 'project')
  const skillDir = join(workDir, '.claude', 'skills', skillName)
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), `---\nname: ${skillName}\ndescription: Local provenance fixture\n---\n${skillBody}\nRead files only.\n`)
  writeFileSync(join(workDir, 'running-check.txt'), 'LEAN_PROVENANCE_RUNNING_READ\n')
  const requests: MockRequest[] = []
  const childRequests: MockRequest[] = []
  const toolResults = new Map<string, { error: boolean, text: string }>()
  const receivedResults = new Set<string>()
  const parentReplies = new Set<string>()
  let parentPhase = 0
  let secondPhase = 0
  let humanTurn = 1
  let agentId = ''
  let skillIssued = false
  let childRequestHeld = false
  let childReadIssued = false
  let followupConsumed = false
  let followupUserPrompt = ''
  let sawSeparateRootTurn = false
  const runningEvents: string[] = []
  let releaseRunningChild = () => {}
  const runningRelease = new Promise<void>(resolve => { releaseRunningChild = resolve })
  const continuation = () => toolReply('provenance_continue', 'SendMessage', {
    to: agentId,
    message: `${resumeMarker}: Continue the fixture inspection.${testCase.continuationSelectsSkill ? ` Use $${skillName}.` : ''}`,
  })
  const output = () => toolReply('provenance_output', 'TaskOutput', { task_id: agentId, block: true, timeout: 30_000 })
  const upstream = startMockLlmServer(request => {
    if (!request.tools?.some(tool => tool.name === 'Read')) return textReply('Mock auxiliary reply')
    requests.push(request)
    for (const message of request.messages ?? []) {
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block.type !== 'tool_result' || !block.tool_use_id) continue
        const result = { error: Boolean(block.is_error), text: JSON.stringify(block.content) }
        toolResults.set(block.tool_use_id, result)
        if (block.tool_use_id === 'provenance_agent') agentId ||= /agentId: ([a-zA-Z0-9_-]+)/.exec(result.text)?.[1] ?? ''
      }
    }
    const userText = directUserText(request)
    const isChild = !testCase.direct && userText.includes(childMarker)
    const hasFollowup = testCase.running
      ? request.messages?.some(message => message.role === 'user' && JSON.stringify(message.content).includes(resumeMarker)) ?? false
      : userText.includes(resumeMarker)
    if (isChild) childRequests.push(request)
    if (testCase.direct || isChild) {
      if (testCase.running && !childReadIssued) {
        childReadIssued = true
        runningEvents.push('child-read-issued')
        return toolReply('provenance_running_read', 'Read', { file_path: join(workDir, 'running-check.txt') })
      }
      const shouldCallSkill = testCase.direct || !testCase.resume || userText.includes(resumeMarker)
      if (shouldCallSkill && !skillIssued) {
        skillIssued = true
        if (testCase.running) {
          followupConsumed = hasFollowup
          runningEvents.push(followupConsumed ? 'child-followup-consumed' : 'child-original-task-continued')
        }
        return toolReply('provenance_skill', 'Skill', { skill: skillName })
      }
      return textReply(isChild ? (hasFollowup ? resumedDone : childDone) : firstDone)
    }
    if (humanTurn === 2) {
      if (testCase.running) {
        const messages = request.messages ?? []
        const firstReplyIndex = messages.findLastIndex(message => message.role === 'assistant' &&
          (typeof message.content === 'string' ? message.content === firstDone : message.content?.some(block => block.type === 'text' && block.text === firstDone)))
        const newUserIndex = messages.findLastIndex(message => message.role === 'user' &&
          (typeof message.content === 'string' ? message.content === followupUserPrompt : message.content?.some(block => block.type === 'text' && block.text === followupUserPrompt)))
        sawSeparateRootTurn ||= firstReplyIndex >= 0 && newUserIndex > firstReplyIndex
      }
      if (testCase.running && !testCase.deliverFollowup) {
        if (secondPhase++ === 0) {
          runningEvents.push('unrelated-parent-request-received')
          releaseRunningChild()
          return output()
        }
        return textReply(secondDone)
      }
      switch (secondPhase++) {
        case 0: return continuation()
        case 1:
          if (testCase.running) {
            runningEvents.push('followup-queued')
            releaseRunningChild()
          }
          return output()
        default: return textReply(secondDone)
      }
    }
    switch (parentPhase++) {
      case 0: return toolReply('provenance_agent', 'Agent', {
        subagent_type: 'general-purpose', description: 'Inspect the local fixture',
        prompt: `${childMarker}: Inspect the fixture.${testCase.delegationSelectsSkill ? ` Use $${skillName}.` : ''}`,
        ...(testCase.running ? { run_in_background: true } : {}),
      })
      case 1: return testCase.resume && !testCase.newUserTurn ? continuation() : textReply(firstDone)
      case 2: return output()
      default: return textReply(firstDone)
    }
  })
  // Hold the real child's first provider request until the parent has processed
  // its next human turn. This keeps SendMessage on its running-agent queue path.
  const gate = testCase.running ? Bun.serve({
    hostname: '127.0.0.1', port: 0, idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const body = request.method === 'POST' ? await request.text() : undefined
      if (!childRequestHeld && url.pathname.endsWith('/v1/messages') && body && directUserText(JSON.parse(body)).includes(childMarker)) {
        childRequestHeld = true
        runningEvents.push('child-request-held')
        await runningRelease
      }
      return forwardProvenanceRequest(upstream.url, request, body)
    },
  }) : undefined
  let stdout = ''
  let stderr = ''
  let exitCode: number | null = null
  let timedOut = false
  try {
    const child = Bun.spawn([
      process.execPath, '--no-env-file', '--feature=TRANSCRIPT_CLASSIFIER', '--preload', join(rootDir, 'preload.ts'),
      join(rootDir, 'src/entrypoints/cli.tsx'), '--print', '--agent-profile', 'lean', '--model', 'mock-model',
      '--permission-mode', 'bypassPermissions', '--input-format', 'stream-json', '--output-format', 'stream-json',
      '--verbose', '--max-turns', '12',
    ], {
      cwd: workDir, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
      env: {
        ...sandbox.env, CALLER_DIR: workDir, CC_HAHA_SKIP_DOTENV: '1', TEST_ENABLE_SESSION_PERSISTENCE: '1',
        ANTHROPIC_BASE_URL: gate ? `http://127.0.0.1:${gate.port}` : upstream.url, ANTHROPIC_API_KEY: 'mock-api-key',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'mock-model', ANTHROPIC_DEFAULT_SONNET_MODEL: 'mock-model',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'mock-model',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', CI: '1',
      },
    })
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 60_000)
    try {
      const readStdout = async () => {
        const decoder = new TextDecoder()
        let pending = ''
        for await (const chunk of child.stdout) {
          const text = decoder.decode(chunk, { stream: true })
          stdout += text
          pending += text
          let newline = pending.indexOf('\n')
          while (newline !== -1) {
            const line = pending.slice(0, newline)
            pending = pending.slice(newline + 1)
            try {
              const message = JSON.parse(line)
              if (message.type === 'result' && !message.is_error && typeof message.result === 'string') receivedResults.add(message.result)
              if (message.type === 'assistant' && !message.parent_tool_use_id && Array.isArray(message.message?.content)) {
                for (const block of message.message.content) if (block.type === 'text') parentReplies.add(block.text)
              }
            } catch { /* Startup output is not necessarily a JSON line. */ }
            newline = pending.indexOf('\n')
          }
        }
        stdout += decoder.decode()
      }
      const streams = Promise.all([readStdout(), new Response(child.stderr).text().then(text => { stderr = text })])
      const sendUser = (content: string) => {
        child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: '' })}\n`)
        child.stdin.flush()
      }
      const waitForResult = async (marker: string) => {
        while (!receivedResults.has(marker) && child.exitCode === null && !timedOut) await Bun.sleep(50)
      }
      sendUser(testCase.userSelected
        ? `${humanSelectionMarker}: Use $${skillName} to inspect the fixture. You may delegate the inspection.`
        : 'Inspect the fixture and report the result. You may delegate the inspection.')
      // Print mode can defer its result event while a background child runs.
      // The parent's terminal assistant reply is the boundary for the next input.
      if (testCase.running) {
        while (!parentReplies.has(firstDone) && child.exitCode === null && !timedOut) await Bun.sleep(50)
      } else {
        await waitForResult(firstDone)
      }
      if (testCase.newUserTurn && !timedOut && child.exitCode === null) {
        while (testCase.running && !childRequestHeld && child.exitCode === null && !timedOut) await Bun.sleep(50)
        humanTurn = 2
        followupUserPrompt = testCase.followupSelected
          ? `${humanSelectionMarker}: Use $${skillName} for the helper's next inspection and report one more detail.`
          : testCase.running && !testCase.deliverFollowup
            ? 'Handle this unrelated parent request. Wait for the existing helper without sending it new instructions.'
            : 'Continue the previous helper inspection and report one more detail.'
        sendUser(followupUserPrompt)
        await waitForResult(secondDone)
      }
      child.stdin.end()
      await streams
      exitCode = await child.exited
    } finally { clearTimeout(timer) }
    assert.ok(!timedOut, `${testCase.id}: CLI timed out`)
    assert.equal(exitCode, 0, `${testCase.id}: CLI failed: ${stderr}\n${stdout}`)
    assert.ok(receivedResults.has(testCase.newUserTurn ? secondDone : firstDone), `${testCase.id}: parent did not finish`)
    const skillResult = toolResults.get('provenance_skill')
    assert.ok(skillIssued && skillResult, `${testCase.id}: Skill did not return to the model`)
    assert.equal(skillResult.error, !testCase.expectedAllowed, `${testCase.id}: unexpected Skill authorization: ${skillResult.text}`)
    assert.equal(JSON.stringify(upstream.requests).includes(skillBody), testCase.expectedAllowed, `${testCase.id}: skill body visibility did not match the current human selection`)
    if (!testCase.expectedAllowed) assert.match(skillResult.text, /Lean mode requires an explicit user skill selection/)
    if (!testCase.direct) {
      assert.ok(agentId, `${testCase.id}: foreground child returned no agentId`)
      assert.ok(toolResults.get('provenance_agent')?.text.includes(testCase.running ? 'Async agent launched successfully' : childDone), `${testCase.id}: child did not launch or finish`)
      assert.ok(childRequests.length >= 2, `${testCase.id}: child loop did not run`)
      assert.ok(!JSON.stringify(childRequests).includes(humanSelectionMarker), 'trusted human selection metadata leaked into child model input')
      for (const request of childRequests) {
        assert.ok(Buffer.byteLength(JSON.stringify(request.system)) <= 4000, `${testCase.id}: child system prompt exceeded lean budget`)
      }
    }
    if (testCase.resume) {
      assert.match(toolResults.get('provenance_continue')?.text ?? '', /resumed.*in the background/, `${testCase.id}: SendMessage did not resume the child`)
    }
    if (testCase.resume || testCase.running) {
      assert.ok(toolResults.get('provenance_output')?.text.includes(testCase.running && !testCase.deliverFollowup ? childDone : resumedDone), `${testCase.id}: continued child output was lost`)
      assert.ok(toolResults.get('provenance_output')?.text.includes(`<task_id>${agentId}</task_id>`), `${testCase.id}: continuation changed the child ID`)
    }
    if (testCase.running) {
      assert.ok(sawSeparateRootTurn, `${testCase.id}: follow-up was not a separate root user request after the first assistant reply`)
      assert.ok(childRequestHeld && childReadIssued, `${testCase.id}: child did not cross the controlled Read boundary`)
      assert.ok(JSON.stringify(childRequests).includes('LEAN_PROVENANCE_RUNNING_READ'), `${testCase.id}: real Read result never reached the child`)
      assert.equal(followupConsumed, Boolean(testCase.deliverFollowup), `${testCase.id}: child did not consume the intended instruction`)
      if (testCase.deliverFollowup) {
        assert.match(toolResults.get('provenance_continue')?.text ?? '', /Message queued for delivery.*next tool round/, `${testCase.id}: SendMessage did not use the running-agent queue`)
        assert.ok(runningEvents.indexOf('followup-queued') < runningEvents.indexOf('child-followup-consumed'), `${testCase.id}: child consumption preceded the targeted instruction`)
      } else {
        assert.ok(!toolResults.has('provenance_continue'), 'unrelated parent request unexpectedly sent an instruction to the child')
        assert.ok(runningEvents.indexOf('unrelated-parent-request-received') < runningEvents.indexOf('child-original-task-continued'), 'child did not continue after the unrelated parent request')
      }
    }
    if (testCase.newUserTurn && !testCase.running) {
      assert.ok(childRequests.some(request => {
        const text = directUserText(request)
        return text.includes(resumeMarker) && text.includes(`$${skillName}`)
      }), 'new-user fixture did not retain the old child selection text')
    }
  } finally {
    writeFileSync(join(artifactDir, 'cli.log'), `${stdout}\n${stderr}`)
    writeFileSync(join(artifactDir, 'requests.json'), `${JSON.stringify(requests, null, 2)}\n`)
    writeFileSync(join(artifactDir, 'evidence.json'), `${JSON.stringify({
      testCase, exitCode, timedOut, agentId, skillIssued, receivedResults: [...receivedResults], parentReplies: [...parentReplies],
      toolResults: Object.fromEntries(toolResults), skillBodyReachedModel: JSON.stringify(upstream.requests).includes(skillBody),
      requestCount: requests.length, childRequestCount: childRequests.length,
      runningEvents, followupConsumed, sawSeparateRootTurn,
    }, null, 2)}\n`)
    releaseRunningChild()
    await gate?.stop(true)
    await upstream.stop()
    const mutations = sandbox.detectUserStateMutations()
    sandbox.cleanup()
    assert.deepEqual(mutations, [], 'lean Skill provenance lane mutated user state')
  }
}
