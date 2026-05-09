#!/usr/bin/env bun

import { existsSync, readFileSync, appendFileSync } from 'node:fs'

export type ChangeArea =
  | 'desktop'
  | 'server'
  | 'adapters'
  | 'docs'
  | 'release'
  | 'cli-core'

export type ChangePolicyResult = {
  files: string[]
  labels: string[]
  areas: ChangeArea[]
  areaLabels: string[]
  blocked: boolean
  blockingReason: string | null
  blockingReasons: string[]
  cliCoreFiles: string[]
  coveragePolicyFiles: string[]
  missingTestSignals: string[]
  checks: {
    desktop: boolean
    server: boolean
    adapters: boolean
    desktopNative: boolean
    docs: boolean
    coverage: boolean
  }
}

const ALLOW_CLI_CORE_LABEL = 'allow-cli-core-change'
const ALLOW_MISSING_TESTS_LABEL = 'allow-missing-tests'
const ALLOW_COVERAGE_BASELINE_LABEL = 'allow-coverage-baseline-change'

const areaLabels: Record<ChangeArea, string> = {
  desktop: 'area:desktop',
  server: 'area:server',
  adapters: 'area:adapters',
  docs: 'area:docs',
  release: 'area:release',
  'cli-core': 'area:cli-core',
}

const cliCorePrefixes = [
  'bin/',
  'src/entrypoints/',
  'src/screens/',
  'src/components/',
  'src/commands/',
  'src/tools/',
  'src/utils/',
]

const desktopNativeExactPaths = new Set([
  'bun.lock',
  'package.json',
  'desktop/bun.lock',
  'desktop/package.json',
  'desktop/package-lock.json',
  'desktop/src-tauri/Cargo.lock',
  'desktop/src-tauri/Cargo.toml',
  'desktop/src-tauri/tauri.conf.json',
])

const docsExactPaths = new Set([
  'README.md',
  'README.en.md',
  'package.json',
  'package-lock.json',
  '.github/workflows/deploy-docs.yml',
])

const releaseExactPaths = new Set([
  '.github/workflows/pr-quality.yml',
  '.github/workflows/pr-triage.yml',
  '.github/workflows/release-desktop.yml',
  '.github/workflows/build-desktop-dev.yml',
  'scripts/pr/change-policy.ts',
  'scripts/pr/change-policy.test.ts',
  'scripts/pr/check-pr.ts',
  'scripts/pr/run-server-tests.ts',
  'scripts/release.ts',
  'desktop/src-tauri/tauri.conf.json',
  'desktop/src-tauri/Cargo.toml',
  'desktop/src-tauri/Cargo.lock',
])

const coveragePolicyExactPaths = new Set([
  'scripts/quality-gate/coverage-baseline.json',
  'scripts/quality-gate/coverage-thresholds.json',
])

function normalizePath(path: string) {
  return path.trim().replace(/\\/g, '/').replace(/^\.\//, '')
}

function startsWithAny(path: string, prefixes: string[]) {
  return prefixes.some((prefix) => path.startsWith(prefix))
}

function isCliCorePath(path: string) {
  return startsWithAny(path, cliCorePrefixes)
}

function areasForPath(path: string): ChangeArea[] {
  const areas = new Set<ChangeArea>()

  if (path.startsWith('desktop/')) {
    areas.add('desktop')
  }

  if (path.startsWith('src/server/')) {
    areas.add('server')
  }

  if (path.startsWith('adapters/')) {
    areas.add('adapters')
  }

  if (
    path.startsWith('docs/') ||
    path.startsWith('release-notes/') ||
    docsExactPaths.has(path)
  ) {
    areas.add('docs')
  }

  if (releaseExactPaths.has(path)) {
    areas.add('release')
  }

  if (isCliCorePath(path)) {
    areas.add('cli-core')
  }

  return [...areas]
}

function hasMatchingTest(files: string[], predicate: (file: string) => boolean) {
  return files.some((file) => (
    predicate(file) &&
    (/\.test\.[cm]?[jt]sx?$/.test(file) || file.includes('/__tests__/'))
  ))
}

function changedProductionFiles(files: string[], predicate: (file: string) => boolean) {
  return files.filter((file) => (
    predicate(file) &&
    !/\.test\.[cm]?[jt]sx?$/.test(file) &&
    !file.includes('/__tests__/') &&
    !file.includes('/fixtures/')
  ))
}

function missingTestSignals(files: string[]) {
  const signals: string[] = []
  const desktopProd = changedProductionFiles(files, (file) => file.startsWith('desktop/src/'))
  const serverProd = changedProductionFiles(files, (file) => file.startsWith('src/server/'))
  const adapterProd = changedProductionFiles(files, (file) => file.startsWith('adapters/'))
  const agentRuntimeProd = changedProductionFiles(files, (file) => (
    file.startsWith('src/tools/') ||
    file.startsWith('src/utils/')
  ))

  if (desktopProd.length > 0 && !hasMatchingTest(files, (file) => file.startsWith('desktop/src/'))) {
    signals.push('Desktop product files changed without a desktop test file in the PR.')
  }
  if (serverProd.length > 0 && !hasMatchingTest(files, (file) => file.startsWith('src/server/'))) {
    signals.push('Server product files changed without a server test file in the PR.')
  }
  if (adapterProd.length > 0 && !hasMatchingTest(files, (file) => file.startsWith('adapters/'))) {
    signals.push('Adapter product files changed without an adapter test file in the PR.')
  }
  if (agentRuntimeProd.length > 0 && !hasMatchingTest(files, (file) => file.startsWith('src/tools/') || file.startsWith('src/utils/'))) {
    signals.push('Agent/runtime product files changed without a tools/utils test file in the PR.')
  }

  return signals
}

export function evaluateChangePolicy(
  inputFiles: string[],
  inputLabels: string[] = [],
): ChangePolicyResult {
  const files = [...new Set(inputFiles.map(normalizePath).filter(Boolean))].sort()
  const labels = [...new Set(inputLabels.map((label) => label.trim()).filter(Boolean))].sort()
  const areas = new Set<ChangeArea>()

  for (const file of files) {
    for (const area of areasForPath(file)) {
      areas.add(area)
    }
  }

  const cliCoreFiles = files.filter(isCliCorePath)
  const hasCliCoreChange = cliCoreFiles.length > 0
  const hasCliCoreOverride = labels.includes(ALLOW_CLI_CORE_LABEL)
  const coveragePolicyFiles = files.filter((file) => coveragePolicyExactPaths.has(file))
  const hasCoveragePolicyOverride = labels.includes(ALLOW_COVERAGE_BASELINE_LABEL)
  const missingTests = missingTestSignals(files)
  const hasMissingTestsOverride = labels.includes(ALLOW_MISSING_TESTS_LABEL)
  const blockingReasons: string[] = []

  if (hasCliCoreChange && !hasCliCoreOverride) {
    blockingReasons.push(`CLI core changes require the ${ALLOW_CLI_CORE_LABEL} label and maintainer approval.`)
  }
  if (missingTests.length > 0 && !hasMissingTestsOverride) {
    blockingReasons.push(`Production code changes require matching tests or the ${ALLOW_MISSING_TESTS_LABEL} maintainer override.`)
  }
  if (coveragePolicyFiles.length > 0 && !hasCoveragePolicyOverride) {
    blockingReasons.push(`Coverage baseline or threshold changes require the ${ALLOW_COVERAGE_BASELINE_LABEL} label and maintainer approval.`)
  }
  const blocked = blockingReasons.length > 0

  const touchesDesktopNative = files.some((file) => (
    file.startsWith('desktop/') ||
    file.startsWith('adapters/') ||
    file.startsWith('src/server/') ||
    desktopNativeExactPaths.has(file)
  ))

  const touchesDocs = files.some((file) => (
    file.startsWith('docs/') ||
    file.startsWith('release-notes/') ||
    docsExactPaths.has(file)
  ))
  const touchesCoverage = files.some((file) => (
    file.startsWith('desktop/src/') ||
    file.startsWith('src/server/') ||
    file.startsWith('src/tools/') ||
    file.startsWith('src/utils/') ||
    file.startsWith('adapters/') ||
    file.startsWith('scripts/quality-gate/') ||
    file === 'package.json' ||
    file === 'desktop/package.json' ||
    file === 'desktop/bun.lock'
  ))

  const orderedAreas = [...areas].sort()

  return {
    files,
    labels,
    areas: orderedAreas,
    areaLabels: orderedAreas.map((area) => areaLabels[area]),
    blocked,
    blockingReason: blockingReasons[0] ?? null,
    blockingReasons,
    cliCoreFiles,
    coveragePolicyFiles,
    missingTestSignals: missingTests,
    checks: {
      desktop: areas.has('desktop') || areas.has('server'),
      server: areas.has('server') || files.some((file) => file.startsWith('src/tools/') || file.startsWith('src/utils/')),
      adapters: areas.has('adapters'),
      desktopNative: touchesDesktopNative,
      docs: touchesDocs,
      coverage: touchesCoverage,
    },
  }
}

function parseArgs(argv: string[]) {
  const args = new Map<string, string>()

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) {
      continue
    }

    const next = argv[index + 1]
    if (next && !next.startsWith('--')) {
      args.set(arg, next)
      index += 1
    } else {
      args.set(arg, 'true')
    }
  }

  return args
}

function readListFile(path: string) {
  if (!existsSync(path)) {
    throw new Error(`Missing file: ${path}`)
  }

  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

function formatSummary(result: ChangePolicyResult) {
  const lines = [
    'PR change policy',
    `  Areas: ${result.areas.length ? result.areas.join(', ') : 'none'}`,
    `  Labels: ${result.labels.length ? result.labels.join(', ') : 'none'}`,
    `  Checks: desktop=${result.checks.desktop}, server=${result.checks.server}, adapters=${result.checks.adapters}, desktopNative=${result.checks.desktopNative}, docs=${result.checks.docs}, coverage=${result.checks.coverage}`,
  ]

  if (result.cliCoreFiles.length > 0) {
    lines.push('  CLI core files:')
    for (const file of result.cliCoreFiles) {
      lines.push(`    - ${file}`)
    }
  }

  if (result.coveragePolicyFiles.length > 0) {
    lines.push('  Coverage policy files:')
    for (const file of result.coveragePolicyFiles) {
      lines.push(`    - ${file}`)
    }
  }

  if (result.missingTestSignals.length > 0) {
    lines.push('  Missing test signals:')
    for (const signal of result.missingTestSignals) {
      lines.push(`    - ${signal}`)
    }
  }

  if (result.blockingReasons.length > 0) {
    lines.push('  Blocked:')
    for (const reason of result.blockingReasons) {
      lines.push(`    - ${reason}`)
    }
  }

  return lines.join('\n')
}

function writeGithubOutputs(result: ChangePolicyResult) {
  const outputPath = process.env.GITHUB_OUTPUT
  if (!outputPath) {
    return
  }

  const outputs = {
    areas: result.areas.join(','),
    area_labels: result.areaLabels.join(','),
    blocked: String(result.blocked),
    desktop_checks: String(result.checks.desktop),
    server_checks: String(result.checks.server),
    adapter_checks: String(result.checks.adapters),
    desktop_native_checks: String(result.checks.desktopNative),
    docs_checks: String(result.checks.docs),
    coverage_checks: String(result.checks.coverage),
  }

  appendFileSync(
    outputPath,
    Object.entries(outputs)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n') + '\n',
  )
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2))
  const filesPath = args.get('--files')
  const labelsPath = args.get('--labels-file')
  const labelsArg = args.get('--labels')

  if (!filesPath) {
    console.error('Usage: bun run scripts/pr/change-policy.ts --files <changed-files.txt> [--labels-file <labels.txt>]')
    process.exit(2)
  }

  const files = readListFile(filesPath)
  const labels = labelsPath
    ? readListFile(labelsPath)
    : labelsArg?.split(',').map((label) => label.trim()).filter(Boolean) ?? []

  const result = evaluateChangePolicy(files, labels)
  console.log(formatSummary(result))
  writeGithubOutputs(result)

  if (result.blocked) {
    process.exit(1)
  }
}
