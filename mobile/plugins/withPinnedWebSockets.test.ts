import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const { pinWebSockets } = require('./withPinnedWebSockets')
const fixture = (name: string) =>
  readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8')
// Unmodified Expo SDK 58 prebuild output, copied from this app's MainApplication.
const template = fixture('MainApplication.kt')
// What the plugin generated before the Cloudflare edge fallback existed.
const pinnedOnly = fixture('MainApplication.pinned-websocket-v1.kt')
const moduleImport =
  'import com.facebook.react.modules.websocket.WebSocketModule'
const edgeImport = 'import app.cchaha.network.CloudflareEdge'
const policy = [
  '    super.onCreate()',
  '    // cc-haha: native network policy (begin)',
  '    CloudflareEdge.install(this)',
  '    WebSocketModule.setCustomClientBuilder { builder ->',
  '      builder.followRedirects(false)',
  '      builder.followSslRedirects(false)',
  '      CloudflareEdge.configureWebSocket(builder)',
  '    }',
  '    // cc-haha: native network policy (end)',
  '    DefaultNewArchitectureEntryPoint.releaseLevel = try {',
].join('\n')

describe('native network policy config plugin', () => {
  test('pins WebSocket redirects and routes HTTP and WebSocket clients through the edge fallback before React initializes', () => {
    const output = pinWebSockets(template, 'kt')
    expect(output).toStartWith(
      `package app.cchaha.mobile\n\n${edgeImport}\n${moduleImport}\n\nimport android.app.Application\n`
    )
    expect(output).toContain(policy)
    expect(output.indexOf('CloudflareEdge.install(this)')).toBeLessThan(
      output.indexOf('loadReactNative(this)')
    )
    expect(output).toContain(
      'ApplicationLifecycleDispatcher.onApplicationCreate(this)'
    )
  })

  test('upgrades the previously generated WebSocket-only policy to exactly a fresh generation', () => {
    expect(pinnedOnly).toContain('// cc-haha: pinned WebSocket origin (begin)')
    const fresh = pinWebSockets(template, 'kt')
    expect(pinWebSockets(pinnedOnly, 'kt')).toBe(fresh)
    expect(pinWebSockets(pinnedOnly.replace(/\n/g, '\r\n'), 'kt')).toBe(
      fresh.replace(/\n/g, '\r\n')
    )
    expect(fresh).not.toContain('pinned WebSocket origin')
  })

  test('repeated generation is byte-for-byte idempotent, including existing imports and CRLF', () => {
    for (const source of [
      template,
      pinnedOnly,
      template.replace(
        'import android.app.Application',
        `${moduleImport}\nimport android.app.Application`
      ),
      template.replace(/\n/g, '\r\n'),
    ]) {
      const output = pinWebSockets(source, 'kt')
      expect(pinWebSockets(output, 'kt')).toBe(output)
      expect(output.split(moduleImport)).toHaveLength(2)
      expect(output.split(edgeImport)).toHaveLength(2)
      expect(
        output.split('WebSocketModule.setCustomClientBuilder')
      ).toHaveLength(2)
      expect(output.split('CloudflareEdge.install(this)')).toHaveLength(2)
    }
  })

  test('rejects unsupported templates instead of silently leaving redirects enabled', () => {
    expect(() => pinWebSockets(template, 'java')).toThrow(
      'Only the Expo Kotlin'
    )
    expect(() =>
      pinWebSockets(
        template.replace('override fun onCreate()', 'override fun start()'),
        'kt'
      )
    ).toThrow('Unrecognized')
    expect(() =>
      pinWebSockets(
        template.replace('super.onCreate()', 'super.onCreate();'),
        'kt'
      )
    ).toThrow('Unrecognized')
    expect(() =>
      pinWebSockets(
        template.replace('class MainApplication', 'class CustomApplication'),
        'kt'
      )
    ).toThrow('Unrecognized')
    expect(() =>
      pinWebSockets(
        template + '\n  override fun onCreate() {\n    super.onCreate()\n  }',
        'kt'
      )
    ).toThrow('Unrecognized')
  })

  test('rejects conflicting builders, factories, import aliases, and modified or misplaced generated policies', () => {
    expect(() =>
      pinWebSockets(
        template.replace(
          'super.onCreate()',
          'super.onCreate()\n    WebSocketModule.setCustomClientBuilder(null)'
        ),
        'kt'
      )
    ).toThrow('Another custom')
    expect(() =>
      pinWebSockets(
        template.replace(
          'super.onCreate()',
          'super.onCreate()\n    OkHttpClientProvider.setOkHttpClientFactory(null)'
        ),
        'kt'
      )
    ).toThrow('Another OkHttp client factory')
    expect(() =>
      pinWebSockets(
        template.replace(
          'import android.app.Application',
          `${moduleImport} as Socket\nimport android.app.Application`
        ),
        'kt'
      )
    ).toThrow('Conflicting')
    expect(() =>
      pinWebSockets(
        template.replace(
          'import android.app.Application',
          `${edgeImport} as Edge\nimport android.app.Application`
        ),
        'kt'
      )
    ).toThrow('Conflicting')
    const output = pinWebSockets(template, 'kt')
    for (const modified of [
      output.replace('followRedirects(false)', 'followRedirects(true)'),
      output.replace('      CloudflareEdge.configureWebSocket(builder)\n', ''),
      output.replace('    CloudflareEdge.install(this)\n', ''),
      output.replace('    // cc-haha: native network policy (end)', ''),
      output.replace(
        '    super.onCreate()\n',
        '    super.onCreate()\n    loadReactNative(this)\n'
      ),
    ])
      expect(() => pinWebSockets(modified, 'kt')).toThrow('modified or moved')
    for (const modified of [
      pinnedOnly.replace('followRedirects(false)', 'followRedirects(true)'),
      pinnedOnly.replace('    // cc-haha: pinned WebSocket origin (end)', ''),
      pinnedOnly.replace(
        '    super.onCreate()\n',
        '    super.onCreate()\n    loadReactNative(this)\n'
      ),
    ])
      expect(() => pinWebSockets(modified, 'kt')).toThrow('modified or moved')
  })

  test('installed React Native retains the Kotlin SAM hook used by the generated code', () => {
    const module = readFileSync(
      new URL(
        '../node_modules/react-native/ReactAndroid/src/main/java/com/facebook/react/modules/websocket/WebSocketModule.kt',
        import.meta.url
      ),
      'utf8'
    )
    const builder = readFileSync(
      new URL(
        '../node_modules/react-native/ReactAndroid/src/main/java/com/facebook/react/modules/network/CustomClientBuilder.kt',
        import.meta.url
      ),
      'utf8'
    )
    expect(module).toContain(
      'public fun setCustomClientBuilder(ccb: CustomClientBuilder?)'
    )
    expect(module.indexOf('applyCustomBuilder(okHttpBuilder)')).toBeLessThan(
      module.indexOf('val client = okHttpBuilder.build()')
    )
    expect(builder).toContain('public fun interface CustomClientBuilder')
    expect(builder).toContain('public fun apply(builder: OkHttpClient.Builder)')
  })
})
