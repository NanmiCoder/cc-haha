import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { candidateBuildCommands, candidateCaptureScript, candidatePackage, cleanupCandidateDirectory, runCandidatePackage, validateCandidatePackageTrigger, verifyCandidateOutputs } from './prepare-windows-installer-candidate-package'
import { type SevenZipRunner } from './windows-installer-member-proof'

const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
const head = 'a'.repeat(40), nonce = 'fixture-only-nonce'
function trigger() {
  return { event: { action: 'synchronize', number: 1883, pull_request: { number: 1883,
    base: { ref: 'main', repo: { full_name: 'NanmiCoder/cc-haha' } },
    head: { sha: head, ref: 'fix/installer-fallback-foreign-helpers', repo: { full_name: 'toBerlinWay/cc-haha' } } } },
    env: { CI: 'true', GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'pull_request', GITHUB_REPOSITORY: 'NanmiCoder/cc-haha',
      GITHUB_RUN_ATTEMPT: '1', GITHUB_RUN_ID: '12345', WINDOWS_INSTALLER_CHECKS_RESULT: 'success' } }
}
function ownedFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-haha-candidate-package-unit-')))
  const temp = join(root, 'private build with spaces'), source = join(temp, 'source'), evidence = join(root, 'evidence'), capture = join(evidence, 'capture')
  for (const dir of [source, capture]) mkdirSync(dir, { recursive: true })
  const put = (file: string, bytes: Buffer | string) => {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, bytes)
    return file
  }
  return { root, temp, source, evidence, capture, put, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

describe('candidate package execution boundary', () => {
  test.each(['opened', 'synchronize', 'reopened', 'ready_for_review'])('accepts only an exact checked-out ordinary %s PR after successful Windows checks', action => {
    const f = trigger()
    f.event.action = action
    expect(validateCandidatePackageTrigger(f.event, f.env, head)).toEqual({ sourceHead: head, runId: '12345', runAttempt: 1, eventAction: action })
  })
  test.each(['labeled', 'unlabeled', 'push', 'workflow_dispatch', 'closed', 'unknown'])('rejects %s without a build', action => {
    const f = trigger()
    f.event.action = action
    expect(() => validateCandidatePackageTrigger(f.event, f.env, head)).toThrow('reviewed PR')
  })
  test.each(['repository', 'number', 'nested-number', 'base', 'base-repo', 'head-repo', 'head-ref', 'head', 'attempt', 'run-id', 'windows', 'ci', 'actions', 'event'])('rejects changed %s identity before a build', kind => {
    const f = trigger()
    if (kind === 'repository') f.env.GITHUB_REPOSITORY = 'other/repo'
    if (kind === 'number') f.event.number++
    if (kind === 'nested-number') f.event.pull_request.number++
    if (kind === 'base') f.event.pull_request.base.ref = 'other'
    if (kind === 'base-repo') f.event.pull_request.base.repo.full_name = 'other/repo'
    if (kind === 'head-repo') f.event.pull_request.head.repo.full_name = 'other/repo'
    if (kind === 'head-ref') f.event.pull_request.head.ref = 'fix/other'
    if (kind === 'head') f.event.pull_request.head.sha = 'b'.repeat(40)
    if (kind === 'attempt') f.env.GITHUB_RUN_ATTEMPT = '2'
    if (kind === 'run-id') f.env.GITHUB_RUN_ID = 'unknown'
    if (kind === 'windows') f.env.WINDOWS_INSTALLER_CHECKS_RESULT = 'skipped'
    if (kind === 'ci') f.env.CI = 'false'
    if (kind === 'actions') f.env.GITHUB_ACTIONS = 'false'
    if (kind === 'event') f.env.GITHUB_EVENT_NAME = 'pull_request_target'
    expect(() => validateCandidatePackageTrigger(f.event, f.env, head)).toThrow('reviewed PR')
  })
  test.skipIf(process.platform === 'win32')('cannot run a real build on this host', async () => {
    await expect(runCandidatePackage()).rejects.toThrow('Windows CI only')
  })
  test('uses the full release builder after frozen workspace installs and real dependency preparation', () => {
    const f = ownedFixture()
    try {
      const bun = join(f.temp, 'bun'), commands = candidateBuildCommands(f.source, join(f.temp, 'powershell'), bun)
      expect(commands.slice(0, 4).map(value => value.cwd)).toEqual(['', 'desktop', 'adapters', 'mobile'].map(value => join(f.source, value)))
      for (const item of commands.slice(0, 4)) expect(item.argv).toEqual([bun, 'install', '--frozen-lockfile'])
      expect(commands.map(item => item.name)).toContain('prepare-ripgrep')
      expect(commands.find(item => item.name === 'fetch-native')!.argv).toContain('--locked')
      expect(commands.at(-1)!.argv.at(-1)).toBe(join(f.source, 'desktop/scripts/build-windows-x64.ps1'))
      expect(commands.flatMap(item => item.argv).some(arg => /fake|stub|tiny|old-setup|profile|--publish always/.test(arg))).toBe(false)
    } finally { f.cleanup() }
  })
  test.each(['owner', 'parent', 'prefix'])('refuses %s mismatch cleanup, retaining owned fixture evidence', kind => {
    const f = ownedFixture(), directory = realpathSync(mkdtempSync(join(f.root, kind === 'prefix' ? 'foreign-' : 'cc-haha-candidate-package-')))
    try {
      writeFileSync(join(directory, '.owner'), nonce)
      expect(() => cleanupCandidateDirectory(directory, kind === 'parent' ? f.temp : f.root, kind === 'owner' ? 'other' : nonce)).toThrow('Unowned')
      expect(existsSync(directory)).toBe(true)
      if (kind !== 'prefix') {
        cleanupCandidateDirectory(directory, f.root, nonce)
        expect(existsSync(directory)).toBe(false)
      }
    } finally { f.cleanup() }
  })
})

describe('observation of the unchanged NSIS compiler path', () => {
  function fixture(outside = false) {
    const f = ownedFixture()
    const helperSource = f.put(join(f.source, 'desktop/build/guarded-removal.cs'), '// fixture; no compiler/PE execution')
    const image = Buffer.from('MZ fixture compiled helper; never executed'), config = Buffer.from('<fixture/>')
    const compilerOutput = outside ? join(f.root, 'outside') : join(f.temp, 'compiler-output')
    mkdirSync(compilerOutput)
    const guarded = f.put(join(f.source, 'desktop/scripts/nsis-guarded-removal.cjs'), `const f=require('node:fs'),p=require('node:path'),c=require('node:crypto');exports.compile=o=>{const executable=p.join(${JSON.stringify(compilerOutput)},'helper.exe'),config=executable+'.config';const image=Buffer.from(${JSON.stringify([...image])}),settings=Buffer.from(${JSON.stringify([...config])});f.writeFileSync(executable,image);f.writeFileSync(config,settings);return{executable,config,bytes:image.length,sha256:c.createHash('sha256').update(image).digest('hex'),configBytes:settings.length,configSha256:c.createHash('sha256').update(settings).digest('hex'),sourceSha256:c.createHash('sha256').update(f.readFileSync(o.source)).digest('hex')}}`)
    const legacy = f.put(join(f.source, 'desktop/scripts/nsis-legacy-compat.cjs'), `exports.run=(mode,args)=>{if(mode==='prepare-guarded')require('./nsis-guarded-removal.cjs').compile({source:args[0]});return 42}`)
    const uninstaller = f.put(join(f.source, 'desktop/build-artifacts/electron/owned.__uninstaller.exe'), 'MZ fixture current uninstaller; never executed')
    const configFile = f.put(join(f.temp, 'capture-config.json'), JSON.stringify({ source: f.source, temp: f.temp, output: f.capture, sourceHead: head, nonce,
      sourceSha256: sha(readFileSync(helperSource)), legacySha256: sha(readFileSync(legacy)), guardedSha256: sha(readFileSync(guarded)), uninstaller }))
    const preload = f.put(join(f.temp, 'capture.cjs'), candidateCaptureScript(configFile))
    const run = (mode: string, args: string[]) => spawnSync('node', ['-e', 'console.log(require(process.argv[1]).run(process.argv[2],JSON.parse(process.argv[3])))', legacy, mode, JSON.stringify(args)], { encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NODE_OPTIONS: `--require="${preload}"` } })
    return { ...f, helperSource, image, config, compilerOutput, uninstaller, run }
  }
  test('captures exact produced bytes before normal temp cleanup, preserving original return values', () => {
    const f = fixture()
    try {
      const helper = f.run('prepare-guarded', [f.helperSource])
      expect(helper.status, helper.stderr).toBe(0)
      expect(helper.stdout.trim()).toBe('42')
      const uninstall = f.run('prepare', [f.uninstaller, '/owned/bootstrap'])
      expect(uninstall.status, uninstall.stderr).toBe(0)
      expect(uninstall.stdout.trim()).toBe('42')
      rmSync(f.compilerOutput, { recursive: true })
      rmSync(f.uninstaller)
      expect(readFileSync(join(f.capture, 'compiled-helper.exe'))).toEqual(f.image)
      expect(readFileSync(join(f.capture, 'compiled-helper.exe.config'))).toEqual(f.config)
      expect(JSON.parse(readFileSync(join(f.capture, 'helper-capture.json'), 'utf8'))).toMatchObject({ sourceHead: head, nonce, helper: { bytes: f.image.length, sha256: sha(f.image) } })
      expect(existsSync(join(f.capture, 'uninstaller-capture.json'))).toBe(true)
    } finally { f.cleanup() }
  })
  test.each(['outside', 'wrong-source', 'duplicate'])('fails capture for %s without combining unrelated output', kind => {
    const f = fixture(kind === 'outside')
    try {
      if (kind === 'duplicate') expect(f.run('prepare-guarded', [f.helperSource]).status).toBe(0)
      const source = kind === 'wrong-source' ? f.put(join(f.source, 'other.cs'), 'other') : f.helperSource
      const result = f.run('prepare-guarded', [source])
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain(kind === 'outside' ? 'Candidate capture file boundary' : kind === 'wrong-source' ? 'Candidate helper source changed' : 'EEXIST')
      if (kind !== 'duplicate') expect(existsSync(join(f.capture, 'helper-capture.json'))).toBe(false)
    } finally { f.cleanup() }
  })
})

describe('static candidate package lineage', () => {
  async function fixture() {
    const f = ownedFixture(), output = join(f.source, 'desktop/build-artifacts/windows-x64')
    const setup = f.put(join(output, candidatePackage.setupName), 'MZ owned sparse setup fixture; never executed')
    truncateSync(setup, 100 * 1024 * 1024)
    const helper = Buffer.from('MZ owned helper bytes; never executed'), uninstall = Buffer.from('MZ owned uninstaller bytes; never executed')
    const settings: Buffer = createRequire(import.meta.url)('../../desktop/scripts/nsis-guarded-removal.cjs').clrConfig
    const pin = (name: string, data: Buffer) => {
      const file = f.put(join(f.capture, name), data)
      return { file, bytes: data.length, sha256: sha(data) }
    }
    const source = f.put(join(f.source, 'desktop/build/guarded-removal.cs'), '// fixture source')
    f.put(join(f.capture, 'helper-capture.json'), JSON.stringify({ version: 1, sourceHead: head, nonce, sourceSha256: sha(readFileSync(source)), helper: pin('compiled-helper.exe', helper), config: pin('compiled-helper.exe.config', settings) }))
    f.put(join(f.capture, 'uninstaller-capture.json'), JSON.stringify({ version: 1, sourceHead: head, nonce, output: pin('compiled-uninstaller.exe', uninstall) }))
    const pe = Buffer.alloc(256)
    pe.write('MZ')
    pe.writeUInt32LE(64, 0x3c)
    pe.write('PE\0\0', 64)
    pe.writeUInt16LE(0x8664, 68)
    const app = f.put(join(output, 'win-unpacked/Claude Code Haha.exe'), pe)
    const sidecar = f.put(join(output, `win-unpacked/resources/app.asar.unpacked/src-tauri/binaries/claude-sidecar-${candidatePackage.target}.exe`), pe)
    const main = 'module.exports = "owned bundle; never executed"'
    f.put(join(f.source, 'desktop/electron-dist/main.cjs'), main)
    f.put(join(output, 'win-unpacked/resources/app.asar'), JSON.stringify({ 'package.json': JSON.stringify({ version: '0.7.8' }), 'electron-dist/main.cjs': main }))
    f.put(join(f.source, 'desktop/package.json'), '{"name":"test-owned-only"}')
    f.put(join(f.source, 'desktop/node_modules/app-builder-lib/package.json'), '{"name":"app-builder-lib","version":"fixture"}')
    f.put(join(f.source, 'desktop/node_modules/@electron/asar/index.js'), `exports.extractFile=(file,name)=>Buffer.from(JSON.parse(require('node:fs').readFileSync(file,'utf8'))[name])`)
    const tool = f.put(join(f.temp, '7z.exe'), 'MZ owned fake tool; never executed')
    const calls: string[][] = []
    let mutation = ''
    const run: SevenZipRunner = (_file, argv) => {
      calls.push(argv)
      const setupRead = argv.includes(setup)
      const configRead = !setupRead && argv.at(-1) === candidatePackage.helperConfigLiteral
      const literal = setupRead ? candidatePackage.uninstallerLiteral : configRead ? candidatePackage.helperConfigLiteral : candidatePackage.helperLiteral
      const bytes = setupRead ? uninstall : configRead ? settings : helper
      let stdout: Buffer
      if (argv[0] === 'i') stdout = Buffer.from('7-Zip 26.06 (x64)\nFormats:\n F Nsis nsis\nCodecs:\n')
      else if (argv[0] === 'l') {
        const member = `Path = ${mutation === 'literal' || (mutation === 'helper-literal' && !setupRead) ? 'Other.exe' : literal}\nSize = ${bytes.length}\nPacked Size = 10`
        const config = `Path = ${mutation === 'config-literal' ? 'cc-haha-guarded-removal.exe.config' : candidatePackage.helperConfigLiteral}\nSize = ${settings.length + (mutation === 'config-size' ? 1 : 0)}\nPacked Size = 10${mutation === 'config-folder' ? '\nFolder = +' : mutation === 'config-encrypted' ? '\nEncrypted = +' : ''}`
        stdout = Buffer.from(`--\nPath = ${argv.at(-1)}\nType = Nsis\n\n----------\n${member}\n${mutation === 'duplicate' ? `\n${member}\n` : ''}${!setupRead && mutation !== 'config-missing' ? `\n${config}\n${mutation === 'config-duplicate' ? `\n${config}\n` : ''}` : ''}`)
      } else {
        stdout = mutation === 'bytes' || (mutation === 'helper-bytes' && !setupRead) ? Buffer.from('MZ changed bytes') : bytes
        if (configRead && mutation === 'config-bytes') { stdout = Buffer.from(settings); stdout[20] = stdout[20]! ^ 1 }
      }
      return { status: 0, stdout, stderr: Buffer.alloc(0) }
    }
    const options = { source: f.source, temp: f.temp, evidence: f.evidence, trigger: validateCandidatePackageTrigger(trigger().event, trigger().env, head), nonce,
      extractor: { version: '26.06', executable: tool, files: [{ file: tool, bytes: readFileSync(tool).length, sha256: sha(readFileSync(tool)) }] }, run }
    return { ...f, output, setup, app, sidecar, settings, calls, options, mutate: (value: string) => { mutation = value } }
  }
  test('binds the complete setup, exact uninstaller and embedded compiled helper plus actual unpacked payload hashes', async () => {
    const f = await fixture()
    try {
      const receipt = await verifyCandidateOutputs(f.options)
      expect(receipt.kind).toBe('full-electron-nsis-package')
      expect(receipt.displayVersion).toBe('0.7.8')
      expect(receipt.payloads.map(value => value.kind)).toEqual(['app-exe', 'app-asar', 'sidecar'])
      expect(receipt.uninstallerMember.proof.status).toBe('member_proven')
      expect(receipt.helperMember.proof.status).toBe('member_proven')
      expect(receipt.configMember.proof.status).toBe('member_proven')
      for (const args of f.calls.filter(value => value[0] === 'e')) {
        expect(args).toContain('-spd')
        expect(args).toContain('-tNsis')
      }
      expect(f.calls.filter(value => value[0] === 'e').map(value => value.at(-1))).toEqual([candidatePackage.uninstallerLiteral, candidatePackage.helperLiteral, candidatePackage.helperConfigLiteral])
      expect(receipt.runtimeInstall).toBe('not_run')
      expect(receipt.fullF1).toBe('not_proven')
    } finally { f.cleanup() }
  })
  test('embedded helper config binds non-PE compiler XML bytes to its full literal packaged member', async () => {
    const f = await fixture()
    try {
      const receipt = await verifyCandidateOutputs(f.options)
      const proof = receipt.configMember.proof
      expect(proof.status).toBe('member_proven')
      expect(proof.contentKind).toBe('helper-runtime-config')
      expect(proof.literalMember).toBe('$PLUGINSDIR\\cc-haha-guarded-removal.exe.config')
      expect(proof.member!.Path).toBe(proof.literalMember)
      expect(proof.setup.sha256).toBe(receipt.uninstallerSha256)
      expect(proof.captured).toEqual(receipt.compiledConfig)
      expect(proof.output!.bytes).toBe(f.settings.length)
      expect(proof.output!.sha256).toBe(sha(f.settings))
      expect(readFileSync(proof.output!.file)).toEqual(f.settings)
      expect(f.settings.toString('utf8')).toStartWith('<?xml')
      expect(f.settings.toString('ascii', 0, 2)).not.toBe('MZ')
      expect(proof.commands.map(value => value.argv[0])).toEqual(['l', 'e'])
      for (const command of proof.commands) {
        expect(command.argv).toContain('-tNsis')
        expect(command.status).toBe(0)
      }
      expect(proof.commands[1]!.argv).toEqual(['e', '-tNsis', '-spd', '-so', '-bso0', '-bse2', '-bsp0', '--', proof.setup.file, proof.literalMember])
      expect(readFileSync(proof.commands[1]!.stdout.file!)).toEqual(f.settings)
      expect(JSON.parse(readFileSync(receipt.configMember.evidenceFile, 'utf8')).status).toBe('member_proven')
      expect(receipt.fullF1).toBe('not_proven')
    } finally { f.cleanup() }
  })
  test.each(['missing', 'duplicate', 'literal', 'bytes', 'size', 'folder', 'encrypted'])('embedded helper config rejects %s and leaves package unprepared', async kind => {
    const f = await fixture()
    try {
      f.mutate(`config-${kind}`)
      await expect(verifyCandidateOutputs(f.options)).rejects.toThrow('member is not proven')
      expect(existsSync(join(f.evidence, 'candidate-package-receipt.json'))).toBe(false)
      expect(existsSync(join(f.evidence, 'embedded-helper.exe.config'))).toBe(false)
      if (kind !== 'duplicate') {
        const proof = JSON.parse(readFileSync(join(f.evidence, 'uninstaller-config-member/member-proof.json'), 'utf8'))
        expect(proof.status).toBe('not_proven')
        expect(proof.literalMember).toBe(candidatePackage.helperConfigLiteral)
      }
    } finally { f.cleanup() }
  })
  test.each(['literal', 'duplicate', 'bytes', 'helper-literal', 'helper-bytes', 'capture', 'nonce', 'tiny', 'extra-setup', 'missing-sidecar', 'wrong-arch', 'asar-version', 'asar-main'])('rejects %s output without claiming a full package proof', async kind => {
    const f = await fixture()
    try {
      if (['literal', 'duplicate', 'bytes', 'helper-literal', 'helper-bytes'].includes(kind)) f.mutate(kind)
      if (kind === 'capture') writeFileSync(join(f.capture, 'compiled-helper.exe'), 'MZ changed compiled output')
      if (kind === 'nonce') f.options.nonce = 'another invocation'
      if (kind === 'tiny') truncateSync(f.setup, 4096)
      if (kind === 'extra-setup') copyFileSync(f.setup, join(f.output, 'Other-Setup.exe'))
      if (kind === 'missing-sidecar') rmSync(f.sidecar)
      if (kind === 'wrong-arch') {
        const value = readFileSync(f.sidecar)
        value.writeUInt16LE(0x14c, 68)
        writeFileSync(f.sidecar, value)
      }
      if (kind === 'asar-version') {
        const file = join(f.output, 'win-unpacked/resources/app.asar'), value = JSON.parse(readFileSync(file, 'utf8'))
        value['package.json'] = '{"version":"0.0.0"}'
        writeFileSync(file, JSON.stringify(value))
      }
      if (kind === 'asar-main') writeFileSync(join(f.source, 'desktop/electron-dist/main.cjs'), 'different build main')
      const message = ['literal', 'duplicate', 'bytes'].includes(kind) ? 'uninstaller member is not proven'
        : kind.startsWith('helper-') ? 'compiled helper member is not proven' : kind.startsWith('asar-') ? 'version/main bundle'
        : kind === 'capture' ? 'capture identity changed' : kind === 'nonce' ? 'another invocation'
          : kind === 'tiny' ? 'Unbounded or aliased' : kind === 'extra-setup' ? 'one complete current'
            : kind === 'missing-sidecar' ? 'ENOENT' : 'Windows x64'
      await expect(verifyCandidateOutputs(f.options)).rejects.toThrow(message)
      expect(existsSync(join(f.evidence, 'candidate-package-receipt.json'))).toBe(false)
    } finally { f.cleanup() }
  })
})
