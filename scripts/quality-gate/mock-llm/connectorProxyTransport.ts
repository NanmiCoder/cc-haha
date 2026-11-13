import { mock } from 'bun:test'
import { join, resolve } from 'node:path'
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { configureConnectorProxyFixture } from './connectorProxyFixture'

// Only this offline fixture replaces its endpoint and supports the runner's
// platform. Installation, plugin files, credentials and reload use production code.
const platform = `${process.platform}-${process.arch}`
const recipe = configureConnectorProxyFixture(process.env.MOCK_CONNECTOR_ENDPOINT, platform)
if (process.env.MOCK_CONNECTOR_TRACE) appendFileSync(process.env.MOCK_CONNECTOR_TRACE, JSON.stringify({ pid: process.pid, stage: 'preload', endpoint: recipe.endpoint, platform, argv: process.argv.slice(0, 3) }) + '\n')

// Separate CLI processes must read the fake key saved by the real API. Keep
// their substitute credential store inside this run's disposable config.
const configDir = process.env.CLAUDE_CONFIG_DIR
if (!configDir || !process.env.HOME || !configDir.startsWith(process.env.HOME + '/')) {
  throw new Error('Connector fixture requires a sandboxed credential store')
}
const credentialFile = join(configDir, 'mock-connector-secrets.json')
const readCredentials = () => existsSync(credentialFile) ? JSON.parse(readFileSync(credentialFile, 'utf8')) : null
mock.module(resolve(import.meta.dir, '../../../src/utils/secureStorage/index.ts'), () => ({
  getSecureStorage: () => ({
    name: 'offline-connector-sandbox', read: readCredentials, readAsync: async () => readCredentials(),
    update: (next: unknown) => {
      writeFileSync(credentialFile, JSON.stringify(next), { mode: 0o600 })
      return { success: true }
    },
    delete: () => {
      rmSync(credentialFile, { force: true })
      return true
    },
  }),
}))

const originalFetch = globalThis.fetch
globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
  const target = new URL(input instanceof Request ? input.url : String(input))
  if (process.env.MOCK_CONNECTOR_TRACE && target.hostname.includes('huggingface')) appendFileSync(process.env.MOCK_CONNECTOR_TRACE, JSON.stringify({ pid: process.pid, stage: 'blocked-real-catalog', hostname: target.hostname }) + '\n')
  const local = (host: string) => ['127.0.0.1', 'localhost', '[::1]'].includes(host)
  const proxy = (init as RequestInit & { proxy?: string | false })?.proxy
    ?? process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY
  const fixture = target.hostname === 'mcp.blocked.test' && typeof proxy === 'string' && local(new URL(proxy).hostname)
  if (!local(target.hostname) && !fixture) throw new Error('Offline connector scenario blocked external fetch')
  return originalFetch(input, init)
}, originalFetch)
