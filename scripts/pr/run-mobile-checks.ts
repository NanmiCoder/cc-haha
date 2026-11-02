#!/usr/bin/env bun

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxedTestEnvironment, removeTestSandbox } from './test-environment'

export function mobileCheckEnvironment(home: string, source: NodeJS.ProcessEnv = process.env) {
  return createSandboxedTestEnvironment(home, {
    CI: '1',
    EXPO_OFFLINE: '1',
    EXPO_NO_TELEMETRY: '1',
    EXPO_NO_DOTENV: '1',
  }, source)
}

export async function runMobileChecks(root = join(import.meta.dir, '..', '..')) {
  const home = mkdtempSync(join(tmpdir(), 'cc-haha-mobile-checks-'))
  try {
    const env = mobileCheckEnvironment(home)
    // The last step builds the phone H5 the desktop serves (mobile/scripts/export-h5.ts),
    // so a change that breaks the web export fails here rather than in a desktop build.
    const commands = [['typecheck'], ['lint'], ['test'], ['export:h5', join(home, 'h5')]]
    for (const [command, ...args] of commands) {
      console.log(`[mobile-checks] ${command}`)
      const child = Bun.spawn([process.execPath, '--no-env-file', 'run', command!, ...args], {
        cwd: join(root, 'mobile'),
        env,
        stdout: 'inherit',
        stderr: 'inherit',
      })
      const code = await child.exited
      if (code !== 0) return code
    }
    return 0
  } finally {
    removeTestSandbox(home, 'mobile-checks')
  }
}

if (import.meta.main) process.exitCode = await runMobileChecks()
