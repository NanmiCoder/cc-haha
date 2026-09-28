import net from 'node:net'
import { spawn } from 'node:child_process'
import path from 'node:path'
import type { NetworkProbe } from '../../../src/features/network-manager/networkTypes'

export type TcpProbe = (address: string, port: number) => Promise<NetworkProbe>
export type HttpProbe = (url: string, port: number) => Promise<NetworkProbe>
export type DirectHttpProbe = (address: string, port: number, protocol: 'http' | 'https') => Promise<NetworkProbe>

export const probeTcp: TcpProbe = (address, port) => new Promise(resolve => {
  const started = Date.now()
  const socket = new net.Socket()
  let settled = false
  const finish = (ok: boolean, detail: string) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    const source = socket.localAddress
    socket.destroy()
    resolve({ target: address, port, kind: 'tcp', ok, checkedAt: new Date().toISOString(), latencyMs: Date.now() - started, source, detail })
  }
  const timer = setTimeout(() => finish(false, 'TCP_TIMEOUT'), 3000)
  socket.setTimeout(3000, () => finish(false, 'TCP_TIMEOUT'))
  socket.once('error', () => finish(false, 'TCP_UNREACHABLE'))
  socket.connect({ host: address, port }, () => finish(true, 'TCP_CONNECTED'))
})

export const probeHttpProxy: HttpProbe = (url, port) => new Promise(resolve => {
  const started = Date.now()
  const child = spawn(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'curl.exe'), ['--disable', '--silent', '--output', 'NUL', '--connect-timeout', '3', '--max-time', '8', '--proto', '=https', '--noproxy', '', '--proxy', `http://127.0.0.1:${port}`, '--write-out', '%{http_code}', '--url', url], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'ignore'] })
  let output = ''
  let settled = false
  const finish = (ok: boolean) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    const statusCode = Number(output.trim()) || undefined
    resolve({ target: url, kind: 'http-proxy', ok: ok && !!statusCode && statusCode >= 200 && statusCode < 400, checkedAt: new Date().toISOString(), latencyMs: Date.now() - started, statusCode, detail: ok ? 'EXPLICIT_PROXY_HTTP_RESPONSE' : 'EXPLICIT_PROXY_FAILED' })
  }
  const timer = setTimeout(() => { child.kill(); finish(false) }, 10_000)
  child.stdout.on('data', data => { if (output.length < 100) output += String(data) })
  child.once('error', () => finish(false))
  child.once('close', code => finish(code === 0))
})

/** Probe one numeric IPv4 destination without consulting system or SakuraCat proxies. */
export const probeDirectHttp: DirectHttpProbe = (address, port, protocol) => new Promise(resolve => {
  const started = Date.now()
  const url = `${protocol}://${address}:${port}/`
  const child = spawn(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'curl.exe'),
    ['--disable', '--silent', '--output', 'NUL', '--connect-timeout', '3', '--max-time', '8', '--ipv4', '--proto', `=${protocol}`, '--noproxy', '*', '--write-out', '%{http_code}', '--url', url],
    { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'ignore'] })
  let output = ''
  let settled = false
  const finish = (completed: boolean) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    const statusCode = Number(output.trim()) || undefined
    resolve({ target: url, port, kind: 'http-direct', ok: completed && !!statusCode && statusCode >= 100 && statusCode <= 599,
      checkedAt: new Date().toISOString(), latencyMs: Date.now() - started, statusCode,
      detail: completed && statusCode ? 'DIRECT_HTTP_RESPONSE' : 'DIRECT_HTTP_FAILED' })
  }
  const timer = setTimeout(() => { child.kill(); finish(false) }, 10_000)
  child.stdout.on('data', data => { if (output.length < 100) output += String(data) })
  child.once('error', () => finish(false))
  child.once('close', code => finish(code === 0))
})
