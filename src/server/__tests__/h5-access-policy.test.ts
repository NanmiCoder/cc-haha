import { describe, expect, test } from 'bun:test'
import {
  classifyH5Request,
  isLoopbackHost,
  shouldBlockDisabledH5Access,
  shouldRequireH5Token,
} from '../h5AccessPolicy.js'

function req(url: string, init: RequestInit = {}) {
  return new Request(url, init)
}

const localContext = { clientAddress: '127.0.0.1' }
const remoteContext = { clientAddress: '192.168.0.44' }

describe('h5AccessPolicy', () => {
  test('recognizes loopback hosts as local trusted requests', () => {
    expect(isLoopbackHost('localhost')).toBe(true)
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('127.0.1.1')).toBe(true)
    expect(isLoopbackHost('[::1]')).toBe(true)
    expect(isLoopbackHost('::ffff:127.0.0.1')).toBe(true)
    expect(isLoopbackHost('127.example.com')).toBe(false)
    expect(isLoopbackHost('127.bad.0.1')).toBe(false)
    expect(isLoopbackHost('192.168.0.20')).toBe(false)
  })

  test('keeps Electron desktop WebView requests to loopback tokenless', () => {
    for (const origin of ['file://']) {
      const request = req('http://127.0.0.1:3456/api/status', {
        headers: { Origin: origin },
      })
      expect(classifyH5Request(request, new URL(request.url), localContext)).toBe('local-trusted')
      expect(shouldRequireH5Token({ request, url: new URL(request.url), h5Enabled: true, context: localContext })).toBe(false)
    }
  })

  test('does not keep retired Tauri origins trusted after Electron replacement', () => {
    for (const origin of ['http://tauri.localhost', 'https://tauri.localhost', 'tauri://localhost']) {
      const request = req('http://127.0.0.1:3456/api/status', {
        headers: { Origin: origin },
      })
      expect(classifyH5Request(request, new URL(request.url), localContext)).toBe('h5-browser')
      expect(shouldRequireH5Token({ request, url: new URL(request.url), h5Enabled: true, context: localContext })).toBe(true)
    }
  })

  test('keeps local internal SDK websocket routes tokenless', () => {
    const request = req('http://127.0.0.1:3456/sdk/session-1')
    expect(classifyH5Request(request, new URL(request.url), localContext)).toBe('internal-sdk')
    expect(shouldRequireH5Token({ request, url: new URL(request.url), h5Enabled: true, context: localContext })).toBe(false)
  })

  test('does not trust remote SDK websocket routes by path alone', () => {
    const request = req('http://192.168.0.20:3456/sdk/session-1')
    expect(classifyH5Request(request, new URL(request.url), remoteContext)).toBe('h5-browser')
    expect(shouldRequireH5Token({ request, url: new URL(request.url), h5Enabled: true, context: remoteContext })).toBe(false)
  })

  test('accepts an SDK route only after its session token is authorized', () => {
    const request = req('http://127.0.0.1:3456/sdk/session-1?token=sdk-secret')
    const configuredContext = {
      clientAddress: '127.0.0.1',
      localAccessTokenConfigured: true,
      localAccessAuthorized: false,
      internalSdkAuthorized: true,
    }

    expect(classifyH5Request(request, new URL(request.url), configuredContext)).toBe('internal-sdk')
  })

  test('keeps adapter API routes tokenless for local integrations', () => {
    const request = req('http://127.0.0.1:3456/api/adapters')
    expect(classifyH5Request(request, new URL(request.url), localContext)).toBe('local-trusted')
    expect(shouldRequireH5Token({ request, url: new URL(request.url), h5Enabled: true, context: localContext })).toBe(false)
  })

  test('keeps loopback browser origins tokenless for local dev capability routes', () => {
    for (const pathname of [
      '/api/status',
      '/api/adapters',
      '/proxy/openai/v1/chat/completions',
      '/ws/session-1',
      '/local-file/Users/alice/report.html',
      '/preview-fs/session-1/index.html',
    ]) {
      for (const origin of [
        'http://localhost:5173',
        'http://127.0.0.1:2024',
        'http://127.0.1.1:2024',
        'http://[::1]:5173',
      ]) {
        const request = req(`http://127.0.0.1:3456${pathname}`, {
          headers: { Origin: origin },
        })
        expect(classifyH5Request(request, new URL(request.url), localContext)).toBe('local-trusted')
        expect(shouldRequireH5Token({ request, url: new URL(request.url), h5Enabled: true, context: localContext })).toBe(false)
        expect(shouldBlockDisabledH5Access({
          request,
          url: new URL(request.url),
          h5Enabled: false,
          explicitAuthRequired: false,
          context: localContext,
        })).toBe(false)
      }
    }
  })

  test('does not trust adapter requests from non-loopback browser origins', () => {
    const request = req('http://127.0.0.1:3456/api/adapters', {
      headers: { Origin: 'https://phone.example' },
    })
    expect(classifyH5Request(request, new URL(request.url), localContext)).toBe('h5-browser')
    expect(shouldRequireH5Token({ request, url: new URL(request.url), h5Enabled: true, context: localContext })).toBe(true)
  })

  test('does not trust spoofed loopback hosts from remote clients', () => {
    const request = req('http://127.0.0.1:3456/api/status', {
      headers: { Origin: 'http://127.0.0.1:5179' },
    })
    expect(classifyH5Request(request, new URL(request.url), remoteContext)).toBe('h5-browser')
    expect(shouldBlockDisabledH5Access({
      request,
      url: new URL(request.url),
      h5Enabled: false,
      explicitAuthRequired: false,
      context: remoteContext,
    })).toBe(true)
  })

  test('keeps local desktop chat websocket routes tokenless', () => {
    for (const init of [{}, { headers: { Origin: 'file://' } }]) {
      const request = req('http://127.0.0.1:3456/ws/session-1', init)
      expect(classifyH5Request(request, new URL(request.url), localContext)).toBe('local-trusted')
      expect(shouldRequireH5Token({ request, url: new URL(request.url), h5Enabled: true, context: localContext })).toBe(false)
    }
  })

  test('does not trust a public request host just because a reverse proxy connects from loopback', () => {
    for (const pathname of [
      '/api/status',
      '/local-file/Users/alice/report.html',
      '/preview-fs/session-1/index.html',
      '/proxy/openai/v1/chat/completions',
      '/ws/session-1',
    ]) {
      const request = req(`https://haha.example.com:8443${pathname}`)
      const url = new URL(request.url)

      expect(classifyH5Request(request, url, localContext)).toBe('h5-browser')
      expect(shouldRequireH5Token({ request, url, h5Enabled: true, context: localContext })).toBe(true)
      expect(shouldBlockDisabledH5Access({
        request,
        url,
        h5Enabled: false,
        explicitAuthRequired: false,
        context: localContext,
      })).toBe(true)
    }
  })

  test('does not trust loopback requests carrying reverse proxy trace headers', () => {
    for (const [header, value] of [
      ['Forwarded', 'for=203.0.113.9;proto=https;host=haha.example.com'],
      ['X-Forwarded-For', '203.0.113.9'],
      ['X-Forwarded-Host', 'haha.example.com'],
      ['X-Forwarded-Proto', 'https'],
      ['X-Real-IP', '203.0.113.9'],
      ['Via', '1.1 proxy.example.com'],
    ]) {
      for (const pathname of [
        '/api/status',
        '/local-file/Users/alice/report.html',
        '/preview-fs/session-1/index.html',
        '/proxy/openai/v1/chat/completions',
        '/ws/session-1',
      ]) {
        const request = req(`http://127.0.0.1:3456${pathname}`, {
          headers: { [header]: value },
        })
        const url = new URL(request.url)

        expect(classifyH5Request(request, url, localContext)).toBe('h5-browser')
        expect(shouldRequireH5Token({ request, url, h5Enabled: true, context: localContext })).toBe(true)
        expect(shouldBlockDisabledH5Access({
          request,
          url,
          h5Enabled: false,
          explicitAuthRequired: false,
          context: localContext,
        })).toBe(true)
      }
    }
  })

  test('requires the configured local credential even when a proxy perfectly mimics loopback', () => {
    const request = req('http://127.0.0.1:3456/api/h5-access')
    const url = new URL(request.url)
    const unauthorizedContext = {
      clientAddress: '127.0.0.1',
      localAccessTokenConfigured: true,
      localAccessAuthorized: false,
    }
    const authorizedContext = {
      ...unauthorizedContext,
      localAccessAuthorized: true,
    }

    expect(classifyH5Request(request, url, unauthorizedContext)).toBe('h5-browser')
    expect(shouldBlockDisabledH5Access({
      request,
      url,
      h5Enabled: false,
      explicitAuthRequired: false,
      context: unauthorizedContext,
    })).toBe(true)
    expect(classifyH5Request(request, url, authorizedContext)).toBe('local-trusted')
  })

  test('does not grant internal SDK trust to a request carrying proxy traces', () => {
    const request = req('http://127.0.0.1:3456/sdk/session-1', {
      headers: { 'X-Forwarded-For': '203.0.113.9' },
    })

    expect(classifyH5Request(request, new URL(request.url), localContext)).toBe('h5-browser')
  })

  test('keeps no-Origin requests tokenless when both connection and target hosts are loopback', () => {
    for (const { requestUrl, clientAddress } of [
      { requestUrl: 'http://localhost:3456/api/status', clientAddress: '127.0.0.1' },
      { requestUrl: 'https://127.0.1.1:8443/api/status', clientAddress: '::ffff:127.0.0.1' },
      { requestUrl: 'http://[::1]:3456/api/status', clientAddress: '::1' },
    ]) {
      const request = req(requestUrl)
      const url = new URL(request.url)
      const context = { clientAddress }

      expect(classifyH5Request(request, url, context)).toBe('local-trusted')
      expect(shouldRequireH5Token({ request, url, h5Enabled: true, context })).toBe(false)
    }
  })

  test('requires H5 token for LAN browser API, proxy, and chat websocket routes when enabled', () => {
    for (const pathname of [
      '/api/status',
      '/api/mcp',
      '/api/plugins',
      '/api/agents',
      '/local-file/Users/alice/report.html',
      '/preview-fs/session-1/index.html',
      '/proxy/openai/v1/chat/completions',
      '/ws/session-1',
    ]) {
      const request = req(`http://192.168.0.20:3456${pathname}`, {
        headers: { Origin: 'http://192.168.0.20:3456' },
      })
      expect(classifyH5Request(request, new URL(request.url), remoteContext)).toBe('h5-browser')
      expect(shouldRequireH5Token({ request, url: new URL(request.url), h5Enabled: true, context: remoteContext })).toBe(true)
    }
  })

  test('blocks LAN browser capability routes while H5 access is disabled', () => {
    for (const pathname of [
      '/api/status',
      '/api/mcp',
      '/api/plugins',
      '/api/agents',
      '/local-file/Users/alice/report.html',
      '/preview-fs/session-1/index.html',
      '/proxy/openai/v1/chat/completions',
      '/ws/session-1',
      '/sdk/session-1',
    ]) {
      const request = req(`http://192.168.0.20:3456${pathname}`, {
        headers: { Origin: 'http://192.168.0.20:3456' },
      })
      expect(shouldBlockDisabledH5Access({
        request,
        url: new URL(request.url),
        h5Enabled: false,
        explicitAuthRequired: false,
        context: remoteContext,
      })).toBe(true)
    }
  })

  test('keeps local non-filesystem capability routes and static bootstrap routes available while H5 access is disabled', () => {
    for (const pathname of [
      '/api/status',
      '/proxy/openai/v1/chat/completions',
      '/ws/session-1',
      '/sdk/session-1',
    ]) {
      const request = req(`http://127.0.0.1:3456${pathname}`)
      expect(shouldBlockDisabledH5Access({
        request,
        url: new URL(request.url),
        h5Enabled: false,
        explicitAuthRequired: false,
        context: localContext,
      })).toBe(false)
    }

    for (const pathname of [
      '/local-file/Users/alice/report.html',
      '/preview-fs/session-1/index.html',
    ]) {
      const request = req(`http://127.0.0.1:3456${pathname}`)
      expect(shouldBlockDisabledH5Access({
        request,
        url: new URL(request.url),
        h5Enabled: false,
        explicitAuthRequired: false,
        context: localContext,
      })).toBe(false)
    }

    for (const pathname of ['/', '/health', '/assets/app.js']) {
      const request = req(`http://192.168.0.20:3456${pathname}`, {
        headers: { Origin: 'http://192.168.0.20:3456' },
      })
      expect(shouldBlockDisabledH5Access({
        request,
        url: new URL(request.url),
        h5Enabled: false,
        explicitAuthRequired: false,
        context: remoteContext,
      })).toBe(false)
    }
  })

  test('explicit deployment auth does not use the H5 token gate when H5 is disabled', () => {
    const request = req('http://127.0.0.1:3456/api/status')
    expect(shouldRequireH5Token({
      request,
      url: new URL(request.url),
      h5Enabled: false,
      context: localContext,
    })).toBe(false)
  })

  test('does not block explicitly authenticated deployments before auth middleware runs', () => {
    const request = req('http://192.168.0.20:3456/api/status', {
      headers: { Origin: 'https://phone.example' },
    })
    expect(shouldBlockDisabledH5Access({
      request,
      url: new URL(request.url),
      h5Enabled: false,
      explicitAuthRequired: true,
      context: remoteContext,
    })).toBe(false)
  })
})
