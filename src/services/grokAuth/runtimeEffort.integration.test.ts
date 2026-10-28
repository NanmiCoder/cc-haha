import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createSandboxedTestEnvironment } from '../../../scripts/pr/test-environment.js'
import { buildGrokOfficialRuntimeEnv } from '../../server/services/grokOfficialProvider.js'
import { clearGrokModelCatalogCache, getGrokModelCatalog } from './modelCatalog.js'

afterEach(() => clearGrokModelCatalogCache())

for (const catalogState of ['discovered', 'pending', 'failed'] as const) {
  test(`a fresh official Grok process preserves selected effort with a ${catalogState} catalog`, async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'grok-runtime-effort-'))
    try {
      await getGrokModelCatalog({
        accessToken: 'offline-access-token',
        forceRefresh: catalogState === 'discovered',
        throwOnError: catalogState === 'discovered',
        fetchOverride: async () => catalogState === 'pending'
          ? new Promise<Response>(() => {})
          : catalogState === 'failed'
            ? new Response(null, { status: 503 })
            : Response.json({ models: [
          {
            id: 'grok-future-release',
            supportsReasoningEffort: true,
            reasoningEffort: 'low',
            reasoningEfforts: ['low', 'xhigh', 'max'],
          },
          { id: 'grok-future-no-effort', supportsReasoningEffort: false },
        ] }),
      })
      const env = createSandboxedTestEnvironment(sandbox, buildGrokOfficialRuntimeEnv({
        main: 'grok-future-release', haiku: 'grok-future-release',
        sonnet: 'grok-future-release', opus: 'grok-future-release',
      }))
      const tokenFile = join(env.CLAUDE_CONFIG_DIR!, 'grok-oauth.json')
      await mkdir(env.CLAUDE_CONFIG_DIR!, { recursive: true })
      await writeFile(tokenFile, JSON.stringify({
        accessToken: 'offline-access-token', refreshToken: 'offline-refresh-token',
        expiresAt: Date.now() + 3_600_000,
      }))
      env.GROK_OAUTH_FILE = tokenFile

      const source = `
        globalThis.fetch = async () => { throw new Error('Unexpected network request') }
        const { resolveAppliedEffort } = await import('./src/utils/effort.ts')
        const { configureEffortParams } = await import('./src/services/api/claude.ts')
        const { buildGrokFetch } = await import('./src/services/grokAuth/fetch.ts')
        const cases = [
          { model: 'grok-future-release', effort: 'xhigh' },
          { model: 'grok-future-release', effort: 'max' },
          { model: 'grok-future-release', effort: 'medium' },
          { model: 'grok-future-no-effort', effort: 'high' },
        ]
        if (${catalogState !== 'discovered'}) cases.length = 2
        const results = []
        for (const item of cases) {
          const applied = resolveAppliedEffort(item.model, item.effort)
          const outputConfig = {}
          configureEffortParams(applied, outputConfig, {}, [], item.model)
          let outbound
          const transport = buildGrokFetch(async (_url, init) => {
            outbound = JSON.parse(String(init.body))
            return new Response('data: {"type":"response.completed","response":{"id":"offline-response","status":"completed","output":[]}}\\n\\n', {
              headers: { 'content-type': 'text/event-stream' },
            })
          }, 'runtime-effort-test')
          const response = await transport('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            body: JSON.stringify({
              model: item.model, max_tokens: 64, stream: true,
              messages: [{ role: 'user', content: 'hello' }], output_config: outputConfig,
            }),
          })
          await response.text()
          results.push({ status: response.status, model: outbound.model, effort: outbound.reasoning?.effort ?? null })
        }
        console.log(JSON.stringify(results))
      `
      const child = Bun.spawn([process.execPath, '--no-env-file', '--eval', source], {
        cwd: resolve(import.meta.dir, '../../..'), env, stdout: 'pipe', stderr: 'pipe',
      })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ])
      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' })
      const expected = [
        { status: 200, model: 'grok-future-release', effort: 'xhigh' },
        { status: 200, model: 'grok-future-release', effort: 'max' },
        { status: 200, model: 'grok-future-release', effort: 'low' },
        { status: 200, model: 'grok-future-no-effort', effort: null },
      ]
      expect(JSON.parse(stdout)).toEqual(catalogState === 'discovered' ? expected : expected.slice(0, 2))
    } finally {
      await rm(sandbox, { recursive: true, force: true })
    }
  }, 20_000)
}
