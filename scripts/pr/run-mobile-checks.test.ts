import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mobileCheckEnvironment, runMobileChecks } from './run-mobile-checks'

test('mobile checks isolate developer state, credentials, Expo network and dotenv', () => {
  const home = mkdtempSync(join(tmpdir(), 'mobile-check-env-'))
  try {
    const env = mobileCheckEnvironment(home, {
      HOME: '/real-user', EXPO_TOKEN: 'private-token', ANTHROPIC_API_KEY: 'private-key',
      CC_HAHA_GOOGLE_SERVICES_FILE: '/real/firebase.json', PATH: process.env.PATH,
    })
    expect(env.HOME).toBe(home)
    expect(env.CLAUDE_CONFIG_DIR).toBe(join(home, '.claude'))
    expect(env.EXPO_TOKEN).toBeUndefined()
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.CC_HAHA_GOOGLE_SERVICES_FILE).toBeUndefined()
    expect(env.EXPO_OFFLINE).toBe('1')
    expect(env.EXPO_NO_TELEMETRY).toBe('1')
    expect(env.EXPO_NO_DOTENV).toBe('1')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test.each([0, 7])('mobile checks execute in order and stop on a failing lint (%i)', async (lintExit) => {
  const root = mkdtempSync(join(tmpdir(), 'mobile-check-run-'))
  const mobile = join(root, 'mobile')
  mkdirSync(mobile)
  writeFileSync(join(mobile, 'package.json'), JSON.stringify({ scripts: {
    typecheck: 'bun --no-env-file fixture.ts typecheck 0',
    lint: `bun --no-env-file fixture.ts lint ${lintExit}`,
    test: 'bun --no-env-file fixture.ts test 0',
    'export:h5': 'bun --no-env-file fixture.ts export:h5 0',
  } }))
  writeFileSync(join(mobile, '.env'), 'MOBILE_TEST_LEAK=unexpected\n')
  writeFileSync(join(mobile, 'fixture.ts'), `
    import { appendFileSync } from 'node:fs'
    if (process.env.MOBILE_TEST_LEAK) process.exit(91)
    appendFileSync('calls.txt', process.argv.slice(2).filter((arg, index) => index !== 1).join(' ') + '\\n')
    process.exit(Number(process.argv[3]))
  `)
  try {
    expect(await runMobileChecks(root)).toBe(lintExit)
    const calls = readFileSync(join(mobile, 'calls.txt'), 'utf8').trim().split('\n')
    if (lintExit) {
      expect(calls).toEqual(['typecheck', 'lint'])
    } else {
      expect(calls.slice(0, 3)).toEqual(['typecheck', 'lint', 'test'])
      // The H5 export runs last, into the check's own temporary directory.
      expect(calls[3]).toMatch(/^export:h5 .*mobile-checks-.*[\\/]h5$/)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
