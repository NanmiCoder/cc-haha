import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const manifest = require('../../package.json')
const repositoryRoot = path.resolve(path.dirname(require.resolve('../../package.json')), '..')
describe('remote access packaging', () => {
  it('does not ship the retired ngrok provider or its native loader', () => {
    expect(manifest.dependencies['@ngrok/ngrok']).toBeUndefined()
    expect(manifest.build.asarUnpack).not.toContain('node_modules/@ngrok/**')
    expect(manifest.build.files).not.toContain('node_modules/@ngrok/**')
    expect(manifest.scripts['build:electron']).not.toContain('--external @ngrok/ngrok')
  })
  it.each(['release-desktop.yml', 'build-desktop-dev.yml'])('%s installs native addons for cross-architecture packages', workflow => {
    const source = parse(readFileSync(path.join(repositoryRoot, '.github', 'workflows', workflow), 'utf8'))
    const jobs = Object.values(source.jobs) as { steps?: { name?: string, run?: string, 'working-directory'?: string }[] }[]
    const desktopInstalls = jobs.flatMap(job => job.steps ?? []).filter(step => step.name === 'Install desktop dependencies')
    expect(desktopInstalls.length).toBeGreaterThan(0)
    for (const step of desktopInstalls) {
      expect(step['working-directory']).toBe('desktop')
      // Cross-architecture packages still need their other native dependencies
      // installed before packaging because npmRebuild is disabled.
      expect(step.run).toContain('--cpu="*"')
    }
  })
})
