import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { isAgentDesktopHelp, prepareAgentDesktopArguments, validateAgentDesktopInput } from './agentDesktopArguments.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

test.each(['type', 'set-value', 'clipboard-set'])('%s preserves literal debug text after the option terminator', async command => {
  const args = command === 'clipboard-set' ? ['--', '--debug'] : ['@s:e1', '--', '--debug']
  expect(await prepareAgentDesktopArguments({ command, args }, 'owned', '/unused-artifacts')).toEqual(args)
})

test.each(['--debug', '--help', '--headed', '--session'])('launch preserves the application argument %s', async value => {
  const input = { command: 'launch', args: ['Fixture', '--arg', value] }
  expect(() => validateAgentDesktopInput(input)).not.toThrow()
  expect(isAgentDesktopHelp(input)).toBe(false)
  expect(await prepareAgentDesktopArguments(input, 'owned', '/unused-artifacts')).toEqual(input.args)
})

test.each(['type', 'set-value'])('%s preserves unknown hyphen-leading text without an option terminator', async command => {
  for (const value of ['--literal-text', '-unknown']) {
    const input = { command, args: ['--timeout-ms', '5000', '@s:e1', value] }
    expect(() => validateAgentDesktopInput(input)).not.toThrow()
    expect(isAgentDesktopHelp(input)).toBe(false)
    expect(await prepareAgentDesktopArguments(input, 'owned', '/unused-artifacts')).toEqual(input.args)
  }
})

test('a real debug option receives its output option before a literal ref terminator', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cu-debug-arguments-'))
  roots.push(root)
  const args = await prepareAgentDesktopArguments({ command: 'click', args: ['--debug', '--', '@s:e1'] }, 'owned', root)
  expect(args).toEqual(['--debug', '--screenshot', expect.stringMatching(/\.html$/), '--', '@s:e1'])
})

test('actual global identity and physical-input flags remain host-owned', () => {
  for (const args of [['--headed', '@s:e1', 'hello'], ['@s:e1', '--headed', 'hello'], ['@s:e1', '--trace=/foreign.jsonl', 'hello'], ['@s:e1', 'hello', '--session=foreign']]) {
    expect(() => validateAgentDesktopInput({ command: 'type', args })).toThrow('managed by the host')
  }
  expect(isAgentDesktopHelp({ command: 'snapshot', args: ['--help'] })).toBe(true)
  expect(isAgentDesktopHelp({ command: 'type', args: ['@s:e1', '--help'] })).toBe(true)
  expect(isAgentDesktopHelp({ command: 'type', args: ['@s:e1', '--', '--help'] })).toBe(false)
})

test('global verbosity cannot bypass session-end ownership or trace output ownership', async () => {
  await expect(prepareAgentDesktopArguments({ command: 'session', args: ['--verbose', 'end', 'foreign'] }, 'owned', '/unused-artifacts')).rejects.toThrow('host-owned')
  await expect(prepareAgentDesktopArguments({ command: 'session', args: ['end', '--verbose', 'foreign'] }, 'owned', '/unused-artifacts')).rejects.toThrow('host-owned')
  expect(await prepareAgentDesktopArguments({ command: 'session', args: ['--verbose', 'end'] }, 'owned', '/unused-artifacts')).toEqual(['--verbose', 'end', 'owned'])
  const root = await mkdtemp(path.join(os.tmpdir(), 'cu-trace-arguments-'))
  roots.push(root)
  const args = await prepareAgentDesktopArguments({ command: 'trace', args: ['--verbose', 'export', '--out', '/foreign.html'] }, 'owned', root)
  expect(args).toEqual(['--verbose', 'export', '--out', expect.stringContaining(root)])
})

test('set-value does not inherit type-only option values that can hide a global flag', () => {
  for (const flag of ['--headed', '--trace=/foreign.jsonl']) {
    expect(() => validateAgentDesktopInput({ command: 'set-value', args: ['@s:e1', '--interval-ms', flag] })).toThrow('managed by the host')
  }
  expect(isAgentDesktopHelp({ command: 'set-value', args: ['@s:e1', '--interval-ms', '--help'] })).toBe(true)
})
