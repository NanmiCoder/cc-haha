#!/usr/bin/env bun

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { assertOutsideSourceGit, assertPreparedTemporaryRoot, cleanupPreparedWindowsInstallerTests, isInsideDirectory, pinnedNsisCompiler, pinnedNsisResources, sha256File, type PreparedWindowsInstallerTests } from './prepare-windows-installer-tests'
import { createSandboxedTestEnvironment } from './test-environment'

type InstallerCheckRunner = (command: string[], options: { cwd: string; env: Record<string, string> }) => Promise<number>

export async function runWindowsInstallerChecks(options: {
  platform?: NodeJS.Platform
  manifestFile?: string
  sourceRoot?: string
  tempParent?: string
  run?: InstallerCheckRunner
} = {}) {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') {
    console.log(`[windows-installer-checks] not_run on ${platform}; the selected Windows PR job must run the native NSIS cases`)
    return { status: 'not_run' as const, exitCode: 0 }
  }
  if (!options.run && process.env.CI !== 'true') throw new Error('Native installer tests may run only on a disposable Windows CI runner')
  const sourceRoot = realpathSync(options.sourceRoot ?? resolve(import.meta.dir, '../..'))
  const prepared = JSON.parse(readFileSync(options.manifestFile ?? join(sourceRoot, 'artifacts/windows-installer/prepared.json'), 'utf8')) as PreparedWindowsInstallerTests
  if (prepared.version !== 1 || prepared.status !== 'prepared' || prepared.sourceRoot !== sourceRoot || !prepared.tools || !prepared.historicalInstaller?.verified) {
    throw new Error('Windows installer checks require successful pinned dependency preparation for this source root')
  }
  const tempParent = realpathSync(options.tempParent ?? process.env.RUNNER_TEMP ?? tmpdir())
  assertPreparedTemporaryRoot(prepared, { sourceRoot, tempParent })
  if (!existsSync(prepared.tools.compiler) || !existsSync(join(prepared.tools.templates, 'include/getProcessInfo.nsh'))) {
    throw new Error('Prepared NSIS compiler or templates are missing')
  }
  if (!isInsideDirectory(prepared.tempRoot, prepared.tools.compiler) || prepared.tools.version !== pinnedNsisCompiler.version ||
      prepared.tools.archiveSha512 !== pinnedNsisCompiler.archiveSha512 ||
      await sha256File(prepared.tools.compiler) !== prepared.tools.compilerSha256) {
    throw new Error('Prepared NSIS compiler identity changed or is outside the private dependency directory')
  }
  const resources = prepared.tools.resources
  if (!resources || resources.version !== pinnedNsisResources.version || resources.archiveSha512 !== pinnedNsisResources.archiveSha512 ||
      !existsSync(resources.directory) || !isInsideDirectory(prepared.tempRoot, resources.directory) ||
      !resources.pluginsSha256 || Object.keys(resources.pluginsSha256).length !== pinnedNsisResources.plugins.length) {
    throw new Error('Prepared NSIS resources identity changed or is outside the private dependency directory')
  }
  for (const name of pinnedNsisResources.plugins) {
    const file = join(resources.directory, 'plugins/x86-unicode', name)
    if (!existsSync(file) || !isInsideDirectory(prepared.tempRoot, file) || await sha256File(file) !== resources.pluginsSha256[name]) {
      throw new Error('Prepared NSIS resources identity changed or is outside the private dependency directory')
    }
  }
  assertOutsideSourceGit(tempParent, sourceRoot)
  const sandbox = mkdtempSync(join(tempParent, 'cc-haha-nsis-run-'))
  assertOutsideSourceGit(sandbox, sourceRoot)
  const report = join(sourceRoot, 'artifacts/windows-installer/checks.json')
  mkdirSync(dirname(report), { recursive: true })
  const run = options.run ?? (async (command, spawnOptions) => {
    const child = Bun.spawn(command, { ...spawnOptions, stdout: 'inherit', stderr: 'inherit' })
    return child.exited
  })
  const command = [process.execPath, '--no-env-file', 'test', '--parallel=1', '--max-concurrency=1', '--no-orphans',
    './scripts/pr/windows-installer-process-check.test.ts', './scripts/pr/windows-installer-recovery.test.ts',
    './scripts/pr/windows-installer-guarded-removal.test.ts',
    './scripts/pr/windows-installer-member-proof.test.ts']
  try {
    const env = createSandboxedTestEnvironment(join(sandbox, 'home'), {
      CC_HAHA_TEST_MAKENSIS: prepared.tools.compiler,
      CC_HAHA_TEST_NSIS_TEMPLATES: prepared.tools.templates,
      CC_HAHA_TEST_NSIS_RESOURCES: resources.directory,
    })
    for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'CODEX_HOME', 'GH_CONFIG_DIR', 'TEMP', 'TMP', 'TMPDIR']) {
      mkdirSync(env[name]!, { recursive: true })
      assertOutsideSourceGit(env[name]!, sourceRoot)
    }
    const exitCode = await run(command, { cwd: sourceRoot, env })
    const status = exitCode === 0 ? 'passed' as const : 'failed' as const
    writeFileSync(report, `${JSON.stringify({ status, platform, command, exitCode, temporaryRoot: sandbox,
      sourceRoot, compiler: prepared.tools.compiler, templates: prepared.tools.templates, resources: resources.directory,
      historicalInstallerSha256: prepared.historicalInstaller.sha256,
      historicalProfile: 'not_proven', originalUserScenario: 'not_run', fullPackageUpgrade: 'not_run',
    }, null, 2)}\n`)
    return { status, exitCode }
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  try {
    if (process.argv.includes('--cleanup-prepared')) {
      const manifestFile = resolve('artifacts/windows-installer/prepared.json')
      if (existsSync(manifestFile)) {
        const prepared = JSON.parse(readFileSync(manifestFile, 'utf8')) as PreparedWindowsInstallerTests
        if (existsSync(prepared.tempRoot)) cleanupPreparedWindowsInstallerTests(prepared)
      }
    } else {
      process.exitCode = (await runWindowsInstallerChecks()).exitCode
    }
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}
