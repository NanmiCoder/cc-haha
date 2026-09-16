import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const manifest = require('../../package.json')
const repositoryRoot = path.resolve(path.dirname(require.resolve('../../package.json')), '..')
describe('ngrok native packaging', () => {
  it('ships and unpacks SDK native dependencies instead of bundling the loader', () => {
    expect(manifest.dependencies['@ngrok/ngrok']).toBeTruthy()
    expect(manifest.build.asarUnpack).toContain('node_modules/@ngrok/**')
    expect(manifest.build.files).toContain('node_modules/@ngrok/**')
    expect(manifest.scripts['build:electron']).toContain('--external @ngrok/ngrok')
    const sdkManifest = require('@ngrok/ngrok/package.json')
    for (const target of ['darwin-arm64', 'darwin-x64', 'win32-x64-msvc', 'win32-arm64-msvc']) {
      expect(sdkManifest.optionalDependencies[`@ngrok/ngrok-${target}`]).toBeTruthy()
    }
  })
  it.each(['release-desktop.yml', 'build-desktop-dev.yml'])('%s installs native addons for cross-architecture packages', workflow => {
    const source = parse(readFileSync(path.join(repositoryRoot, '.github', 'workflows', workflow), 'utf8'))
    const jobs = Object.values(source.jobs) as { steps?: { name?: string, run?: string, 'working-directory'?: string }[] }[]
    const desktopInstalls = jobs.flatMap(job => job.steps ?? []).filter(step => step.name === 'Install desktop dependencies')
    expect(desktopInstalls.length).toBeGreaterThan(0)
    for (const step of desktopInstalls) {
      expect(step['working-directory']).toBe('desktop')
      // Windows ARM64 is built on the x64 runner. Host-only installation omits
      // ngrok-win32-arm64-msvc, and npmRebuild:false cannot fetch it at packaging.
      expect(step.run).toContain('--cpu="*"')
    }
  })
  it('loads the current host native addon without opening an ngrok session', () => {
    const sdk = require('@ngrok/ngrok')
    expect(typeof sdk.forward).toBe('function')
    expect(typeof sdk.disconnect).toBe('function')
    const builder = new sdk.SessionBuilder()
    expect(typeof builder.authtoken).toBe('function')
    expect(typeof builder.handleDisconnection).toBe('function')
    expect(typeof builder.handleHeartbeat).toBe('function')
    expect(typeof builder.connect).toBe('function')
  })
})
