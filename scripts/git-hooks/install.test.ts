import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installPrePushHook } from './install'

function runGit(rootDir: string, args: string[]) {
  const proc = Bun.spawnSync(['git', ...args], {
    cwd: rootDir,
    stdout: 'pipe',
    stderr: 'pipe',
  })

  if (proc.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(proc.stderr))
  }

  return new TextDecoder().decode(proc.stdout).trim()
}

describe('installPrePushHook', () => {
  test('copies the tracked hook and makes it executable', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'git-hook-install-test-'))
    try {
      const sourcePath = join(tempDir, 'source-pre-push')
      const hookPath = join(tempDir, 'hooks', 'pre-push')
      writeFileSync(sourcePath, '#!/usr/bin/env bash\necho quality\n')

      const result = installPrePushHook({
        rootDir: tempDir,
        sourcePath,
        hookPath,
      })

      expect(result.hookPath).toBe(hookPath)
      expect(result.liveConfigured).toBe(false)
      expect(readFileSync(hookPath, 'utf8')).toContain('echo quality')
      expect(statSync(hookPath).mode & 0o111).toBeGreaterThan(0)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('refuses to overwrite an unrelated existing hook unless forced', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'git-hook-install-test-'))
    try {
      const sourcePath = join(tempDir, 'source-pre-push')
      const hookPath = join(tempDir, 'hooks', 'pre-push')
      writeFileSync(sourcePath, '#!/usr/bin/env bash\necho new\n')
      mkdirSync(join(tempDir, 'hooks'), { recursive: true })
      writeFileSync(hookPath, '#!/usr/bin/env bash\necho old\n')

      expect(() => installPrePushHook({
        rootDir: tempDir,
        sourcePath,
        hookPath,
      })).toThrow('Refusing to overwrite existing hook')

      installPrePushHook({
        rootDir: tempDir,
        sourcePath,
        hookPath,
        force: true,
      })

      expect(readFileSync(hookPath, 'utf8')).toContain('echo new')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('disables stale live smoke settings during default install', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'git-hook-install-test-'))
    try {
      runGit(tempDir, ['init'])
      runGit(tempDir, ['config', '--local', 'quality.prePushLive', 'true'])
      runGit(tempDir, ['config', '--local', 'quality.prePushProviderModels', 'codingplan:main:codingplan-main'])
      const sourcePath = join(tempDir, 'source-pre-push')
      writeFileSync(sourcePath, '#!/usr/bin/env bash\necho default\n')

      const result = installPrePushHook({
        rootDir: tempDir,
        sourcePath,
      })

      expect(result.liveConfigured).toBe(false)
      expect(readFileSync(result.hookPath, 'utf8')).toContain('echo default')
      expect(runGit(tempDir, ['config', '--local', '--get', 'quality.prePushLive'])).toBe('false')
      expect(runGit(tempDir, ['config', '--local', '--get', 'quality.prePushProviderModels'])).toBe('codingplan:main:codingplan-main')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('stores live gate settings in local git config', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'git-hook-install-test-'))
    try {
      runGit(tempDir, ['init'])
      const sourcePath = join(tempDir, 'source-pre-push')
      writeFileSync(sourcePath, '#!/usr/bin/env bash\necho live\n')

      const result = installPrePushHook({
        rootDir: tempDir,
        sourcePath,
        liveProviderModels: ['codingplan:main:codingplan-main'],
        liveMode: 'baseline',
        allowCliCoreChange: true,
        allowCoverageBaselineChange: true,
      })

      expect(result.liveConfigured).toBe(true)
      expect(readFileSync(result.hookPath, 'utf8')).toContain('echo live')
      expect(runGit(tempDir, ['config', '--local', '--get', 'quality.prePushLive'])).toBe('true')
      expect(runGit(tempDir, ['config', '--local', '--get', 'quality.prePushProviderModels'])).toBe('codingplan:main:codingplan-main')
      expect(runGit(tempDir, ['config', '--local', '--get', 'quality.prePushLiveMode'])).toBe('baseline')
      expect(runGit(tempDir, ['config', '--local', '--get', 'quality.allowCliCoreChange'])).toBe('true')
      expect(runGit(tempDir, ['config', '--local', '--get', 'quality.allowCoverageBaselineChange'])).toBe('true')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
