#!/usr/bin/env bun
/**
 * Bundle budget gate for the editor-lsp-foundation feature.
 *
 * Asserts that the total gzipped JS bundle size in `dist/assets/` does not
 * exceed `BASELINE_GZIP_BYTES + BUDGET_GZIP_BYTES`.
 *
 * The baseline was captured on `origin/main @ 95931d49` (post-R5 default-view
 * change, pre-CodeMirror) by summing gzip-compressed output of every
 * `dist/assets/*.js` file produced by `bun run build`.
 *
 * Run before/after dependency or feature changes that affect the desktop
 * client bundle. Fails non-zero when the budget is exceeded so CI can gate it.
 *
 * _Requirements: 1.3, 1.8 (Phase 2 task 6)_
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

// Captured 2026-06-12 on origin/main @ 95931d49 (post-R5, pre-CodeMirror).
const BASELINE_GZIP_BYTES = 3_378_955
// Budget: ~100 KB (gzipped) of headroom for CodeMirror 6 core + 3 lang packs.
const BUDGET_GZIP_BYTES = 100 * 1024

const ROOT_DIR = new URL('..', import.meta.url).pathname
// Strip leading slash on Windows paths returned from URL.pathname (e.g. "/C:/...").
const DESKTOP_DIR = process.platform === 'win32' && ROOT_DIR.startsWith('/')
  ? ROOT_DIR.slice(1)
  : ROOT_DIR
const DIST_DIR = join(DESKTOP_DIR, 'dist', 'assets')

function fail(message: string): never {
  console.error(`bundle-budget: ${message}`)
  process.exit(1)
}

function formatBytes(bytes: number): string {
  return `${(bytes / 1024).toFixed(2)} KB`
}

let entries: string[]
try {
  entries = readdirSync(DIST_DIR)
} catch (err) {
  fail(
    `cannot read ${DIST_DIR}: ${err instanceof Error ? err.message : String(err)}\n` +
    `Run "bun run build" first.`,
  )
}

let totalGzip = 0
let totalRaw = 0
let jsFileCount = 0

for (const name of entries) {
  if (!name.endsWith('.js')) continue
  const fullPath = join(DIST_DIR, name)
  const stats = statSync(fullPath)
  if (!stats.isFile()) continue

  const buf = readFileSync(fullPath)
  totalRaw += buf.length
  totalGzip += gzipSync(buf).length
  jsFileCount += 1
}

if (jsFileCount === 0) {
  fail(`no .js files found in ${DIST_DIR}. Did the build emit assets?`)
}

const ceiling = BASELINE_GZIP_BYTES + BUDGET_GZIP_BYTES
const delta = totalGzip - BASELINE_GZIP_BYTES

console.log(`bundle-budget: scanned ${jsFileCount} JS files in dist/assets`)
console.log(`bundle-budget: total raw    = ${formatBytes(totalRaw)}`)
console.log(`bundle-budget: total gzip   = ${formatBytes(totalGzip)}`)
console.log(`bundle-budget: baseline     = ${formatBytes(BASELINE_GZIP_BYTES)} (origin/main @ 95931d49, pre-CodeMirror)`)
console.log(`bundle-budget: budget       = +${formatBytes(BUDGET_GZIP_BYTES)} gz`)
console.log(`bundle-budget: ceiling      = ${formatBytes(ceiling)}`)
console.log(`bundle-budget: delta        = ${delta >= 0 ? '+' : ''}${formatBytes(delta)} (vs baseline)`)

if (totalGzip > ceiling) {
  fail(
    `total gzip ${formatBytes(totalGzip)} exceeds ceiling ${formatBytes(ceiling)} ` +
    `(baseline ${formatBytes(BASELINE_GZIP_BYTES)} + budget ${formatBytes(BUDGET_GZIP_BYTES)}). ` +
    `Either reduce the change or update BASELINE_GZIP_BYTES with justification.`,
  )
}

console.log(`bundle-budget: OK (${formatBytes(ceiling - totalGzip)} headroom remaining)`)
