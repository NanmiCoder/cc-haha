import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { ProviderService } from '../../../src/server/services/providerService'
import type { BaselineTarget, LaneResult } from '../types'

type SavedProvider = Awaited<ReturnType<ProviderService['getProvider']>>

function getPort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

async function waitForHttp(url: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      // Keep polling until timeout.
    }
    await Bun.sleep(500)
  }
  throw new Error(`Timed out waiting for ${url}`)
}

function anthropicProbeBody(model: string, stream: boolean) {
  return {
    model,
    max_tokens: 32,
    stream,
    messages: [
      {
        role: 'user',
        content: 'Say "ok" and nothing else.',
      },
    ],
  }
}

async function runProxyProbe(
  rootDir: string,
  artifactDir: string,
  provider: SavedProvider,
  modelId: string,
) {
  const port = await getPort()
  const baseUrl = `http://127.0.0.1:${port}`
  const serverLogPath = join(artifactDir, 'proxy-server.log')
  ProviderService.setServerPort(port)

  const server = Bun.spawn(['bun', 'run', 'src/server/index.ts', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: rootDir,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      SERVER_PORT: String(port),
    },
  })

  const pipe = async (stream: ReadableStream<Uint8Array> | null) => {
    if (!stream) return
    const reader = stream.getReader()
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      appendFileSync(serverLogPath, Buffer.from(value))
    }
  }
  void pipe(server.stdout)
  void pipe(server.stderr)

  try {
    await waitForHttp(`${baseUrl}/health`, 60_000)
    const proxyPath = `${baseUrl}/proxy/providers/${encodeURIComponent(provider.id)}/v1/messages`

    const nonStream = await fetch(proxyPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(anthropicProbeBody(modelId, false)),
    })
    const nonStreamText = await nonStream.text()
    writeFileSync(join(artifactDir, 'proxy-non-stream.json'), nonStreamText)
    if (!nonStream.ok) {
      throw new Error(`non-stream proxy probe failed with HTTP ${nonStream.status}: ${nonStreamText.slice(0, 300)}`)
    }
    const parsed = JSON.parse(nonStreamText) as { type?: string; content?: unknown[] }
    if (parsed.type !== 'message' || !Array.isArray(parsed.content)) {
      throw new Error('non-stream proxy probe did not return Anthropic message shape')
    }

    const stream = await fetch(proxyPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(anthropicProbeBody(modelId, true)),
    })
    const streamText = await stream.text()
    writeFileSync(join(artifactDir, 'proxy-stream.sse'), streamText)
    if (!stream.ok) {
      throw new Error(`stream proxy probe failed with HTTP ${stream.status}: ${streamText.slice(0, 300)}`)
    }
    if (!streamText.includes('message_start') && !streamText.includes('content_block')) {
      throw new Error('stream proxy probe did not return Anthropic SSE events')
    }
  } finally {
    server.kill()
    await server.exited.catch(() => undefined)
  }
}

async function runSavedProviderSmoke(
  rootDir: string,
  artifactDir: string,
  target: BaselineTarget,
) {
  const service = new ProviderService()
  if (!target.providerId) {
    const { providers, activeId } = await service.listProviders()
    const activeProvider = providers.find((provider) => provider.id === activeId)
    if (!activeProvider) {
      return runEnvProviderSmoke(artifactDir)
    }

    writeFileSync(join(artifactDir, 'resolved-target.json'), JSON.stringify({
      source: 'active-provider',
      providerId: activeProvider.id,
      providerName: activeProvider.name,
      requestedModel: target.modelId,
    }, null, 2) + '\n')
    return runSavedProviderSmoke(rootDir, artifactDir, {
      ...target,
      providerId: activeProvider.id,
    })
  }

  const provider = await service.getProvider(target.providerId)
  const modelId = target.modelId === 'current' ? provider.models.main : target.modelId
  const result = await service.testProvider(target.providerId, { modelId })
  writeFileSync(join(artifactDir, 'provider-test.json'), JSON.stringify(result, null, 2) + '\n')

  if (!result.connectivity.success) {
    throw new Error(`provider connectivity failed: ${result.connectivity.error ?? 'unknown error'}`)
  }
  if (result.proxy?.success === false) {
    throw new Error(`provider proxy transform failed: ${result.proxy.error ?? 'unknown error'}`)
  }

  const apiFormat = provider.apiFormat ?? 'anthropic'
  if (apiFormat === 'openai_chat' || apiFormat === 'openai_responses') {
    await runProxyProbe(rootDir, artifactDir, provider, modelId)
  }

  return { skipped: false as const }
}

async function runEnvProviderSmoke(artifactDir: string) {
  const baseUrl = process.env.QUALITY_GATE_PROVIDER_BASE_URL
  const apiKey = process.env.QUALITY_GATE_PROVIDER_API_KEY
  const modelId = process.env.QUALITY_GATE_PROVIDER_MODEL
  if (!baseUrl || !apiKey || !modelId) {
    return { skipped: true as const, reason: 'set QUALITY_GATE_PROVIDER_BASE_URL, QUALITY_GATE_PROVIDER_API_KEY, and QUALITY_GATE_PROVIDER_MODEL or pass a saved provider target' }
  }

  const service = new ProviderService()
  const result = await service.testProviderConfig({
    baseUrl,
    apiKey,
    modelId,
    apiFormat: (process.env.QUALITY_GATE_PROVIDER_API_FORMAT as 'anthropic' | 'openai_chat' | 'openai_responses' | undefined) ?? 'openai_chat',
    authStrategy: (process.env.QUALITY_GATE_PROVIDER_AUTH_STRATEGY as 'api_key' | 'auth_token' | 'auth_token_empty_api_key' | 'dual_same_token' | 'dual_dummy' | undefined) ?? 'api_key',
  })
  writeFileSync(join(artifactDir, 'provider-test.json'), JSON.stringify(result, null, 2) + '\n')
  if (!result.connectivity.success) {
    throw new Error(`provider connectivity failed: ${result.connectivity.error ?? 'unknown error'}`)
  }
  if (result.proxy?.success === false) {
    throw new Error(`provider proxy transform failed: ${result.proxy.error ?? 'unknown error'}`)
  }

  return { skipped: false as const }
}

export async function executeProviderSmoke(
  rootDir: string,
  artifactDir: string,
  resultId: string,
  resultTitle: string,
  target: BaselineTarget | undefined,
): Promise<LaneResult> {
  const started = Date.now()
  mkdirSync(artifactDir, { recursive: true })

  try {
    const result = target
      ? await runSavedProviderSmoke(rootDir, artifactDir, target)
      : await runEnvProviderSmoke(artifactDir)

    if (result.skipped) {
      return {
        id: resultId,
        title: resultTitle,
        status: 'skipped',
        durationMs: Date.now() - started,
        skipReason: result.reason,
        artifactDir,
      }
    }

    return {
      id: resultId,
      title: resultTitle,
      status: 'passed',
      durationMs: Date.now() - started,
      artifactDir,
    }
  } catch (error) {
    return {
      id: resultId,
      title: resultTitle,
      status: 'failed',
      durationMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
      artifactDir,
    }
  }
}
