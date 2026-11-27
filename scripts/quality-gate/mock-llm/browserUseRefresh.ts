import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createQualityGateSandbox } from '../sandbox'
import { startMockLlmServer } from './server'
import type { MockReply, MockRequest } from './scriptedModel'

const BROWSER_TOOL_NAMES = [
  'BrowserTabs',
  'BrowserNavigate',
  'BrowserSnapshot',
  'BrowserAct',
  'BrowserInspect',
  'BrowserTakeover',
] as const

const textReply = (text: string): MockReply => ({
  kind: 'message',
  content: [{ type: 'text', text }],
  stopReason: 'end_turn',
})

/**
 * Deterministic mock-LLM E2E scenario proving:
 * 1. Prewarmed CLI starts with 0 Browser Use tools when disabled (0 tokens).
 * 2. Enabling Browser Use in `browser-use-config.json` exposes all 6 native
 *    Browser* tools AND the bundled `browser-use` skill on the very next turn
 *    without restarting the CLI.
 * 3. Executing BrowserSnapshot -> BrowserTakeover routes through the loopback
 *    desktop server with X-Session-Id + Bearer auth, attaches image blocks,
 *    and cleanly pauses the turn on BrowserTakeover without clearing takeover
 *    in stopHooks cleanup.
 * 4. Toggling Browser Use OFF removes all 6 tools on the next turn (0 tokens).
 * 5. `--agent-profile lean` never exposes Browser Use tools even when enabled.
 */
export async function runBrowserUseRefreshScenario(
  rootDir: string,
  artifactDir: string,
): Promise<void> {
  mkdirSync(artifactDir, { recursive: true })
  const sandbox = createQualityGateSandbox({
    label: 'browser-use-refresh',
    seedProviders: false,
    source: {
      PATH: process.env.PATH,
      SHELL: process.env.SHELL,
      SYSTEMROOT: process.env.SYSTEMROOT,
    },
  })

  const workDir = join(sandbox.home, 'project')
  const configPath = join(sandbox.configDir, 'cc-haha', 'browser-use-config.json')
  mkdirSync(workDir, { recursive: true })
  mkdirSync(join(sandbox.configDir, 'cc-haha'), { recursive: true })

  const setEnabled = (enabled: boolean) => {
    writeFileSync(
      configPath,
      JSON.stringify({
        enabled,
        preferredTarget: 'workspace',
        showCursorOverlay: true,
        autoOpenWorkspacePanel: true,
        managedChromeHeadless: false,
      }),
    )
  }

  // Loopback fake desktop bridge endpoint to capture real CLI tool HTTP calls
  const bridgeCalls: Array<{
    action: string
    sessionId: string | null
    authorization: string | null
    origin: string | null
    body: Record<string, unknown>
  }> = []
  const fakeDesktopServer = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const match = /^\/api\/browser-use\/([^/]+)$/.exec(url.pathname)
      if (!match || req.method !== 'POST') {
        return new Response('Not Found', { status: 404 })
      }
      const action = match[1]!
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
      bridgeCalls.push({
        action,
        sessionId: req.headers.get('x-session-id'),
        authorization: req.headers.get('authorization'),
        origin: req.headers.get('origin'),
        body,
      })

      if (action === 'snapshot') {
        return Response.json({
          tabId: 'tab-e2e-1',
          target: 'workspace',
          url: 'http://127.0.0.1:5173/login',
          title: 'Demo App Login',
          frameId: 'frame-1',
          loaderId: 'loader-1',
          refCount: 2,
          refs: [],
          treeText: '@e1 textbox "Email"\n@e2 button "Sign in"',
          screenshotDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
        })
      }
      if (action === 'takeover') {
        return Response.json({
          takeoverId: 'tk-e2e-1',
          tabId: 'tab-e2e-1',
          target: 'workspace',
          reason: body.reason ?? 'login',
          message: body.message ?? 'Please sign in',
          status: 'pending',
          createdAt: Date.now(),
        })
      }
      return Response.json({ ok: true })
    },
  })

  const agentRequests: MockRequest[] = []
  let activeProbe:
    | { kind: 'skill'; issued: boolean; result?: { is_error?: boolean; content?: unknown }; messages?: string }
    | { kind: 'tool-flow'; step: number }
    | undefined

  const upstream = startMockLlmServer(request => {
    if (
      !request.tools?.some(
        tool => tool.name === 'Read' || tool.name === 'BrowserSnapshot',
      )
    ) {
      return textReply('Mock auxiliary reply')
    }
    agentRequests.push(request)

    if (activeProbe?.kind === 'skill') {
      if (!activeProbe.issued) {
        activeProbe.issued = true
        return {
          kind: 'message',
          content: [
            {
              type: 'tool_use',
              id: 'browser_use_skill_call',
              name: 'Skill',
              input: { skill: 'browser-use' },
            },
          ],
          stopReason: 'tool_use',
        }
      }
      activeProbe.result = request.messages
        ?.flatMap(m => (Array.isArray(m.content) ? m.content : []))
        .find(
          block =>
            block.type === 'tool_result' &&
            block.tool_use_id === 'browser_use_skill_call',
        )
      activeProbe.messages = JSON.stringify(request.messages)
      return textReply('BROWSER_USE_SKILL_VERIFIED')
    }

    if (activeProbe?.kind === 'tool-flow') {
      if (activeProbe.step === 0) {
        activeProbe.step = 1
        return {
          kind: 'message',
          content: [
            {
              type: 'tool_use',
              id: 'browser_snapshot_call',
              name: 'BrowserSnapshot',
              input: { screenshot: true },
            },
          ],
          stopReason: 'tool_use',
        }
      }
      if (activeProbe.step === 1) {
        activeProbe.step = 2
        return {
          kind: 'message',
          content: [
            {
              type: 'tool_use',
              id: 'browser_takeover_call',
              name: 'BrowserTakeover',
              input: {
                reason: 'login',
                message: 'Please sign in to Demo App before resuming.',
              },
            },
          ],
          stopReason: 'tool_use',
        }
      }
      return textReply('SHOULD_NOT_REACH_AFTER_TAKEOVER_PAUSE')
    }

    return textReply('BROWSER_USE_INVENTORY_CAPTURED')
  })

  const captures: Array<{
    profile: string
    phase: string
    tools: string[]
  }> = []

  async function runProfile(profile: 'standard' | 'lean') {
    rmSync(configPath, { force: true })
    const child = Bun.spawn(
      [
        process.execPath,
        '--no-env-file',
        '--preload',
        join(rootDir, 'preload.ts'),
        join(rootDir, 'src/entrypoints/cli.tsx'),
        '--print',
        '--agent-profile',
        profile,
        '--model',
        'mock-model',
        '--permission-mode',
        'bypassPermissions',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--verbose',
      ],
      {
        cwd: workDir,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          ...sandbox.env,
          CALLER_DIR: workDir,
          CC_HAHA_SKIP_DOTENV: '1',
          ANTHROPIC_BASE_URL: upstream.url,
          ANTHROPIC_API_KEY: 'mock-api-key',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          DISABLE_AUTOUPDATER: '1',
          CC_HAHA_DESKTOP_SERVER_URL: `http://127.0.0.1:${fakeDesktopServer.port}`,
          CC_HAHA_SESSION_COLLABORATION_TOKEN: 'e2e-sdk-token',
          CC_HAHA_SESSION_ID: `sess-browser-${profile}`,
          CI: '1',
        },
      },
    )

    let stdout = ''
    let stderr = ''
    const results: Array<{ is_error?: boolean; errors?: string[]; result?: string }> = []
    const drainOut = (async () => {
      const decoder = new TextDecoder()
      let pending = ''
      for await (const data of child.stdout) {
        const text = decoder.decode(data, { stream: true })
        stdout += text
        pending += text
        for (;;) {
          const at = pending.indexOf('\n')
          if (at < 0) break
          const line = pending.slice(0, at)
          pending = pending.slice(at + 1)
          if (!line.trim()) continue
          try {
            const msg = JSON.parse(line)
            if (msg.type === 'result') results.push(msg)
          } catch {}
        }
      }
    })()
    const drainErr = (async () => {
      stderr = await new Response(child.stderr).text()
    })()

    async function submit(phase: string, content: string) {
      const before = results.length
      child.stdin.write(
        `${JSON.stringify({
          type: 'user',
          message: { role: 'user', content },
          parent_tool_use_id: null,
          session_id: '',
        })}\n`,
      )
      await child.stdin.flush()
      const deadline = Date.now() + 60_000
      while (
        results.length === before &&
        child.exitCode === null &&
        Date.now() < deadline
      ) {
        await Bun.sleep(20)
      }
      assert.ok(
        results.length > before,
        `CLI did not complete ${phase}: ${stderr}\n${stdout}`,
      )
      return results[before]!
    }

    const killTimer = setTimeout(() => child.kill('SIGKILL'), 120_000)
    try {
      // Phase 1: Disabled on startup (no config file) -> 0 Browser Use tools
      const reqStart1 = agentRequests.length
      const r1 = await submit('disabled-start', 'Report tools for disabled-start.')
      assert.equal(r1.is_error, false)
      const tools1 = agentRequests
        .slice(reqStart1)
        .at(-1)!
        .tools!.map(t => t.name!)
        .sort()
      captures.push({ profile, phase: 'disabled-start', tools: tools1 })
      assert.deepEqual(
        tools1.filter(name => (BROWSER_TOOL_NAMES as readonly string[]).includes(name)),
        [],
        `${profile} leaked Browser Use tools when disabled`,
      )

      // Phase 2: Hot-enable without restarting CLI
      setEnabled(true)
      const reqStart2 = agentRequests.length
      activeProbe =
        profile === 'standard' ? { kind: 'skill', issued: false } : undefined
      const r2 = await submit(
        'enabled-next-turn',
        profile === 'standard'
          ? 'Load the browser-use skill and report tools.'
          : 'Report tools after enable.',
      )
      assert.equal(r2.is_error, false)
      const tools2 = agentRequests
        .slice(reqStart2)
        .at(-1)!
        .tools!.map(t => t.name!)
        .sort()
      captures.push({ profile, phase: 'enabled-next-turn', tools: tools2 })

      const browserTools2 = tools2.filter(name =>
        (BROWSER_TOOL_NAMES as readonly string[]).includes(name),
      )
      if (profile === 'standard') {
        assert.deepEqual(
          browserTools2,
          [...BROWSER_TOOL_NAMES].sort(),
          'standard profile must expose all 6 Browser* tools immediately after hot-enable',
        )
        assert.ok(
          activeProbe?.kind === 'skill' &&
            activeProbe.result &&
            !activeProbe.result.is_error,
          'browser-use skill failed to load after hot-enable',
        )
        assert.ok(
          activeProbe?.kind === 'skill' &&
            activeProbe.messages?.includes('Snapshot -> Act -> Verify'),
          'browser-use skill workflow did not reach the model',
        )
      } else {
        assert.deepEqual(
          browserTools2,
          [],
          'lean profile must never expose Browser Use tools even when enabled',
        )
      }
      activeProbe = undefined

      // Phase 3 (standard only): Execute BrowserSnapshot -> BrowserTakeover
      if (profile === 'standard') {
        bridgeCalls.length = 0
        const reqStart3 = agentRequests.length
        activeProbe = { kind: 'tool-flow', step: 0 }
        const r3 = await submit('browser-tool-flow', 'Check login page and hand over.')
        assert.equal(r3.is_error, false)
        activeProbe = undefined

        // Verify BrowserSnapshot and BrowserTakeover hit loopback bridge with auth headers & no Origin
        assert.deepEqual(
          bridgeCalls.map(c => c.action),
          ['snapshot', 'takeover'],
          `Expected snapshot -> takeover (with takeover preserved on turn end), got: ${JSON.stringify(bridgeCalls.map(c => c.action))}`,
        )
        for (const call of bridgeCalls) {
          assert.equal(call.sessionId, 'sess-browser-standard')
          assert.equal(call.authorization, 'Bearer e2e-sdk-token')
          assert.equal(call.origin, null)
        }
        // Verify BrowserTakeover paused the turn (model was NOT called a 3rd time)
        assert.equal(
          agentRequests.length - reqStart3,
          2,
          'BrowserTakeover must pause the turn before calling the model again',
        )
      }

      // Phase 4: Hot-disable without restarting CLI -> 0 Browser Use tools again
      setEnabled(false)
      const reqStart4 = agentRequests.length
      const r4 = await submit('disabled-again', 'Report tools after disabling.')
      assert.equal(r4.is_error, false)
      const tools4 = agentRequests
        .slice(reqStart4)
        .at(-1)!
        .tools!.map(t => t.name!)
        .sort()
      captures.push({ profile, phase: 'disabled-again', tools: tools4 })
      assert.deepEqual(
        tools4.filter(name => (BROWSER_TOOL_NAMES as readonly string[]).includes(name)),
        [],
        `${profile} kept stale Browser Use tools after hot-disable`,
      )
    } finally {
      child.stdin.end()
      const exitTimer = setTimeout(() => child.kill('SIGKILL'), 10_000)
      try {
        const exitCode = await child.exited
        await Promise.all([drainOut, drainErr])
        writeFileSync(join(artifactDir, `${profile}.log`), `${stdout}\n${stderr}`)
        assert.equal(exitCode, 0, `${profile} CLI did not shut down cleanly: ${stderr}`)
      } finally {
        clearTimeout(exitTimer)
        clearTimeout(killTimer)
      }
    }
  }

  try {
    await runProfile('standard')
    await runProfile('lean')
    writeFileSync(
      join(artifactDir, 'summary.json'),
      `${JSON.stringify({ captures, bridgeCalls }, null, 2)}\n`,
    )
  } finally {
    fakeDesktopServer.stop(true)
    await upstream.stop()
    sandbox.cleanup()
  }
}
