import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test } from 'bun:test'
import { createSandboxedTestEnvironment, removeTestSandbox } from '../../scripts/pr/test-environment'

test('the generated native network policies allow explicit HTTP server hostnames', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'mobile-http-build-config-'))
  try {
    const root = resolve(import.meta.dir, '..')
    const output = execFileSync(process.execPath, [
      '--no-env-file', join(root, 'node_modules/expo/bin/cli'), 'config', '--type', 'introspect', '--json',
    ], {
      cwd: root,
      env: { ...createSandboxedTestEnvironment(sandbox, {
        CI: '1', EXPO_NO_DOTENV: '1', EXPO_NO_TELEMETRY: '1', EXPO_OFFLINE: '1',
      }), NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15000,
    })
    const mods = JSON.parse(output.toString())._internal.modResults
    const ats = mods.ios.infoPlist.NSAppTransportSecurity
    expect(ats.NSAllowsArbitraryLoads).toBe(true)
    // On iOS 10+, even a false granular key makes ArbitraryLoads ineffective.
    // https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsallowsarbitraryloads
    for (const key of ['NSAllowsLocalNetworking', 'NSAllowsArbitraryLoadsForMedia', 'NSAllowsArbitraryLoadsInWebContent'])
      expect(ats).not.toHaveProperty(key)
    expect(mods.ios.infoPlist.NSLocalNetworkUsageDescription).toBeTruthy()
    const manifest = mods.android.manifest.manifest
    const application = manifest.application[0].$
    expect(application['android:usesCleartextTraffic']).toBe('true')
    expect(application).not.toHaveProperty('android:networkSecurityConfig')
    expect(manifest['uses-permission']).toContainEqual({ $: { 'android:name': 'android.permission.INTERNET' } })
  } finally {
    removeTestSandbox(sandbox, 'mobile HTTP config')
  }
}, 20000)
