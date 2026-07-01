#!/usr/bin/env bun
/**
 * Offline schema validation for the reverse-engineering plugin.
 *
 * Runs the same validators that `claude plugin validate` runs, but
 * focused on this plugin and its enclosing marketplace. Use this as the
 * first step of any "did I break the manifest" check, before bringing
 * up the server / desktop UI.
 *
 * Usage (from repo root):
 *   bun run plugins/reverse-engineering/scripts/validate.ts
 *
 * Exits non-zero on any error. Warnings do not fail the run.
 */

import path from 'node:path'
import process from 'node:process'
import {
  validateMarketplaceManifest,
  validatePluginContents,
  validatePluginManifest,
  type ValidationResult,
} from '../../../src/utils/plugins/validatePlugin.js'

const repoRoot = path.resolve(import.meta.dir, '..', '..', '..')
const pluginRoot = path.join(repoRoot, 'plugins', 'reverse-engineering')
const marketplaceManifest = path.join(
  repoRoot,
  'plugins',
  '.claude-plugin',
  'marketplace.json',
)
const pluginManifest = path.join(pluginRoot, '.claude-plugin', 'plugin.json')

function fmt(result: ValidationResult): string {
  const status = result.success ? 'OK' : 'FAIL'
  const summary = `[${status}] ${result.fileType}: ${result.filePath}`
  const lines = [summary]
  for (const err of result.errors) {
    lines.push(`  ERROR ${err.path}: ${err.message}`)
  }
  for (const warn of result.warnings) {
    lines.push(`  warn  ${warn.path}: ${warn.message}`)
  }
  return lines.join('\n')
}

async function main(): Promise<void> {
  // biome-ignore lint/suspicious/noConsole:: developer tool
  console.log('Validating reverse-engineering plugin...\n')

  const results: ValidationResult[] = []
  results.push(await validateMarketplaceManifest(marketplaceManifest))
  results.push(await validatePluginManifest(pluginManifest))
  // validatePluginContents walks skills/, agents/, commands/, hooks/
  for (const r of await validatePluginContents(pluginRoot)) {
    results.push(r)
  }

  for (const r of results) {
    // biome-ignore lint/suspicious/noConsole:: developer tool
    console.log(fmt(r))
    // biome-ignore lint/suspicious/noConsole:: developer tool
    console.log('')
  }

  const failed = results.filter(r => !r.success)
  const totalWarnings = results.reduce(
    (acc, r) => acc + r.warnings.length,
    0,
  )

  // biome-ignore lint/suspicious/noConsole:: developer tool
  console.log(
    `Summary: ${results.length} files validated, ${failed.length} failed, ${totalWarnings} warnings.`,
  )

  if (failed.length > 0) {
    process.exit(1)
  }
}

main().catch(err => {
  // biome-ignore lint/suspicious/noConsole:: developer tool
  console.error(err)
  process.exit(2)
})
