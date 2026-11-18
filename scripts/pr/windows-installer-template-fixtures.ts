import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'

export const installerPathCases = [
  { name: 'plain', source: 'source', current: 'current', temp: 'temp', beforeFails: false },
  { name: 'source-apostrophe', source: "source O'Neil", current: 'current', temp: 'temp', beforeFails: true },
  { name: 'source-backtick', source: 'source`printf x`', current: 'current', temp: 'temp', beforeFails: process.platform !== 'win32' },
  { name: 'current-apostrophe', source: 'source', current: "current O'Neil", temp: 'temp', beforeFails: true },
  { name: 'current-backtick', source: 'source', current: 'current`printf y`', temp: 'temp', beforeFails: process.platform !== 'win32' },
  { name: 'temp-apostrophe', source: 'source', current: 'current', temp: "temp O'Neil", beforeFails: true },
  { name: 'temp-backtick', source: 'source', current: 'current', temp: 'temp`printf z`', beforeFails: process.platform !== 'win32' },
  { name: 'combined', source: "source O'Neil `printf x` ~27 %P2% ! ^", current: "current O'Neil `printf y` ~27 %P2% ! ^", temp: "temp O'Neil `printf z` ~27 %P2% ! ^", beforeFails: true },
] as const

// Deliberately not runnable. Only the build-time PE/embedding interfaces are
// exercised on non-Windows hosts; no compiler or product-backend claim follows.
export function guardedRemovalCompilerFixturePe() {
  const bytes = Buffer.alloc(512)
  bytes.write('MZ')
  bytes.writeUInt32LE(0x80, 0x3c)
  bytes.write('PE\0\0', 0x80)
  bytes.writeUInt16LE(0x14c, 0x84)
  bytes.writeUInt16LE(1, 0x86)
  bytes.writeUInt16LE(224, 0x94)
  bytes.writeUInt16LE(0x10b, 0x98)
  bytes.writeUInt32LE(16, 0x98 + 92)
  bytes.writeUInt32LE(0x2000, 0x98 + 208)
  bytes.writeUInt32LE(72, 0x98 + 212)
  bytes.writeUInt32LE(0x2000, 0x178 + 12)
  bytes.writeUInt32LE(72, 0x178 + 16)
  bytes.writeUInt32LE(0x1a0, 0x178 + 20)
  bytes.writeUInt32LE(72, 0x1a0)
  bytes.writeUInt16LE(2, 0x1a0 + 4)
  bytes.writeUInt16LE(5, 0x1a0 + 6)
  bytes.writeUInt32LE(3, 0x1a0 + 16)
  return bytes
}

export async function compileInstallerPathCases(options: {
  root: string
  sourceRoot: string
  compiler: string
  templates: string
  resources: string
  env: Record<string, string>
}) {
  const { root, sourceRoot, compiler, templates, resources } = options
  const vendorRoot = resolve(templates, '../..')
  const require = createRequire(join(vendorRoot, 'package.json'))
  // Load the ordinary package entry first, as electron-builder does, to avoid
  // loading NsisTarget in the middle of its PlatformPackager circular import.
  require(join(vendorRoot, 'out/index.js'))
  const { NsisTarget } = require(join(vendorRoot, 'out/targets/nsis/NsisTarget.js'))
  const { UninstallerReader } = require(join(vendorRoot, 'out/targets/nsis/nsisUtil.js'))
  const installer = readFileSync(join(sourceRoot, 'desktop/build/installer.nsh'), 'utf8').replace(/\r\n/g, '\n')
  const legacyLauncher = readFileSync(join(sourceRoot, 'scripts/pr/fixtures/nsis-build-launcher-before-path-encoding.nsh'), 'utf8').replace(/\r\n/g, '\n')
  const launcher = installer.match(/!macro CcHahaRunBuildHelper[^\n]*\n[\s\S]*?\n!macroend/)?.[0]
  if (!launcher) throw new Error('The actual build helper launcher is missing')
  let temporaryFile = 0
  const target = Object.create(NsisTarget.prototype)
  target.options = JSON.parse(readFileSync(join(sourceRoot, 'desktop/package.json'), 'utf8')).build.nsis
  const buildResources = join(sourceRoot, 'desktop/build')
  target.packager = {
    projectDir: join(sourceRoot, 'desktop'),
    info: { buildResourcesDir: buildResources, cancellationToken: { cancelled: false } },
    getResource: async (_custom: unknown, name: string) => name === 'installer.nsh' ? join(buildResources, 'installer.nsh') : null,
    getTempFile: async (name: string) => join(root, `${temporaryFile++}-${name}`),
  }
  // This generator only reads the prepared plugin directory. Do not permit its
  // lazy dependency resolver to acquire anything from the public network here.
  const previousResources = process.env.ELECTRON_BUILDER_NSIS_RESOURCES_DIR
  process.env.ELECTRON_BUILDER_NSIS_RESOURCES_DIR = resources
  let header: string
  try { header = await target.computeCommonInstallerScriptHeader() } finally {
    if (previousResources === undefined) delete process.env.ELECTRON_BUILDER_NSIS_RESOURCES_DIR
    else process.env.ELECTRON_BUILDER_NSIS_RESOURCES_DIR = previousResources
  }
  const originalScript = `${header}\n${readFileSync(join(templates, 'installer.nsi'), 'utf8')}`
  const observations = []
  for (const item of installerPathCases) {
    for (const revision of ['before', 'current'] as const) {
      const caseRoot = join(root, `${revision}-${item.name}`)
      const desktop = join(caseRoot, item.source, 'desktop')
      const build = join(desktop, 'build')
      const scripts = join(desktop, 'scripts')
      const temp = join(caseRoot, item.temp, 'tmp')
      const app = join(caseRoot, 'owned-app')
      const current = join(caseRoot, item.current, 'current.exe')
      for (const directory of [build, scripts, temp, app, dirname(current)]) mkdirSync(directory, { recursive: true })
      for (const name of ['legacy-uninstaller-compat.nsh', 'guarded-removal-launch.nsh', 'check-install-processes.nsh', 'recover-legacy-install-data.ps1']) {
        copyFileSync(join(buildResources, name), join(build, name))
      }
      writeFileSync(join(build, 'installer.nsh'), revision === 'before' ? installer.replace(launcher, legacyLauncher.trimEnd()) : installer)
      copyFileSync(join(sourceRoot, 'desktop/scripts/nsis-legacy-compat.cjs'), join(scripts, 'nsis-legacy-compat.production.cjs'))
      copyFileSync(join(sourceRoot, 'desktop/scripts/nsis-guarded-removal.cjs'), join(scripts, 'nsis-guarded-removal.cjs'))
      const helperSource = join(sourceRoot, 'desktop/build/guarded-removal.cs')
      if (existsSync(helperSource)) copyFileSync(helperSource, join(build, 'guarded-removal.cs'))
      else writeFileSync(join(build, 'guarded-removal.cs'), '// Owned compile-only fixture: production backend is not executed or compiled here.\n')
      // Dependency injection is confined to this owned fixture copy. The
      // production CLI has no environment flag to bypass Windows/system CSC.
      writeFileSync(join(scripts, 'nsis-legacy-compat.cjs'), `
const fs = require('node:fs')
const path = require('node:path')
const helper = require(path.join(__dirname, 'nsis-guarded-removal.cjs'))
helper.compile = ({ source, directory }) => {
  const executable = path.join(directory, 'guarded-removal.exe')
  const bytes = Buffer.from('${guardedRemovalCompilerFixturePe().toString('base64')}', 'base64')
  const config = executable + '.config'
  fs.writeFileSync(executable, bytes, { flag: 'wx' })
  fs.writeFileSync(config, helper.clrConfig, { flag: 'wx' })
  return { executable, bytes: bytes.length, sha256: helper.digest(bytes), config,
    configBytes: helper.clrConfig.length, configSha256: helper.digest(helper.clrConfig), sourceSha256: helper.digest(fs.readFileSync(source)) }
}
exports.run = require(path.join(__dirname, 'nsis-legacy-compat.production.cjs')).run
if (require.main === module) exports.run(process.argv[2], process.argv.slice(3))
`)
      writeFileSync(join(app, 'fixture.txt'), 'Owned compile-only payload; no PE execution')
      const env = { ...options.env, NODE_PATH: dirname(vendorRoot), NSISDIR: resolve(dirname(compiler), '..'), TMPDIR: temp, TEMP: temp, TMP: temp }
      const defines = {
        APP_ID: 'com.claude-code-haha.desktop', APP_GUID: 'f01cf2f0-8fe7-55b9-af4b-027bcf9c2cfe',
        UNINSTALL_APP_KEY: 'f01cf2f0-8fe7-55b9-af4b-027bcf9c2cfe', PRODUCT_NAME: 'Claude Code Haha',
        PRODUCT_FILENAME: 'Claude Code Haha', APP_FILENAME: 'Claude Code Haha', APP_DESCRIPTION: 'Path compile-only fixture',
        VERSION: '0.7.8', PROJECT_DIR: desktop, BUILD_RESOURCES_DIR: build, APP_PACKAGE_NAME: 'claude-code-desktop',
        APP_BUILD_DIR: app, APP_64: 'fixture', INSTALL_MODE_PER_ALL_USERS_REQUIRED: null,
        MULTIUSER_INSTALLMODE_ALLOW_ELEVATION: null, allowToChangeInstallationDirectory: null,
        SHORTCUT_NAME: 'Claude Code Haha', UNINSTALL_DISPLAY_NAME: 'Claude Code Haha 0.7.8', UNINSTALLER_OUT_FILE: current,
      }
      const script = originalScript.split(buildResources).join(build)
      const compile = (phase: string, out: string, extra: Record<string, null> = {}) => {
        const prefix = process.platform === 'win32' ? '/' : '-'
        const args = [`${prefix}WX`, `${prefix}XUnicode true`, `${prefix}V2`, `${prefix}INPUTCHARSET`, 'UTF8',
          ...Object.entries({ ...defines, ...extra }).map(([key, value]) => value === null ? `${prefix}D${key}` : `${prefix}D${key}=${value}`),
          `${prefix}XOutFile "${out}"`, `${prefix}XSetCompressor zlib`, '-',
        ]
        const result = spawnSync(compiler, args, { input: script, cwd: templates, env, encoding: 'utf8', timeout: 20_000 })
        const log = join(root, `${revision}-${item.name}-${phase}.log`)
        writeFileSync(log, `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ?? ''}`)
        return { status: result.status, error: result.error?.message, log,
          outputSha256: existsSync(out) ? createHash('sha256').update(readFileSync(out)).digest('hex') : null }
      }
      const wrapper = join(caseRoot, 'wrapper.exe')
      const wrapperCompile = compile('wrapper', wrapper, { BUILD_UNINSTALLER: null })
      if (wrapperCompile.status !== 0) {
        if (revision !== 'before' || !item.beforeFails) throw new Error(`Default uninstaller wrapper failed: ${wrapperCompile.log}\n${readFileSync(wrapperCompile.log, 'utf8')}`)
        observations.push({ name: item.name, revision, beforeFails: item.beforeFails, wrapper: wrapperCompile,
          final: { status: null, error: 'not run: old launcher failed during wrapper compilation', log: wrapperCompile.log, outputSha256: null },
          source: build, current, temp, peExecution: false, helperCompiler: 'injected non-runnable fixture' })
        continue
      }
      // The official extractor reads PE bytes; this never executes a PE.
      await UninstallerReader.exec(wrapper, current)
      const final = compile('final', join(caseRoot, 'installer-compile-only.exe'))
      if (final.status !== 0 && (revision !== 'before' || !item.beforeFails)) throw new Error(`Default final installer failed: ${final.log}\n${readFileSync(final.log, 'utf8')}`)
      observations.push({ name: item.name, revision, beforeFails: item.beforeFails,
        wrapper: wrapperCompile, final, source: build, current, temp, peExecution: false, helperCompiler: 'injected non-runnable fixture' })
    }
  }
  return observations
}
