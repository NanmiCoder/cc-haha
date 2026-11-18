#!/usr/bin/env bun

import { createHash, randomUUID } from 'node:crypto'
import { closeSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { assertOutsideSourceGit, downloadPinnedInstaller, isInsideDirectory, pinnedNsisCompiler, pinnedNsisResources, sha256File, verifyInstallerFixture } from './prepare-windows-installer-tests'
import { bootstrapFullSevenZip, parseSevenZipListing, pinnedFullSevenZip, proveNsisMember, selectLiteralMember, type NsisMemberProof, type SevenZipExtractor, type SevenZipRunner } from './windows-installer-member-proof'
import { createOfflineTestEnvironment, createSandboxedTestEnvironment } from './test-environment'

export const candidatePackage = {
  repository: 'NanmiCoder/cc-haha', number: 1883, headRepository: 'toBerlinWay/cc-haha',
  headRef: 'fix/installer-fallback-foreign-helpers', version: '0.7.8',
  target: 'x86_64-pc-windows-msvc',
  setupName: 'Claude-Code-Haha-0.7.8-Windows-x64-Setup.exe',
  uninstallerLiteral: '$R0\\Uninstall Claude Code Haha.exe',
  helperLiteral: '$PLUGINSDIR\\cc-haha-guarded-removal.exe',
  helperConfigLiteral: '$PLUGINSDIR\\cc-haha-guarded-removal.exe.config',
  maxSetupBytes: 1024 * 1024 * 1024, maxLogBytes: 1024 * 1024,
} as const
const sourcePaths = [
  'package.json', 'bun.lock', 'desktop/package.json', 'desktop/bun.lock', 'adapters/bun.lock', 'mobile/bun.lock',
  'desktop/scripts/build-windows-x64.ps1', 'desktop/scripts/build-sidecars.ts', 'desktop/build/installer.nsh',
  'desktop/build/guarded-removal.cs', 'desktop/build/guarded-removal-launch.nsh', 'desktop/build/legacy-uninstaller-compat.nsh',
  'desktop/scripts/nsis-guarded-removal.cjs', 'desktop/scripts/nsis-legacy-compat.cjs',
] as const
type Pin = { file: string, bytes: number, sha256: string }
type Trigger = { sourceHead: string, runId: string, runAttempt: 1, eventAction: string }
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
const json = (file: string, value: unknown) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })
const same = (left: string, right: string) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right

export function validateCandidatePackageTrigger(event: any, env: NodeJS.ProcessEnv, actualHead: string): Trigger {
  const head = event?.pull_request?.head?.sha
  if (env.CI !== 'true' || env.GITHUB_ACTIONS !== 'true' || env.GITHUB_EVENT_NAME !== 'pull_request' ||
      env.GITHUB_REPOSITORY !== candidatePackage.repository ||
      env.GITHUB_RUN_ATTEMPT !== '1' || !/^[1-9]\d{0,19}$/.test(env.GITHUB_RUN_ID ?? '') ||
      !['opened', 'synchronize', 'reopened', 'ready_for_review'].includes(event?.action) ||
      env.WINDOWS_INSTALLER_CHECKS_RESULT !== 'success' ||
      event?.number !== candidatePackage.number || event.pull_request.number !== candidatePackage.number ||
      event.pull_request.base?.ref !== 'main' || event.pull_request.base?.repo?.full_name !== candidatePackage.repository ||
      event.pull_request.head?.repo?.full_name !== candidatePackage.headRepository || event.pull_request.head?.ref !== candidatePackage.headRef ||
      !/^[0-9a-f]{40}$/.test(head ?? '') || head !== actualHead) {
    throw new Error('Candidate package requires the reviewed PR, successful Windows checks, first attempt and exact checkout')
  }
  return { sourceHead: head, runId: env.GITHUB_RUN_ID!, runAttempt: 1, eventAction: event.action }
}

function regular(file: string, parent: string, maxBytes: number, minimum = 1) {
  const stat = lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || !same(realpathSync(file), resolve(file)) ||
      !isInsideDirectory(parent, file) || stat.size < minimum || stat.size > maxBytes) throw new Error(`Unbounded or aliased candidate file: ${basename(file)}`)
  return stat
}
async function pin(file: string, parent: string, maxBytes: number, minimum = 1): Promise<Pin> {
  const stat = regular(file, parent, maxBytes, minimum)
  return { file: realpathSync(file), bytes: stat.size, sha256: await sha256File(file) }
}
function requireX64Pe(file: string) {
  const handle = openSync(file, 'r'), dos = Buffer.alloc(64), pe = Buffer.alloc(24)
  try {
    if (readSync(handle, dos, 0, dos.length, 0) !== dos.length || dos.toString('ascii', 0, 2) !== 'MZ') throw new Error('Candidate payload is not a PE')
    const offset = dos.readUInt32LE(0x3c)
    if (offset < 64 || readSync(handle, pe, 0, pe.length, offset) !== pe.length || pe.toString('ascii', 0, 4) !== 'PE\0\0' || pe.readUInt16LE(4) !== 0x8664) throw new Error('Candidate payload is not Windows x64')
  } finally { closeSync(handle) }
}
function readJson(file: string, parent: string) {
  regular(file, parent, 128 * 1024)
  return JSON.parse(readFileSync(file, 'utf8'))
}
function readonlyGit(source: string, argv: string[]) {
  const result = spawnSync('git', ['-C', source, ...argv], { encoding: 'utf8', shell: false, timeout: 30_000, maxBuffer: 1024 * 1024 })
  if (result.error || result.status !== 0) throw new Error('Cannot verify candidate checkout identity')
  return result.stdout.trim()
}

export function candidateCaptureNodeOptions(preload: string) {
  // NODE_OPTIONS has its own quoted-argument lexer; backslashes and quotes
  // must survive that lexer before Node resolves the exact preload file.
  const argument = preload.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return `--require="${argument}"`
}

// The preload only observes the existing supported NSIS build helper. Neither
// its return values nor electron-builder's BUILD_UNINSTALLER path are changed.
export function candidateCaptureScript(configFile: string) {
  return `const fs = require('node:fs'), p = require('node:path'), crypto = require('node:crypto')
const config = JSON.parse(fs.readFileSync(${JSON.stringify(configFile)}, 'utf8'))
const sha = b => crypto.createHash('sha256').update(b).digest('hex')
const same = (a,b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
function bytes(file, parent, limit) {
  const s = fs.lstatSync(file), r = p.relative(fs.realpathSync(parent), fs.realpathSync(file))
  if (!s.isFile() || s.isSymbolicLink() || !same(fs.realpathSync(file), p.resolve(file)) || !r || p.isAbsolute(r) || r === '..' || r.startsWith('..'+p.sep) || s.size < 1 || s.size > limit) throw Error('Candidate capture file boundary')
  return fs.readFileSync(file)
}
const legacyFile = p.join(config.source, 'desktop/scripts/nsis-legacy-compat.cjs')
const guardedFile = p.join(config.source, 'desktop/scripts/nsis-guarded-removal.cjs')
for (const [file, hash] of [[legacyFile, config.legacySha256], [guardedFile, config.guardedSha256]]) if (sha(bytes(file, config.source, 128*1024)) !== hash) throw Error('Candidate capture source changed')
function save(name, data) {
  const file = p.join(config.output, name)
  fs.writeFileSync(file, data, {flag:'wx'})
  return {file, bytes:data.length, sha256:sha(data)}
}
const guarded = require(guardedFile), compile = guarded.compile
guarded.compile = function(options) {
  if (!same(p.resolve(options.source), p.join(config.source, 'desktop/build/guarded-removal.cs')) || sha(bytes(options.source, config.source, 1024*1024)) !== config.sourceSha256) throw Error('Candidate helper source changed')
  const result = compile(options)
  const image = bytes(result.executable, config.temp, 4*1024*1024), settings = bytes(result.config, config.temp, 64*1024)
  if (image.length !== result.bytes || sha(image) !== result.sha256 || settings.length !== result.configBytes || sha(settings) !== result.configSha256 || result.sourceSha256 !== config.sourceSha256) throw Error('Candidate compiled helper identity changed')
  const receipt = {version:1, sourceHead:config.sourceHead, nonce:config.nonce, sourceSha256:config.sourceSha256, helper:save('compiled-helper.exe',image), config:save('compiled-helper.exe.config',settings)}
  fs.writeFileSync(p.join(config.output,'helper-capture.json'), JSON.stringify(receipt,null,2)+'\\n', {flag:'wx'})
  return result
}
const legacy = require(legacyFile), run = legacy.run
legacy.run = function(mode, args) {
  if (mode === 'prepare' && (args.length !== 2 || !same(p.resolve(args[0]), config.uninstaller))) throw Error('Candidate uninstaller output changed')
  const result = run(mode, args)
  if (mode === 'prepare') {
    const image = bytes(args[0], config.source, 4*1024*1024)
    const receipt = {version:1, sourceHead:config.sourceHead, nonce:config.nonce, output:save('compiled-uninstaller.exe',image)}
    fs.writeFileSync(p.join(config.output,'uninstaller-capture.json'), JSON.stringify(receipt,null,2)+'\\n',{flag:'wx'})
  }
  return result
}
`
}

export function candidateBuildCommands(source: string, powershell: string, bun = process.execPath) {
  const desktop = join(source, 'desktop')
  return [
    ...['', 'desktop', 'adapters', 'mobile'].map(directory => ({ name: `install-${directory || 'root'}`, cwd: join(source, directory), argv: [bun, 'install', '--frozen-lockfile'] })),
    { name: 'prepare-ripgrep', cwd: desktop, argv: [bun, '--no-env-file', 'run', 'prepare:ripgrep'] },
    { name: 'fetch-native', cwd: source, argv: ['cargo', '+stable', 'fetch', '--locked', '--manifest-path', join(source, 'native/agent-desktop/Cargo.toml'), '--target', candidatePackage.target] },
    { name: 'build-full-windows-x64', cwd: source, argv: [powershell, '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(desktop, 'scripts/build-windows-x64.ps1')] },
  ]
}

async function acquireTools(source: string, temp: string, evidence: string): Promise<{ extractor: SevenZipExtractor, nsis: unknown }> {
  const require = createRequire(join(source, 'desktop/package.json'))
  if (require('app-builder-lib/package.json').version !== '26.8.1') throw new Error('Unreviewed app-builder-lib')
  const nsis = require('app-builder-lib/out/targets/nsis/nsisUtil.js')
  nsis.NsisTargetOptions.resolve({})
  const binary = await nsis.NSIS_PATH(), resources = await nsis.NSIS_RESOURCES_PATH()
  const compiler = await pin(join(binary, 'Bin/makensis.exe'), temp, 16 * 1024 * 1024)
  if (!isInsideDirectory(temp, resources)) throw new Error('NSIS resources escaped candidate preparation')
  const plugins: Record<string, Pin> = {}
  for (const name of pinnedNsisResources.plugins) plugins[name] = await pin(join(resources, 'plugins/x86-unicode', name), temp, 4 * 1024 * 1024)
  const builderRequire = createRequire(createRequire(require.resolve('app-builder-lib/package.json')).resolve('builder-util/package.json'))
  if (builderRequire('7zip-bin/package.json').version !== '5.2.0') throw new Error('Unreviewed extractor bootstrap')
  const bootstrap = join(dirname(builderRequire.resolve('7zip-bin/package.json')), 'win/x64/7za.exe')
  if (await sha256File(bootstrap) !== 'b0cfdeaf429f5cc53f85123dd8f5a5feb92c19d31aa34df257edf9a26be05f95') throw new Error('Extractor bootstrap identity changed')
  const archive = join(temp, '7z2606-x64.exe')
  await downloadPinnedInstaller(pinnedFullSevenZip.url, archive)
  await verifyInstallerFixture(archive, pinnedFullSevenZip)
  return { extractor: bootstrapFullSevenZip({ archive, bootstrap, directory: join(temp, 'full-seven-zip'), evidenceDirectory: join(evidence, 'tools') }),
    nsis: { compiler: { ...pinnedNsisCompiler, ...compiler }, resources: { ...pinnedNsisResources, directory: resources, plugins } } }
}

// Config is generic bytes, never a PE. Keep proveNsisMember's MZ checks intact
// for both executable links and bind this one literal member to its capture.
async function proveEmbeddedConfig(options: {
  container: Pin, captured: Pin, extractor: SevenZipExtractor, evidence: string, run?: SevenZipRunner
}) {
  const directory = join(options.evidence, 'uninstaller-config-member')
  mkdirSync(directory)
  const proof: NsisMemberProof & { contentKind: 'helper-runtime-config', captured: Pin } = {
    version: 1, status: 'not_proven', setup: options.container, extractor: options.extractor,
    forcedType: 'Nsis', literalMember: candidatePackage.helperConfigLiteral, commands: [], peExecuted: false,
    contentKind: 'helper-runtime-config', captured: options.captured,
  }
  const verifyPin = async (expected: Pin, limit: number) => {
    const actual = await pin(expected.file, dirname(expected.file), limit, 2)
    if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) throw new Error('Embedded config input pin changed')
  }
  const command = (name: string, argv: string[], maxBuffer: number) => {
    const result = (options.run ?? spawnSync)(options.extractor.executable, argv, {
      cwd: directory, env: createSandboxedTestEnvironment(join(directory, 'home')),
      timeout: 60_000, maxBuffer, windowsHide: true,
    })
    const stdout = Buffer.from(result.stdout ?? []), stderr = Buffer.from(result.stderr ?? [])
    const stdoutFile = join(directory, `${name}.stdout.bin`), stderrFile = join(directory, `${name}.stderr.bin`)
    writeFileSync(stdoutFile, stdout, { flag: 'wx' })
    writeFileSync(stderrFile, stderr, { flag: 'wx' })
    const record = { executable: options.extractor.executable, argv, status: result.status, error: result.error?.message,
      stdout: { bytes: stdout.length, sha256: digest(stdout), file: stdoutFile },
      stderr: { bytes: stderr.length, sha256: digest(stderr), file: stderrFile }, record: join(directory, `${name}.command.json`) }
    json(record.record, record)
    proof.commands.push(record)
    if (result.error || result.status !== 0 || stderr.length !== 0 || stdout.length > maxBuffer) throw new Error('Embedded config extractor command failed or exceeded its budget')
    return stdout
  }
  try {
    if (options.extractor.version !== '26.06' || !options.extractor.files.some(value => resolve(value.file) === resolve(options.extractor.executable))) throw new Error('Embedded config extractor is not pinned')
    await verifyPin(options.container, 4 * 1024 * 1024)
    await verifyPin(options.captured, 64 * 1024)
    for (const file of options.extractor.files) await verifyPin(file, 4 * 1024 * 1024)
    const raw = command('nsis-list', ['l', '-slt', '-sccUTF-8', '-tNsis', '--', options.container.file], 4 * 1024 * 1024)
    const listing = parseSevenZipListing(new TextDecoder('utf-8', { fatal: true }).decode(raw), 'Nsis')
    if (listing.archive.Path !== options.container.file) throw new Error('Embedded config listing names a different uninstaller')
    proof.member = selectLiteralMember(listing, { path: candidatePackage.helperConfigLiteral, bytes: options.captured.bytes })
    if (proof.member.Encrypted === '+') throw new Error('Embedded config member is encrypted')
    const bytes = command('nsis-extract', ['e', '-tNsis', '-spd', '-so', '-bso0', '-bse2', '-bsp0', '--', options.container.file,
      candidatePackage.helperConfigLiteral], options.captured.bytes + 64 * 1024)
    if (bytes.length !== options.captured.bytes || digest(bytes) !== options.captured.sha256 || !bytes.equals(readFileSync(options.captured.file))) throw new Error('Embedded config bytes differ from this build capture')
    await verifyPin(options.container, 4 * 1024 * 1024)
    await verifyPin(options.captured, 64 * 1024)
    for (const file of options.extractor.files) await verifyPin(file, 4 * 1024 * 1024)
    const output = join(options.evidence, 'embedded-helper.exe.config')
    writeFileSync(output, bytes, { flag: 'wx' })
    proof.output = { file: realpathSync(output), bytes: bytes.length, sha256: digest(bytes) }
    proof.status = 'member_proven'
  } catch (error) { proof.error = String(error) }
  const evidenceFile = join(directory, 'member-proof.json')
  json(evidenceFile, proof)
  return { proof, evidenceFile }
}

export async function verifyCandidateOutputs(options: {
  source: string, temp: string, evidence: string, trigger: Trigger, nonce: string, extractor: SevenZipExtractor, run?: SevenZipRunner
}) {
  const { source, evidence, trigger, nonce, extractor } = options
  const output = join(source, 'desktop/build-artifacts/windows-x64')
  const setups = readdirSync(output).filter(name => name.toLowerCase().endsWith('setup.exe'))
  if (setups.length !== 1 || setups[0] !== candidatePackage.setupName) throw new Error('Expected one complete current x64 Setup')
  const setup = await pin(join(output, candidatePackage.setupName), source, candidatePackage.maxSetupBytes, 100 * 1024 * 1024)
  if (setup.sha256 === 'dca6bb82f4d0fbee8d43c91912e4d50e7dcea69a7cb22c51cdd9cb265767c7e7') throw new Error('Historical setup cannot be the current package')
  copyFileSync(setup.file, join(evidence, candidatePackage.setupName))
  const capture = join(evidence, 'capture')
  const helper = readJson(join(capture, 'helper-capture.json'), evidence)
  const uninstaller = readJson(join(capture, 'uninstaller-capture.json'), evidence)
  for (const receipt of [helper, uninstaller]) {
    if (receipt.version !== 1 || receipt.sourceHead !== trigger.sourceHead || receipt.nonce !== nonce) throw new Error('Candidate build capture belongs to another invocation')
  }
  if (helper.sourceSha256 !== await sha256File(join(source, 'desktop/build/guarded-removal.cs'))) throw new Error('Captured helper source changed')
  for (const [name, value] of [['compiled-helper.exe', helper.helper], ['compiled-helper.exe.config', helper.config], ['compiled-uninstaller.exe', uninstaller.output]] as const) {
    const actual = await pin(join(capture, name), evidence, 4 * 1024 * 1024)
    if (value?.file !== actual.file || value.bytes !== actual.bytes || value.sha256 !== actual.sha256) throw new Error('Candidate build capture identity changed')
  }
  if (uninstaller.output.sha256 === 'b0242b31b839cc8bf40ba4ac492004629bcf8ed28f8648d8c46b1797f7befb60') throw new Error('Historical uninstaller cannot be the current member')
  const uninstallerProof = proveNsisMember({ setup, extractor, member: { path: candidatePackage.uninstallerLiteral, ...uninstaller.output },
    output: join(evidence, 'new-uninstaller.exe'), evidenceDirectory: join(evidence, 'setup-member'), run: options.run })
  if (uninstallerProof.proof.status !== 'member_proven') throw new Error('Current Setup uninstaller member is not proven')
  const helperProof = proveNsisMember({ setup: uninstallerProof.proof.output!, extractor, member: { path: candidatePackage.helperLiteral, ...helper.helper },
    output: join(evidence, 'embedded-helper.exe'), evidenceDirectory: join(evidence, 'uninstaller-member'), run: options.run })
  if (helperProof.proof.status !== 'member_proven') throw new Error('Current uninstaller compiled helper member is not proven')
  const configProof = await proveEmbeddedConfig({ container: uninstallerProof.proof.output!, captured: helper.config,
    extractor, evidence, run: options.run })
  if (configProof.proof.status !== 'member_proven') throw new Error('Current uninstaller embedded helper config member is not proven')
  const payloads = []
  for (const [kind, relativePath] of [
    ['app-exe', 'Claude Code Haha.exe'], ['app-asar', 'resources/app.asar'],
    ['sidecar', `resources/app.asar.unpacked/src-tauri/binaries/claude-sidecar-${candidatePackage.target}.exe`],
  ]) {
    const value = await pin(join(output, 'win-unpacked', relativePath!), source, candidatePackage.maxSetupBytes)
    if (kind !== 'app-asar') requireX64Pe(value.file)
    payloads.push({ kind, relativePath: relativePath!.replaceAll('/', '\\'), bytes: value.bytes, sha256: value.sha256 })
  }
  const require = createRequire(join(source, 'desktop/package.json'))
  const asar = createRequire(require.resolve('app-builder-lib/package.json'))('@electron/asar')
  const appArchive = join(output, 'win-unpacked/resources/app.asar')
  if (JSON.parse(asar.extractFile(appArchive, 'package.json').toString('utf8')).version !== candidatePackage.version ||
      !asar.extractFile(appArchive, 'electron-dist/main.cjs').equals(readFileSync(join(source, 'desktop/electron-dist/main.cjs')))) {
    throw new Error('Current app.asar does not contain this build version/main bundle')
  }
  const copied = await pin(join(evidence, candidatePackage.setupName), evidence, candidatePackage.maxSetupBytes)
  if (copied.bytes !== setup.bytes || copied.sha256 !== setup.sha256 || await sha256File(setup.file) !== setup.sha256) throw new Error('Current package changed during static verification')
  return { kind: 'full-electron-nsis-package', displayVersion: candidatePackage.version, setupSha256: setup.sha256, setupBytes: setup.bytes,
    uninstallerSha256: uninstaller.output.sha256, uninstallerBytes: uninstaller.output.bytes,
    guardedRemovalSha256: helper.helper.sha256, guardedRemovalBytes: helper.helper.bytes, payloads,
    setup: { ...copied, file: candidatePackage.setupName }, uninstallerMember: uninstallerProof, helperMember: helperProof,
    compiledConfig: helper.config, configMember: configProof, payloadOrigin: 'actual-win-unpacked-from-this-build', runtimeInstall: 'not_run', fullF1: 'not_proven' }
}

async function command(argv: string[], cwd: string, env: Record<string, string>, evidence: string, name: string) {
  const startUtc = new Date().toISOString()
  const child = Bun.spawn(argv, { cwd, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', windowsHide: true })
  const collect = async (stream: ReadableStream<Uint8Array>, suffix: string) => {
    const chunks: Uint8Array[] = [], hash = createHash('sha256')
    let bytes = 0, kept = 0
    for await (const chunk of stream) {
      hash.update(chunk)
      bytes += chunk.length
      const part = chunk.subarray(0, Math.max(0, candidatePackage.maxLogBytes - kept))
      if (part.length) chunks.push(part)
      kept += part.length
    }
    writeFileSync(join(evidence, `${name}.${suffix}.log`), Buffer.concat(chunks), { flag: 'wx' })
    return { bytes, kept, sha256: hash.digest('hex'), overflow: bytes !== kept }
  }
  const [stdout, stderr, exitCode] = await Promise.all([collect(child.stdout, 'stdout'), collect(child.stderr, 'stderr'), child.exited])
  const result = { argv, cwd, startUtc, endUtc: new Date().toISOString(), exitCode, stdout, stderr }
  json(join(evidence, `${name}.command.json`), result)
  if (exitCode !== 0 || stdout.overflow || stderr.overflow) throw new Error(`Candidate command failed or exceeded raw budget: ${name}`)
  return result
}

type CleanupGuard = 'canonical-path' | 'directory-kind' | 'parent' | 'prefix' | 'owner-kind' | 'owner-size' | 'owner-value' | null
type CleanupRemovalDetails = {
  syscall: string | null, errno: number | null, relativePath: string | null,
  entryKind: 'file' | 'directory' | 'missing' | 'other' | null, modeWriteBits: number | null,
}
type NodeCleanupOutcome = 'timeout' | 'output-limit' | 'spawn-error' | 'signal' | 'unexpected-output' | 'invalid-reply'
  | 'runtime-refused' | 'child-admission-refused' | 'child-failed' | 'nonzero-exit' | 'target-still-present' | 'absence-unknown'
type CleanupDiagnostic = {
  site: 'admission' | 'remove' | 'unknown'; guard: CleanupGuard; nativeCode: string | null
  nodeOutcome?: NodeCleanupOutcome
} & Partial<CleanupRemovalDetails>
const cleanupNativeCodes = new Set(['EACCES', 'EBUSY', 'EEXIST', 'EIO', 'EISDIR', 'ELOOP', 'EMFILE',
  'ENAMETOOLONG', 'ENFILE', 'ENOENT', 'ENOSPC', 'ENOTDIR', 'ENOTEMPTY', 'EPERM', 'EROFS', 'ETXTBSY'])
const cleanupSyscalls = new Set(['unlink', 'rmdir', 'scandir', 'lstat', 'stat', 'rm'])
export const candidateCleanupNodeScript = String.raw`
const fs = require('node:fs'), p = require('node:path')
const codes = new Set(${JSON.stringify([...cleanupNativeCodes])}), syscalls = new Set(${JSON.stringify([...cleanupSyscalls])})
const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
const emit = (outcome, error) => {
  process.stdout.write(JSON.stringify({version:1,nodeVersion:process.versions.node,outcome,...(error ? {error} : {})}))
  process.exitCode = outcome === 'removed' ? 0 : 1
}
;(() => {
  if (!/^22\.[0-9]+\.[0-9]+$/.test(process.versions.node)) return emit('runtime-refused')
  if (process.argv.length !== 4) return emit('admission-refused')
  const [temp, parent, nonce] = process.argv.slice(1), owner = p.join(temp, '.owner')
  try {
    if (!p.isAbsolute(temp) || !p.isAbsolute(parent) || !same(fs.realpathSync(parent), parent)
      || !fs.lstatSync(parent).isDirectory() || fs.lstatSync(parent).isSymbolicLink()
      || !same(fs.realpathSync(process.cwd()), parent) || !same(fs.realpathSync(temp), temp)
      || !fs.lstatSync(temp).isDirectory() || fs.lstatSync(temp).isSymbolicLink()
      || p.dirname(temp) !== parent || !p.basename(temp).startsWith('cc-haha-candidate-package-')
      || !fs.lstatSync(owner).isFile() || fs.lstatSync(owner).isSymbolicLink()
      || fs.lstatSync(owner).size > 64 || fs.readFileSync(owner, 'utf8') !== nonce) return emit('admission-refused')
  } catch { return emit('admission-refused') }
  try {
    fs.rmSync(temp, { recursive: true })
    emit('removed')
  } catch (error) {
    emit('failed', {code: codes.has(error.code) ? error.code : null,
      syscall: syscalls.has(error.syscall) ? error.syscall : null,
      errno: Number.isInteger(error.errno) && error.errno >= -2147483648 && error.errno <= 2147483647 ? error.errno : null,
      path: typeof error.path === 'string' && error.path.length <= 8192 && !/[\p{Cc}\p{Cf}]/u.test(error.path) ? error.path : null})
  }
})()
`
class CandidateNodeCleanupFailure extends Error {
  constructor(readonly outcome: NodeCleanupOutcome, fields: Record<string, unknown>, cause: unknown) {
    super('Candidate Node cleanup failed', { cause })
    Object.assign(this, fields)
  }
}
function nodeCleanup(temp: string, parent: string, nonce: string) {
  const home = join(temp, 'home')
  const result = spawnSync('node', ['--input-type=commonjs', '--eval', candidateCleanupNodeScript, '--', temp, parent, nonce], {
    shell: false, cwd: parent, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 180_000, maxBuffer: 64 * 1024,
    env: createOfflineTestEnvironment({ HOME: home, CFFIXED_USER_HOME: home, USERPROFILE: home,
      APPDATA: join(home, '.config'), LOCALAPPDATA: join(home, '.local'), TEMP: parent, TMP: parent, TMPDIR: parent }),
  })
  const fail = (outcome: NodeCleanupOutcome, fields: Record<string, unknown> = {}): never => {
    throw new CandidateNodeCleanupFailure(outcome, fields, result)
  }
  if (result.error) fail(cleanupErrorField(result.error, 'code') === 'ETIMEDOUT' ? 'timeout'
    : cleanupErrorField(result.error, 'code') === 'ENOBUFS' ? 'output-limit' : 'spawn-error')
  if (result.signal) fail('signal')
  if (result.stderr?.length || !result.stdout || result.stdout.length > 64 * 1024) fail('unexpected-output')
  let reply: any
  try { reply = JSON.parse(result.stdout.toString('utf8')) } catch { fail('invalid-reply') }
  if (!reply || typeof reply !== 'object' || Array.isArray(reply) || reply.version !== 1
    || Object.keys(reply).some(key => !['version', 'nodeVersion', 'outcome', 'error'].includes(key))) fail('invalid-reply')
  if (reply.outcome === 'runtime-refused') fail('runtime-refused')
  if (typeof reply.nodeVersion !== 'string' || !/^22\.[0-9]{1,3}\.[0-9]{1,3}$/.test(reply.nodeVersion)) fail('invalid-reply')
  if (reply.outcome === 'admission-refused') fail('child-admission-refused')
  if (reply.outcome === 'failed' && result.status === 1) {
    const error = reply.error
    if (!error || typeof error !== 'object' || Array.isArray(error)
      || Object.keys(error).length !== 4 || Object.keys(error).some(key => !['code', 'syscall', 'errno', 'path'].includes(key))
      || !(error.code === null || cleanupNativeCodes.has(error.code))
      || !(error.syscall === null || cleanupSyscalls.has(error.syscall))
      || !(error.errno === null || Number.isInteger(error.errno) && error.errno >= -2147483648 && error.errno <= 2147483647)
      || !(error.path === null || typeof error.path === 'string' && error.path.length <= 8192 && !/[\p{Cc}\p{Cf}]/u.test(error.path))) fail('invalid-reply')
    fail('child-failed', error)
  }
  if (result.status !== 0) fail('nonzero-exit')
  if (reply.outcome !== 'removed' || 'error' in reply) fail('invalid-reply')
  try { lstatSync(temp); fail('target-still-present') }
  catch (error) {
    if (error instanceof CandidateNodeCleanupFailure) throw error
    if (cleanupErrorField(error, 'code') !== 'ENOENT') fail('absence-unknown')
  }
  return { runtime: 'node22', version: reply.nodeVersion, attempts: 1, confirmedAbsent: true }
}
function cleanupErrorField(error: unknown, key: 'code' | 'syscall' | 'errno' | 'path') {
  try { return error && typeof error === 'object' ? Reflect.get(error, key) : undefined } catch { return undefined }
}
function cleanupNativeCode(error: unknown) {
  const code = cleanupErrorField(error, 'code')
  return typeof code === 'string' && cleanupNativeCodes.has(code) ? code : 'UNRECOGNIZED'
}
function cleanupRemovalDetails(error: unknown, temp: string): CleanupRemovalDetails {
  const syscall = cleanupErrorField(error, 'syscall'), errno = cleanupErrorField(error, 'errno')
  const unknown: CleanupRemovalDetails = {
    syscall: typeof syscall === 'string' && cleanupSyscalls.has(syscall) ? syscall : null,
    errno: typeof errno === 'number' && Number.isInteger(errno) && errno >= -2147483648 && errno <= 2147483647 ? errno : null,
    relativePath: null, entryKind: null, modeWriteBits: null,
  }
  const path = cleanupErrorField(error, 'path')
  if (typeof path !== 'string' || path.length > 32767 || /[\p{Cc}\p{Cf}]/u.test(path) || !isAbsolute(path)
    || path.replaceAll('\\', '/').split('/').some(part => part === '.' || part === '..')) return unknown
  const taskRelative = relative(temp, path), parts = taskRelative.split(sep)
  if (!taskRelative || taskRelative.length > 512 || isAbsolute(taskRelative) || parts.length > 64
    || parts.some(part => !part || part === '.' || part === '..' || /[\\/:<>"|?*]/.test(part) || /[ .]$/.test(part)
      || /^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(part))) return unknown
  try {
    const root = lstatSync(temp)
    if (!root.isDirectory() || root.isSymbolicLink()) return unknown
    let current = temp
    for (const [index, part] of parts.entries()) {
      current = join(current, part)
      let stat: ReturnType<typeof lstatSync>
      try { stat = lstatSync(current) }
      catch (metadataError) {
        return index === parts.length - 1 && cleanupErrorField(metadataError, 'code') === 'ENOENT'
          ? { ...unknown, relativePath: parts.join('/'), entryKind: 'missing' } : unknown
      }
      // Never descend through a link/junction or a non-directory ancestor.
      if (stat.isSymbolicLink() || index < parts.length - 1 && !stat.isDirectory()) return unknown
      if (index === parts.length - 1) return { ...unknown, relativePath: parts.join('/'),
        entryKind: stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'other',
        // POSIX-style mode hint only; not Windows ReadOnly or Win32LastError.
        modeWriteBits: Number(stat.mode) & 0o222 }
    }
  } catch {}
  return unknown
}
class CandidateCleanupFailure extends Error {
  constructor(readonly diagnostic: CleanupDiagnostic, cause: unknown, denied: boolean) {
    super(denied ? 'Unowned candidate temporary directory' : 'Candidate temporary cleanup failed', { cause })
  }
}
class CandidatePackageFailure extends Error {
  constructor(stage: unknown, cause: unknown, cleanupCause: unknown) {
    const known = ['archive', 'install-root', 'install-desktop', 'install-adapters', 'install-mobile', 'prepare-ripgrep',
      'fetch-native', 'build-full-windows-x64', 'pinned-tools', 'static-output-verification', 'cleanup']
    super(`Candidate package not proven at ${typeof stage === 'string' && known.includes(stage) ? stage : 'unknown'}; bounded evidence preserved`, { cause })
    Object.defineProperty(this, 'cleanupCause', { value: cleanupCause })
  }
}
export function candidatePackageFailureSummary(error: unknown) {
  return error instanceof CandidatePackageFailure ? error.message : 'Candidate package preflight failed; package not proven'
}
export function cleanupCandidateDirectory(temp: string, parent: string, nonce: string) {
  const owner = join(temp, '.owner')
  let site: CleanupDiagnostic['site'] = 'admission', guard: CleanupGuard = 'canonical-path', denied = false
  const refuse = (): never => { denied = true; throw new Error('Unowned candidate temporary directory') }
  try {
    if (!same(realpathSync(temp), temp)) refuse()
    guard = 'directory-kind'
    if (!lstatSync(temp).isDirectory() || lstatSync(temp).isSymbolicLink()) refuse()
    guard = 'parent'
    if (dirname(temp) !== parent) refuse()
    guard = 'prefix'
    if (!basename(temp).startsWith('cc-haha-candidate-package-')) refuse()
    guard = 'owner-kind'
    if (!lstatSync(owner).isFile() || lstatSync(owner).isSymbolicLink()) refuse()
    guard = 'owner-size'
    if (lstatSync(owner).size > 64) refuse()
    guard = 'owner-value'
    if (readFileSync(owner, 'utf8') !== nonce) refuse()
    site = 'remove'; guard = null
    return nodeCleanup(temp, parent, nonce)
  } catch (error) {
    throw new CandidateCleanupFailure({ site, guard, nativeCode: denied ? null : cleanupNativeCode(error),
      ...(site === 'remove' ? cleanupRemovalDetails(error, temp) : {}),
      ...(error instanceof CandidateNodeCleanupFailure ? { nodeOutcome: error.outcome } : {}) }, error, denied)
  }
}

/** The real producer and fixture tests share this receipt/terminal-error path. */
export function finishCandidatePackage(options: {
  receipt: any, evidence: string, temp: string, parent: string, nonce: string, originalError?: unknown
}) {
  const { receipt, evidence, temp, parent, nonce, originalError } = options
  let failed = originalError !== undefined || receipt.failedStage !== undefined
  let failure = originalError, cleanupCause: unknown
  try {
    receipt.cleanupRuntime = cleanupCandidateDirectory(temp, parent, nonce)
    receipt.cleanup = 'owned_temporary_directory_removed'
  } catch (error) {
    cleanupCause = error
    receipt.cleanup = 'unknown'
    receipt.status = 'not_proven'
    receipt.cleanupFailure = error instanceof CandidateCleanupFailure ? error.diagnostic
      : { site: 'unknown', guard: null, nativeCode: cleanupNativeCode(error) }
    receipt.failedStage ??= 'cleanup'
    receipt.errorCode ??= 'candidate_package_not_proven'
    if (!failed) { failed = true; failure = error }
  }
  json(join(evidence, 'candidate-package-receipt.json'), receipt)
  if (failed) throw new CandidatePackageFailure(receipt.failedStage ?? 'cleanup', failure, cleanupCause)
  return receipt
}

export async function runCandidatePackage() {
  if (process.platform !== 'win32') throw new Error('Candidate package preparation is Windows CI only')
  const source = realpathSync(resolve(import.meta.dir, '../..'))
  const eventFile = process.env.GITHUB_EVENT_PATH!
  if (!eventFile || lstatSync(eventFile).size > 1024 * 1024) throw new Error('Missing bounded Actions event')
  const trigger = validateCandidatePackageTrigger(JSON.parse(readFileSync(eventFile, 'utf8')), process.env, readonlyGit(source, ['rev-parse', 'HEAD']))
  if (readonlyGit(source, ['status', '--porcelain', '--untracked-files=no'])) throw new Error('Candidate checkout must be clean')
  const parent = realpathSync(process.env.RUNNER_TEMP!)
  assertOutsideSourceGit(parent, source)
  const evidence = join(source, 'artifacts/windows-installer-candidate-package')
  mkdirSync(dirname(evidence), { recursive: true })
  mkdirSync(evidence)
  const temp = realpathSync(mkdtempSync(join(parent, 'cc-haha-candidate-package-'))), nonce = randomUUID()
  writeFileSync(join(temp, '.owner'), nonce, { flag: 'wx' })
  const build = join(temp, 'source'), logs = join(evidence, 'commands'), capture = join(evidence, 'capture')
  for (const directory of [build, logs, capture]) mkdirSync(directory)
  const env = createSandboxedTestEnvironment(join(temp, 'home'), {
    NODE_ENV: 'development', ELECTRON_BUILDER_CACHE: join(temp, 'builder-cache'), BUN_INSTALL_CACHE_DIR: join(temp, 'bun-cache'),
    CARGO_HOME: process.env.CARGO_HOME!, RUSTUP_HOME: process.env.RUSTUP_HOME!, RUSTUP_AUTO_INSTALL: '0', RUSTUP_NO_UPDATE_CHECK: '1',
    SIDECAR_TARGET_TRIPLE: candidatePackage.target, CSC_IDENTITY_AUTO_DISCOVERY: 'false', SKIP_INSTALL: '1', SKIP_PACKAGE_SMOKE: '1',
  })
  const receipt: any = { version: 1, status: 'not_proven', ...trigger, sourceTree: readonlyGit(source, ['rev-parse', 'HEAD^{tree}']),
    nonce, accountsCreated: 0, profilesCreated: 0, installed: false, signed: false, published: false, fullF1: 'not_proven', commands: [] }
  let stage = 'archive', originalError: unknown
  const saved = { ELECTRON_BUILDER_CACHE: process.env.ELECTRON_BUILDER_CACHE, ELECTRON_BUILDER_NSIS_DIR: process.env.ELECTRON_BUILDER_NSIS_DIR, ELECTRON_BUILDER_NSIS_RESOURCES_DIR: process.env.ELECTRON_BUILDER_NSIS_RESOURCES_DIR }
  try {
    json(join(evidence, 'invocation.json'), receipt)
    for (const name of ['CARGO_HOME', 'RUSTUP_HOME']) {
      mkdirSync(env[name]!, { recursive: true })
      if (!isInsideDirectory(parent, env[name]!)) throw new Error('Candidate toolchain must be owned runner temporary state')
    }
    const powershell = join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe')
    const tar = join(process.env.SystemRoot!, 'System32/tar.exe'), archive = join(temp, 'source.tar')
    receipt.commands.push(await command(['git', '-C', source, 'archive', '--format=tar', '--output', archive, trigger.sourceHead], source, env, logs, 'archive'))
    receipt.commands.push(await command([tar, '-xf', archive, '-C', build], source, env, logs, 'unpack-source'))
    if (JSON.parse(readFileSync(join(build, 'desktop/package.json'), 'utf8')).version !== candidatePackage.version) throw new Error('Candidate version must remain 0.7.8')
    receipt.sourcePins = await Promise.all(sourcePaths.map(async file => ({ path: file, ...await pin(join(build, file), build, 16 * 1024 * 1024) })))
    const commands = candidateBuildCommands(build, powershell)
    for (const item of commands.slice(0, 4)) {
      stage = item.name
      receipt.commands.push(await command(item.argv, item.cwd, env, logs, item.name))
    }
    env.NODE_ENV = 'production'
    stage = 'pinned-tools'
    process.env.ELECTRON_BUILDER_CACHE = env.ELECTRON_BUILDER_CACHE
    delete process.env.ELECTRON_BUILDER_NSIS_DIR
    delete process.env.ELECTRON_BUILDER_NSIS_RESOURCES_DIR
    const tools = await acquireTools(build, temp, evidence)
    receipt.tools = tools
    const configFile = join(temp, 'capture-config.json'), preload = join(temp, 'capture.cjs')
    json(configFile, { source: build, temp, output: capture, sourceHead: trigger.sourceHead, nonce,
      sourceSha256: await sha256File(join(build, 'desktop/build/guarded-removal.cs')),
      legacySha256: await sha256File(join(build, 'desktop/scripts/nsis-legacy-compat.cjs')),
      guardedSha256: await sha256File(join(build, 'desktop/scripts/nsis-guarded-removal.cjs')),
      uninstaller: join(build, 'desktop/build-artifacts/electron', candidatePackage.setupName.replace(/exe$/, '__uninstaller.exe')) })
    writeFileSync(preload, candidateCaptureScript(configFile), { flag: 'wx' })
    env.NODE_OPTIONS = candidateCaptureNodeOptions(preload)
    for (const item of commands.slice(4)) {
      stage = item.name
      receipt.commands.push(await command(item.argv, item.cwd, env, logs, item.name))
    }
    stage = 'static-output-verification'
    Object.assign(receipt, await verifyCandidateOutputs({ source: build, temp, evidence, trigger, nonce, extractor: tools.extractor }))
    for (const input of receipt.sourcePins) if (await sha256File(input.file) !== input.sha256) throw new Error('Candidate tracked build input changed')
    receipt.status = 'candidate_package_prepared'
  } catch (error) {
    originalError = error
    receipt.failedStage = stage
    receipt.errorCode = 'candidate_package_not_proven'
    receipt.failure = error instanceof Error ? { name: error.name.slice(0, 64), message: error.message.slice(0, 1024) } : { name: 'UnknownFailure' }
  }
  finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
  return finishCandidatePackage({ receipt, evidence, temp, parent, nonce, originalError })
}

if (import.meta.main) {
  try {
    if (process.argv.length !== 2) throw new Error('Candidate package runner takes no execution override')
    const result = await runCandidatePackage()
    console.log(`[candidate-package] ${result.status}; full F1 remains not_proven`)
  } catch (error) {
    console.error(candidatePackageFailureSummary(error))
    process.exitCode = 1
  }
}
