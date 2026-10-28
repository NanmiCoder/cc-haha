import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createQualityGateSandbox } from '../sandbox'
import { startMockLlmServer } from './server'
import type { MockReply, MockRequest } from './scriptedModel'
import { runLeanSkillProvenanceScenario } from './leanSkillProvenance'

const leanTools = new Set([
  'Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'PowerShell', 'Skill',
  'Agent', 'SendMessage', 'TaskOutput', 'TaskStop', 'WebSearch', 'WebFetch',
  'TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList', 'TodoWrite',
])
// Fixed-prefix budgets for the first lean request (JSON bytes, as in the comparison
// artifact): measured 3273 / 24953 on macOS after adding subagents, web research
// and tasks, plus headroom for host path lengths and shell lines. Exceeding them
// means lean re-imported standard-profile weight,
// such as the ~12.8KB auto-memory guide or the ~6KB git commit/PR manual.
const LEAN_REQUEST_BUDGET = { systemBytes: 3600, childSystemBytes: 4000, bashToolSchemaBytes: 26500 }
const webSearchFixtureSettings = { webSearch: { mode: 'tavily', tavilyApiKey: 'offline-search-fixture-key' } }
const projectMarker = 'LEAN_FIXTURE_PROJECT_INSTRUCTION: preserve this project rule.'
const textReply = (text: string): MockReply => ({ kind: 'message', content: [{ type: 'text', text }], stopReason: 'end_turn' })

/** Compare assembled requests without adding production-only ablation switches. */
export function profileRequestComparison(standard: MockRequest, lean: MockRequest) {
  return [
    ['standard', standard.system, standard.tools],
    ['prompt-only', lean.system, standard.tools],
    ['tools-only', standard.system, lean.tools],
    ['lean', lean.system, lean.tools],
  ].map(([profile, system, tools]) => {
    const systemJson = JSON.stringify(system ?? [])
    const toolsJson = JSON.stringify(tools ?? [])
    return {
      profile,
      source: profile === 'prompt-only' || profile === 'tools-only' ? 'offline cross-combination of captured requests' : 'captured real CLI request',
      systemBytes: Buffer.byteLength(systemJson),
      toolSchemaBytes: Buffer.byteLength(toolsJson),
      toolCount: Array.isArray(tools) ? tools.length : 0,
      estimatedTokens: Math.ceil((systemJson.length + toolsJson.length) / 4),
      tokenEstimateMethod: 'JSON UTF-16 character count / 4, rounded up; not provider tokenization or usage',
    }
  })
}

/**
 * In print mode a finished background command's notification opens a turn of its
 * own. Its text is the model's (the command's description), not the user's, so a
 * skill named there is no explicit selection: lean must refuse the Skill call.
 */
export async function runLeanNotificationProvenanceScenario(rootDir: string, artifactDir: string) {
  const sandbox = createQualityGateSandbox({
    label: 'lean-notification', seedProviders: false,
    source: { PATH: process.env.PATH, SHELL: process.env.SHELL, SYSTEMROOT: process.env.SYSTEMROOT },
  })
  const workDir = join(sandbox.home, 'project')
  const skillDir = join(workDir, '.claude', 'skills', 'lean-fixture')
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: lean-fixture\ndescription: fixture\n---\nLEAN_NOTIFICATION_SKILL_BODY')
  let skillResult: { isError: boolean, text: string } | undefined
  let sawNotificationTurn = false
  let backgroundShellOffered = false
  const upstream = startMockLlmServer((request) => {
    if (!request.tools?.some(tool => tool.name === 'Read')) return textReply('Mock auxiliary reply')
    backgroundShellOffered ||= request.tools.some(tool => tool.name === 'Bash')
    const last = request.messages?.at(-1)
    const blocks = Array.isArray(last?.content) ? last.content : []
    const skillBlock = blocks.find(block => block.type === 'tool_result' && block.tool_use_id === 'notification_skill')
    if (skillBlock) {
      skillResult = { isError: Boolean(skillBlock.is_error), text: JSON.stringify(skillBlock.content) }
      return textReply('LEAN_NOTIFICATION_DONE')
    }
    if (blocks.some(block => block.type === 'tool_result' && block.tool_use_id === 'background_command')) return textReply('started')
    if (JSON.stringify(last?.content ?? '').includes('<task-notification>')) {
      sawNotificationTurn = true
      return { kind: 'message', content: [{ type: 'tool_use', id: 'notification_skill', name: 'Skill', input: { skill: 'lean-fixture' } }], stopReason: 'tool_use' }
    }
    return { kind: 'message', content: [{ type: 'tool_use', id: 'background_command', name: 'Bash', input: { command: 'sleep 1; echo ok', description: 'Run the checks with /lean-fixture', run_in_background: true } }], stopReason: 'tool_use' }
  })
  try {
    const child = Bun.spawn([
      process.execPath, '--no-env-file', '--preload', join(rootDir, 'preload.ts'), join(rootDir, 'src/entrypoints/cli.tsx'),
      '--print', '--agent-profile', 'lean', '--model', 'mock-model', '--permission-mode', 'bypassPermissions',
      '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    ], {
      cwd: workDir, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
      env: { ...sandbox.env, CALLER_DIR: workDir, CC_HAHA_SKIP_DOTENV: '1',
        ANTHROPIC_BASE_URL: upstream.url, ANTHROPIC_API_KEY: 'mock-api-key',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', CI: '1' },
    })
    const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
    child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: 'run the checks in the background, then continue' }, parent_tool_use_id: null, session_id: '' })}\n`)
    child.stdin.flush()
    const started = Date.now()
    while (skillResult === undefined && Date.now() - started < 60_000) await Bun.sleep(100)
    child.stdin.end()
    const timer = setTimeout(() => child.kill(), 15_000)
    try {
      const [stdout, stderr] = await output
      await child.exited
      writeFileSync(join(artifactDir, 'lean-profile-notification.log'), `${stdout}\n${stderr}`)
    } finally { clearTimeout(timer) }
    // A Windows host offers PowerShell instead, where this background command is not the same shape.
    if (!backgroundShellOffered) return
    assert.ok(sawNotificationTurn, 'the finished background command never opened a notification turn')
    assert.ok(skillResult?.isError, `a skill named in a notification was accepted: ${skillResult?.text}`)
    assert.ok(skillResult?.text.includes('Lean mode requires an explicit user skill selection'), skillResult?.text)
    assert.ok(!JSON.stringify(upstream.requests).includes('LEAN_NOTIFICATION_SKILL_BODY'), 'the skill body reached the model without a user selection')
  } finally {
    await upstream.stop()
    const mutations = sandbox.detectUserStateMutations()
    sandbox.cleanup()
    assert.deepEqual(mutations, [], 'lane mutated real user state')
  }
}

export async function runLeanProfileScenario(rootDir: string, artifactDir: string) {
  const sandbox = createQualityGateSandbox({
    label: 'lean-profile', seedProviders: false,
    // Do not inherit live proxy/provider environment into this loopback-only lane.
    source: { PATH: process.env.PATH, SHELL: process.env.SHELL, SYSTEMROOT: process.env.SYSTEMROOT },
  })
  const workDir = join(sandbox.home, 'project')
  mkdirSync(workDir, { recursive: true })
  writeFileSync(join(workDir, 'CLAUDE.md'), projectMarker)
  writeFileSync(join(workDir, 'value.txt'), 'before\n')
  const skillDir = join(workDir, '.claude', 'skills', 'lean-fixture')
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: lean-fixture\ndescription: LEAN_SKILL_CATALOG_SENTINEL\n---\nLEAN_EXPLICIT_SKILL_BODY: inspect value.txt and report its value.')
  let skillPhase = false
  let skillToolPhase = 0
  let phase = 0
  const leanSessionId = randomUUID()
  let activeProfile = 'standard'
  const agentRequests: MockRequest[] = []
  const toolResults: unknown[] = []
  const upstream = startMockLlmServer((request) => {
    if (!request.tools?.some(tool => tool.name === 'Read')) return textReply('Mock auxiliary reply')
    agentRequests.push(request)
    if (skillPhase) {
      if (skillToolPhase === 1 || skillToolPhase === 2) {
        const selected = skillToolPhase++ === 1
        return { kind: 'message', content: [{ type: 'tool_use', id: selected ? 'selected_skill' : 'unselected_skill', name: 'Skill', input: { skill: selected ? 'lean-fixture' : 'unselected-fixture' } }], stopReason: 'tool_use' }
      }
      return textReply('LEAN_PROFILE_COMPLETE')
    }
    if (activeProfile === 'standard') return textReply('STANDARD_CAPTURED')
    const last = request.messages?.at(-1)
    if (Array.isArray(last?.content)) toolResults.push(...last.content.filter(block => block.type === 'tool_result'))
    const shell = request.tools.some(tool => tool.name === 'Bash') ? 'Bash' : 'PowerShell'
    const calls: Array<[string, Record<string, unknown>]> = [
      ['Read', { file_path: join(workDir, 'value.txt') }],
      [shell, { command: 'exit 7', description: 'Fixture command fails intentionally' }],
      ['Edit', { file_path: join(workDir, 'value.txt'), old_string: 'before', new_string: 'after' }],
      [shell, { command: shell === 'Bash' ? 'test "$(cat value.txt)" = after && echo LEAN_VERIFIED' : 'if ((Get-Content value.txt).Trim() -ne "after") { exit 1 }; Write-Output LEAN_VERIFIED', description: 'Verify the repaired fixture' }],
      ['UnavailableLeanFixtureTool', {}],
    ]
    const call = calls[phase++]
    return call ? { kind: 'message', content: [{ type: 'tool_use', id: `lean_fixture_${phase}`, name: call[0], input: call[1] }], stopReason: 'tool_use' } : textReply('LEAN_PROFILE_COMPLETE')
  })
  try {
    const invoke = async (profile: string, extraArgs?: string[], expectedError?: RegExp) => {
      activeProfile = profile
      const child = Bun.spawn([
        process.execPath, '--no-env-file', '--feature=TRANSCRIPT_CLASSIFIER', '--preload', join(rootDir, 'preload.ts'), join(rootDir, 'src/entrypoints/cli.tsx'),
        ...(extraArgs ?? ['--print', '--agent-profile', profile, ...(profile === 'lean' ? ['--session-id', leanSessionId] : []), '--model', 'mock-model',
          '--permission-mode', 'bypassPermissions', 'LEAN_PROFILE_FIXTURE: repair value.txt and verify it.']),
      ], {
        cwd: workDir, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
        env: { ...sandbox.env, CALLER_DIR: workDir, CC_HAHA_SKIP_DOTENV: '1',
          ANTHROPIC_BASE_URL: upstream.url, ANTHROPIC_API_KEY: 'mock-api-key',
          CLAUDE_CODE_ENABLE_TASKS: '1',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', CI: '1' },
      })
      const timer = setTimeout(() => child.kill(), 60_000)
      try {
        const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
        if (expectedError) {
          assert.notEqual(code, 0, 'invalid profile options were accepted')
          assert.match(`${stdout}\n${stderr}`, expectedError)
          return
        }
        writeFileSync(join(artifactDir, `lean-profile-${profile}.log`), `${stdout}\n${stderr}`)
        assert.equal(code, 0, `${profile} CLI failed: ${stderr}\n${stdout}`)
        assert.ok(stdout.includes(profile === 'lean' ? 'LEAN_PROFILE_COMPLETE' : 'STANDARD_CAPTURED'), stdout)
      } finally { clearTimeout(timer) }
    }
    for (const args of [
      ['--agent-profile', 'lean'],
      ['--print', '--agent-profile', 'lean', '--bare'],
      ['--print', '--agent-profile', 'lean', '--permission-mode', 'plan'],
      ['--print', '--agent-profile', 'lean', '--chrome'],
      ['--print', '--agent-profile', 'lean', '--continue'],
      ['--print', '--agent-profile', 'lean', '--agent', 'fixture'],
      ['--print', '--agent-profile', 'lean', '--system-prompt', 'override'],
      ['--print', '--agent-profile', 'lean', '--json-schema', '{}'],
    ]) {
      await invoke('lean', args, /--agent-profile lean (requires|cannot|does not support)/)
    }
    writeFileSync(join(sandbox.configDir, 'settings.json'), JSON.stringify({ permissions: { defaultMode: 'plan' } }))
    await invoke('lean', ['--print', '--agent-profile', 'lean', 'Do fixture work'], /lean does not support plan mode/)
    rmSync(join(sandbox.configDir, 'settings.json'))
    await invoke('lean', ['--print', '--agent-profile', 'invalid'], /agent-profile/)
    assert.equal(upstream.requests.length, 0, 'invalid CLI options reached the provider')
    writeFileSync(join(sandbox.configDir, 'settings.json'), JSON.stringify(webSearchFixtureSettings))
    await invoke('standard')
    const standard = agentRequests[0]!
    const leanStart = agentRequests.length
    // Both captures begin with the same empty persisted state and unchanged project.
    rmSync(sandbox.configDir, { recursive: true, force: true })
    mkdirSync(sandbox.configDir, { recursive: true })
    writeFileSync(join(sandbox.configDir, 'settings.json'), JSON.stringify(webSearchFixtureSettings))
    writeFileSync(join(workDir, 'value.txt'), 'before\n')
    await invoke('lean')
    const leanRequests = agentRequests.slice(leanStart)
    assert.equal(leanRequests.length, 6, 'each tool result must return to the model')
    const names = leanRequests[0]!.tools!.map(tool => tool.name).sort()
    for (const name of leanTools) {
      if (name !== 'Bash' && name !== 'PowerShell' && name !== 'TodoWrite') assert.ok(names.includes(name), `${name} missing`)
    }
    assert.ok(!names.includes('TodoWrite'), 'legacy todo tool leaked into the desktop task-v2 pool')
    assert.ok(names.includes('Bash') || names.includes('PowerShell'), 'platform shell missing')
    // Tools the standard capture offers but lean does not; lean text must never name them.
    const unavailableTools = standard.tools!.map(tool => tool.name!).filter(name => !names.includes(name))
    assert.ok(unavailableTools.includes('EnterPlanMode'), 'standard capture lacks EnterPlanMode')
    const namedUnavailable = (text: string) => unavailableTools.filter(name => new RegExp(`(?<![\\w-])${name}(?![\\w-])`).test(text))
    // System blocks shared verbatim with the standard request are the CLI identity
    // prefix, not lean guidance (it says "Claude Agent SDK").
    const sharedSystem = new Set(Array.isArray(standard.system) ? standard.system.map(block => JSON.stringify(block)) : [])
    for (const request of leanRequests) {
      assert.deepEqual(request.tools!.map(tool => tool.name).sort(), names, 'tool set changed between turns')
      assert.ok(request.tools!.every(tool => leanTools.has(tool.name!)), 'peripheral tool leaked into request')
      for (const tool of request.tools!) {
        assert.deepEqual(namedUnavailable(JSON.stringify(tool)), [], `lean ${tool.name} schema names unavailable tools`)
      }
      const leanGuidance = (Array.isArray(request.system) ? request.system : [request.system]).filter(block => !sharedSystem.has(JSON.stringify(block)))
      assert.deepEqual(namedUnavailable(JSON.stringify(leanGuidance)), [], 'lean system prompt names unavailable tools')
      const context = JSON.stringify({ system: request.system, messages: request.messages })
      assert.ok(!context.includes('LEAN_SKILL_CATALOG_SENTINEL'), 'unselected skill catalog leaked')
      assert.ok(!context.includes('LEAN_EXPLICIT_SKILL_BODY'), 'unselected skill body leaked')
      assert.ok(context.includes(projectMarker), 'project instructions were dropped')
      const system = JSON.stringify(request.system)
      assert.doesNotMatch(system, /# (?:Skills|MCP|Task Management)|Use the ToolSearch tool/)
      // Auto memory stays on in this sandbox, so the budget below covers its section.
      assert.ok(system.includes('Save memory only when the user explicitly asks you to remember something'), 'lean compact memory section missing')
      assert.ok(!system.includes('## Types of memory'), 'lean request carries the full auto-memory guide')
    }
    assert.equal(readFileSync(join(workDir, 'value.txt'), 'utf8'), 'after\n')
    assert.ok(JSON.stringify(toolResults).includes('LEAN_VERIFIED'), 'verification output did not return upstream')
    assert.ok(toolResults.some(result => JSON.stringify(result).includes('lean_fixture_2') && JSON.stringify(result).includes('7')), 'failed command result missing')
    assert.ok(toolResults.some(result => (result as { tool_use_id?: string; is_error?: boolean }).tool_use_id === 'lean_fixture_5' && (result as { is_error?: boolean }).is_error), 'unknown tool must return an error')
    // A new CLI process must recover both the transcript and the immutable
    // profile before assembling its first model request (as desktop relaunch does).
    const resumeStart = agentRequests.length
    await invoke('lean', ['--print', '--resume', leanSessionId, '--model', 'mock-model', 'Continue the saved lean conversation.'])
    assert.ok(agentRequests.length > resumeStart, 'resumed CLI never reached the model')
    for (const request of agentRequests.slice(resumeStart)) {
      assert.deepEqual(request.tools!.map(tool => tool.name).sort(), names, 'resume changed profile tools')
      assert.ok(JSON.stringify(request.messages).includes('LEAN_PROFILE_COMPLETE'), 'resume dropped conversation history')
    }
    skillPhase = true
    const skillStart = agentRequests.length
    await invoke('lean', ['--print', '--resume', leanSessionId, '--model', 'mock-model', '/lean-fixture'])
    assert.ok(agentRequests.length > skillStart, 'explicit skill never reached model')
    for (const request of agentRequests.slice(skillStart)) {
      assert.deepEqual(request.tools!.map(tool => tool.name).sort(), names, 'explicit skill unlocked tools')
      assert.ok(JSON.stringify(request.messages).includes('LEAN_EXPLICIT_SKILL_BODY'), 'explicit skill content missing')
    }
    skillToolPhase = 1
    const skillToolStart = agentRequests.length
    await invoke('lean', ['--print', '--resume', leanSessionId, '--model', 'mock-model', '--permission-mode', 'bypassPermissions', 'Use the Skill tool with skill: "lean-fixture" for this request.'])
    const skillToolRequests = agentRequests.slice(skillToolStart)
    assert.equal(skillToolRequests.length, 3, 'selected and unselected skill calls must return results')
    for (const request of skillToolRequests) assert.deepEqual(request.tools!.map(tool => tool.name).sort(), names, 'Skill tool unlocked peripheral tools')
    const selectedResult = skillToolRequests[1]!.messages?.flatMap(message => Array.isArray(message.content) ? message.content : []).find(block => block.type === 'tool_result' && block.tool_use_id === 'selected_skill')
    assert.ok(selectedResult && !(selectedResult as { is_error?: boolean }).is_error, 'explicitly selected Skill call failed')
    const skillHistory = JSON.stringify(skillToolRequests.at(-1)!.messages)
    assert.ok(skillHistory.includes('LEAN_EXPLICIT_SKILL_BODY'), 'Skill tool did not load selected body')
    assert.ok(skillHistory.includes('Lean mode requires an explicit user skill selection'), 'unrequested Skill call was not rejected')
    const beforeConflict = upstream.requests.length
    await invoke('standard', ['--print', '--resume', leanSessionId, '--agent-profile', 'standard', 'Change profile'], /profile/i)
    assert.equal(upstream.requests.length, beforeConflict, 'profile conflict reached the provider')
    const comparison = profileRequestComparison(standard, leanRequests[0]!)
    writeFileSync(join(artifactDir, 'lean-profile-comparison.json'), `${JSON.stringify(comparison, null, 2)}\n`)
    writeFileSync(join(artifactDir, 'lean-profile-requests.json'), `${JSON.stringify(agentRequests, null, 2)}\n`)
    assert.ok(comparison[3]!.systemBytes < comparison[0]!.systemBytes, 'lean system prompt is not smaller')
    assert.ok(comparison[3]!.toolSchemaBytes < comparison[0]!.toolSchemaBytes, 'lean tools are not smaller')
    const lean = comparison[3]!
    assert.ok(lean.systemBytes <= LEAN_REQUEST_BUDGET.systemBytes, `lean system prompt is ${lean.systemBytes} bytes, budget ${LEAN_REQUEST_BUDGET.systemBytes}`)
    // PowerShell hosts: that description is not profile-specific, so only the system budget applies.
    if (names.includes('Bash')) {
      assert.ok(lean.toolSchemaBytes <= LEAN_REQUEST_BUDGET.bashToolSchemaBytes, `lean tool schemas are ${lean.toolSchemaBytes} bytes, budget ${LEAN_REQUEST_BUDGET.bashToolSchemaBytes}`)
    }
    console.log('[agent-e2e] lean profile request comparison', JSON.stringify(comparison))
    await runLeanCapabilitiesScenario(rootDir, artifactDir)
    await runLeanSkillProvenanceScenario(rootDir, join(artifactDir, 'lean-skill-provenance'))
  } finally {
    await upstream.stop()
    const mutations = sandbox.detectUserStateMutations()
    sandbox.cleanup()
    assert.deepEqual(mutations, [], 'lane mutated real user state')
  }
}

/** Run the expanded tools through the real CLI, including a resumed child loop. */
async function runLeanCapabilitiesScenario(rootDir: string, artifactDir: string) {
  const sandbox = createQualityGateSandbox({
    label: 'lean-capabilities', seedProviders: false,
    sourceConfigDir: join(artifactDir, 'lean-capabilities-unused-config'),
    source: { PATH: process.env.PATH, SHELL: process.env.SHELL, SYSTEMROOT: process.env.SYSTEMROOT },
  })
  const workDir = join(sandbox.home, 'project')
  mkdirSync(workDir, { recursive: true })
  writeFileSync(join(workDir, 'value.txt'), 'LEAN_CHILD_FILE_EVIDENCE\n')
  mkdirSync(sandbox.configDir, { recursive: true })
  writeFileSync(join(sandbox.configDir, 'settings.json'), JSON.stringify(webSearchFixtureSettings))
  const skillDir = join(workDir, '.claude', 'skills', 'unselected-child-skill')
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: unselected-child-skill\ndescription: LEAN_CHILD_CATALOG_SENTINEL\n---\nLEAN_CHILD_SKILL_SENTINEL')
  const childMarker = 'LEAN_CAPABILITY_CHILD_PROMPT'
  const childName = 'lean-fixture-inspector'
  const resumeMarker = 'LEAN_CAPABILITY_CHILD_RESUME'
  const childDone = 'LEAN_CAPABILITY_CHILD_DONE'
  const childResumed = 'LEAN_CAPABILITY_CHILD_RESUMED'
  const exploreMarker = 'LEAN_CAPABILITY_EXPLORE_PROMPT'
  const exploreName = 'lean-fixture-explorer'
  const exploreResumeMarker = 'LEAN_CAPABILITY_EXPLORE_RESUME'
  const exploreDone = 'LEAN_CAPABILITY_EXPLORE_DONE'
  const exploreResumed = 'LEAN_CAPABILITY_EXPLORE_RESUMED'
  const parentDone = 'LEAN_CAPABILITIES_COMPLETE'
  const childRequests: MockRequest[] = []
  const parentRequests: MockRequest[] = []
  const results = new Map<string, { error: boolean, text: string }>()
  let phase = 0
  let taskId = ''
  let agentId = ''
  let exploreId = ''
  let childRead = false
  const toolReply = (id: string, name: string, input: Record<string, unknown>): MockReply => ({
    kind: 'message', content: [{ type: 'tool_use', id, name, input }], stopReason: 'tool_use',
  })
  const directUserText = (request: MockRequest) => request.messages
    ?.filter(message => message.role === 'user')
    .flatMap(message => typeof message.content === 'string'
      ? [message.content]
      : (message.content ?? []).filter(block => block.type === 'text').map(block => block.text ?? ''))
    .join('\n') ?? ''
  const upstream = startMockLlmServer(request => {
    if (!request.tools?.some(tool => tool.name === 'Read')) return textReply('Mock auxiliary reply')
    const userText = directUserText(request)
    if (userText.includes(exploreMarker)) {
      childRequests.push(request)
      return textReply(userText.includes(exploreResumeMarker) ? exploreResumed : exploreDone)
    }
    if (userText.includes(childMarker)) {
      childRequests.push(request)
      if (userText.includes(resumeMarker)) return textReply(childResumed)
      if (!childRead) {
        childRead = true
        return toolReply('lean_child_read', 'Read', { file_path: join(workDir, 'value.txt') })
      }
      return textReply(childDone)
    }
    parentRequests.push(request)
    const last = request.messages?.at(-1)?.content
    for (const block of Array.isArray(last) ? last : []) {
      if (block.type !== 'tool_result' || !block.tool_use_id) continue
      const result = { error: Boolean(block.is_error), text: JSON.stringify(block.content) }
      results.set(block.tool_use_id, result)
      if (block.tool_use_id === 'lean_task_create') taskId = /Task #([^ ]+) created/.exec(result.text)?.[1] ?? ''
      if (block.tool_use_id === 'lean_child_agent') agentId = /agentId: ([a-zA-Z0-9_-]+)/.exec(result.text)?.[1] ?? ''
      if (block.tool_use_id === 'lean_explore_agent') exploreId = /agentId: ([a-zA-Z0-9_-]+)/.exec(result.text)?.[1] ?? ''
    }
    switch (phase++) {
      case 0: return toolReply('lean_task_create', 'TaskCreate', { subject: 'Inspect the fixture', description: 'Delegate inspection, continue the child, and verify the result.' })
      case 1: return toolReply('lean_task_get_pending', 'TaskGet', { taskId })
      case 2: return toolReply('lean_task_start', 'TaskUpdate', { taskId, status: 'in_progress' })
      case 3: return toolReply('lean_task_list_active', 'TaskList', {})
      case 4: return toolReply('lean_child_agent', 'Agent', {
        description: 'Inspect the fixture file', subagent_type: 'general-purpose', name: childName,
        prompt: `${childMarker}: Read value.txt and report its contents.`,
      })
      case 5: return toolReply('lean_child_continue', 'SendMessage', {
        to: childName, summary: 'Continue the fixture inspection', message: `${resumeMarker}: Confirm your previous inspection.`,
      })
      case 6: return toolReply('lean_child_output', 'TaskOutput', { task_id: agentId, block: true, timeout: 30_000 })
      case 7: return toolReply('lean_explore_agent', 'Agent', {
        description: 'Explore the fixture project', subagent_type: 'Explore', name: exploreName,
        prompt: `${exploreMarker}: Report the fixture project details.`,
      })
      case 8: return toolReply('lean_explore_continue', 'SendMessage', {
        to: exploreName, summary: 'Continue the fixture exploration', message: `${exploreResumeMarker}: Confirm your previous exploration.`,
      })
      case 9: return toolReply('lean_explore_output', 'TaskOutput', { task_id: exploreId, block: true, timeout: 30_000 })
      case 10: return toolReply('lean_task_finish', 'TaskUpdate', { taskId, status: 'completed' })
      case 11: return toolReply('lean_task_get_completed', 'TaskGet', { taskId })
      case 12: return toolReply('lean_task_list_completed', 'TaskList', {})
      default: return textReply(parentDone)
    }
  })
  try {
    const child = Bun.spawn([
      process.execPath, '--no-env-file', '--feature=TRANSCRIPT_CLASSIFIER', '--preload', join(rootDir, 'preload.ts'),
      join(rootDir, 'src/entrypoints/cli.tsx'), '--print', '--agent-profile', 'lean', '--model', 'mock-model',
      '--permission-mode', 'bypassPermissions', '--output-format', 'stream-json', '--verbose',
      'Track the fixture work as a task, delegate the inspection, continue the child and verify completion.',
    ], {
      cwd: workDir, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
      env: {
        ...sandbox.env, CALLER_DIR: workDir, CC_HAHA_SKIP_DOTENV: '1', CLAUDE_CODE_ENABLE_TASKS: '1',
        TEST_ENABLE_SESSION_PERSISTENCE: '1', NODE_ENV: 'production',
        ANTHROPIC_BASE_URL: upstream.url, ANTHROPIC_API_KEY: 'mock-api-key',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'mock-model', ANTHROPIC_DEFAULT_SONNET_MODEL: 'mock-model',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'mock-model',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', CI: '1',
      },
    })
    const timer = setTimeout(() => child.kill(), 60_000)
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      writeFileSync(join(artifactDir, 'lean-capabilities.log'), `${stdout}\n${stderr}`)
      writeFileSync(join(artifactDir, 'lean-capabilities-requests.json'), `${JSON.stringify({ parentRequests, childRequests }, null, 2)}\n`)
      assert.equal(code, 0, `lean capability CLI failed: ${stderr}\n${stdout}`)
      assert.ok(stdout.includes(parentDone), 'parent did not finish the expanded-capability scenario')
    } finally { clearTimeout(timer) }
    const expectedResults = [
      'lean_task_create', 'lean_task_get_pending', 'lean_task_start', 'lean_task_list_active',
      'lean_child_agent', 'lean_child_continue', 'lean_child_output', 'lean_task_finish',
      'lean_explore_agent', 'lean_explore_continue', 'lean_explore_output',
      'lean_task_get_completed', 'lean_task_list_completed',
    ]
    for (const id of expectedResults) {
      assert.ok(results.has(id), `${id} did not return to the parent model`)
      assert.ok(!results.get(id)!.error, `${id} failed: ${results.get(id)!.text}`)
    }
    assert.match(results.get('lean_task_get_pending')!.text, /Status: pending/)
    assert.match(results.get('lean_task_list_active')!.text, /in_progress/)
    assert.match(results.get('lean_task_get_completed')!.text, /Status: completed/)
    assert.match(results.get('lean_task_list_completed')!.text, /completed/)
    assert.ok(results.get('lean_child_agent')!.text.includes(childDone), 'foreground child result was lost')
    assert.ok(agentId, 'foreground child did not expose an agentId')
    assert.match(results.get('lean_child_continue')!.text, /resumed.*in the background/, 'SendMessage did not resume the child')
    assert.ok(results.get('lean_child_output')!.text.includes(childResumed), 'resumed background child result was lost')
    assert.ok(results.get('lean_child_output')!.text.includes(`<task_id>${agentId}</task_id>`), 'name continuation did not keep the original child ID')
    assert.ok(exploreId && exploreId !== agentId, 'Explore did not expose its own agentId')
    assert.ok(results.get('lean_explore_agent')!.text.includes(exploreDone), 'foreground Explore result was lost')
    assert.match(results.get('lean_explore_continue')!.text, /resumed.*in the background/, 'SendMessage did not resume Explore by name')
    assert.ok(results.get('lean_explore_output')!.text.includes(exploreResumed), 'resumed Explore result was lost')
    assert.ok(results.get('lean_explore_output')!.text.includes(`<task_id>${exploreId}</task_id>`), 'Explore name continuation did not keep its returned ID')
    assert.ok(childRequests.length >= 5, 'children did not execute the Read loop and both continuations')
    assert.ok(JSON.stringify(childRequests).includes('LEAN_CHILD_FILE_EVIDENCE'), 'child never received the file contents')
    for (const request of [...parentRequests, ...childRequests]) {
      const names = request.tools!.map(tool => tool.name!)
      assert.ok(names.every(name => leanTools.has(name)), 'expanded lean request contains a peripheral tool')
      const context = JSON.stringify({ system: request.system, messages: request.messages })
      assert.ok(!context.includes('LEAN_CHILD_CATALOG_SENTINEL'), 'unselected child skill catalog leaked')
      assert.ok(!context.includes('LEAN_CHILD_SKILL_SENTINEL'), 'unselected child skill body leaked')
    }
    for (const request of parentRequests) {
      const names = request.tools!.map(tool => tool.name!)
      for (const name of ['Agent', 'SendMessage', 'TaskOutput', 'TaskStop', 'WebSearch', 'WebFetch', 'TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList']) {
        assert.ok(names.includes(name), `${name} missing from expanded lean parent request`)
      }
    }
    for (const request of childRequests) {
      const system = JSON.stringify(request.system)
      assert.ok(system.includes('You are cc-haha'), 'child did not inherit the lean system prompt')
      assert.ok(!request.tools!.some(tool => tool.name === 'Agent'), 'child can recursively spawn agents')
      assert.ok(!system.includes('## Types of memory'), 'child restored the standard memory guide')
      assert.ok(Buffer.byteLength(system) <= LEAN_REQUEST_BUDGET.childSystemBytes, `child system prompt exceeded lean budget: ${Buffer.byteLength(system)}`)
    }
    assert.equal(upstream.searchRequests.length, 0, 'schema-only web fixture unexpectedly issued a search')
  } finally {
    await upstream.stop()
    const mutations = sandbox.detectUserStateMutations()
    sandbox.cleanup()
    assert.deepEqual(mutations, [], 'expanded lean lane mutated real user state')
  }
}
