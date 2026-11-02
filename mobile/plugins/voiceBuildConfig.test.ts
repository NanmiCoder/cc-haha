import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test } from 'bun:test'
import { createSandboxedTestEnvironment, removeTestSandbox } from '../../scripts/pr/test-environment'

test('the composed native config grants foreground dictation without image-picker blocking or background audio', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'mobile-voice-build-config-'))
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
    expect(mods.ios.infoPlist.NSMicrophoneUsageDescription).toContain('连接的电脑进行转写')
    expect(mods.ios.infoPlist.UIBackgroundModes).not.toContain('audio')
    const permissions = mods.android.manifest.manifest['uses-permission'] as { $: Record<string, string> }[]
    const microphone = permissions.filter(permission => permission.$['android:name'] === 'android.permission.RECORD_AUDIO')
    expect(microphone).toHaveLength(1)
    expect(microphone[0]!.$['tools:node']).not.toBe('remove')
    expect(permissions.some(permission => permission.$['android:name'].startsWith('android.permission.FOREGROUND_SERVICE'))).toBe(false)
    const services = mods.android.manifest.manifest.application[0].service ?? []
    expect(services.some((service: { $: Record<string, string> }) => service.$['android:name'].includes('audioapi'))).toBe(false)
    expect(mods.android.gradleProperties).toContainEqual({ type: 'property', key: 'disableAudioapiFFmpeg', value: 'true' })
  } finally {
    removeTestSandbox(sandbox, 'mobile voice config')
  }
}, 20000)
