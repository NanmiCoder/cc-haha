import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createSandboxedTestEnvironment } from '../../../scripts/pr/test-environment.js'

test('a fresh official OpenAI process preserves future model IDs and selected effort in outgoing requests', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'openai-runtime-effort-'))
  try {
    const env = createSandboxedTestEnvironment(sandbox, {
      CC_HAHA_OPENAI_OAUTH_PROVIDER: '1',
    })
    const tokenFile = join(env.CLAUDE_CONFIG_DIR, 'openai-oauth.json')
    await mkdir(env.CLAUDE_CONFIG_DIR, { recursive: true })
    await writeFile(tokenFile, JSON.stringify({
      accessToken: 'offline-access-token',
      refreshToken: 'offline-refresh-token',
      accountId: 'offline-account',
      expiresAt: Date.now() + 3_600_000,
    }))
    env.OPENAI_CODEX_OAUTH_FILE = tokenFile

    const root = resolve(import.meta.dir, '../../..')
    const source = `
      globalThis.fetch = async () => { throw new Error('Unexpected network request') }
      const { resolveAppliedEffort } = await import('./src/utils/effort.ts')
      const { configureEffortParams } = await import('./src/services/api/claude.ts')
      const { buildOpenAICodexFetch } = await import('./src/services/openaiAuth/fetch.ts')
      const cases = [
        { sessionEffort: 'low' },
        { sessionEffort: 'xhigh' },
        { sessionEffort: 'max' },
        { sessionEffort: 'high', requestEffort: 'low' },
        { sessionEffort: 'low', requestEffort: 'xhigh' },
        { sessionEffort: 'low', requestEffort: 'max' },
      ]
      const results = []
      for (const item of cases) {
        process.env.CC_HAHA_OPENAI_REASONING_EFFORT = item.sessionEffort
        const applied = resolveAppliedEffort('codex-future', item.requestEffort)
        const outputConfig = {}
        configureEffortParams(applied, outputConfig, {}, [], 'codex-future')
        let outbound
        const transport = buildOpenAICodexFetch(async (_url, init) => {
          outbound = JSON.parse(init.body instanceof Uint8Array
            ? Buffer.from(Bun.zstdDecompressSync(init.body)).toString('utf8')
            : String(init.body))
          return Response.json({
            id: 'offline-response', object: 'response', status: 'completed',
            model: 'codex-future', output: [],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          })
        }, 'runtime-effort-test')
        const response = await transport('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          body: JSON.stringify({
            model: 'codex-future', max_tokens: 64,
            messages: [{ role: 'user', content: 'hello' }],
            output_config: outputConfig,
          }),
        })
        await response.text()
        results.push({ status: response.status, model: outbound.model, effort: outbound.reasoning.effort, outputConfig })
      }
      console.log(JSON.stringify(results))
    `
    const child = Bun.spawn([process.execPath, '--no-env-file', '--eval', source], {
      cwd: root, env, stdout: 'pipe', stderr: 'pipe',
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' })
    expect(JSON.parse(stdout)).toEqual([
      { status: 200, model: 'codex-future', effort: 'low', outputConfig: {} },
      { status: 200, model: 'codex-future', effort: 'xhigh', outputConfig: {} },
      { status: 200, model: 'codex-future', effort: 'max', outputConfig: {} },
      { status: 200, model: 'codex-future', effort: 'low', outputConfig: { effort: 'low' } },
      { status: 200, model: 'codex-future', effort: 'xhigh', outputConfig: { effort: 'xhigh' } },
      { status: 200, model: 'codex-future', effort: 'max', outputConfig: { effort: 'max' } },
    ])
  } finally {
    await rm(sandbox, { recursive: true, force: true })
  }
}, 20_000)
