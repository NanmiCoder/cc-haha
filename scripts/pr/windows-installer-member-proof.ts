import { createHash } from 'node:crypto'
import { closeSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createSandboxedTestEnvironment } from './test-environment'

export type FilePin = { bytes: number; sha256: string }
export const pinnedFullSevenZip = {
  version: '26.06',
  assetId: 720544254,
  url: 'https://github.com/ip7z/7zip/releases/download/26.06/7z2606-x64.exe',
  bytes: 1659704,
  sha256: '9b697f65ecc2d9b0152f5ee96d72dde522a7827690349d9307935dacf40f42ec',
  files: {
    '7z.exe': { bytes: 574464, sha256: 'dc0493429fe28136fcb177a0e77c9875cbb3b0bff5f2f8eeba4df302e98cef76' },
    '7z.dll': { bytes: 1897984, sha256: '500db9eb17f3c21b729ba41dd02ecfe1823da05028c7e4ba129084cc74cc364e' },
  },
} as const
export const historicalUninstallerMember = {
  // This is the literal NSIS member name in the hash-pinned v0.7.8 setup,
  // including its virtual register directory; never strip or expand $R0.
  path: '$R0\\Uninstall Claude Code Haha.exe',
  bytes: 174881,
  sha256: 'b0242b31b839cc8bf40ba4ac492004629bcf8ed28f8648d8c46b1797f7befb60',
} as const

export type SevenZipCommand = {
  executable: string
  argv: string[]
  status: number | null
  error?: string
  stdout: { bytes: number; sha256: string; file?: string }
  stderr: { bytes: number; sha256: string; file: string }
  record: string
}
export type SevenZipExtractor = {
  version: string
  executable: string
  files: Array<{ file: string } & FilePin>
  archive?: { file: string } & FilePin
  bootstrap?: SevenZipCommand[]
}
type CommandResult = { status: number | null; stdout: Buffer; stderr: Buffer; error?: Error }
export type SevenZipRunner = (executable: string, argv: string[], options: {
  cwd: string; env: Record<string, string>; timeout: number; maxBuffer: number; windowsHide: boolean
}) => CommandResult
const nativeRun: SevenZipRunner = (executable, argv, options) => spawnSync(executable, argv, options)
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

function verifyFile(file: string, pin: FilePin) {
  const stat = lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== pin.bytes) {
    throw new Error(`Pinned file identity changed: ${basename(file)}`)
  }
  const hash = createHash('sha256')
  const buffer = Buffer.alloc(1024 * 1024)
  const handle = openSync(file, 'r')
  try {
    let bytes: number
    while ((bytes = readSync(handle, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes))
  } finally { closeSync(handle) }
  if (hash.digest('hex') !== pin.sha256) throw new Error(`Pinned file identity changed: ${basename(file)}`)
}

function capture(options: {
  executable: string; argv: string[]; directory: string; name: string; maxBuffer: number; binary?: boolean; run?: SevenZipRunner; workingDirectory?: string
}) {
  mkdirSync(options.directory, { recursive: true })
  const cwd = options.workingDirectory ?? options.directory
  const result = (options.run ?? nativeRun)(options.executable, options.argv, {
    cwd,
    env: createSandboxedTestEnvironment(resolve(cwd, '../seven-zip-command-home')),
    timeout: 60_000, maxBuffer: options.maxBuffer, windowsHide: true,
  })
  const stdout = Buffer.from(result.stdout ?? [])
  const stderr = Buffer.from(result.stderr ?? [])
  const stderrFile = join(options.directory, `${options.name}.stderr.txt`)
  const stdoutFile = options.binary ? undefined : join(options.directory, `${options.name}.stdout.txt`)
  if (stdoutFile) writeFileSync(stdoutFile, stdout)
  writeFileSync(stderrFile, stderr)
  const evidence: SevenZipCommand = {
    executable: options.executable, argv: options.argv, status: result.status, error: result.error?.message,
    stdout: { bytes: stdout.length, sha256: digest(stdout), ...(stdoutFile ? { file: stdoutFile } : {}) },
    stderr: { bytes: stderr.length, sha256: digest(stderr), file: stderrFile },
    record: join(options.directory, `${options.name}.command.json`),
  }
  writeFileSync(evidence.record, `${JSON.stringify(evidence, null, 2)}\n`)
  return { result, stdout, stderr, evidence }
}

function requireSuccess(command: ReturnType<typeof capture>) {
  if (command.result.status !== 0 || command.result.error || command.stderr.length !== 0) throw new Error(`7-Zip command failed or returned unknown diagnostics: ${command.evidence.record}`)
}
function text(bytes: Buffer) {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r\n/g, '\n')
}
function safeMemberPath(value: string) {
  if (!value || /[\x00-\x1f\x7f:]/.test(value) || /^[\\/]/.test(value) || value.split(/[\\/]/).some(part => !part || part === '.' || part === '..')) {
    throw new Error('Unsafe archive member path')
  }
  return value.replace(/\\/g, '/')
}
function fields(lines: string[]) {
  const result: Record<string, string> = Object.create(null)
  for (const line of lines) {
    if (!line) continue
    const at = line.indexOf(' = ')
    if (at < 1 || Object.hasOwn(result, line.slice(0, at))) throw new Error('Malformed or duplicate technical-listing field')
    result[line.slice(0, at)] = line.slice(at + 3)
  }
  return result
}

export function parseSevenZipListing(source: string, type: 'Nsis' | '7z') {
  const lines = source.replace(/\r\n/g, '\n').trimEnd().split('\n')
  if (source.length > 4 * 1024 * 1024 || /[\x00-\x08\x0b-\x1f\x7f]/.test(lines.join('\n')) || /^(?:ERROR|WARNINGS?):/mi.test(source)) throw new Error('Malformed or warning-bearing technical listing')
  const start = lines.indexOf('--')
  const separator = lines.indexOf('----------')
  if (start < 0 || separator <= start || lines.lastIndexOf('--') !== start || lines.lastIndexOf('----------') !== separator) {
    throw new Error('Missing or ambiguous archive listing boundary')
  }
  const archive = fields(lines.slice(start + 1, separator))
  if (archive.Type !== type || !archive.Path || archive.ERROR || archive.WARNINGS) throw new Error(`Expected unambiguous ${type} archive`)
  const body = lines.slice(separator + 1).join('\n').trim()
  if (!body) throw new Error('Archive has no listed members')
  const members = body.split(/\n\n+/).map(block => fields(block.split('\n')))
  const seen = new Set<string>()
  for (const member of members) {
    const name = safeMemberPath(member.Path ?? '')
    const key = name.toLowerCase()
    if (seen.has(key)) throw new Error('Duplicate archive member path')
    seen.add(key)
    for (const name of ['Size', 'Packed Size', 'Offset']) {
      const value = member[name]
      if (value !== undefined && value !== '' && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))) {
        throw new Error('Malformed archive member size or offset')
      }
    }
  }
  return { archive, members }
}

export function selectLiteralMember(listing: ReturnType<typeof parseSevenZipListing>, expected: { path: string; bytes: number }) {
  safeMemberPath(expected.path)
  if (!Number.isSafeInteger(expected.bytes) || expected.bytes < 2 || expected.bytes > 4 * 1024 * 1024) throw new Error('Invalid expected member size')
  const matches = listing.members.filter(member => member.Path === expected.path)
  if (matches.length !== 1) throw new Error('Exact literal archive member is absent or ambiguous')
  const member = matches[0]!
  if (member.Folder === '+' || member['Symbolic Link'] || member['Hard Link'] || member['Alternate Stream'] ||
      (member.Size !== undefined && member.Size !== '' && Number(member.Size) !== expected.bytes)) {
    throw new Error('Literal archive member is not the expected regular file')
  }
  return member
}

/** The installer is data only: the reduced, already pinned extractor opens its 7z payload. */
export function bootstrapFullSevenZip(options: {
  archive: string; bootstrap: string; directory: string; evidenceDirectory: string; run?: SevenZipRunner
  pins?: { version: string; bytes: number; sha256: string; files: Record<string, FilePin> }
}): SevenZipExtractor {
  const pins = options.pins ?? pinnedFullSevenZip
  verifyFile(options.archive, pins)
  if (realpathSync(options.archive) === realpathSync(options.bootstrap)) throw new Error('Never execute the tool installer')
  mkdirSync(options.directory)
  const list = capture({ executable: options.bootstrap, argv: ['l', '-slt', '-sccUTF-8', '-t7z', '--', options.archive],
    directory: options.evidenceDirectory, workingDirectory: options.directory, name: 'bootstrap-list', maxBuffer: 4 * 1024 * 1024, run: options.run })
  requireSuccess(list)
  const listing = parseSevenZipListing(text(list.stdout), '7z')
  for (const [path, pin] of Object.entries(pins.files)) selectLiteralMember(listing, { path, bytes: pin.bytes })
  const extract = capture({ executable: options.bootstrap,
    argv: ['e', '-t7z', '-spd', '-y', `-o${options.directory}`, '--', options.archive, ...Object.keys(pins.files)],
    directory: options.evidenceDirectory, workingDirectory: options.directory, name: 'bootstrap-extract', maxBuffer: 4 * 1024 * 1024, run: options.run })
  requireSuccess(extract)
  if (readdirSync(options.directory).sort().join('\n') !== Object.keys(pins.files).sort().join('\n')) throw new Error('Unexpected bootstrap outputs')
  const files = Object.entries(pins.files).map(([name, pin]) => {
    const file = join(options.directory, name)
    verifyFile(file, pin)
    return { file: realpathSync(file), ...pin }
  })
  return { version: pins.version, executable: realpathSync(join(options.directory, '7z.exe')), files,
    archive: { file: realpathSync(options.archive), bytes: pins.bytes, sha256: pins.sha256 },
    bootstrap: [list.evidence, extract.evidence] }
}

export type NsisMemberProof = {
  version: 1
  status: 'member_proven' | 'not_proven'
  setup: { file: string } & FilePin
  extractor: SevenZipExtractor
  forcedType: 'Nsis'
  literalMember: string
  member?: Record<string, string>
  commands: SevenZipCommand[]
  output?: { file: string } & FilePin
  peExecuted: false
  error?: string
}

export function proveNsisMember(options: {
  setup: { file: string } & FilePin
  extractor: SevenZipExtractor
  member: { path: string } & FilePin
  output: string
  evidenceDirectory: string
  run?: SevenZipRunner
}) {
  const proof: NsisMemberProof = {
    version: 1, status: 'not_proven', setup: options.setup, extractor: options.extractor,
    forcedType: 'Nsis', literalMember: options.member.path, commands: [], peExecuted: false,
  }
  mkdirSync(options.evidenceDirectory, { recursive: true })
  try {
    if (!/^[0-9a-f]{64}$/.test(options.member.sha256)) throw new Error('Invalid expected member SHA-256')
    if (!Number.isSafeInteger(options.member.bytes) || options.member.bytes < 2 || options.member.bytes > 4 * 1024 * 1024) throw new Error('Invalid expected member size')
    verifyFile(options.setup.file, options.setup)
    for (const file of options.extractor.files) verifyFile(file.file, file)
    if (!options.extractor.files.some(file => resolve(file.file) === resolve(options.extractor.executable))) throw new Error('Extractor executable is not pinned')
    const info = capture({ executable: options.extractor.executable, argv: ['i', '-sccUTF-8'], directory: options.evidenceDirectory,
      workingDirectory: dirname(options.output), name: 'formats', maxBuffer: 1024 * 1024, run: options.run })
    proof.commands.push(info.evidence)
    requireSuccess(info)
    const description = text(info.stdout)
    const formats = description.split('Formats:\n')[1]?.split('\nCodecs:')[0]
    if (options.extractor.version !== '26.06' || !/^7-Zip(?: \(z\))? 26\.06\b/m.test(description) ||
        !formats?.split('\n').some(line => line.trim().split(/\s+/).includes('Nsis'))) throw new Error('Full extractor has no proven NSIS handler')
    const list = capture({ executable: options.extractor.executable,
      argv: ['l', '-slt', '-sccUTF-8', '-tNsis', '--', options.setup.file], directory: options.evidenceDirectory,
      workingDirectory: dirname(options.output), name: 'nsis-list', maxBuffer: 4 * 1024 * 1024, run: options.run })
    proof.commands.push(list.evidence)
    requireSuccess(list)
    const listing = parseSevenZipListing(text(list.stdout), 'Nsis')
    if (listing.archive.Path !== options.setup.file) throw new Error('Listing names a different setup')
    proof.member = selectLiteralMember(listing, options.member)
    const extract = capture({ executable: options.extractor.executable,
      argv: ['e', '-tNsis', '-spd', '-so', '-bso0', '-bse2', '-bsp0', '--', options.setup.file, options.member.path],
      directory: options.evidenceDirectory, name: 'nsis-extract', binary: true,
      workingDirectory: dirname(options.output), maxBuffer: options.member.bytes + 64 * 1024, run: options.run })
    proof.commands.push(extract.evidence)
    requireSuccess(extract)
    if (extract.stdout.length !== options.member.bytes || digest(extract.stdout) !== options.member.sha256 ||
        extract.stdout.toString('ascii', 0, 2) !== 'MZ') throw new Error('Extracted member byte count or SHA-256 does not match')
    // Recheck the container and tool identities after the read-only subprocesses.
    verifyFile(options.setup.file, options.setup)
    for (const file of options.extractor.files) verifyFile(file.file, file)
    writeFileSync(options.output, extract.stdout, { flag: 'wx' })
    proof.output = { file: realpathSync(options.output), bytes: extract.stdout.length, sha256: digest(extract.stdout) }
    proof.status = 'member_proven'
  } catch (error) {
    proof.error = String(error)
  }
  const evidenceFile = join(options.evidenceDirectory, 'member-proof.json')
  writeFileSync(evidenceFile, `${JSON.stringify(proof, null, 2)}\n`)
  return { proof, evidenceFile }
}
