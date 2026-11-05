#!/usr/bin/env bun

import { mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { loadQuarantineManifest, quarantinedPathSet } from '../quality-gate/quarantine'
import { rootBunTestFilter } from './bun-test-filter'
import { classifyFailedFiles, formatFlakeReport } from './server-test-flakes'
import { createSandboxedTestEnvironment, removeTestDirectory } from './test-environment'
import { readServerTestSummary } from './server-test-summary'

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

async function runTestFile(file: string): Promise<TestFileResult> {
  const sandboxHome = mkdtempSync(join(tmpdir(), 'cc-haha-server-test-'))
  try {
    const proc = Bun.spawn(
      [
        'bun',
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
    const { passedTests, failedTests, skippedTests, evidenceComplete } = readServerTestSummary(output, exitCode)
    if (!evidenceComplete) {
      process.stderr.write(output)
    }
    console.log(
      `[server-tests] ${file}: ${evidenceComplete ? (passedTests > 0 ? 'passed' : `skipped (${skippedTests})`) : `failed or incomplete (${exitCode})`}`,
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
    removeTestDirectory(sandboxHome)
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
// Re-run each failed file once, alone, to tell a race from a regression. The
// exit code does not depend on the re-run.
const flakeReport = await classifyFailedFiles(
  failedFiles.map((result) => result.file).sort(),
  async (file) => (await runTestFile(file)).evidenceComplete,
)
for (const line of formatFlakeReport(flakeReport)) console.log(line)
if (flakeReport.verdicts.length > 0) {
  const artifactDir = join(root, 'artifacts', 'server-tests')
  mkdirSync(artifactDir, { recursive: true })
  writeFileSync(join(artifactDir, 'flaky.json'), JSON.stringify(flakeReport, null, 2) + '\n')
}
process.exit(flakeReport.exitCode)
