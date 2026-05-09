#!/usr/bin/env bun

import { runQualityGate } from './runner'
import { formatProviderTargets, loadProviderIndex, parseBaselineTargetValues } from './providerTargets'
import type { BaselineTarget, QualityGateMode } from './types'

function parseArgs(argv: string[]) {
  const args = new Map<string, Array<string | boolean>>()

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) {
      continue
    }

    const next = argv[index + 1]
    if (next && !next.startsWith('--')) {
      args.set(arg, [...(args.get(arg) ?? []), next])
      index += 1
    } else {
      args.set(arg, [...(args.get(arg) ?? []), true])
    }
  }

  return args
}

function firstArg(args: Map<string, Array<string | boolean>>, name: string) {
  return args.get(name)?.[0]
}

function hasFlag(args: Map<string, Array<string | boolean>>, name: string) {
  return args.has(name)
}

function readMode(value: string | boolean | undefined): QualityGateMode {
  if (value === 'pr' || value === 'baseline' || value === 'release') {
    return value
  }
  throw new Error('Usage: bun run quality:gate --mode <pr|baseline|release> [--dry-run] [--allow-live] [--provider-model provider:model[:label]] [--only lane-id|prefix*] [--skip lane-id|prefix*]')
}

function readBaselineTargets(args: Map<string, Array<string | boolean>>): BaselineTarget[] {
  const values = (args.get('--provider-model') ?? [])
    .filter((value): value is string => typeof value === 'string')

  return parseBaselineTargetValues(values)
}

function readStringValues(args: Map<string, Array<string | boolean>>, name: string) {
  return (args.get(name) ?? [])
    .filter((value): value is string => typeof value === 'string')
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean)
}

const args = parseArgs(process.argv.slice(2))

if (hasFlag(args, '--list-providers')) {
  console.log(formatProviderTargets(loadProviderIndex()))
  process.exit(0)
}

const mode = readMode(firstArg(args, '--mode'))
const dryRun = hasFlag(args, '--dry-run')
const allowLive = hasFlag(args, '--allow-live')
const artifactsDir = typeof firstArg(args, '--artifacts-dir') === 'string'
  ? String(firstArg(args, '--artifacts-dir'))
  : undefined
const baselineTargets = readBaselineTargets(args)

const { report, outputDir } = await runQualityGate({
  mode,
  dryRun,
  allowLive,
  baselineTargets,
  rootDir: process.cwd(),
  artifactsDir,
  onlyLaneSelectors: readStringValues(args, '--only'),
  skipLaneSelectors: readStringValues(args, '--skip'),
})

console.log(`Quality gate report: ${outputDir}/report.md`)
console.log(`Summary: passed=${report.summary.passed} failed=${report.summary.failed} skipped=${report.summary.skipped}`)

if (report.summary.failed > 0) {
  process.exit(1)
}
