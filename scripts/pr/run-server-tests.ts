#!/usr/bin/env bun

import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { loadQuarantineManifest, quarantinedPathSet } from '../quality-gate/quarantine'
import { rootBunTestFilter } from './bun-test-filter'
import { createSandboxedTestEnvironment } from './test-environment'

const root = process.cwd()
// The root runtime is wider than src/server: CLI commands, query handling,
// shared services, tools, and utils all ship in the same Bun product. Keeping a
// single src root prevents approved CLI/core changes from receiving a green
// server check without their existing tests ever being discovered.
const roots = ['src']
const excludedFiles = quarantinedPathSet(loadQuarantineManifest())
const TEST_PROCESS_CONCURRENCY = 4
const TEST_FILE_PATTERN = /\.test\.[cm]?[jt]sx?$/

function normalize(path: string) {
  return relative(root, path).split(sep).join('/')
}

function walk(path: string, files: string[]) {
  const stat = statSync(path)

  if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) {
      walk(join(path, entry), files)
    }
    return
  }

  if (!stat.isFile()) {
    return
  }

  const normalized = normalize(path)
  if (TEST_FILE_PATTERN.test(normalized) && !excludedFiles.has(normalized)) {
    files.push(normalized)
  }
}

const testFiles: string[] = []
for (const testRoot of roots) {
  walk(join(root, testRoot), testFiles)
}

testFiles.sort()

if (testFiles.length === 0) {
  console.log('No server-side test files found.')
  process.exit(0)
}

type TestFileResult = {
  file: string
  exitCode: number
  passedTests: number
  failedTests: number
  skippedTests: number
  evidenceComplete: boolean
}

function summaryCount(output: string, label: 'pass' | 'fail' | 'skip') {
  const match = output.match(new RegExp(`^\\s*(\\d+) ${label}$`, 'm'))
  return match ? Number(match[1]) : 0
}

async function runTestFile(file: string): Promise<TestFileResult> {
  const sandboxHome = mkdtempSync(join(tmpdir(), 'cc-haha-server-test-'))
  try {
    const proc = Bun.spawn(
      [
        process.execPath,
        '--no-env-file',
        'test',
        '--max-concurrency=1',
        '--timeout=20000',
        rootBunTestFilter(file),
      ],
      {
        cwd: root,
        env: createSandboxedTestEnvironment(sandboxHome),
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    const output = `${stdout}${stderr}`
    const passedTests = summaryCount(output, 'pass')
    const failedTests = summaryCount(output, 'fail')
    const skippedTests = summaryCount(output, 'skip')
    const reportedFiles = Number(
      output.match(/Ran\s+\d+\s+tests?\s+across\s+(\d+)\s+files?\./)?.[1] ?? 0,
    )
    const evidenceComplete =
      exitCode === 0 &&
      reportedFiles === 1 &&
      passedTests + failedTests + skippedTests > 0
    if (!evidenceComplete) {
      process.stderr.write(output)
    }
    console.log(
      `[server-tests] ${file}: ${evidenceComplete ? 'passed' : `failed or incomplete (${exitCode})`}`,
    )
    return {
      file,
      exitCode,
      passedTests,
      failedTests,
      skippedTests,
      evidenceComplete,
    }
  } finally {
    rmSync(sandboxHome, { recursive: true, force: true })
  }
}

let nextFile = 0
const results: TestFileResult[] = []
async function runWorker() {
  while (nextFile < testFiles.length) {
    const file = testFiles[nextFile]
    nextFile += 1
    results.push(await runTestFile(file))
  }
}

await Promise.all(
  Array.from(
    { length: Math.min(TEST_PROCESS_CONCURRENCY, testFiles.length) },
    () => runWorker(),
  ),
)

const failedFiles = results.filter((result) => !result.evidenceComplete)
console.log(
  `[server-tests] summary: files=${results.length} passed-tests=${results.reduce((total, result) => total + result.passedTests, 0)} skipped-tests=${results.reduce((total, result) => total + result.skippedTests, 0)} failed-tests=${results.reduce((total, result) => total + result.failedTests, 0)} failed-files=${failedFiles.length}`,
)
for (const result of failedFiles) {
  console.error(`[server-tests] failed-file: ${result.file} exit=${result.exitCode} pass=${result.passedTests} skip=${result.skippedTests} fail=${result.failedTests}`)
}
process.exit(failedFiles.length === 0 ? 0 : 1)
