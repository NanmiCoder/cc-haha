// Invoked only by customHeader in the final NSIS installer compilation. Keep
// electron-builder's installer.nsi and automatic uninstaller signing intact.
const { createHash, randomUUID } = require('node:crypto')
const { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { basename, dirname, join, resolve } = require('node:path')
const guardedRemoval = require('./nsis-guarded-removal.cjs')

const pins = Object.freeze({
  version: '26.8.1',
  'templates/nsis/include/installUtil.nsh': '97bd546b5cd2aaf16b77bc9e2be8a18962dd74ab5c4d23b35b163ca89bf4dd2a',
  'templates/nsis/installer.nsi': '8811964416d122612c3e7601728af5d3f998d677918df829a4e8b4c739c8b9f8',
  'templates/nsis/uninstaller.nsh': '9ee2dac4593478083e8aa6f8487287ce9401006ccd50ecc538871d133ea4a42c',
  'out/targets/nsis/NsisTarget.js': 'ae42d47b34ca010e74a37c79133378bd937d4627eb992abbe4d30de1519d7236',
})
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const literal = value => {
  if (/[\r\n"$]/.test(value)) throw new Error('Unsupported NSIS build path')
  return value
}

function validateVendor(vendorRoot) {
  if (JSON.parse(readFileSync(join(vendorRoot, 'package.json'), 'utf8')).version !== pins.version) {
    throw new Error('Review app-builder-lib before changing the pinned legacy compatibility template')
  }
  for (const [file, expected] of Object.entries(pins)) {
    if (file === 'version') continue
    if (digest(readFileSync(join(vendorRoot, file))) !== expected) throw new Error(`Unreviewed NSIS signing/template boundary: ${file}`)
  }
}

function defaultRemoveFiles(source) {
  if (digest(source) !== pins['templates/nsis/uninstaller.nsh']) throw new Error('Unreviewed app-builder-lib uninstaller.nsh')
  const before = '  # delete the installed files\n  !ifmacrodef customRemoveFiles\n    !insertmacro customRemoveFiles\n  !else\n'
  const after = '  !endif\n\n  ${ifNot} ${isKeepShortcuts}'
  if (source.split(before).length !== 2 || source.split(after).length !== 2) throw new Error('Pinned NSIS removal insertion points are not unique')
  return source.slice(source.indexOf(before) + before.length, source.indexOf(after))
}

function prepareGuarded({ vendorRoot, source, bootstrap, temporaryParent = tmpdir(), compilerCwd = process.cwd(), compile = guardedRemoval.compile }) {
  validateVendor(vendorRoot)
  const originalCwd = realpathSync(join(vendorRoot, 'templates/nsis'))
  if (realpathSync(compilerCwd) !== originalCwd) throw new Error('Unreviewed NSIS compiler working directory')
  const directory = mkdtempSync(join(realpathSync(temporaryParent), 'cc-haha-nsis-compat-'))
  try {
    const owner = randomUUID()
    writeFileSync(join(directory, '.owner'), owner, { flag: 'wx' })
    const helper = compile({ source, directory })
    // Bind the actual final bytes, after compilation. The installer signature
    // covers the embedded resources; it is not a signature on helper.exe.
    for (const [file, bytes, hash] of [[helper.executable, helper.bytes, helper.sha256], [helper.config, helper.configBytes, helper.configSha256]]) {
      if (dirname(file) !== directory || guardedRemoval.regular(file, 'Guarded removal resource').length !== bytes
        || digest(readFileSync(file)) !== hash) throw new Error('Guarded removal compiler resource binding failed')
    }
    guardedRemoval.validatePe(readFileSync(helper.executable))
    const defaultRemoval = join(directory, 'default-remove-files.nsh')
    writeFileSync(defaultRemoval, '!macro CcHahaVendorDefaultRemoveFiles\n'
      + defaultRemoveFiles(readFileSync(join(vendorRoot, 'templates/nsis/uninstaller.nsh'), 'utf8')) + '!macroend\n', { flag: 'wx' })
    writeFileSync(bootstrap, [
      `!define CC_HAHA_GUARDED_HELPER_FILE "${literal(helper.executable)}"`,
      `!define CC_HAHA_GUARDED_HELPER_SHA256 "${helper.sha256}"`,
      `!define CC_HAHA_GUARDED_HELPER_BYTES ${helper.bytes}`,
      `!define CC_HAHA_GUARDED_CONFIG_FILE "${literal(helper.config)}"`,
      `!define CC_HAHA_GUARDED_CONFIG_SHA256 "${helper.configSha256}"`,
      `!define CC_HAHA_GUARDED_CONFIG_BYTES ${helper.configBytes}`,
      `!define CC_HAHA_NSIS_GUARDED_DIRECTORY "${literal(directory)}"`,
      `!define CC_HAHA_NSIS_GUARDED_OWNER "${owner}"`,
      `!include "${literal(defaultRemoval)}"`,
      '',
    ].join('\n'))
    return { directory, owner, helper }
  } catch (error) {
    rmSync(directory, { recursive: true, force: true })
    throw error
  }
}

function adaptInstallUtil(source) {
  if (digest(source) !== pins['templates/nsis/include/installUtil.nsh']) {
    throw new Error('Unreviewed app-builder-lib installUtil.nsh; legacy compatibility is disabled')
  }
  const before = '  # Retry counter\n  StrCpy $R5 0'
  const result = '    CheckResult:\n      ${if} $R0 == 0'
  if (source.split(before).length !== 2 || source.split(result).length !== 2) {
    throw new Error('Pinned NSIS compatibility insertion points are not unique')
  }
  return source.replace(before, '  !insertmacro CcHahaPrepareLegacyCompat\n\n' + before)
    .replace(result, '    CheckResult:\n      !insertmacro CcHahaReturnForLegacyCompat22\n      ${if} $R0 == 0')
    + '\n!cd "${CC_HAHA_NSIS_COMPAT_ORIGINAL_CWD}"\n'
}

function prepare({ vendorRoot, uninstaller, bootstrap, temporaryParent = tmpdir(), compilerCwd = process.cwd() }) {
  validateVendor(vendorRoot)
  const originalCwd = realpathSync(join(vendorRoot, 'templates/nsis'))
  if (realpathSync(compilerCwd) !== originalCwd) throw new Error('Unreviewed NSIS compiler working directory')
  if (!lstatSync(uninstaller).isFile() || lstatSync(uninstaller).isSymbolicLink()) throw new Error('Current uninstaller must be a regular build output')
  const current = readFileSync(uninstaller)
  if (current.length < 2 || current.toString('ascii', 0, 2) !== 'MZ' || digest(current) === 'b0242b31b839cc8bf40ba4ac492004629bcf8ed28f8648d8c46b1797f7befb60') {
    throw new Error('Current signed/generated uninstaller is unavailable')
  }
  const directory = mkdtempSync(join(realpathSync(temporaryParent), 'cc-haha-nsis-compat-'))
  try {
    const owner = randomUUID()
    writeFileSync(join(directory, '.owner'), owner, { flag: 'wx' })
    writeFileSync(join(directory, 'installUtil.nsh'), adaptInstallUtil(readFileSync(join(vendorRoot, 'templates/nsis/include/installUtil.nsh'), 'utf8')), { flag: 'wx' })
    writeFileSync(bootstrap, [
      `!define CC_HAHA_LEGACY_COMPAT_TEMPLATE "${pins.version}"`,
      `!define CC_HAHA_CURRENT_UNINSTALLER_SHA256 "${digest(current)}"`,
      `!define CC_HAHA_CURRENT_UNINSTALLER_BYTES ${current.length}`,
      `!define CC_HAHA_NSIS_COMPAT_DIRECTORY "${literal(directory)}"`,
      `!define CC_HAHA_NSIS_COMPAT_OWNER "${owner}"`,
      `!define CC_HAHA_NSIS_COMPAT_ORIGINAL_CWD "${literal(originalCwd)}"`,
      // NSIS 3.0.4.1 has no /prepend. CWD takes precedence over include dirs;
      // the adapted include restores the pinned original CWD at its final line.
      `!cd "${literal(directory)}"`,
      '',
    ].join('\n'))
    return { directory, owner }
  } catch (error) {
    rmSync(directory, { recursive: true, force: true })
    throw error
  }
}

function cleanup(directory, owner) {
  if (!/^cc-haha-nsis-compat-[a-zA-Z0-9]+$/.test(basename(directory)) || realpathSync(directory) !== resolve(directory)
    || lstatSync(directory).isSymbolicLink() || readFileSync(join(directory, '.owner'), 'utf8') !== owner) {
    throw new Error('Refusing to clean an unowned NSIS temporary directory')
  }
  rmSync(directory, { recursive: true })
}

function run(mode, args) {
  if (mode === 'prepare' && args.length === 2) {
    const vendorRoot = dirname(require.resolve('app-builder-lib/package.json'))
    prepare({ vendorRoot, uninstaller: args[0], bootstrap: args[1] })
  } else if (mode === 'prepare-guarded' && args.length === 2) {
    const vendorRoot = dirname(require.resolve('app-builder-lib/package.json'))
    prepareGuarded({ vendorRoot, source: args[0], bootstrap: args[1] })
  } else if (mode === 'cleanup' && args.length === 2) {
    cleanup(args[0], args[1])
  } else {
    throw new Error('Expected prepare <current-uninstaller> <bootstrap>, prepare-guarded <source> <bootstrap>, or cleanup <directory> <owner>')
  }
}

module.exports = { adaptInstallUtil, cleanup, defaultRemoveFiles, digest, pins, prepare, prepareGuarded, run }
if (require.main === module) run(process.argv[2], process.argv.slice(3))
