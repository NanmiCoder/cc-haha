#!/usr/bin/env bun

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

type LiveMode = 'smoke' | 'baseline'

export type InstallPrePushHookOptions = {
  rootDir?: string
  sourcePath?: string
  hookPath?: string
  force?: boolean
  allowCliCoreChange?: boolean
  allowCoverageBaselineChange?: boolean
  allowMissingTests?: boolean
  liveProviderModels?: string[]
  liveMode?: LiveMode
  live?: boolean
}

export type InstallPrePushHookResult = {
  hookPath: string
  liveConfigured: boolean
}

function decode(buffer: ArrayBuffer | Uint8Array) {
  return new TextDecoder().decode(buffer).trim()
}

function runGit(rootDir: string, args: string[]) {
  const proc = Bun.spawnSync(['git', ...args], {
    cwd: rootDir,
    stdout: 'pipe',
    stderr: 'pipe',
  })

  if (proc.exitCode !== 0) {
    throw new Error(decode(proc.stderr) || decode(proc.stdout) || `git ${args.join(' ')} failed`)
  }

  return decode(proc.stdout)
}

function gitHookPath(rootDir: string) {
  return resolve(rootDir, runGit(rootDir, ['rev-parse', '--git-path', 'hooks/pre-push']))
}

function gitConfig(rootDir: string, key: string, value: string) {
  runGit(rootDir, ['config', '--local', key, value])
}

function sameFileContent(leftPath: string, rightPath: string) {
  return existsSync(leftPath) && readFileSync(leftPath, 'utf8') === readFileSync(rightPath, 'utf8')
}

export function installPrePushHook(options: InstallPrePushHookOptions = {}): InstallPrePushHookResult {
  const rootDir = options.rootDir ? resolve(options.rootDir) : process.cwd()
  const sourcePath = options.sourcePath ? resolve(options.sourcePath) : resolve(rootDir, 'scripts/git-hooks/pre-push')
  const hookPath = options.hookPath ? resolve(options.hookPath) : gitHookPath(rootDir)

  if (!existsSync(sourcePath)) {
    throw new Error(`Pre-push hook source not found: ${sourcePath}`)
  }

  if (existsSync(hookPath) && !options.force && !sameFileContent(hookPath, sourcePath)) {
    throw new Error(`Refusing to overwrite existing hook at ${hookPath}. Re-run with --force after reviewing it.`)
  }

  mkdirSync(dirname(hookPath), { recursive: true })
  copyFileSync(sourcePath, hookPath)
  chmodSync(hookPath, 0o755)

  if (options.allowCliCoreChange) {
    gitConfig(rootDir, 'quality.allowCliCoreChange', 'true')
  }

  if (options.allowCoverageBaselineChange) {
    gitConfig(rootDir, 'quality.allowCoverageBaselineChange', 'true')
  }

  if (options.allowMissingTests) {
    gitConfig(rootDir, 'quality.allowMissingTests', 'true')
  }

  const shouldWriteGitConfig = !options.hookPath
  const shouldEnableLive = options.live !== false && Boolean(options.liveProviderModels?.length)

  if (shouldWriteGitConfig && shouldEnableLive) {
    gitConfig(rootDir, 'quality.prePushLive', 'true')
    gitConfig(rootDir, 'quality.prePushProviderModels', options.liveProviderModels?.join(' ') ?? '')
  } else if (shouldWriteGitConfig) {
    gitConfig(rootDir, 'quality.prePushLive', 'false')
  }

  if (options.liveMode) {
    gitConfig(rootDir, 'quality.prePushLiveMode', options.liveMode)
  }

  return {
    hookPath,
    liveConfigured: Boolean(options.liveProviderModels?.length || options.liveMode || options.live === false),
  }
}

type ParsedArgs = {
  force: boolean
  allowCliCoreChange: boolean
  allowCoverageBaselineChange: boolean
  allowMissingTests: boolean
  liveProviderModels: string[]
  liveMode?: LiveMode
  live?: boolean
  help: boolean
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    force: false,
    allowCliCoreChange: false,
    allowCoverageBaselineChange: false,
    allowMissingTests: false,
    liveProviderModels: [],
    help: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = argv[index + 1]

    if (arg === '--force') {
      parsed.force = true
    } else if (arg === '--allow-cli-core-change') {
      parsed.allowCliCoreChange = true
    } else if (arg === '--allow-coverage-baseline-change') {
      parsed.allowCoverageBaselineChange = true
    } else if (arg === '--allow-missing-tests') {
      parsed.allowMissingTests = true
    } else if (arg === '--no-live') {
      parsed.live = false
    } else if (arg === '--live-provider-model') {
      if (!next || next.startsWith('--')) {
        throw new Error('--live-provider-model requires a provider:model[:label] value')
      }
      parsed.liveProviderModels.push(next)
      index += 1
    } else if (arg === '--live-mode') {
      if (next !== 'smoke' && next !== 'baseline') {
        throw new Error('--live-mode must be smoke or baseline')
      }
      parsed.liveMode = next
      index += 1
    } else if (arg === '--help' || arg === '-h') {
      parsed.help = true
    } else {
      throw new Error(`Unknown option: ${arg}`)
    }
  }

  return parsed
}

function printHelp() {
  console.log(`Install the repository pre-push quality gate.

Usage:
  bun run hooks:install [-- --force] [-- --no-live] [-- --live-provider-model <selector>] [-- --live-mode smoke|baseline]
  bun run hooks:install -- --allow-cli-core-change --allow-coverage-baseline-change

Examples:
  bun run hooks:install
  bun run hooks:install -- --no-live
  bun run quality:providers
  bun run hooks:install -- --live-provider-model codingplan:main:codingplan-main
  bun run hooks:install -- --live-provider-model codingplan:main:codingplan-main --live-mode baseline
  bun run hooks:install -- --allow-cli-core-change --allow-coverage-baseline-change
`)
}

if (import.meta.main) {
  try {
    const args = parseArgs(process.argv.slice(2))

    if (args.help) {
      printHelp()
      process.exit(0)
    }

    const result = installPrePushHook({
      force: args.force,
      allowCliCoreChange: args.allowCliCoreChange,
      allowCoverageBaselineChange: args.allowCoverageBaselineChange,
      allowMissingTests: args.allowMissingTests,
      liveProviderModels: args.liveProviderModels,
      liveMode: args.liveMode,
      live: args.live,
    })

    console.log(`Installed pre-push quality gate: ${result.hookPath}`)
    console.log('Every git push now runs: bun run quality:push')
    console.log('Coverage remains in bun run verify, quality:pr, and CI.')

    if (args.liveProviderModels.length > 0) {
      console.log(`Live ${args.liveMode ?? 'smoke'} gate is enabled for ${args.liveProviderModels.length} provider selector(s).`)
    } else if (args.live === false) {
      console.log('Live model gate is disabled in local git config.')
    } else {
      console.log('Live model gate is disabled. Enable it with --live-provider-model after running bun run quality:providers.')
    }

    if (args.allowCliCoreChange || args.allowCoverageBaselineChange || args.allowMissingTests) {
      console.log('Local maintainer override config was updated for this clone.')
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
