import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createSandboxedTestEnvironment } from '../../scripts/pr/test-environment.js'
import { _setGlobalConfigCacheForTesting, getGlobalConfig, refreshGlobalConfigFromDisk } from './config.js'
import { getFsImplementation, setFsImplementation } from './fsOperations.js'

test('refresh retains the last valid in-memory snapshot without disk writes', () => {
  const originalNodeEnv = process.env.NODE_ENV
  const originalFs = getFsImplementation()
  let content = JSON.stringify({ customApiKeyResponses: { approved: ['fake-key'], rejected: [] }, futureField: true })
  let missing = false
  try {
    // All disk reads are intercepted, including when NODE_ENV enables the
    // production cache path. No test can read or repair a real config here.
    setFsImplementation({
      ...originalFs,
      statSync: () => {
        if (missing) throw new Error('fixture missing')
        return { mtimeMs: 123, size: content.length } as ReturnType<typeof originalFs.statSync>
      },
      readFileSync: () => content,
    })
    process.env.NODE_ENV = 'production'
    expect(refreshGlobalConfigFromDisk()).toBe(true)
    const good = getGlobalConfig()
    expect(good.customApiKeyResponses.approved).toEqual(['fake-key'])
    expect(good).toHaveProperty('futureField', true)
    for (const invalid of ['{', 'null', '[]', '42']) {
      content = invalid
      expect(refreshGlobalConfigFromDisk()).toBe(false)
      expect(getGlobalConfig()).toBe(good)
    }
    missing = true
    expect(refreshGlobalConfigFromDisk()).toBe(false)
    expect(getGlobalConfig()).toBe(good)
    process.env.NODE_ENV = 'test'
    expect(refreshGlobalConfigFromDisk()).toBe(false)
  } finally {
    setFsImplementation(originalFs)
    _setGlobalConfigCacheForTesting(null)
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = originalNodeEnv
  }
})

test('explicit refresh observes external MCP writes immediately and preserves good cache on read failure', () => {
  const home = mkdtempSync(join(tmpdir(), 'config-refresh-'))
  try {
    const child = Bun.spawnSync([process.execPath, '--no-env-file', '-e', `
      const assert = await import('node:assert/strict')
      const fs = await import('node:fs')
      const { getGlobalClaudeFile } = await import(${JSON.stringify(resolve('src/utils/env.ts'))})
      const file = getGlobalClaudeFile()
      fs.mkdirSync(${JSON.stringify(join(home, '.claude'))}, { recursive: true })
      fs.writeFileSync(file, JSON.stringify({ customApiKeyResponses: { approved: ['fake-old-key'], rejected: [] }, projects: {} }))
      const config = await import(${JSON.stringify(resolve('src/utils/config.ts'))})
      config.enableConfigs()
      const before = config.getGlobalConfig()
      const external = JSON.stringify({
        customApiKeyResponses: { approved: ['fake-new-key'], rejected: [] },
        futureField: { preserve: true },
        projects: { '/fixture': { mcpServers: { late: { type: 'http', url: 'http://127.0.0.1:1/mcp' } } } }
      })
      fs.writeFileSync(file, '\\uFEFF' + external)
      assert.equal(config.getGlobalConfig(), before, 'hot-path cache is still the old snapshot')
      // The fallback represents the old behavior, which waits for the watcher.
      config.refreshGlobalConfigFromDisk?.()
      const refreshed = config.getGlobalConfig()
      assert.equal(refreshed.projects['/fixture']?.mcpServers?.late?.type, 'http', 'explicit reconnect must see the externally added MCP immediately')
      assert.deepEqual(refreshed.customApiKeyResponses.approved, ['fake-new-key'])
      assert.deepEqual(refreshed.futureField, { preserve: true })
      assert.equal(fs.readFileSync(file, 'utf8'), '\\uFEFF' + external, 'refresh is read-only')
      for (const invalid of ['{', 'null', '[]', '42']) {
        fs.writeFileSync(file, invalid)
        assert.equal(config.refreshGlobalConfigFromDisk(), false)
        assert.equal(config.getGlobalConfig(), refreshed, 'invalid JSON must not erase valid auth or MCP state')
        assert.equal(fs.readFileSync(file, 'utf8'), invalid, 'refresh must not repair or back up invalid files')
      }
      fs.unlinkSync(file)
      assert.equal(config.refreshGlobalConfigFromDisk(), false)
      assert.equal(config.getGlobalConfig(), refreshed)
      fs.mkdirSync(file)
      assert.equal(config.refreshGlobalConfigFromDisk(), false)
      assert.equal(config.getGlobalConfig(), refreshed)
      console.log('refresh fixture passed')
    `], {
      cwd: resolve('.'),
      env: createSandboxedTestEnvironment(home, { NODE_ENV: 'production' }),
      stdout: 'pipe', stderr: 'pipe',
    })
    expect(new TextDecoder().decode(child.stderr)).toBe('')
    expect(child.exitCode).toBe(0)
    expect(new TextDecoder().decode(child.stdout)).toContain('refresh fixture passed')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a pending watcher read cannot overwrite an explicit refresh with a restored older mtime', () => {
  const home = mkdtempSync(join(tmpdir(), 'config-refresh-race-'))
  try {
    const fixture = join(home, 'watcher-race.ts')
    writeFileSync(fixture, `
      import { mock } from 'bun:test'
      import * as assert from 'node:assert/strict'
      const fs = { ...await import('fs') }
      let watcher
      mock.module('fs', () => ({
        ...fs,
        watchFile: (_file, _options, callback) => { watcher = callback },
        unwatchFile: () => {},
      }))
      const { getGlobalClaudeFile } = await import(${JSON.stringify(resolve('src/utils/env.ts'))})
      const { getFsImplementation, setFsImplementation } = await import(${JSON.stringify(resolve('src/utils/fsOperations.ts'))})
      const file = getGlobalClaudeFile()
      fs.mkdirSync(${JSON.stringify(join(home, '.claude'))}, { recursive: true })
      fs.writeFileSync(file, JSON.stringify({ snapshot: 'initial' }))
      const { enableConfigs, getGlobalConfig, refreshGlobalConfigFromDisk } = await import(${JSON.stringify(resolve('src/utils/config.ts'))})
      enableConfigs()
      getGlobalConfig()
      assert.equal(typeof watcher, 'function')
      const time = Date.now()
      const pending = JSON.stringify({ snapshot: 'pending-stale', customApiKeyResponses: { approved: ['stale-fake-key'], rejected: [] } })
      fs.writeFileSync(file, pending)
      fs.utimesSync(file, (time + 8000) / 1000, (time + 8000) / 1000)
      const originalFs = getFsImplementation()
      let completeRead
      setFsImplementation({
        ...originalFs,
        readFile: (path, options) => path === file
          ? new Promise(resolve => { completeRead = () => resolve(pending) })
          : originalFs.readFile(path, options),
      })
      watcher(fs.statSync(file))
      assert.equal(typeof completeRead, 'function')
      fs.writeFileSync(file, JSON.stringify({ snapshot: 'restored-final', customApiKeyResponses: { approved: ['restored-fake-key'], rejected: [] } }))
      fs.utimesSync(file, (time + 4000) / 1000, (time + 4000) / 1000)
      assert.equal(refreshGlobalConfigFromDisk(), true)
      const refreshed = getGlobalConfig()
      assert.equal(refreshed.snapshot, 'restored-final')
      completeRead()
      await Promise.resolve()
      await Promise.resolve()
      assert.equal(getGlobalConfig(), refreshed, 'stale watcher read must not replace the explicitly refreshed snapshot')
      assert.deepEqual(getGlobalConfig().customApiKeyResponses.approved, ['restored-fake-key'])
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).snapshot, 'restored-final')
      // Ordinary overlapping watcher reads must still let the newer snapshot
      // win after an older watcher read completes first.
      const reads = []
      setFsImplementation({
        ...originalFs,
        readFile: (path, options) => path === file
          ? new Promise(resolve => {
              const snapshot = fs.readFileSync(file, 'utf8')
              reads.push(() => resolve(snapshot))
            })
          : originalFs.readFile(path, options),
      })
      for (const [snapshot, offset] of [['watch-older', 10000], ['watch-newer', 12000]]) {
        fs.writeFileSync(file, JSON.stringify({ snapshot }))
        fs.utimesSync(file, (time + offset) / 1000, (time + offset) / 1000)
        watcher(fs.statSync(file))
      }
      reads[0]()
      await Promise.resolve()
      await Promise.resolve()
      assert.equal(getGlobalConfig().snapshot, 'watch-older')
      reads[1]()
      await Promise.resolve()
      await Promise.resolve()
      assert.equal(getGlobalConfig().snapshot, 'watch-newer', 'normal newer watcher reads must still advance the cache')
      console.log('watcher race fixture passed')
    `)
    const child = Bun.spawnSync([process.execPath, '--no-env-file', fixture], {
      cwd: resolve('.'),
      env: createSandboxedTestEnvironment(home, { NODE_ENV: 'production' }),
      stdout: 'pipe', stderr: 'pipe',
    })
    expect(new TextDecoder().decode(child.stderr)).toBe('')
    expect(child.exitCode).toBe(0)
    expect(new TextDecoder().decode(child.stdout)).toContain('watcher race fixture passed')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
