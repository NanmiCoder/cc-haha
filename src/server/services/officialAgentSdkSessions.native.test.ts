import { expect, test } from 'bun:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createSandboxedTestEnvironment } from '../../../scripts/pr/test-environment.js'
import { startMockLlmServer } from '../../../scripts/quality-gate/mock-llm/server.js'

test('official native SDK resumes desktop branches, ephemeral fixed-boundary side chats, and rewound history', async () => {
  const sandbox = await realpath(await mkdtemp(join(tmpdir(), 'cc-haha-sdk-session-features-')))
  const root = resolve(import.meta.dir, '../../..')
  const model = startMockLlmServer(() => ({ kind: 'message', stopReason: 'end_turn', content: [{ type: 'text', text: 'OFFLINE_NATIVE_SESSION_OK' }] }))
  const env = createSandboxedTestEnvironment(sandbox, {
    ANTHROPIC_API_KEY: 'fake-offline-sdk-key', ANTHROPIC_BASE_URL: model.url,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
    HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', ALL_PROXY: 'http://127.0.0.1:1',
    NO_PROXY: '127.0.0.1,localhost,::1', no_proxy: '127.0.0.1,localhost,::1',
  })
  const fixture = `
    import assert from 'node:assert/strict'
    import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises'
    import { join } from 'node:path'
    const root = ${JSON.stringify(root)}
    const { query } = await import(root + '/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs')
    const { sessionService } = await import(root + '/src/server/services/sessionService.ts')
    const { createOfficialAgentSdkBranch } = await import(root + '/src/server/services/officialAgentSdkSessions.ts')
    const { markAgentSdkSession, readConversationRuntime } = await import(root + '/src/server/services/officialAgentSdkRuntime.ts')
    const workDir = join(process.env.HOME, 'project')
    await mkdir(workDir)
    async function turn(prompt, launch) {
      const stream = query({ prompt, options: { cwd: workDir, env: process.env, model: 'claude-haiku-5-5', tools: [], settingSources: [], maxTurns: 1, ...launch } })
      let result
      try { for await (const event of stream) if (event.type === 'result') result = event }
      finally { stream.close() }
      assert.equal(result?.subtype, 'success', JSON.stringify(result))
      assert.equal(result.result, 'OFFLINE_NATIVE_SESSION_OK')
    }
    const sessionId = crypto.randomUUID()
    await turn('OFFLINE_PARENT_FIRST', { sessionId })
    markAgentSdkSession(process.env.CLAUDE_CONFIG_DIR, sessionId)
    const launchInfo = await sessionService.getSessionLaunchInfo(sessionId)
    assert.ok(launchInfo)
    await sessionService.appendSessionMetadata(sessionId, { workDir, runtimeProviderId: 'fixture-sdk', runtimeModelId: 'claude-haiku-5-5', effortLevel: 'low' })
    const rows = text => text.trim().split('\\n').map(line => JSON.parse(line))
    const firstRecords = rows(await readFile(launchInfo.filePath, 'utf8'))
    const firstAssistant = firstRecords.findLast(entry => entry.type === 'assistant')
    assert.ok(firstAssistant?.uuid)
    await turn('OFFLINE_PARENT_SECOND_EXCLUDED', { resume: sessionId })
    const parent = await readFile(launchInfo.filePath, 'utf8')
    const parentRows = rows(parent)
    const secondUser = parentRows.find(entry => entry.type === 'user' && JSON.stringify(entry.message).includes('OFFLINE_PARENT_SECOND_EXCLUDED'))
    assert.ok(secondUser?.uuid)
    const branch = await createOfficialAgentSdkBranch({ sourceSessionId: sessionId, launchInfo: await sessionService.getSessionLaunchInfo(sessionId), targetMessageId: firstAssistant.uuid })
    assert.equal(readConversationRuntime(process.env.CLAUDE_CONFIG_DIR, branch.sessionId), 'agent-sdk')
    await turn('OFFLINE_BRANCH_PROBE', { resume: branch.sessionId })
    assert.equal(await readFile(launchInfo.filePath, 'utf8'), parent)
    const sideId = crypto.randomUUID()
    await turn('OFFLINE_SIDE_PROBE', { resume: launchInfo.filePath, resumeSessionAt: firstAssistant.uuid, forkSession: true, sessionId: sideId, persistSession: false })
    assert.equal(await readFile(launchInfo.filePath, 'utf8'), parent)
    const files = await readdir(join(process.env.CLAUDE_CONFIG_DIR, 'projects'), { recursive: true })
    assert.equal(files.some(file => String(file).includes(sideId)), false)
    const hiddenUuid = crypto.randomUUID()
    await appendFile(launchInfo.filePath, JSON.stringify({ type: 'attachment', uuid: hiddenUuid, parentUuid: parentRows.findLast(entry => entry.type === 'assistant').uuid, sessionId, timestamp: new Date().toISOString(), attachment: { type: 'queued_command', prompt: 'OFFLINE_HIDDEN_REMOVED' } }) + '\\n')
    await sessionService.trimSessionMessagesFrom(sessionId, secondUser.uuid)
    const trimmed = await readFile(launchInfo.filePath, 'utf8')
    assert.equal(trimmed.includes(hiddenUuid), false)
    assert.equal(trimmed.includes('OFFLINE_PARENT_SECOND_EXCLUDED'), false, JSON.stringify(rows(trimmed).filter(entry => JSON.stringify(entry).includes('OFFLINE_PARENT_SECOND_EXCLUDED'))))
    assert.equal((await sessionService.getSessionLaunchInfo(sessionId)).runtimeProviderId, 'fixture-sdk')
    assert.equal(readConversationRuntime(process.env.CLAUDE_CONFIG_DIR, sessionId), 'agent-sdk')
    await turn('OFFLINE_REWIND_PROBE', { resume: sessionId })
    const legacy = await sessionService.createSession(workDir)
    const legacyInfo = await sessionService.getSessionLaunchInfo(legacy.sessionId)
    const legacyIds = Array.from({ length: 4 }, () => crypto.randomUUID())
    const legacyContent = [
      [{ type: 'text', text: 'LEGACY_IMPORT_CONTEXT' }],
      [{ type: 'thinking', thinking: 'old provider private thought', signature: 'NOT_A_NATIVE_SIGNATURE' }, { type: 'tool_use', id: 'old-tool', name: 'Write', input: { file_path: join(workDir, 'must-not-replay.txt'), content: 'DO_NOT_EXECUTE' } }],
      [{ type: 'tool_result', tool_use_id: 'old-tool', content: 'LEGACY_HISTORICAL_TOOL_RESULT' }],
      [{ type: 'text', text: 'LEGACY_FINAL_REPLY' }],
    ]
    await appendFile(legacyInfo.filePath, legacyIds.map((uuid, i) => JSON.stringify({
      type: i % 2 ? 'assistant' : 'user', uuid, parentUuid: i ? legacyIds[i - 1] : null,
      sessionId: legacy.sessionId, timestamp: new Date(Date.now() + i).toISOString(), cwd: workDir, isSidechain: false,
      message: { role: i % 2 ? 'assistant' : 'user', ...(i % 2 ? { id: 'old-assistant-' + i, type: 'message', model: 'legacy-provider', stop_reason: i === 1 ? 'tool_use' : 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } : {}), content: legacyContent[i] },
    })).join('\\n') + '\\n')
    const legacyOriginal = await readFile(legacyInfo.filePath, 'utf8')
    const imported = await createOfficialAgentSdkBranch({ sourceSessionId: legacy.sessionId, launchInfo: legacyInfo,
      targetMessageId: legacyIds[3], importContext: { providerId: 'fixture-sdk', modelId: 'claude-haiku-5-5', legacy: true } })
    await turn('OFFLINE_IMPORTED_PROBE', { resume: imported.sessionId })
    assert.equal(await readFile(legacyInfo.filePath, 'utf8'), legacyOriginal)
    assert.equal(readConversationRuntime(process.env.CLAUDE_CONFIG_DIR, legacy.sessionId), 'claude-code')
    assert.equal((await readdir(workDir)).includes('must-not-replay.txt'), false)
    console.log('OFFICIAL_SDK_SESSION_FEATURES_OK')
  `
  const child = Bun.spawn([process.execPath, '--no-env-file', '-e', fixture], { cwd: root, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect({ code, stderr: code ? stderr : '' }).toEqual({ code: 0, stderr: '' })
    expect(stdout).toContain('OFFICIAL_SDK_SESSION_FEATURES_OK')
    const prompts = model.requests.map(request => JSON.stringify(request.body.messages))
    for (const probe of ['OFFLINE_BRANCH_PROBE', 'OFFLINE_SIDE_PROBE', 'OFFLINE_REWIND_PROBE']) {
      const request = prompts.find(text => text.includes(probe))
      expect(request).toBeDefined()
      expect(request).toContain('OFFLINE_PARENT_FIRST')
      expect(request).not.toContain('OFFLINE_PARENT_SECOND_EXCLUDED')
      expect(request).not.toContain('OFFLINE_HIDDEN_REMOVED')
    }
    const importedRequest = prompts.find(text => text.includes('OFFLINE_IMPORTED_PROBE'))
    expect(importedRequest).toContain('LEGACY_IMPORT_CONTEXT')
    expect(importedRequest).toContain('LEGACY_HISTORICAL_TOOL_RESULT')
    expect(importedRequest).toContain('LEGACY_FINAL_REPLY')
    expect(importedRequest).not.toContain('NOT_A_NATIVE_SIGNATURE')
  } finally {
    if (child.exitCode === null) { child.kill(); await child.exited }
    await model.stop()
    await rm(sandbox, { recursive: true, force: true })
  }
}, 60_000)
