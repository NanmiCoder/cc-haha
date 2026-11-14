// Build-time only. The shipped installer embeds the completed PE; an end user
// never runs csc or installs a build dependency to use the compatibility path.
const { spawnSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { lstatSync, readFileSync, realpathSync, writeFileSync } = require('node:fs')
const { isAbsolute, join, resolve } = require('node:path')

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const clrConfig = Buffer.from('<?xml version="1.0" encoding="utf-8"?>\r\n<configuration><startup useLegacyV2RuntimeActivationPolicy="false"><supportedRuntime version="v4.0" sku=".NETFramework,Version=v4.0" /></startup><runtime><loadFromRemoteSources enabled="false" /><generatePublisherEvidence enabled="false" /></runtime></configuration>\r\n')
const samePath = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right

function regular(file, description) {
  const stat = lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || !samePath(realpathSync(file), resolve(file))) {
    throw new Error(`${description} must be a regular non-aliased file`)
  }
  return readFileSync(file)
}

function validatePe(bytes) {
  if (bytes.length < 256 || bytes.toString('ascii', 0, 2) !== 'MZ') throw new Error('Guarded removal compiler did not produce a PE')
  const pe = bytes.readUInt32LE(0x3c)
  if (pe < 0x40 || pe > bytes.length - 24 || bytes.toString('ascii', pe, pe + 4) !== 'PE\0\0') {
    throw new Error('Guarded removal compiler produced an invalid PE header')
  }
  const optional = pe + 24
  const optionalBytes = bytes.readUInt16LE(pe + 20)
  if (bytes.readUInt16LE(pe + 4) !== 0x14c || optionalBytes < 224 || optional + optionalBytes > bytes.length
    || bytes.readUInt16LE(optional) !== 0x10b || bytes.readUInt32LE(optional + 92) < 15
    || bytes.readUInt32LE(optional + 208) === 0 || bytes.readUInt32LE(optional + 212) < 72) {
    throw new Error('Guarded removal compiler must produce an x86 CLR PE')
  }
  const sections = bytes.readUInt16LE(pe + 6)
  const table = optional + optionalBytes
  if (sections === 0 || table + sections * 40 > bytes.length) throw new Error('Guarded removal PE section table is invalid')
  const rva = bytes.readUInt32LE(optional + 208)
  let cli = -1
  for (let i = 0; i < sections; i++) {
    const entry = table + i * 40
    const start = bytes.readUInt32LE(entry + 12)
    const size = bytes.readUInt32LE(entry + 16)
    if (rva >= start && rva - start <= size - 72) cli = bytes.readUInt32LE(entry + 20) + rva - start
  }
  if (cli < 0 || cli > bytes.length - 72 || bytes.readUInt32LE(cli) < 72
    || bytes.readUInt16LE(cli + 4) !== 2 || bytes.readUInt16LE(cli + 6) !== 5
    || (bytes.readUInt32LE(cli + 16) & 3) !== 3) {
    throw new Error('Guarded removal PE must be IL-only and require 32 bits')
  }
}

function compile({ source, directory, windowsDirectory = process.env.SystemRoot, platform = process.platform, spawn = spawnSync, environment = process.env }) {
  if (platform !== 'win32') throw new Error('Guarded removal helper must be built on Windows with the system CLR4 compiler')
  if (!windowsDirectory || !isAbsolute(windowsDirectory) || windowsDirectory.startsWith('\\\\')) throw new Error('A canonical Windows system directory is required')
  const canonicalWindows = realpathSync(windowsDirectory)
  if (!samePath(canonicalWindows, resolve(windowsDirectory))) throw new Error('A canonical Windows system directory is required')
  const framework = join(canonicalWindows, 'Microsoft.NET', 'Framework', 'v4.0.30319')
  const compiler = join(framework, 'csc.exe')
  regular(compiler, 'System CLR4 compiler')
  for (const name of ['mscorlib.dll', 'System.dll', 'System.Core.dll']) regular(join(framework, name), 'System CLR4 reference')
  const input = regular(source, 'Guarded removal source')
  const frozenSource = join(directory, 'guarded-removal.cs')
  const output = join(directory, 'guarded-removal.exe')
  const config = `${output}.config`
  writeFileSync(frozenSource, input, { flag: 'wx' })
  const args = ['/nologo', '/noconfig', '/nostdlib+', '/target:exe', '/platform:x86', '/optimize+', '/checked+', '/warnaserror+',
    ...['mscorlib.dll', 'System.dll', 'System.Core.dll'].map(name => `/reference:${join(framework, name)}`),
    `/out:${output}`, frozenSource]
  // Neither csc.rsp, a caller-controlled CWD, nor inherited CLR injection
  // switches are allowed to select code during this build-time compilation.
  const compilerEnvironment = Object.fromEntries(Object.entries(environment).filter(([name]) =>
    !/^(?:COR_|CORECLR_|COMPLUS_|DOTNET_|APPDOMAIN_|DEVPATH$|__COMPAT_LAYER$)/i.test(name)))
  const result = spawn(compiler, args, { cwd: framework, env: compilerEnvironment, encoding: 'utf8', windowsHide: true, timeout: 60_000, shell: false })
  if (result.error || result.status !== 0 || result.signal) throw new Error(`System CLR4 helper compilation failed: ${result.error?.message || result.stderr || result.stdout || result.status}`)
  const bytes = regular(output, 'Guarded removal PE')
  validatePe(bytes)
  writeFileSync(config, clrConfig, { flag: 'wx' })
  return { executable: output, bytes: bytes.length, sha256: digest(bytes), config, configBytes: clrConfig.length,
    configSha256: digest(clrConfig), sourceSha256: digest(input), compiler }
}

module.exports = { clrConfig, compile, digest, regular, validatePe }
