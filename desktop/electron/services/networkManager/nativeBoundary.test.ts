import { spawnSync } from 'node:child_process'
import http from 'node:http'
import net from 'node:net'
import { describe, expect, it } from 'vitest'
import { NETWORK_SCRIPT } from './powershell'
import { probeTcp } from './probes'
import { requestController } from './proxy'

describe('network native boundaries', () => {
  const windowsIt = process.platform === 'win32' ? it : it.skip
  windowsIt('parses the production PowerShell template without executing network commands', () => {
    const parser = `[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
$tokens = $null; $errors = $null
[System.Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(), [ref]$tokens, [ref]$errors) | Out-Null
if ($errors.Count) { $errors | ForEach-Object { [Console]::Error.WriteLine($_.Message) }; exit 1 }`
    const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(parser, 'utf16le').toString('base64')], {
      input: NETWORK_SCRIPT, encoding: 'utf8', timeout: 10000, windowsHide: true, shell: false,
    })
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
  }, 15000)

  it('reports real loopback TCP evidence and a closed port without authenticating', async () => {
    const server = net.createServer(socket => socket.end())
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as net.AddressInfo).port
    try {
      const result = await probeTcp('127.0.0.1', port)
      expect(result).toMatchObject({ kind: 'tcp', ok: true, source: '127.0.0.1', port })
      expect(result.latencyMs).toBeGreaterThanOrEqual(0)
    } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
    expect(await probeTcp('127.0.0.1', port)).toMatchObject({ ok: false, detail: 'TCP_UNREACHABLE' })
  })

  it('keeps controller authentication only in the HTTP header and surfaces authentication failures', async () => {
    const received: Array<{ path: string; method: string; authorization: string }> = []
    const server = http.createServer((request, response) => {
      received.push({ path: request.url!, method: request.method!, authorization: request.headers.authorization ?? '' })
      if (request.url === '/rules') { response.writeHead(403); response.end('forbidden'); return }
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ version: 'fixture' }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`
    try {
      expect(await requestController(base, 'fixture-secret', '/version')).toEqual({ version: 'fixture' })
      await expect(requestController(base, 'fixture-secret', '/rules')).rejects.toThrow('PROXY_AUTH_REQUIRED')
      expect(received).toEqual([
        { path: '/version', method: 'GET', authorization: 'Bearer fixture-secret' },
        { path: '/rules', method: 'GET', authorization: 'Bearer fixture-secret' },
      ])
    } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
  })
})
