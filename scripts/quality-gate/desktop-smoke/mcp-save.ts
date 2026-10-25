import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

type BrowserStep = (args: string[], options?: { timeoutMs?: number; allowFailure?: boolean }) => Promise<{ stdout: string; stderr: string }>
type Audit = { name: string; requestId: string; cwd: string; config: { type: string; url: string }; outcome: string }

/** Real settings/API/persistence/control feedback, with only the CLI receipt faked. */
export async function runDesktopUiMcpSaveSmoke(options: {
  baseUrl: string; projectDir: string; artifactDir: string; auditPath: string; browserStep: BrowserStep
}) {
  const { baseUrl, projectDir, artifactDir, auditPath, browserStep } = options
  const mcp = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(request) {
      if (request.method !== 'POST') return new Response(null, { status: 405 })
      const message = await request.json() as { id?: string | number; method: string }
      if (message.id === undefined) return new Response(null, { status: 202 })
      const result = message.method === 'initialize'
        ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'mcp-save-smoke', version: '1' } }
        : { tools: [] }
      return Response.json({ jsonrpc: '2.0', id: message.id, result })
    },
  })
  const origin = `http://127.0.0.1:${mcp.port}`
  const configPath = join(projectDir, '.mcp.json')
  const names = ['mcp_save_success', 'mcp_save_failure']
  writeFileSync(configPath, JSON.stringify({ mcpServers: Object.fromEntries(names.map(name => [name, { type: 'http', url: `${origin}/${name}/before` }])) }))

  try {
    // H5 hides native settings. This presentation bridge leaves every MCP
    // request and the real server/child control path intact.
    await browserStep(['eval', `(async () => {
      const { browserHost } = await import('/src/lib/desktopHost/browserHost.ts')
      window.desktopHost = { ...browserHost, kind: 'electron', isDesktop: true,
        runtime: { getServerUrl: async () => ${JSON.stringify(baseUrl)}, getLocalAccessToken: async () => null } }
    })()`])
    await browserStep(['click', '[data-testid="sidebar-settings-dock"] button[aria-label="Settings"]'])
    await browserStep(['wait', '[data-testid="settings-page-frame"]'])
    await browserStep(['find', 'role', 'button', 'click', '--name', 'MCP', '--exact'])

    for (const name of names) {
      const url = `${origin}/${name}/after`
      const selector = `button[aria-label="Open ${name}"]`
      await browserStep(['wait', selector])
      await browserStep(['scrollintoview', selector])
      await browserStep(['click', selector])
      const urlInput = 'input[placeholder="https://mcp.example.com/mcp"]'
      await browserStep(['wait', urlInput])
      await browserStep(['scrollintoview', urlInput])
      await browserStep(['fill', urlInput, url])
      await browserStep(['find', 'role', 'button', 'click', '--name', 'Save', '--exact'])
      const tone = name === 'mcp_save_failure' ? 'warning' : 'success'
      const toast = `[data-tone="${tone}"]`
      await browserStep(['wait', '--fn', `Array.from(document.querySelectorAll(${JSON.stringify(toast)})).some(node => node.textContent.includes(${JSON.stringify(`Saved MCP server "${name}"`)}))`])
      const feedback = await browserStep(['get', 'text', toast])
      if (tone === 'warning' && !feedback.stdout.includes('MCP save smoke control rejection')) {
        throw new Error('The MCP save warning did not preserve the child control error')
      }
      const persisted = JSON.parse(readFileSync(configPath, 'utf8')).mcpServers[name]
      if (persisted.url !== url) throw new Error(`MCP ${name} save did not persist the edited URL`)
      const response = await fetch(`${baseUrl}/api/mcp?cwd=${encodeURIComponent(projectDir)}`)
      if (!response.ok) throw new Error(`MCP readback failed with HTTP ${response.status}`)
      const listed = (await response.json() as { servers: Array<{ name: string; config: { url?: string } }> }).servers
      if (!listed.some(server => server.name === name && server.config.url === url)) {
        throw new Error(`MCP ${name} save was not readable through the real API`)
      }
      const audit = readFileSync(auditPath, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Audit)
      const receipt = audit.filter(entry => entry.name === name)
      if (receipt.length !== 1 || receipt[0].config.url !== url || receipt[0].outcome !== (tone === 'success' ? 'applied' : 'failed')) {
        throw new Error(`MCP ${name} did not send exactly one post-persistence control request to the running child`)
      }
      await browserStep(['screenshot', join(artifactDir, `mcp-save-${tone}.png`)])
      writeFileSync(join(artifactDir, `mcp-save-${tone}.json`), JSON.stringify({ persisted, receipt: receipt[0], feedback: feedback.stdout }, null, 2))
      await browserStep(['click', `${toast} button[aria-label="Dismiss notification"]`])
    }
    await browserStep(['find', 'role', 'button', 'click', '--name', 'Close Settings', '--exact'])
    await browserStep(['eval', 'delete window.desktopHost'])
  } finally {
    mcp.stop(true)
  }
}
