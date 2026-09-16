import { describe, expect, test } from 'bun:test'
import {
  classifyH5Request,
  isLocalCredentialOnlyPath,
  isLoopbackHost,
  requiresLocalAccessCredential,
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

  test('requires the local process credential for loopback browser origins when configured', () => {
    const desktopContext = {
      clientAddress: '127.0.0.1',
      localAccessTokenConfigured: true,
      localAccessAuthorized: false,
    }
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
        expect(classifyH5Request(request, new URL(request.url), desktopContext)).toBe('h5-browser')
        expect(shouldRequireH5Token({ request, url: new URL(request.url), h5Enabled: true, context: desktopContext })).toBe(true)
        expect(shouldBlockDisabledH5Access({
          request,
          url: new URL(request.url),
          h5Enabled: false,
          explicitAuthRequired: false,
          context: desktopContext,
        })).toBe(true)
      }
    }
  })

  test('keeps loopback browser origins usable for tokenless local development servers', () => {
    const request = req('http://127.0.0.1:3456/api/status', {
      headers: { Origin: 'http://localhost:5173' },
    })

    expect(classifyH5Request(request, new URL(request.url), localContext)).toBe('local-trusted')
    expect(shouldRequireH5Token({ request, url: new URL(request.url), h5Enabled: true, context: localContext })).toBe(false)
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

  test('requires the configured local credential to reach the H5 control plane', () => {
    const unauthorizedContext = {
      clientAddress: '127.0.0.1',
      localAccessTokenConfigured: true,
      localAccessAuthorized: false,
    }
    const authorizedContext = {
      ...unauthorizedContext,
      localAccessAuthorized: true,
    }

    for (const pathname of ['/api/h5-access', '/api/h5-access/enable']) {
      expect(requiresLocalAccessCredential(pathname, unauthorizedContext)).toBe(true)
      expect(requiresLocalAccessCredential(pathname, authorizedContext)).toBe(false)
    }

    // Verifying a token the phone already holds is not a control-plane change,
    // and an unmanaged (tokenless) server must not lock itself out either.
    expect(requiresLocalAccessCredential('/api/h5-access/verify', unauthorizedContext)).toBe(false)
    expect(requiresLocalAccessCredential('/api/h5-access', { clientAddress: '127.0.0.1' })).toBe(false)
  })

  test('keeps bulk session deletion off the H5 token', () => {
    const unauthorizedContext = {
      clientAddress: '10.0.0.5',
      localAccessTokenConfigured: true,
      localAccessAuthorized: false,
    }
    const authorizedContext = {
      ...unauthorizedContext,
      localAccessAuthorized: true,
    }

    // One request with days=0 wipes every transcript, so a paired phone's
    // bearer token is not a strong enough credential for it.
    expect(isLocalCredentialOnlyPath('/api/settings/session-cleanup')).toBe(true)
    expect(requiresLocalAccessCredential('/api/settings/session-cleanup', unauthorizedContext)).toBe(true)
    expect(requiresLocalAccessCredential('/api/settings/session-cleanup', authorizedContext)).toBe(false)

    // The router splits on '/' and filters empties, so these shapes all reach
    // the same handler and must be gated identically.
    for (const pathname of [
      '/api/settings/session-cleanup/',
      '/api/settings//session-cleanup',
      '//api/settings/session-cleanup//',
    ]) {
      expect(isLocalCredentialOnlyPath(pathname)).toBe(true)
      expect(requiresLocalAccessCredential(pathname, unauthorizedContext)).toBe(true)
    }

    // Neighbouring settings endpoints stay reachable from the phone.
    expect(requiresLocalAccessCredential('/api/settings/user', unauthorizedContext)).toBe(false)
    expect(isLocalCredentialOnlyPath('/api/settings/session-cleanup-extra')).toBe(false)
  })

  test('keeps ordinary loopback capabilities usable without the desktop process token', () => {
    // The desktop shell injects a process token, but the OAuth success page the
    // system browser opens, a `/preview-fs` link and plain `curl` can never
    // carry it. Gating loopback behind that token 401'd all of them.
    const desktopContext = {
      clientAddress: '127.0.0.1',
      localAccessTokenConfigured: true,
      localAccessAuthorized: false,
    }

    for (const pathname of [
      '/api/haha-grok-oauth/success',
      '/api/sessions',
      '/preview-fs/session-1/index.html',
      '/ws/session-1',
    ]) {
      const request = req(`http://127.0.0.1:3456${pathname}`)
      const url = new URL(request.url)

      expect(classifyH5Request(request, url, desktopContext)).toBe('local-trusted')
      expect(shouldRequireH5Token({ request, url, h5Enabled: true, context: desktopContext })).toBe(false)
      expect(shouldBlockDisabledH5Access({
        request,
        url,
        h5Enabled: false,
        explicitAuthRequired: false,
        context: desktopContext,
      })).toBe(false)
    }
  })

  test('does not extend loopback trust to cross-site subresource loads', () => {
    // `<img src="http://127.0.0.1:3456/api/...">` from a malicious page reaches
    // us without an Origin header; only Fetch Metadata separates it from a real
    // local navigation.
    const request = req('http://127.0.0.1:3456/api/sessions', {
      headers: {
        'Sec-Fetch-Site': 'cross-site',
        'Sec-Fetch-Mode': 'no-cors',
        'Sec-Fetch-Dest': 'image',
      },
    })
    expect(classifyH5Request(request, new URL(request.url), localContext)).toBe('h5-browser')

    for (const headers of [
      // The OAuth provider redirecting the browser back to us.
      { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' },
      // The user opening the URL from the address bar or `shell.open`.
      { 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' },
      // The local H5 shell calling its own API.
      { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' },
    ]) {
      const allowed = req('http://127.0.0.1:3456/api/sessions', { headers })
      expect(classifyH5Request(allowed, new URL(allowed.url), localContext)).toBe('local-trusted')
    }
  })

  test('allows same-origin static assets only within their preview filesystem capability', () => {
    const desktopContext = {
      clientAddress: '127.0.0.1',
      localAccessTokenConfigured: true,
      localAccessAuthorized: false,
    }
    const origin = 'http://127.0.0.1:3456'
    const cases = [
      {
        requestPath: '/preview-fs/session-1/site/assets/app.js',
        refererPath: '/preview-fs/session-1/site/index.html',
      },
      {
        requestPath: '/local-file/Users/alice/site/assets/app.js',
        refererPath: '/local-file/Users/alice/site/index.html',
      },
    ]

    for (const { requestPath, refererPath } of cases) {
      const request = req(`${origin}${requestPath}`, {
        headers: {
          Origin: origin,
          Referer: `${origin}${refererPath}`,
          'Sec-Fetch-Site': 'same-origin',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Dest': 'script',
        },
      })
      const url = new URL(request.url)

      expect(classifyH5Request(request, url, desktopContext)).toBe('local-trusted')
      expect(shouldRequireH5Token({
        request,
        url,
        h5Enabled: true,
        context: desktopContext,
      })).toBe(false)
      expect(shouldBlockDisabledH5Access({
        request,
        url,
        h5Enabled: false,
        explicitAuthRequired: false,
        context: desktopContext,
      })).toBe(false)
    }
  })

  test('does not extend preview asset trust across sessions, directories or capability classes', () => {
    const desktopContext = {
      clientAddress: '127.0.0.1',
      localAccessTokenConfigured: true,
      localAccessAuthorized: false,
    }
    const origin = 'http://127.0.0.1:3456'
    const cases = [
      {
        requestPath: '/preview-fs/session-2/site/assets/app.js',
        refererPath: '/preview-fs/session-1/site/index.html',
        destination: 'script',
      },
      {
        requestPath: '/local-file/Users/alice/secrets/token.js',
        refererPath: '/local-file/Users/alice/site/index.html',
        destination: 'script',
      },
      {
        requestPath: '/api/status',
        refererPath: '/preview-fs/session-1/site/index.html',
        destination: 'empty',
      },
      {
        requestPath: '/api/h5-access',
        refererPath: '/preview-fs/session-1/site/index.html',
        destination: 'empty',
      },
      {
        requestPath: '/proxy/provider/v1/messages',
        refererPath: '/preview-fs/session-1/site/index.html',
        destination: 'empty',
      },
      {
        requestPath: '/ws/session-1',
        refererPath: '/preview-fs/session-1/site/index.html',
        destination: 'empty',
      },
      {
        requestPath: '/sdk/session-1',
        refererPath: '/preview-fs/session-1/site/index.html',
        destination: 'empty',
      },
    ]

    for (const { requestPath, refererPath, destination } of cases) {
      const request = req(`${origin}${requestPath}`, {
        headers: {
          Origin: origin,
          Referer: `${origin}${refererPath}`,
          'Sec-Fetch-Site': 'same-origin',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Dest': destination,
        },
      })

      expect(classifyH5Request(request, new URL(request.url), desktopContext))
        .toBe('h5-browser')
    }

    const originlessCrossDirectoryScript = req(
      `${origin}/preview-fs/session-1/secret.js`,
      {
        headers: {
          Referer: `${origin}/preview-fs/session-1/site/index.html`,
          'Sec-Fetch-Site': 'same-origin',
          'Sec-Fetch-Mode': 'no-cors',
          'Sec-Fetch-Dest': 'script',
        },
      },
    )
    expect(classifyH5Request(
      originlessCrossDirectoryScript,
      new URL(originlessCrossDirectoryScript.url),
      desktopContext,
    )).toBe('h5-browser')

    const external = req(`${origin}/preview-fs/session-1/site/assets/app.js`, {
      headers: {
        Origin: 'https://attacker.example',
        Referer: 'https://attacker.example/',
        'Sec-Fetch-Site': 'cross-site',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Dest': 'script',
      },
    })
    expect(classifyH5Request(external, new URL(external.url), desktopContext))
      .toBe('h5-browser')
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
