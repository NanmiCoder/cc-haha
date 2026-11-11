import { createSelfHostedDirectory, parseSelfHostedConfig } from './selfHosted'

export function startSelfHostedDirectory(env: Record<string, string | undefined> = process.env) {
  const config = parseSelfHostedConfig(env)
  const directory = createSelfHostedDirectory(config)
  try {
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: config.port,
      maxRequestBodySize: 4096,
      idleTimeout: 10,
      fetch: request => directory.fetch(request),
      error: () => Response.json({ error: 'temporarily_unavailable' }, { status: 503, headers: { 'cache-control': 'no-store' } }),
    })
    return { server, stop: async () => {
      await server.stop(true)
      directory.close()
    } }
  } catch (error) {
    directory.close()
    throw error
  }
}

if (import.meta.main) {
  try {
    const app = startSelfHostedDirectory()
    console.log(`Private remote directory listening on 127.0.0.1:${app.server.port}`)
    let stopping = false
    const stop = async () => {
      if (stopping) return
      stopping = true
      await app.stop()
      process.exit(0)
    }
    process.once('SIGTERM', stop)
    process.once('SIGINT', stop)
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Remote directory failed to start')
    process.exitCode = 1
  }
}
