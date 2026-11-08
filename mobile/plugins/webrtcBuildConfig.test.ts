import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test } from 'bun:test'
import { createSandboxedTestEnvironment, removeTestSandbox } from '../../scripts/pr/test-environment'

test('direct connections add WebRTC without call permissions, screen capture, or stripped JNI classes', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'mobile-webrtc-build-config-'))
  try {
    const root = resolve(import.meta.dir, '..')
    const output = execFileSync(process.execPath, [
      '--no-env-file', join(root, 'node_modules/expo/bin/cli'), 'config', '--type', 'introspect', '--json',
    ], {
      cwd: root,
      env: { ...createSandboxedTestEnvironment(sandbox, { CI: '1', EXPO_NO_DOTENV: '1' }), NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15000,
    })
    const config = JSON.parse(output.toString())
    const mods = config._internal.modResults
    const permissions = (mods.android.manifest.manifest['uses-permission'] as { $: Record<string, string> }[])
      .filter(permission => permission.$['tools:node'] !== 'remove')
      .map(permission => permission.$['android:name'])
    for (const unwanted of ['BLUETOOTH', 'MODIFY_AUDIO_SETTINGS', 'WAKE_LOCK', 'FOREGROUND_SERVICE_MEDIA_PROJECTION'])
      expect(permissions).not.toContain(`android.permission.${unwanted}`)
    const services = mods.android.manifest.manifest.application[0].service as { $: Record<string, string> }[]
    expect(services).toContainEqual({ $: { 'android:name': 'com.oney.WebRTCModule.MediaProjectionService', 'tools:node': 'remove' } })
    const plugins = JSON.stringify(config.plugins)
    expect(plugins).not.toContain('@config-plugins/react-native-webrtc')
    expect(plugins).toContain('-keep class org.webrtc.** { *; }')
  } finally {
    removeTestSandbox(sandbox, 'mobile webrtc config')
  }
}, 20000)
