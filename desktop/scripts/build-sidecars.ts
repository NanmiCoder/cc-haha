import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  getBundledRipgrepName,
  stageRipgrepLicenses,
} from './prepare-ripgrep'
import {
  SIDECAR_SIGNING_IDENTIFIER,
  codesignTimestampArgument,
  detectStableSigningIdentity,
} from './sign-identity'
import {
  createCuHelperBuildEnv,
  resolveCuHelperArch,
  type CuHelperArch,
} from './cu-helper-build-target'

const desktopRoot = path.resolve(import.meta.dir, '..')
const repoRoot = path.resolve(desktopRoot, '..')
const binariesDir = path.join(desktopRoot, 'src-tauri', 'binaries')

// The SwiftPM resource bundle the cu-helper binary loads at runtime via
// `Bundle.module`. It MUST travel next to the binary or the LensSequence
// overlay assets fail to load. Declared up here (BEFORE the top-level
// `await buildCuHelper()` below) so it is initialized when that runs — a
// `const` placed after the call site hits the temporal dead zone (ReferenceError).
// SwiftPM names the resource bundle `${PackageName}_${TargetName}.bundle`.
// Package stays `cu-helper`; the executable target is now `cc-haha-computer-use`.
const CU_HELPER_RESOURCE_BUNDLE = 'cu-helper_cc-haha-computer-use.bundle'

const targetTriple =
  process.env.SIDECAR_TARGET_TRIPLE ||
  process.env.TAURI_ENV_TARGET_TRIPLE ||
  process.env.CARGO_BUILD_TARGET ||
  (await detectHostTriple())

const bunTarget = mapTargetTripleToBun(targetTriple)

// 编译前先扫一遍 src/ 把所有缺失的 ant-internal 模块在磁盘上 stub 出来。
// 见 desktop/scripts/scan-missing-imports.ts。
console.log('[build-sidecars] scanning for missing imports...')
const scanProc = Bun.spawn(
  [process.execPath, 'run', path.join(desktopRoot, 'scripts/scan-missing-imports.ts')],
  { cwd: repoRoot, stdout: 'inherit', stderr: 'inherit' },
)
const scanExit = await scanProc.exited
if (scanExit !== 0) {
  throw new Error(`[build-sidecars] scan-missing-imports failed (exit ${scanExit})`)
}

await mkdir(binariesDir, { recursive: true })
await stageRipgrepLicenses(binariesDir)
await stageHostRipgrepForOfflineBuild()

// 单一合并 sidecar：server / cli 共享一份 bun runtime + 共享依赖代码。
// 调用方（Electron sidecar manager / legacy Tauri host / conversationService）
// 通过第一个 positional 参数选择 'server' 或 'cli' 模式，详见 desktop/sidecars/claude-sidecar.ts。
await compileExecutable({
  entrypoint: path.join(desktopRoot, 'sidecars/claude-sidecar.ts'),
  outfileBase: path.join(binariesDir, `claude-sidecar-${targetTriple}`),
  productName: 'Claude Code Sidecar',
  bunTarget,
})

console.log(`[build-sidecars] Built desktop sidecar for ${targetTriple} (${bunTarget})`)

// macOS-only: build + bundle the native `cu-helper` Computer Use binary.
// On Windows/Linux this is skipped entirely so the Python helper path is
// preserved (helperBridge.ts routes non-darwin → python). We do NOT ad-hoc
// re-sign cu-helper here: native/cu-helper/build.sh already signs it with a
// STABLE identity + hardened runtime, and re-signing would rotate its TCC
// identity, dropping the user's Accessibility + Screen Recording grants.
const cuHelperArch = resolveCuHelperArch(targetTriple)
if (process.platform === 'darwin' && cuHelperArch) {
  await buildCuHelper(cuHelperArch)
}

async function stageHostRipgrepForOfflineBuild() {
  const destination = path.join(binariesDir, getBundledRipgrepName(targetTriple))
  const manifestPath = path.join(binariesDir, 'ripgrep-manifest.json')
  if (
    await Bun.file(destination).exists() &&
    await hasMatchingRipgrepManifest(manifestPath, targetTriple)
  ) {
    return
  }

  const hostTriple = await detectHostTriple()
  if (hostTriple !== targetTriple) {
    throw new Error(
      `[build-sidecars] bundled ripgrep missing for cross target ${targetTriple}; run prepare:ripgrep first`,
    )
  }

  const systemRipgrep = Bun.which('rg')
  if (!systemRipgrep) {
    console.warn(
      '[build-sidecars] system ripgrep unavailable for offline build; release builds must run prepare:ripgrep',
    )
    return
  }

  const versionCheck = Bun.spawn([systemRipgrep, '--version'], {
    stdout: 'pipe',
    stderr: 'ignore',
  })
  const [versionOutput, versionExit] = await Promise.all([
    new Response(versionCheck.stdout).text(),
    versionCheck.exited,
  ])
  if (versionExit !== 0 || !versionOutput.startsWith('ripgrep ')) {
    console.warn(`[build-sidecars] refusing unusable system ripgrep at ${systemRipgrep}`)
    return
  }

  await copyFile(systemRipgrep, destination)
  await chmod(destination, 0o755)
  await writeFile(
    manifestPath,
    `${JSON.stringify({
      version: versionOutput.split(/\r?\n/, 1)[0]?.replace(/^ripgrep\s+/, ''),
      targetTriple,
      source: 'system-dev-fallback',
    }, null, 2)}\n`,
  )
  console.log(`[build-sidecars] staged host ripgrep for offline build: ${destination}`)
}

async function hasMatchingRipgrepManifest(
  manifestPath: string,
  expectedTargetTriple: string,
): Promise<boolean> {
  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      targetTriple?: string
    }
    return manifest.targetTriple === expectedTargetTriple
  } catch {
    return false
  }
}

async function detectHostTriple() {
  const platform = process.platform
  const arch = process.arch

  if (platform === 'darwin') {
    if (arch === 'arm64') return 'aarch64-apple-darwin'
    if (arch === 'x64') return 'x86_64-apple-darwin'
  }

  if (platform === 'win32') {
    if (arch === 'x64') return 'x86_64-pc-windows-msvc'
    if (arch === 'arm64') return 'aarch64-pc-windows-msvc'
  }

  if (platform === 'linux') {
    if (arch === 'x64') return 'x86_64-unknown-linux-gnu'
    if (arch === 'arm64') return 'aarch64-unknown-linux-gnu'
  }

  throw new Error(`[build-sidecars] Unsupported host platform/arch: ${platform}/${arch}`)
}

function mapTargetTripleToBun(triple: string) {
  switch (triple) {
    case 'aarch64-apple-darwin':
      return 'bun-darwin-arm64'
    case 'x86_64-apple-darwin':
      return 'bun-darwin-x64'
    case 'x86_64-pc-windows-msvc':
      // Prefer baseline on Windows x64 so older CPUs do not crash before the
      // desktop app can even start the local sidecar process.
      // A developer whose machine supports AVX2 may opt into the regular target
      // when diagnosing a local baseline-toolchain problem. Release builds keep
      // the compatible default unless that override is explicit.
      if (process.env.CC_HAHA_BUN_WINDOWS_X64_TARGET === 'bun-windows-x64') {
        return 'bun-windows-x64'
      }
      return 'bun-windows-x64-baseline'
    case 'aarch64-pc-windows-msvc':
      return 'bun-windows-arm64'
    case 'x86_64-unknown-linux-gnu':
      return 'bun-linux-x64-baseline'
    case 'aarch64-unknown-linux-gnu':
      return 'bun-linux-arm64'
    case 'x86_64-unknown-linux-musl':
      return 'bun-linux-x64-musl'
    case 'aarch64-unknown-linux-musl':
      return 'bun-linux-arm64-musl'
    default:
      throw new Error(`[build-sidecars] Unsupported target triple: ${triple}`)
  }
}

async function compileExecutable({
  entrypoint,
  outfileBase,
  productName,
  bunTarget,
}: {
  entrypoint: string
  outfileBase: string
  productName: string
  bunTarget: string
}) {
  const result = await Bun.build({
    entrypoints: [entrypoint],
    features: ['TRANSCRIPT_CLASSIFIER'],
    // minify whitespace + identifiers + dead-code 大概能省 5-15% 的二进制大小，
    // 代价是 stack trace 里的函数名变成短名 —— 终端用户场景可接受。
    minify: { whitespace: true, identifiers: true, syntax: true },
    sourcemap: 'none',
    target: 'bun',
    // 可选 npm 包：开 telemetry / 用 sharp 图像 / 用 Bedrock/Vertex 等
    // 替代 provider 时才需要，全部不在顶层 package.json 里。标 external
    // 让 bun build 跳过解析；运行时 import 在没装时自然失败，由 try/catch
    // 或 feature() gate 兜底。
    external: [
      // OpenTelemetry exporters（开 OTEL_* env 时才加载）
      '@opentelemetry/exporter-trace-otlp-grpc',
      '@opentelemetry/exporter-trace-otlp-http',
      '@opentelemetry/exporter-trace-otlp-proto',
      '@opentelemetry/exporter-logs-otlp-grpc',
      '@opentelemetry/exporter-logs-otlp-http',
      '@opentelemetry/exporter-logs-otlp-proto',
      '@opentelemetry/exporter-metrics-otlp-grpc',
      '@opentelemetry/exporter-metrics-otlp-http',
      '@opentelemetry/exporter-metrics-otlp-proto',
      '@opentelemetry/exporter-prometheus',
      // 替代 LLM provider —— 默认不用，用户自装
      '@aws-sdk/client-bedrock',
      '@aws-sdk/client-sts',
      '@anthropic-ai/bedrock-sdk',
      '@anthropic-ai/foundry-sdk',
      '@anthropic-ai/vertex-sdk',
      '@azure/identity',
      // ant-internal / 可选工具
      '@anthropic-ai/mcpb',
      'fflate',
      'sharp',
      'react-devtools-core',
    ],
    compile: {
      target: bunTarget,
      outfile: outfileBase,
      autoloadTsconfig: true,
      autoloadPackageJson: true,
      windows: {
        title: productName,
        publisher: 'Claude Code',
        description: productName,
        hideConsole: true,
      },
    },
  })

  if (!result.success) {
    const logs = result.logs.map((log) => log.message).join('\n')
    throw new Error(`[build-sidecars] Failed to compile ${productName}:\n${logs}`)
  }

  const outputPath = result.outputs[0]?.path ?? outfileBase
  console.log(`[build-sidecars] ${productName} -> ${outputPath}`)

  // macOS Apple System Policy (ASP) requires valid code signatures on all
  // executables. Bun-compiled binaries ship with an invalid/empty signature
  // that causes "load code signature error 4" and SIGKILL at launch.
  // Fix: strip the broken signature, then re-sign.
  if (process.platform === 'darwin') {
    await signMacBinary(outputPath)
  }
}

/**
 * Sign a compiled sidecar with the build's stable identity and — critically —
 * the FIXED identifier the helper's attestation policy expects.
 *
 * The identifier is the reason this is not just `codesign -s -`. Ad-hoc signing
 * derives the identifier from the file name plus a content hash
 * (`claude-sidecar-aarch64-apple-darwin-5555…`), which never matches
 * `com.claude-code-haha.desktop.sidecar`. `ClientAttestation.swift` compares
 * that identifier exactly, so a hash-suffixed one makes every Computer Use call
 * fail closed with `unauthorized_client`.
 *
 * `--identifier` applies to ad-hoc signatures too, so the unsigned local build
 * still gets the right identifier — it just cannot satisfy the team/leaf half of
 * the policy, which is inherent to having no certificate.
 *
 * electron-builder must not overwrite this signature; `mac.signIgnore` in
 * package.json excludes `claude-sidecar-…` for exactly that reason. That also
 * means entitlements are OUR job here — electron-builder's `entitlementsInherit`
 * never reaches a file it does not sign.
 */
async function signMacBinary(outputPath: string) {
  const identity = await detectStableSigningIdentity()
  const label = identity ?? 'ad-hoc'
  console.log(
    `[build-sidecars] signing ${outputPath} as ${SIDECAR_SIGNING_IDENTIFIER} (${label}) ...`,
  )

  const strip = Bun.spawn(['codesign', '--remove-signature', outputPath], {
    stdout: 'inherit',
    stderr: 'inherit',
  })
  await strip.exited

  const args = [
    'codesign',
    '--sign',
    identity ?? '-',
    '--force',
    '--identifier',
    SIDECAR_SIGNING_IDENTIFIER,
    codesignTimestampArgument(identity),
  ]
  if (identity) {
    // Hardened runtime + inherited entitlements match what electron-builder
    // would have applied, so skipping its signing pass changes nothing else
    // about how the sidecar runs.
    args.push(
      '--options',
      'runtime',
      '--entitlements',
      path.join(desktopRoot, 'build', 'entitlements.mac.inherit.plist'),
    )
  }
  args.push(outputPath)

  const sign = Bun.spawn(args, { stdout: 'inherit', stderr: 'inherit' })
  const signExit = await sign.exited
  if (signExit !== 0) {
    throw new Error(
      `[build-sidecars] codesign failed for ${outputPath} (exit ${signExit}, identity: ${label})`,
    )
  }
  console.log(`[build-sidecars] signed ${outputPath} (${label})`)
}

/**
 * macOS-only: run `native/cu-helper/build.sh`, then copy the produced (already
 * signed) `cu-helper` binary AND its sibling SwiftPM resource bundle into
 * `desktop/src-tauri/binaries/` so electron-builder packs them (the existing
 * `src-tauri/binaries/**` glob already covers both).
 *
 * The copy is byte-preserving (`cp -R`) so cu-helper's stable `dev.cchaha.cu-helper`
 * Mach-O signature is left intact — we never strip or re-sign it here.
 */
async function buildCuHelper(arch: CuHelperArch) {
  const buildScript = path.join(repoRoot, 'native', 'cu-helper', 'build.sh')
  console.log(`[build-sidecars] Building native cu-helper (${arch}) via ${buildScript} ...`)

  const proc = Bun.spawn(['bash', buildScript], {
    cwd: path.dirname(buildScript),
    env: createCuHelperBuildEnv(targetTriple, process.env),
    // build.sh prints all diagnostics to STDERR and the ONE machine-readable
    // `built: <abs path>` line to STDOUT, so capture stdout and inherit stderr.
    stdout: 'pipe',
    stderr: 'inherit',
  })
  const stdout = await new Response(proc.stdout).text()
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    throw new Error(`[build-sidecars] cu-helper build.sh failed (exit ${exitCode})`)
  }

  // Parse the single `built: <abs path>` line (build.sh:286).
  const builtMatch = stdout.match(/^built:\s*(.+)$/m)
  const builtBinary = builtMatch?.[1]?.trim()
  if (!builtBinary) {
    throw new Error(
      `[build-sidecars] cu-helper build.sh did not print a 'built: <path>' line.\nstdout:\n${stdout}`,
    )
  }

  // build.sh now emits the .app BUNDLE path (Screen Recording only works for a
  // real .app bundle subject, not a bare Mach-O). Copy the WHOLE bundle — the
  // resource bundle lives inside it at Contents/Resources/, and the spawnable
  // executable is at Contents/MacOS/cc-haha-computer-use (see cuHelperBridge.ts).
  const destApp = path.join(binariesDir, 'cc-haha-computer-use.app')

  // Remove any stale copies first (incl. ALL legacy bare-binary / bundle / old
  // -name artifacts) so `cp -R` does not nest into an existing dir.
  await Bun.spawn(
    ['rm', '-rf',
     destApp,
     path.join(binariesDir, 'cc-haha-computer-use'),         // legacy bare binary
     path.join(binariesDir, 'cu-helper'),                    // legacy old-name binary
     path.join(binariesDir, CU_HELPER_RESOURCE_BUNDLE),      // legacy sibling bundle
     path.join(binariesDir, 'cu-helper_cu-helper.bundle')],
    { stderr: 'inherit' },
  ).exited

  // Byte-preserving copy — keeps the .app's signature; do NOT re-sign.
  await copyPreserving(builtBinary, destApp)

  console.log(`[build-sidecars] cu-helper .app bundle -> ${destApp}`)
}

/** `cp -R <src> <dest>` — preserves the Mach-O code signature byte-for-byte. */
async function copyPreserving(src: string, dest: string) {
  const proc = Bun.spawn(['cp', '-R', src, dest], { stderr: 'inherit' })
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    throw new Error(`[build-sidecars] failed to copy ${src} -> ${dest} (exit ${exitCode})`)
  }
}
