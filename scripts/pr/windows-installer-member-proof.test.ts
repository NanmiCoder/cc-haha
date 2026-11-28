import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bootstrapFullSevenZip, historicalUninstallerMember, parseSevenZipListing, pinnedFullSevenZip, proveNsisMember, selectLiteralMember, type SevenZipRunner } from './windows-installer-member-proof'
import { cleanupPreparedWindowsInstallerTests, pinnedNsisCompiler, pinnedNsisResources, prepareWindowsInstallerTests } from './prepare-windows-installer-tests'
import { runWindowsInstallerChecks } from './run-windows-installer-checks'

const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
const releasedListingFixture = JSON.parse(readFileSync(new URL('./fixtures/windows-installer-v078-nsis-list.slt.json', import.meta.url), 'utf8')) as { sha256: string; text: string }
const releasedListing = releasedListingFixture.text
const releasedLiteral = '$R0\\Uninstall Claude Code Haha.exe'
function listing(archive: string, members: string[], type = 'Nsis') {
  return `7-Zip 26.06 (x64)\n\n--\nPath = ${archive}\nType = ${type}\nPhysical Size = 1234\n\n----------\n${members.join('\n\n')}\n`
}
function member(path = historicalUninstallerMember.path, size = '') {
  return `Path = ${path}\nSize = ${size}\nPacked Size = 12\nMethod = Deflate\nOffset = 100`
}
const info = '7-Zip 26.06 (x64)\n\nFormats:\n     F  Nsis nsis\n\nCodecs:\n'
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cc-haha-member-proof-unit-'))
  const setupFile = join(root, 'owned setup.exe')
  const tool = join(root, 'owned extractor.exe')
  const setupBytes = Buffer.from('owned setup bytes, never executed')
  const toolBytes = Buffer.from('MZ owned fake extractor, never executed')
  const outputBytes = Buffer.from('MZ owned member bytes, never executed')
  writeFileSync(setupFile, setupBytes)
  writeFileSync(tool, toolBytes)
  const options = {
    setup: { file: setupFile, bytes: setupBytes.length, sha256: sha(setupBytes) },
    extractor: { version: '26.06', executable: tool, files: [{ file: tool, bytes: toolBytes.length, sha256: sha(toolBytes) }] },
    member: { path: historicalUninstallerMember.path, bytes: outputBytes.length, sha256: sha(outputBytes) },
    output: join(root, 'extracted.exe'), evidenceDirectory: join(root, 'evidence'),
  }
  const calls: Array<{ executable: string; argv: string[]; maxBuffer: number }> = []
  const run = (settings: { list?: string | Buffer; bytes?: Buffer; formats?: string; status?: number; error?: Error; stderr?: string } = {}): SevenZipRunner =>
    (executable, argv, commandOptions) => {
      calls.push({ executable, argv, maxBuffer: commandOptions.maxBuffer })
      expect(commandOptions.env.CLAUDE_CONFIG_DIR).not.toBe(process.env.CLAUDE_CONFIG_DIR)
      expect(commandOptions.env.ANTHROPIC_API_KEY).toBeUndefined()
      const value = argv[0] === 'i' ? settings.formats ?? info : argv[0] === 'l'
        ? settings.list ?? listing(setupFile, [member(), member('$PLUGINSDIR/same-bytes.exe')]) : settings.bytes ?? outputBytes
      return { status: argv[0] === 'e' ? settings.status ?? 0 : 0, stdout: Buffer.from(value),
        stderr: Buffer.from(settings.stderr ?? ''), ...(argv[0] === 'e' && settings.error ? { error: settings.error } : {}) }
    }
  return { root, setupFile, tool, outputBytes, options, calls, run, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

describe('static NSIS member proof', () => {
  test('locks the official tool and member identity without granting F1 compatibility', () => {
    expect(pinnedFullSevenZip).toMatchObject({ version: '26.06', assetId: 720544254, bytes: 1659704,
      sha256: '9b697f65ecc2d9b0152f5ee96d72dde522a7827690349d9307935dacf40f42ec' })
    expect(historicalUninstallerMember).toEqual({ path: '$R0\\Uninstall Claude Code Haha.exe', bytes: 174881,
      sha256: 'b0242b31b839cc8bf40ba4ac492004629bcf8ed28f8648d8c46b1797f7befb60' })
  })

  test('selects the full virtual-directory literal from the recorded official setup listing', () => {
    // Original Windows 26.06 listing, with CRLF normalized to LF only.
    expect(sha(releasedListing)).toBe('6b8fc6badbceee41b2e22a14bd23064e46bc526a1e739fd7065fa231a4fdfce9')
    expect(sha(releasedListing)).toBe(releasedListingFixture.sha256)
    const parsed = parseSevenZipListing(releasedListing, 'Nsis')
    expect(parsed.archive['Physical Size']).toBe('230611497')
    expect(() => selectLiteralMember(parsed, { ...historicalUninstallerMember, path: 'Uninstall Claude Code Haha.exe' })).toThrow('absent or ambiguous')
    expect(historicalUninstallerMember.path).toBe(releasedLiteral)
    expect(selectLiteralMember(parsed, historicalUninstallerMember)).toMatchObject({ Path: releasedLiteral, Size: '', 'Packed Size': '153855', Offset: '230342792' })
  })

  test('proves the recorded listing with one exact -spd selector and no virtual-directory output path', () => {
    const f = fixture()
    try {
      const source = releasedListing.replace(/^Path = .+$/m, `Path = ${f.setupFile}`)
      const old = proveNsisMember({ ...f.options, member: { ...f.options.member, path: 'Uninstall Claude Code Haha.exe' },
        output: join(f.root, 'old-output.exe'), evidenceDirectory: join(f.root, 'old-evidence'), run: f.run({ list: source }) }).proof
      expect(old.status).toBe('not_proven')
      expect(f.calls.map(call => call.argv[0])).toEqual(['i', 'l'])
      f.calls.length = 0
      const { proof } = proveNsisMember({ ...f.options, run: f.run({ list: source }) })
      expect(proof.status).toBe('member_proven')
      expect(proof.literalMember).toBe(releasedLiteral)
      expect(proof.member?.['Packed Size']).toBe('153855')
      expect(f.calls[2]!.argv).toEqual(['e', '-tNsis', '-spd', '-so', '-bso0', '-bse2', '-bsp0', '--', f.setupFile, releasedLiteral])
      expect(readFileSync(f.options.output)).toEqual(f.outputBytes)
      expect(proof.peExecuted).toBe(false)
    } finally { f.cleanup() }
  })

  test.each(['duplicate', 'case-duplicate', 'separator-alias', 'basename-only', 'different-register', 'traversal', 'ADS', 'wildcard'])('refuses %s changes to the recorded listing before extraction', kind => {
    const f = fixture()
    try {
      let source = releasedListing.replace(/^Path = .+$/m, `Path = ${f.setupFile}`)
      if (kind === 'duplicate') source += `\n${member(releasedLiteral)}\n`
      if (kind === 'case-duplicate') source += `\n${member(releasedLiteral.toLowerCase())}\n`
      if (kind === 'separator-alias') source += `\n${member('$R0/Uninstall Claude Code Haha.exe')}\n`
      if (kind === 'basename-only') source = source.replace(releasedLiteral, 'Uninstall Claude Code Haha.exe')
      if (kind === 'different-register') source = source.replace(releasedLiteral, '$R1\\Uninstall Claude Code Haha.exe')
      if (kind === 'traversal') source += `\n${member('$R0\\..\\unexpected.exe')}\n`
      if (kind === 'ADS') source += `\n${member('$R0\\unexpected.exe:stream')}\n`
      const expected = kind === 'wildcard' ? { ...f.options.member, path: '$R0\\*Uninstall*.exe' } : f.options.member
      const { proof } = proveNsisMember({ ...f.options, member: expected, run: f.run({ list: source }) })
      expect(proof.status).toBe('not_proven')
      expect(f.calls.map(call => call.argv[0])).toEqual(['i', 'l'])
      expect(existsSync(f.options.output)).toBe(false)
    } finally { f.cleanup() }
  })

  test('allows unknown listing size and same-offset aliases while selecting one exact literal member', () => {
    const f = fixture()
    try {
      const { proof, evidenceFile } = proveNsisMember({ ...f.options, run: f.run() })
      expect(proof.status).toBe('member_proven')
      expect(proof.member?.Size).toBe('')
      expect(proof.peExecuted).toBe(false)
      expect(readFileSync(f.options.output)).toEqual(f.outputBytes)
      expect(f.calls.map(call => call.argv[0])).toEqual(['i', 'l', 'e'])
      expect(f.calls.every(call => call.executable === f.tool)).toBe(true)
      expect(f.calls[1]!.argv).toContain('-tNsis')
      expect(f.calls[2]!.argv).toEqual(['e', '-tNsis', '-spd', '-so', '-bso0', '-bse2', '-bsp0', '--', f.setupFile, historicalUninstallerMember.path])
      expect(f.calls[2]!.maxBuffer).toBe(f.outputBytes.length + 64 * 1024)
      expect(proof.commands[2]!.stdout).toEqual({ bytes: f.outputBytes.length, sha256: sha(f.outputBytes) })
      expect(proof.commands[2]!.stdout.file).toBeUndefined()
      expect(JSON.parse(readFileSync(evidenceFile, 'utf8')).status).toBe('member_proven')
      expect(readFileSync(proof.commands[1]!.stdout.file!, 'utf8')).toContain('$PLUGINSDIR/same-bytes.exe')
    } finally { f.cleanup() }
  })

  test.each([
    ['traversal', '../Uninstall Claude Code Haha.exe'], ['absolute', '/Uninstall Claude Code Haha.exe'],
    ['drive', 'C:\\Uninstall Claude Code Haha.exe'], ['ADS', 'Uninstall Claude Code Haha.exe:stream'],
    ['parent segment', 'a/../Uninstall Claude Code Haha.exe'],
  ])('rejects %s member paths before extraction', (_name, path) => {
    const f = fixture()
    try {
      const proof = proveNsisMember({ ...f.options, run: f.run({ list: listing(f.setupFile, [member(), member(path)]) }) }).proof
      expect(proof.status).toBe('not_proven')
      expect(f.calls.map(call => call.argv[0])).toEqual(['i', 'l'])
      expect(existsSync(f.options.output)).toBe(false)
    } finally { f.cleanup() }
  })

  test.each(['duplicate', 'case-duplicate', 'type7z', 'malformed', 'duplicate-field', 'bad-size', 'missing', 'warning', 'wrong-archive', 'link', 'folder', 'invalid-utf8'])('retains real listing and denies %s', kind => {
    const f = fixture()
    try {
      let source: string | Buffer = listing(f.setupFile, [member()])
      if (kind === 'duplicate') source = listing(f.setupFile, [member(), member()])
      if (kind === 'case-duplicate') source = listing(f.setupFile, [member(), member(historicalUninstallerMember.path.toLowerCase())])
      if (kind === 'type7z') source = listing(f.setupFile, [member()], '7z')
      if (kind === 'malformed') source += '\nunparsed line\n'
      if (kind === 'duplicate-field') source = listing(f.setupFile, [`${member()}\nPath = other.exe`])
      if (kind === 'bad-size') source = listing(f.setupFile, [member(undefined, '-1')])
      if (kind === 'missing') source = listing(f.setupFile, [member('Other uninstall.exe')])
      if (kind === 'warning') source = `WARNINGS:\nunknown archive warning\n${source}`
      if (kind === 'wrong-archive') source = listing('some-other-setup.exe', [member()])
      if (kind === 'link') source = listing(f.setupFile, [`${member()}\nSymbolic Link = target.exe`])
      if (kind === 'folder') source = listing(f.setupFile, [`${member()}\nFolder = +`])
      if (kind === 'invalid-utf8') source = Buffer.from([0xff, 0xfe])
      const { proof } = proveNsisMember({ ...f.options, run: f.run({ list: source }) })
      expect(proof.status).toBe('not_proven')
      expect(proof.commands).toHaveLength(2)
      expect(readFileSync(proof.commands[1]!.stdout.file!)).toEqual(Buffer.from(source))
      expect(f.calls).toHaveLength(2)
      expect(existsSync(f.options.output)).toBe(false)
    } finally { f.cleanup() }
  })

  test.each(['size', 'sha', 'non-mz', 'exit', 'overflow', 'stderr'])('rejects %s output and retains command evidence without writing a candidate', kind => {
    const f = fixture()
    try {
      const bytes = kind === 'size' ? f.outputBytes.subarray(0, 3) : Buffer.from(f.outputBytes)
      if (kind === 'sha') bytes[bytes.length - 1] ^= 1
      if (kind === 'non-mz') bytes[0] = 0
      const memberPin = kind === 'non-mz' ? { ...f.options.member, sha256: sha(bytes) } : f.options.member
      const { proof } = proveNsisMember({ ...f.options, member: memberPin, run: f.run({ bytes,
        status: kind === 'exit' ? 2 : 0, ...(kind === 'overflow' ? { error: new Error('ENOBUFS') } : {}),
        ...(kind === 'stderr' ? { stderr: 'unreviewed diagnostic' } : {}),
      }) })
      expect(proof.status).toBe('not_proven')
      expect(existsSync(f.options.output)).toBe(false)
      expect(proof.commands.length).toBe(kind === 'stderr' ? 1 : 3)
      expect(proof.error).toBeDefined()
    } finally { f.cleanup() }
  })

  test.each(['setup', 'tool', 'formats', 'output-exists'])('fails closed for changed %s state', kind => {
    const f = fixture()
    try {
      if (kind === 'setup') writeFileSync(f.setupFile, 'changed setup')
      if (kind === 'tool') writeFileSync(f.tool, 'changed tool')
      if (kind === 'output-exists') writeFileSync(f.options.output, 'keep this existing file')
      const { proof } = proveNsisMember({ ...f.options, run: f.run(kind === 'formats' ? { formats: '7-Zip 26.06\nFormats:\n7z 7z\n\nCodecs:\n' } : {}) })
      expect(proof.status).toBe('not_proven')
      expect(f.calls.length).toBe(kind === 'setup' || kind === 'tool' ? 0 : kind === 'formats' ? 1 : 3)
      if (kind === 'output-exists') expect(readFileSync(f.options.output, 'utf8')).toBe('keep this existing file')
    } finally { f.cleanup() }
  })

  test('rejects a contradictory known listing size while allowing an omitted size', () => {
    const f = fixture()
    try {
      expect(() => selectLiteralMember(parseSevenZipListing(listing(f.setupFile, [member(undefined, '123')]), 'Nsis'), f.options.member)).toThrow('expected regular file')
      expect(selectLiteralMember(parseSevenZipListing(listing(f.setupFile, [member().replace('Size = \n', '')]), 'Nsis'), f.options.member).Path).toBe(f.options.member.path)
    } finally { f.cleanup() }
  })
})

describe('member proof preparation boundary', () => {
  test.each(['matching', 'changed-receipt'])('preserves mock compatibility and validates %s proof at the consumer', async kind => {
    const f = fixture()
    const sourceRoot = join(f.root, 'source')
    const tempParent = join(f.root, 'temporary')
    const manifestFile = join(sourceRoot, 'artifacts/windows-installer/prepared.json')
    mkdirSync(sourceRoot)
    mkdirSync(tempParent)
    const setupBytes = readFileSync(f.setupFile)
    try {
      const prepare = () => prepareWindowsInstallerTests({ platform: 'win32', sourceRoot, tempParent, manifestFile,
        fixture: { tag: 'owned', assetId: 1, fileName: 'owned.exe', url: 'https://example.invalid/no-network', bytes: setupBytes.length, sha256: sha(setupBytes) },
        acquireTools: async (_source, dependencyRoot) => {
          const compiler = join(dependencyRoot, 'compiler.exe')
          const templates = join(sourceRoot, 'templates')
          mkdirSync(join(templates, 'include'), { recursive: true })
          writeFileSync(compiler, 'owned compiler; never executed')
          writeFileSync(join(templates, 'include/getProcessInfo.nsh'), '; fixture')
          const resources = join(dependencyRoot, 'nsis-resources')
          mkdirSync(join(resources, 'plugins/x86-unicode'), { recursive: true })
          const pluginsSha256: Record<string, string> = {}
          for (const name of pinnedNsisResources.plugins) {
            const bytes = `owned ${name}; never loaded`
            writeFileSync(join(resources, 'plugins/x86-unicode', name), bytes)
            pluginsSha256[name] = sha(bytes)
          }
          return { compiler, templates, ...pinnedNsisCompiler, compilerSha256: sha('owned compiler; never executed'), resources: {
            directory: resources, version: pinnedNsisResources.version, archiveSha512: pinnedNsisResources.archiveSha512, pluginsSha256,
          } }
        },
        download: async (_url, file) => writeFileSync(file, setupBytes),
        extract: async (_source, installer, directory) => {
          const file = join(directory, 'owned-member.exe')
          writeFileSync(file, f.outputBytes)
          return { status: 'extracted', method: 'injected fixture extractor', diagnostics: [], file,
            memberProof: { version: 1, status: 'member_proven', forcedType: 'Nsis', literalMember: f.options.member.path,
              setup: { file: installer, bytes: setupBytes.length, sha256: sha(setupBytes) }, extractor: f.options.extractor,
              commands: [], peExecuted: false,
              output: { file: realpathSync(file), bytes: f.outputBytes.length, sha256: kind === 'changed-receipt' ? '0'.repeat(64) : sha(f.outputBytes) },
            },
          }
        },
      })
      if (kind === 'changed-receipt') await expect(prepare()).rejects.toThrow('no longer matches its static member proof')
      else {
        const prepared = await prepare()
        expect(prepared.extraction?.memberProof?.status).toBe('member_proven')
        expect(prepared.compatibilityEnabled).toBe(false)
        expect(prepared.compatibilityProfile).toBe('not_proven')
        expect(prepared.oldExit22BeforeMutation).toBe('not_run')
        expect(prepared.removalEquivalence).toBe('not_run')
        expect(await runWindowsInstallerChecks({ platform: 'win32', sourceRoot, tempParent, manifestFile,
          run: async (command, options) => {
            expect(command).toContain('./scripts/pr/windows-installer-member-proof.test.ts')
            expect(options.env.CC_HAHA_TEST_NSIS_RESOURCES).toBe(prepared.tools!.resources.directory)
            return 0
          },
        })).toEqual({ status: 'passed', exitCode: 0 })
      }
      cleanupPreparedWindowsInstallerTests(JSON.parse(readFileSync(manifestFile, 'utf8')), { sourceRoot, tempParent })
    } finally { f.cleanup() }
  })
})

describe('read-only full 7-Zip bootstrap', () => {
  test.each(['success', 'archive-mismatch', 'tool-mismatch', 'extra-output', 'wrong-type'])('handles %s without executing the tool installer', kind => {
    const root = mkdtempSync(join(tmpdir(), 'cc-haha-full-seven-zip-unit-'))
    try {
      const archive = join(root, 'tool-installer.exe')
      const bootstrap = join(root, 'existing-7za.exe')
      const directory = join(root, 'full-tool')
      const archiveBytes = Buffer.from('owned archive fixture, never executed')
      const payloads = { '7z.exe': Buffer.from('MZ owned tool, never executed'), '7z.dll': Buffer.from('MZ owned DLL, never loaded') }
      const pins = { version: '26.06', bytes: archiveBytes.length, sha256: sha(archiveBytes),
        files: Object.fromEntries(Object.entries(payloads).map(([name, bytes]) => [name, { bytes: bytes.length, sha256: sha(bytes) }])) }
      writeFileSync(archive, kind === 'archive-mismatch' ? 'changed archive' : archiveBytes)
      writeFileSync(bootstrap, 'owned fake bootstrap, never executed')
      const calls: string[][] = []
      const run: SevenZipRunner = (executable, argv) => {
        expect(executable).toBe(bootstrap)
        expect(executable).not.toBe(archive)
        calls.push(argv)
        if (argv[0] === 'e') {
          for (const [name, bytes] of Object.entries(payloads)) writeFileSync(join(directory, name), kind === 'tool-mismatch' && name === '7z.dll' ? 'changed DLL' : bytes)
          if (kind === 'extra-output') writeFileSync(join(directory, 'unexpected.exe'), 'not allowed')
        }
        return { status: 0, stdout: Buffer.from(argv[0] === 'l' ? listing(archive, Object.entries(pins.files).map(([name, pin]) => member(name, String(pin.bytes))), kind === 'wrong-type' ? 'Nsis' : '7z') : 'Everything is Ok'), stderr: Buffer.alloc(0) }
      }
      const action = () => bootstrapFullSevenZip({ archive, bootstrap, directory, evidenceDirectory: join(root, 'evidence'), pins, run })
      if (kind === 'success') {
        const tool = action()
        expect(tool.files).toHaveLength(2)
        expect(tool.bootstrap).toHaveLength(2)
        expect(calls[1]).toEqual(['e', '-t7z', '-spd', '-y', `-o${directory}`, '--', archive, '7z.exe', '7z.dll'])
      } else {
        expect(action).toThrow()
        expect(calls.length).toBe(kind === 'archive-mismatch' ? 0 : kind === 'wrong-type' ? 1 : 2)
      }
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
