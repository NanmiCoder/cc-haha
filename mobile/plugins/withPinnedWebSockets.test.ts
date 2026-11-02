import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const { pinWebSockets } = require('./withPinnedWebSockets')
// Unmodified Expo SDK 58 prebuild output, copied from this app's MainApplication.
const template = readFileSync(
  new URL('./__fixtures__/MainApplication.kt', import.meta.url),
  'utf8'
)
const moduleImport =
  'import com.facebook.react.modules.websocket.WebSocketModule'

describe('pinned native WebSockets config plugin', () => {
  test('configures both redirect policies before React initializes in the SDK 58 template', () => {
    const output = pinWebSockets(template, 'kt')
    expect(output).toContain(moduleImport)
    expect(output).toContain(
      'WebSocketModule.setCustomClientBuilder { builder ->\n      builder.followRedirects(false)\n      builder.followSslRedirects(false)\n    }'
    )
    expect(output.indexOf('super.onCreate()')).toBeLessThan(
      output.indexOf('WebSocketModule.setCustomClientBuilder')
    )
    expect(
      output.indexOf('WebSocketModule.setCustomClientBuilder')
    ).toBeLessThan(output.indexOf('loadReactNative(this)'))
    expect(output).toContain(
      'ApplicationLifecycleDispatcher.onApplicationCreate(this)'
    )
  })

  test('repeated generation is byte-for-byte idempotent, including existing imports and CRLF', () => {
    for (const source of [
      template,
      template.replace(
        'import android.app.Application',
        `${moduleImport}\nimport android.app.Application`
      ),
      template.replace(/\n/g, '\r\n'),
    ]) {
      const output = pinWebSockets(source, 'kt')
      expect(pinWebSockets(output, 'kt')).toBe(output)
      expect(output.split(moduleImport)).toHaveLength(2)
      expect(
        output.split('WebSocketModule.setCustomClientBuilder')
      ).toHaveLength(2)
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

  test('rejects conflicting builders, import aliases, and modified or misplaced generated policies', () => {
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
          'import android.app.Application',
          `${moduleImport} as Socket\nimport android.app.Application`
        ),
        'kt'
      )
    ).toThrow('Conflicting')
    const output = pinWebSockets(template, 'kt')
    expect(() =>
      pinWebSockets(
        output.replace('followRedirects(false)', 'followRedirects(true)'),
        'kt'
      )
    ).toThrow('modified or moved')
    expect(() =>
      pinWebSockets(
        output.replace('    // cc-haha: pinned WebSocket origin (end)', ''),
        'kt'
      )
    ).toThrow('modified or moved')
    expect(() =>
      pinWebSockets(
        output.replace(
          '    super.onCreate()\n',
          '    super.onCreate()\n    loadReactNative(this)\n'
        ),
        'kt'
      )
    ).toThrow('modified or moved')
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
