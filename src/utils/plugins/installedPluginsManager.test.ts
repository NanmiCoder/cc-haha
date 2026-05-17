import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { deletePluginCache } from './installedPluginsManager.js'

describe('deletePluginCache', () => {
  let tempDir: string
  let originalConfigDir: string | undefined
  let originalPluginCacheDir: string | undefined

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-cache-delete-'))
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR
    originalPluginCacheDir = process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR
    process.env.CLAUDE_CONFIG_DIR = path.join(tempDir, '.claude')
    delete process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR
  })

  afterEach(async () => {
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    }
    if (originalPluginCacheDir === undefined) {
      delete process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR
    } else {
      process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR = originalPluginCacheDir
    }
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  test('refuses to delete paths outside the managed plugin cache', async () => {
    const protectedDir = path.join(tempDir, '.claude')
    const sentinel = path.join(protectedDir, 'settings.json')
    await fs.mkdir(protectedDir, { recursive: true })
    await fs.writeFile(sentinel, '{"keep":true}', 'utf-8')

    expect(() => deletePluginCache(protectedDir)).toThrow(
      'Refusing to delete plugin cache outside managed cache directory',
    )

    await expect(fs.readFile(sentinel, 'utf-8')).resolves.toBe('{"keep":true}')
  })

  test('deletes only versioned directories under the managed plugin cache', async () => {
    const versionDir = path.join(
      tempDir,
      '.claude',
      'plugins',
      'cache',
      'marketplace',
      'plugin',
      '1.0.0',
    )
    const sentinel = path.join(versionDir, 'plugin.json')
    await fs.mkdir(versionDir, { recursive: true })
    await fs.writeFile(sentinel, '{"name":"plugin"}', 'utf-8')

    deletePluginCache(versionDir)

    await expect(fs.stat(versionDir)).rejects.toThrow()
    await expect(fs.stat(path.join(tempDir, '.claude'))).resolves.toBeDefined()
  })
})
