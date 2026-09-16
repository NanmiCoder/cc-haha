import { expect, test } from 'bun:test'
import path from 'node:path'
import { evaluateSignedChainReport, fixtureSigningEnvironment, parseSignedChainArgs, planFixtureSigning, privateKeychainCommands, verifySignedChainReport } from './computer-use-signed-chain'

test('default signing plans use only the explicitly scoped private keychain', () => {
  const directory = path.resolve('/tmp/fixture')
  const keychain = path.join(directory, 'fixture.keychain-db')
  const plan = planFixtureSigning({ directory })
  expect(plan.mode).toBe('temporary')
  expect(plan.requiresPackagedInstall).toBe(false)
  expect(plan.setupCommands('password').every(command => command.args.includes(keychain))).toBe(true)
  expect(plan.signCommand('/tmp/fixture/helper.app', 'dev.cchaha.cu-helper')).toEqual({
    command: path.join(directory, 'private-signer'),
    args: [keychain, '/tmp/fixture/helper.app', 'dev.cchaha.cu-helper'],
  })
  expect(() => planFixtureSigning({ directory: 'relative' })).toThrow()
})

test('real identity signing must be explicit, nonempty, and cannot fall back to ad-hoc signing', () => {
  const identity = 'Developer ID Application: Disposable Test (TEAM123456)'
  const plan = planFixtureSigning({ directory: '/tmp/fixture', signingIdentity: identity })
  expect(plan.mode).toBe('explicit')
  expect(plan.requiresPackagedInstall).toBe(true)
  expect(plan.setupCommands('unused')).toEqual([])
  expect(plan.signCommand('/tmp/fixture/sidecar', 'sidecar', '/tmp/fixture/entitlements.plist')).toEqual({
    command: '/usr/bin/codesign',
    args: ['--force', '--sign', identity, '--identifier', 'sidecar', '--options', 'runtime', '--timestamp=none', '--entitlements', '/tmp/fixture/entitlements.plist', '/tmp/fixture/sidecar'],
  })
  for (const signingIdentity of ['', '  ', '-', '--deep']) {
    expect(() => planFixtureSigning({ directory: '/tmp/fixture', signingIdentity })).toThrow()
  }
})

test('the CLI never discovers a signing identity from defaults or a missing flag value', () => {
  expect(parseSignedChainArgs([])).toEqual({})
  expect(parseSignedChainArgs(['report.json'])).toEqual({ output: 'report.json' })
  expect(parseSignedChainArgs(['--signing-identity', 'Explicit certificate', 'report.json'])).toEqual({ signingIdentity: 'Explicit certificate', output: 'report.json' })
  for (const args of [['--signing-identity'], ['--signing-identity', ' '], ['--signing-identity', '-'], ['--signing-identity', 'A', '--signing-identity', 'B'], ['--unknown']]) {
    expect(() => parseSignedChainArgs(args)).toThrow()
  }
})

test('an authorized signing keychain is explicit even when the test HOME is isolated', () => {
  const signingIdentity = 'Developer ID Application: Disposable Test (TEAM123456)'
  const signingKeychain = '/authorized/keychains/signing.keychain-db'
  expect(parseSignedChainArgs(['--signing-identity', signingIdentity, '--signing-keychain', signingKeychain, 'report.json']))
    .toEqual({ signingIdentity, signingKeychain, output: 'report.json' })
  const plan = planFixtureSigning({ directory: '/tmp/fixture', signingIdentity, signingKeychain })
  const command = plan.signCommand('/tmp/fixture/helper.app', 'dev.cchaha.cu-helper')
  expect(command.args).toContain('--keychain')
  expect(command.args[command.args.indexOf('--keychain') + 1]).toBe(signingKeychain)
  expect(plan.setupCommands('unused')).toEqual([])
})

test('a signing keychain cannot implicitly enable real-key signing or use an ambiguous path', () => {
  for (const signingKeychain of ['', ' ', 'relative.keychain-db', '--deep']) {
    expect(() => planFixtureSigning({ directory: '/tmp/fixture', signingIdentity: 'Explicit', signingKeychain })).toThrow()
  }
  expect(() => planFixtureSigning({ directory: '/tmp/fixture', signingKeychain: '/authorized/keychain' })).toThrow()
  for (const args of [
    ['--signing-keychain', '/authorized/keychain'],
    ['--signing-identity', 'Explicit', '--signing-keychain'],
    ['--signing-identity', 'Explicit', '--signing-keychain', '/first', '--signing-keychain', '/second'],
  ]) expect(() => parseSignedChainArgs(args)).toThrow()
})

test('only explicit signing gets the authorized keychain HOME while app configuration stays isolated', () => {
  const isolated = { HOME: '/tmp/fixture/home', CFFIXED_USER_HOME: '/tmp/fixture/home', CLAUDE_CONFIG_DIR: '/tmp/fixture/config', TMPDIR: '/tmp/fixture/tmp' }
  expect(fixtureSigningEnvironment('temporary', isolated, '/authorized/home')).toBe(isolated)
  expect(fixtureSigningEnvironment('explicit', isolated, '/authorized/home')).toEqual({ ...isolated, HOME: '/authorized/home' })
  expect(isolated.HOME).toBe('/tmp/fixture/home')
  for (const userHome of [undefined, '', 'relative']) {
    expect(() => fixtureSigningEnvironment('explicit', isolated, userHome)).toThrow()
  }
})

test('private signing fixtures always address their explicit keychain and never global trust or search lists', () => {
  const keychain = '/tmp/fixture/private.keychain-db'
  const commands = privateKeychainCommands(keychain, '/tmp/fixture/identity.p12', 'disposable')
  expect(commands).toHaveLength(4)
  for (const args of commands) expect(args).toContain(keychain)
  expect(commands.map(args => args[0])).toEqual(['create-keychain', 'unlock-keychain', 'import', 'set-key-partition-list'])
  expect(() => privateKeychainCommands('relative.keychain', '/tmp/id', 'test')).toThrow()
  expect(() => privateKeychainCommands('/tmp/login.keychain-db', '/tmp/id', 'test')).toThrow()
})

test('an authenticated permission denial cannot be reported as a native GUI replay pass', () => {
  const report = {
    result: {
      ping: { protocolVersion: 'CCHahaComputerUseIPC-2' },
      permissions: { accessibility: false, screenRecording: false },
      first: { content: [{ text: '1' }] }, second: { content: [{ text: '2' }] },
      nativeObservation: { isError: true },
    },
    receiver: { completed: 0, held: false, unpaired: 0 },
    unauthorizedDirect: { ok: false, error: { code: 'unauthorized_client' } },
  }
  expect(verifySignedChainReport(report)).toBe('blocked_os_permissions')
  expect(() => verifySignedChainReport({ ...report, receiver: { ...report.receiver, completed: 1 } })).toThrow()
  expect(() => verifySignedChainReport({ ...report, result: { ...report.result, permissions: { accessibility: true, screenRecording: true } } })).toThrow()
  const failedReplay = { ...report, result: { ...report.result, permissions: { accessibility: true, screenRecording: true }, nativeObservation: {}, replay: { isError: true } }, receiver: { completed: 3, held: true, unpaired: 0 } }
  const captured = evaluateSignedChainReport(failedReplay)
  expect(captured.outcome).toBe('failed_validation')
  expect(captured.validationError).toContain('Native gesture replay failed')
  expect(captured.receiver).toEqual(failedReplay.receiver)
  expect(captured.result).toEqual(failedReplay.result)
  expect(evaluateSignedChainReport(report).outcome).toBe('blocked_os_permissions')
  expect(evaluateSignedChainReport({ ...failedReplay, result: { ...failedReplay.result, nativeObservation: { isError: true } } }).validationError).toContain('Native app observation failed')
  expect(evaluateSignedChainReport({ ...failedReplay, result: { ...failedReplay.result, nativeObservation: undefined, replay: {} }, receiver: { completed: 12, held: false, unpaired: 0 } }).outcome).toBe('failed_validation')
  expect(verifySignedChainReport({ ...report, result: { ...report.result, permissions: { accessibility: true, screenRecording: true }, nativeObservation: {}, replay: {} }, receiver: { ...report.receiver, completed: 12 } })).toBe('passed_native_gui')
  const signed = { ...report, signing: { mode: 'explicit' as const, teamIdentifier: 'TEAM123456' }, result: { ...report.result, packagedInstall: true } }
  expect(verifySignedChainReport(signed)).toBe('blocked_os_permissions')
  expect(() => verifySignedChainReport({ ...signed, result: { ...signed.result, packagedInstall: false } })).toThrow()
  for (const teamIdentifier of [undefined, '', ' ', 'not set']) {
    expect(() => verifySignedChainReport({ ...signed, signing: { mode: 'explicit', teamIdentifier } })).toThrow()
  }
})
