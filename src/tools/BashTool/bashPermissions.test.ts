import { describe, expect, test } from 'bun:test'
import {
  BINARY_HIJACK_VARS,
  getFirstWordPrefix,
  getSimpleCommandPrefix,
  matchWildcardPattern,
  stripAllLeadingEnvVars,
  stripSafeWrappers,
  stripWrappersFromArgv,
} from './bashPermissions'

describe('bash permission command normalization', () => {
  test('extracts stable prefixes only through safe env vars', () => {
    expect(getSimpleCommandPrefix('NODE_ENV=production npm run build')).toBe('npm run')
    expect(getSimpleCommandPrefix('MY_VAR=value npm run build')).toBeNull()
    expect(getSimpleCommandPrefix('git commit -m "fix"')).toBe('git commit')
    expect(getSimpleCommandPrefix('chmod 755 file')).toBeNull()
  })

  test('uses first-word fallback without suggesting broad shell wrappers', () => {
    expect(getFirstWordPrefix('python3 script.py 2>&1 | tail -20')).toBe('python3')
    expect(getFirstWordPrefix('bash -c "rm -rf /tmp/x"')).toBeNull()
    expect(getFirstWordPrefix('./script.sh')).toBeNull()
  })

  test('strips only safe wrappers and leading safe env assignments', () => {
    expect(stripSafeWrappers('RUST_LOG=debug timeout -k 5s --signal TERM 10s nohup nice -n 5 -- git status')).toBe('git status')
    expect(stripSafeWrappers('timeout -k$(id) 10s ls')).toBe('timeout -k$(id) 10s ls')
    expect(stripSafeWrappers('timeout 10s FOO=bar npm test')).toBe('FOO=bar npm test')
  })

  test('normalizes wrapper argv with the same safety boundary', () => {
    expect(stripWrappersFromArgv(['timeout', '--signal', 'TERM', '10s', 'nohup', 'git', 'status'])).toEqual(['git', 'status'])
    expect(stripWrappersFromArgv(['timeout', '--signal', '$(id)', '10s', 'ls'])).toEqual(['timeout', '--signal', '$(id)', '10s', 'ls'])
    expect(stripWrappersFromArgv(['nice', '-n', '5', '--', 'git', 'status'])).toEqual(['git', 'status'])
  })

  test('strips arbitrary leading env vars for deny matching but keeps binary hijack vars', () => {
    expect(stripAllLeadingEnvVars('FOO=bar TOKEN="safe value" claude --help')).toBe('claude --help')
    expect(stripAllLeadingEnvVars('PATH=/tmp/bin claude --help', BINARY_HIJACK_VARS)).toBe('PATH=/tmp/bin claude --help')
  })

  test('matches wildcard permission patterns consistently', () => {
    expect(matchWildcardPattern('git *', 'git status --short')).toBe(true)
    expect(matchWildcardPattern('git commit', 'git status')).toBe(false)
  })
})
