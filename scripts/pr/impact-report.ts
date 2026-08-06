#!/usr/bin/env bun

import { evaluateChangePolicy } from './change-policy'
import { changedFilesForLocalPrCheck } from './changed-files'
import { dependentFilesForChangeSet } from './module-graph'

function parseListArg(name: string) {
  const index = process.argv.indexOf(name)
  if (index === -1) {
    return []
  }

  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) {
    return []
  }

  return value.split(',').map((item) => item.trim()).filter(Boolean)
}

async function changedFiles() {
  const files = parseListArg('--files')
  return changedFilesForLocalPrCheck(files)
}

function commandList(result: ReturnType<typeof evaluateChangePolicy>) {
  const commands: string[] = []

  if (result.checks.policy) {
    commands.push('bun run check:policy')
  }

  if (result.checks.desktop) {
    commands.push('bun run check:desktop')
  }
  if (result.checks.server) {
    commands.push('bun run check:server')
  }
  if (result.checks.providerContract) {
    commands.push('bun run check:provider-contract')
  }
  if (result.checks.chatContract) {
    commands.push('bun run check:chat-contract')
  }
  if (result.checks.agentFlow) {
    commands.push('bun run check:agent-flow')
  }
  if (result.checks.adapters) {
    commands.push('bun run check:adapters')
  }
  if (result.checks.desktopNative) {
    commands.push('bun run check:native')
  }
  if (result.checks.persistence) {
    commands.push('bun run check:persistence-upgrade')
  }
  if (result.checks.docs) {
    commands.push('bun run check:docs')
  }
  if (result.checks.coverage) {
    commands.push('bun run check:coverage')
  }

  return commands
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
    /\.[cm]?[jt]sx?$/.test(file) &&
    !/\.test\.[cm]?[jt]sx?$/.test(file) &&
    !file.includes('/__tests__/') &&
    !file.includes('/fixtures/')
  ))
}

function coverageWarnings(files: string[]) {
  const warnings: string[] = []
  const desktopProd = changedProductionFiles(files, (file) => file.startsWith('desktop/src/'))
  const serverProd = changedProductionFiles(files, (file) => file.startsWith('src/server/'))
  const adapterProd = changedProductionFiles(files, (file) => file.startsWith('adapters/'))
  const agentRuntimeProd = changedProductionFiles(files, (file) => (
    file.startsWith('src/server/ws/') ||
    file.startsWith('src/server/services/conversation') ||
    file.startsWith('src/tools/') ||
    file.startsWith('src/utils/')
  ))

  if (desktopProd.length > 0 && !hasMatchingTest(files, (file) => file.startsWith('desktop/src/'))) {
    warnings.push('Desktop product files changed without a desktop test file in the PR.')
  }

  if (serverProd.length > 0 && !hasMatchingTest(files, (file) => file.startsWith('src/server/'))) {
    warnings.push('Server product files changed without a server test file in the PR.')
  }

  if (adapterProd.length > 0 && !hasMatchingTest(files, (file) => file.startsWith('adapters/'))) {
    warnings.push('Adapter product files changed without an adapter test file in the PR.')
  }

  if (agentRuntimeProd.length > 0) {
    warnings.push('Agent/model runtime path changed: prefer request-shape/mock tests in PR and maintainer live-model smoke before release.')
  }

  return warnings
}

function riskNotes(files: string[]) {
  const notes: string[] = []

  if (files.some((file) => file.startsWith('desktop/src-tauri/') || file.startsWith('desktop/electron/'))) {
    notes.push('Desktop native host code changed: check sidecar build, Electron IPC, packaging config, and runtime smoke output closely.')
  }
  if (files.some((file) => file.startsWith('desktop/src/stores/') || file.startsWith('desktop/src/api/'))) {
    notes.push('Desktop state/API layer changed: verify store persistence, WebSocket behavior, and startup errors.')
  }
  if (files.some((file) => file.startsWith('src/server/ws/') || file.startsWith('src/server/services/conversation'))) {
    notes.push('Session runtime changed: review reconnect, startup diagnostics, provider selection, and thinking settings.')
  }
  if (files.some((file) => file.includes('provider') || file.includes('WebSearchTool'))) {
    notes.push('Provider/search behavior changed: PR gate uses mock tests; live-provider tests should stay maintainer-only.')
  }
  if (files.some((file) => file.startsWith('.github/workflows/') || file.startsWith('scripts/pr/'))) {
    notes.push('CI/policy changed: inspect the PR workflow behavior itself, not just application tests.')
  }

  return notes
}

const labels = [
  ...parseListArg('--labels'),
  ...(process.env.PR_LABELS?.split(',').map((label) => label.trim()).filter(Boolean) ?? []),
]

if (process.env.ALLOW_CLI_CORE_CHANGE === '1') {
  labels.push('allow-cli-core-change')
}
if (process.env.ALLOW_MISSING_TESTS === '1') {
  labels.push('allow-missing-tests')
}
if (process.env.ALLOW_COVERAGE_BASELINE_CHANGE === '1') {
  labels.push('allow-coverage-baseline-change')
}

const files = await changedFiles()
const dependency = dependentFilesForChangeSet(process.cwd(), files, {
  enabled: !process.argv.includes('--no-dependency-graph'),
})
const result = evaluateChangePolicy(files, labels, dependency.dependents)
const commands = commandList(result)
const warnings = [...coverageWarnings(result.files)]
const blockingTestSignals = result.missingTestSignals
const notes = riskNotes(result.files)

console.log('# PR impact report')
console.log('')
console.log(`Changed files: ${result.files.length}`)
console.log(`Areas: ${result.areas.length ? result.areas.join(', ') : 'none'}`)
console.log(`Labels: ${result.labels.length ? result.labels.join(', ') : 'none'}`)
console.log(`Blocked: ${result.blocked ? 'yes' : 'no'}`)

if (result.blockingReason) {
  console.log('Blocking reasons:')
  for (const reason of result.blockingReasons) {
    console.log(`- ${reason}`)
  }
}

console.log('')
console.log('## Required local checks')
for (const command of commands) {
  console.log(`- \`${command}\``)
}

console.log('')
console.log('## Cross-surface impact')
if (dependency.degraded) {
  console.log(`- Dependency graph unavailable (${dependency.reason}); every surface check was selected as a safe fallback.`)
} else if (dependency.dependents.length === 0) {
  console.log('- No file outside the diff imports a changed file.')
} else {
  const pathOnly = evaluateChangePolicy(files, labels)
  const widened = (Object.keys(result.checks) as Array<keyof typeof result.checks>)
    .filter((check) => result.checks[check] && !pathOnly.checks[check])
  console.log(`- ${dependency.dependents.length} file(s) outside the diff import a changed file.`)
  if (widened.length === 0) {
    console.log('- Path-based routing already covered every importing surface.')
  } else {
    for (const check of widened) {
      const example = dependency.dependents.find((file) => (
        check === 'desktop' ? file.startsWith('desktop/src/')
          : check === 'desktopNative' ? file.startsWith('desktop/electron/') || file.startsWith('desktop/scripts/')
            : check === 'adapters' ? file.startsWith('adapters/')
              : check === 'server' ? file.startsWith('src/')
                : true
      ))
      console.log(`- Selected \`${check}\` because a changed file is imported by \`${example ?? dependency.dependents[0]}\`.`)
    }
  }
}

console.log('')
console.log('## Test coverage signals')
if (blockingTestSignals.length > 0) {
  for (const signal of blockingTestSignals) {
    console.log(`- BLOCKING: ${signal}`)
  }
}
if (warnings.length === 0 && blockingTestSignals.length === 0) {
  console.log('- No obvious missing-test signal from changed paths.')
} else {
  for (const warning of warnings) {
    console.log(`- ${warning}`)
  }
}

console.log('')
console.log('## Risk notes')
if (notes.length === 0) {
  console.log('- No special risk notes from changed paths.')
} else {
  for (const note of notes) {
    console.log(`- ${note}`)
  }
}

console.log('')
console.log('## Agent/model testing policy')
console.log('- Default PR gate should not call real models or live providers.')
console.log('- Cover agent behavior with mock CLI, request-shape assertions, transcript fixtures, and provider capability tests.')
console.log('- Run live-model smoke tests only in maintainer-controlled workflows with secrets, rate limits, and explicit labels.')
