#!/usr/bin/env bun

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createSandboxedTestEnvironment, removeTestSandbox } from './test-environment'

type SwiftCheckRunner = (
  command: string[],
  options: { cwd: string; env: Record<string, string> },
) => Promise<number>

export async function runSwiftChecks(options: {
  platform?: NodeJS.Platform
  run?: SwiftCheckRunner
} = {}): Promise<number> {
  const platform = options.platform ?? process.platform
  if (platform !== 'darwin') {
    console.log(`[swift-checks] not applicable on ${platform}: cu-helper targets macOS; PR CI requires the macOS Swift job separately`)
    return 0
  }

  const root = resolve(import.meta.dir, '../..')
  const sandboxHome = mkdtempSync(join(tmpdir(), 'cc-haha-swift-checks-'))
  const run = options.run ?? (async (command, spawnOptions) => {
    const child = Bun.spawn(command, { ...spawnOptions, stdout: 'inherit', stderr: 'inherit' })
    return await child.exited
  })
  try {
    const env = createSandboxedTestEnvironment(sandboxHome, { CFFIXED_USER_HOME: sandboxHome })
    const swiftExit = await run([
      'swift', 'test',
      '--package-path', join(root, 'native/cu-helper'),
      '--scratch-path', join(sandboxHome, 'build'),
      '--enable-xctest',
    ], { cwd: root, env })
    if (swiftExit !== 0) return swiftExit
    // The macOS PR job and local check:native share this entrypoint. Keep the
    // shell packaging/probe regressions here so they cannot silently remain
    // unexecuted while Swift XCTest alone reports the native lane green.
    return await run([
      'bun', 'test', join(root, 'native/cu-helper/build.test.ts'),
    ], { cwd: root, env })
  } finally {
    // The tests already reported. A leftover the runner refuses to delete must not
    // turn a passing Swift lane red (seen as EROFS on GitHub macOS runners).
    removeTestSandbox(sandboxHome, 'swift-checks')
  }
}

if (import.meta.main) process.exit(await runSwiftChecks())
