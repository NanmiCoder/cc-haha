#!/usr/bin/env bun
/**
 * Remote SSH workspace — deploy & tunnel helper.
 *
 * The cc-haha desktop renderer is a thin client over one server: that server
 * owns each session's working directory, spawns the agent, and runs every tool
 * (file read/write/edit, Glob, Grep, Bash) and every permission check. So if
 * the server runs on a remote GPU box and the renderer reaches it over an
 * `ssh -L` forward, the whole workspace — files, commands, approvals, GPU —
 * lives remotely while the GUI stays local. That is what this helper sets up.
 *
 * It does four things:
 *   1. produce a Linux sidecar (cross-compile, or reuse one you pass),
 *   2. copy it plus a Linux ripgrep to the remote host (Grep/Glob need `rg`;
 *      it is staged next to the sidecar, which is the first place the runtime
 *      looks — see `src/utils/ripgrep.ts:getBundledRipgrepPath`),
 *   3. start `claude-sidecar server` there bound to its own loopback,
 *   4. open `ssh -L <localPort>:127.0.0.1:<remotePort>` and wait for /health.
 *
 * The server binds to 127.0.0.1 on the remote and is reached only through the
 * tunnel, so the forwarded peer looks like loopback to it — no token, no public
 * exposure. Paste the printed URL into Settings ▸ Remote Workspace.
 *
 * Usage:
 *   bun run scripts/remote-workspace/deploy.ts --host my-gpu-server
 *   bun run scripts/remote-workspace/deploy.ts --host my-gpu-server --stop
 *
 * Options:
 *   --host <sshAlias>        SSH host from ~/.ssh/config (required)
 *   --remote-port <n>        port the server binds on the remote (default 3456)
 *   --local-port <n>         port forwarded on this machine (default = remote)
 *   --work-dir <path>        remote install dir (default ~/.cc-haha-remote)
 *   --sidecar <path>         reuse a prebuilt Linux sidecar instead of building
 *   --arch <x64|arm64>       remote CPU arch (default x64)
 *   --skip-deploy            don't rebuild/recopy; just start + tunnel
 *   --no-wait                start the tunnel, print the URL, exit (don't hold)
 *   --stop                   kill the remote server and any tunnel, then exit
 *   --session <name>         tmux session name (default cc-haha-remote)
 *
 * Requires: `ssh`/`rsync` on this machine, key-based (passwordless) auth to the
 * host, and `bun` here for the cross-compile step (unless --sidecar/--skip-deploy).
 */

import { randomBytes } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '../..')
const desktopRoot = path.join(repoRoot, 'desktop')

/** The credential minted for this deploy's remote server; printed for the GUI. */
let remoteAccessToken = ''

/**
 * Optional npm packages kept external so native modules are not embedded.
 * Mirrors `desktop/scripts/build-sidecars.ts:compileExecutable` — if that list
 * changes, change it here too.
 */
const SIDECAR_EXTERNALS = [
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
  '@aws-sdk/client-bedrock',
  '@aws-sdk/client-sts',
  '@anthropic-ai/bedrock-sdk',
  '@anthropic-ai/foundry-sdk',
  '@anthropic-ai/vertex-sdk',
  '@azure/identity',
  '@anthropic-ai/mcpb',
  'fflate',
  'sharp',
  'react-devtools-core',
]

type Options = {
  host: string
  remotePort: number
  localPort: number
  workDir: string
  sidecar: string | null
  arch: 'x64' | 'arm64'
  skipDeploy: boolean
  noWait: boolean
  stop: boolean
  session: string
}

function fail(message: string): never {
  console.error(`\n[remote-workspace] ${message}\n`)
  process.exit(1)
}

function info(message: string): void {
  console.log(`[remote-workspace] ${message}`)
}

/**
 * These values are interpolated into shell commands run on the remote host, so
 * they are restricted to a conservative charset rather than quoted-then-trusted.
 * They all come from the local user's own command line, but a public helper
 * should still refuse to build a command string out of shell metacharacters.
 */
const SAFE_TOKEN = /^[A-Za-z0-9@._+:/~-]+$/

function requireSafeToken(value: string, flag: string): string {
  if (!value) {
    fail(`${flag} is required`)
  }
  if (!SAFE_TOKEN.test(value)) {
    fail(`${flag} may only contain letters, numbers and the characters @ . _ + : / ~ -  (got "${value}")`)
  }
  return value
}

function parseOptions(argv: string[]): Options {
  const value = (flag: string): string | null => {
    const index = argv.indexOf(flag)
    return index >= 0 ? argv[index + 1] ?? null : null
  }
  const has = (flag: string): boolean => argv.includes(flag)

  const remotePort = Number(value('--remote-port') ?? '3456')
  const localPort = Number(value('--local-port') ?? String(remotePort))
  const arch = value('--arch')
  if (arch !== null && arch !== 'x64' && arch !== 'arm64') {
    fail(`--arch must be x64 or arm64 (got "${arch}")`)
  }
  if (!Number.isInteger(remotePort) || !Number.isInteger(localPort)) {
    fail('--remote-port and --local-port must be integers')
  }
  if (remotePort < 1 || remotePort > 65535 || localPort < 1 || localPort > 65535) {
    fail('--remote-port and --local-port must be between 1 and 65535')
  }

  return {
    host: requireSafeToken(value('--host') ?? '', '--host'),
    remotePort,
    localPort,
    workDir: requireSafeToken(value('--work-dir') ?? '~/.cc-haha-remote', '--work-dir'),
    sidecar: value('--sidecar'),
    arch: arch ?? 'x64',
    skipDeploy: has('--skip-deploy'),
    noWait: has('--no-wait'),
    stop: has('--stop'),
    session: requireSafeToken(value('--session') ?? 'cc-haha-remote', '--session'),
  }
}

function bunTargetTriple(arch: 'x64' | 'arm64'): { triple: string; bunTarget: string } {
  return arch === 'arm64'
    ? { triple: 'aarch64-unknown-linux-gnu', bunTarget: 'bun-linux-arm64' }
    : { triple: 'x86_64-unknown-linux-gnu', bunTarget: 'bun-linux-x64-baseline' }
}

/** Run a command, streaming output. Throws on non-zero exit. */
function run(command: string, args: string[], label: string): void {
  const result = spawnSync(command, args, { stdio: 'inherit', cwd: repoRoot })
  if (result.error) fail(`${label}: ${result.error.message}`)
  if (result.status !== 0) fail(`${label} failed (exit ${result.status ?? 'signal'})`)
}

/** Run a command, returning stdout, without throwing on non-zero. */
function capture(command: string, args: string[]): { status: number; stdout: string } {
  const result = spawnSync(command, args, { cwd: repoRoot, encoding: 'utf8' })
  return { status: result.status ?? -1, stdout: result.stdout ?? '' }
}

function sshBatch(host: string, remoteCommand: string): { status: number; stdout: string } {
  return capture('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, remoteCommand])
}

async function buildSidecar(arch: 'x64' | 'arm64', outDir: string): Promise<string> {
  const { bunTarget } = bunTargetTriple(arch)
  const outfile = path.join(outDir, `claude-sidecar-${bunTarget}`)
  info(`cross-compiling Linux sidecar (${bunTarget})… this downloads the target runtime on first run`)

  const result = await Bun.build({
    entrypoints: [path.join(repoRoot, 'desktop/sidecars/claude-sidecar.ts')],
    features: ['TRANSCRIPT_CLASSIFIER'],
    minify: { whitespace: true, identifiers: true, syntax: true },
    sourcemap: 'none',
    target: 'bun',
    external: SIDECAR_EXTERNALS,
    compile: { target: bunTarget, outfile, autoloadTsconfig: true, autoloadPackageJson: true },
  })
  if (!result.success) {
    fail(`sidecar compile failed:\n${result.logs.map((log) => log.message).join('\n')}`)
  }
  await chmod(outfile, 0o755)
  return result.outputs[0]?.path ?? outfile
}

async function resolveSidecar(options: Options, outDir: string): Promise<string> {
  if (options.sidecar) {
    info(`using provided sidecar: ${options.sidecar}`)
    return path.resolve(options.sidecar)
  }
  return buildSidecar(options.arch, outDir)
}

/**
 * Stage the pinned Linux ripgrep and return its path.
 *
 * Shells out to the desktop build helper rather than importing it: that helper
 * lives under `desktop/scripts/`, which is outside the policy gate's module
 * graph roots, so a static import here would be flagged as an unresolvable
 * repo-local specifier. The helper writes the binary to a fixed, gitignored
 * location and verifies its sha256; Grep/Glob find it at runtime as the
 * sidecar's sibling (see `src/utils/ripgrep.ts:getBundledRipgrepPath`).
 */
function resolveRipgrep(triple: string): string {
  info(`preparing Linux ripgrep (${triple})…`)
  run(
    'bun',
    ['run', path.join(desktopRoot, 'scripts/prepare-ripgrep.ts'), '--target-triple', triple],
    'prepare-ripgrep',
  )
  return path.join(desktopRoot, 'src-tauri', 'binaries', 'rg')
}

async function deploy(options: Options): Promise<void> {
  const { triple } = bunTargetTriple(options.arch)
  const probe = sshBatch(options.host, 'echo ok')
  if (probe.status !== 0 || !probe.stdout.includes('ok')) {
    fail(`cannot reach "${options.host}" over ssh (BatchMode). Check ~/.ssh/config and key auth.`)
  }

  const workDir = options.workDir.replace(/^~/, '$HOME')
  const remoteBin = `${workDir}/claude-sidecar`
  // Linux ripgrep is always `rg` (only Windows targets use `rg.exe`).
  const remoteRg = `${workDir}/rg`
  const appRoot = `${workDir}/app-root`

  if (options.skipDeploy) {
    info('--skip-deploy: reusing the sidecar already on the remote')
  } else {
    const outDir = await mkdtemp(path.join(tmpdir(), 'cc-haha-sidecar-'))
    try {
      const sidecarPath = await resolveSidecar(options, outDir)
      const rgPath = resolveRipgrep(triple)

      info(`provisioning ${options.host}:${workDir}`)
      run('ssh', ['-o', 'BatchMode=yes', options.host, `mkdir -p ${appRoot}`], 'mkdir app-root')
      run('rsync', ['-az', sidecarPath, `${options.host}:${remoteBin}`], 'rsync sidecar')
      run('rsync', ['-az', rgPath, `${options.host}:${remoteRg}`], 'rsync ripgrep')
      run('ssh', ['-o', 'BatchMode=yes', options.host, `chmod +x ${remoteBin} ${remoteRg}`], 'chmod')
    } finally {
      await rm(outDir, { recursive: true, force: true })
    }
  }

  startRemoteServer(options, remoteBin, appRoot)
}

function startRemoteServer(options: Options, remoteBin: string, appRoot: string): void {
  const workDir = options.workDir.replace(/^~/, '$HOME')
  // Stop any previous instance (same tmux session, or a bare process on the port)
  // so a re-deploy does not leave two servers fighting over the port.
  sshBatch(options.host, `tmux kill-session -t ${options.session} 2>/dev/null; true`)

  // Mint a fresh process credential for the remote server on every deploy and
  // hand the same value to the desktop renderer (the deploy output prints it
  // for the Remote Workspace pane). With a configured credential the server
  // classifies the renderer's requests by the token they carry — the strongest
  // signal it has — instead of by origin and locality, which is exactly how
  // the local sidecar is authenticated.
  const accessToken = randomBytes(32).toString('base64url')
  const trustedOrigin = `CC_HAHA_TRUSTED_RENDERER_ORIGIN=http://localhost:1420`
  const tokenEnv = `CC_HAHA_LOCAL_ACCESS_TOKEN=${accessToken}`
  const serverCmd = `env ${tokenEnv} ${trustedOrigin} ${remoteBin} server --app-root ${appRoot} --host 127.0.0.1 --port ${options.remotePort}`
  const hasTmux = sshBatch(options.host, 'command -v tmux').status === 0
  const logFile = `${workDir}/server.log`

  if (hasTmux) {
    info(`starting server in tmux session "${options.session}" on ${options.host}:${options.remotePort}`)
    sshBatch(options.host, `mkdir -p ${appRoot} && tmux new-session -d -s ${options.session} '${serverCmd} 2>&1 | tee ${logFile}'`)
  } else {
    info(`tmux not found on remote; starting server with nohup (log: ${logFile})`)
    sshBatch(options.host, `mkdir -p ${appRoot} && nohup ${serverCmd} > ${logFile} 2>&1 &`)
  }
  remoteAccessToken = accessToken
}

async function waitForHealth(url: string, attempts = 40): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(`${url}/health`, { cache: 'no-store' })
      if (response.ok) {
        const body = await response.json().catch(() => null) as { status?: string } | null
        if (body?.status === 'ok') return true
      }
    } catch {
      // tunnel not up yet — keep trying
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return false
}

function openTunnel(options: Options): ReturnType<typeof spawn> {
  info(`opening tunnel  ssh -N -L ${options.localPort}:127.0.0.1:${options.remotePort} ${options.host}`)
  const tunnel = spawn(
    'ssh',
    ['-N', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30',
      '-L', `${options.localPort}:127.0.0.1:${options.remotePort}`, options.host],
    { stdio: 'inherit' },
  )
  return tunnel
}

function stop(options: Options): void {
  const workDir = options.workDir.replace(/^~/, '$HOME')
  info(`stopping remote server and tmux session "${options.session}"`)
  sshBatch(options.host, `tmux kill-session -t ${options.session} 2>/dev/null; pkill -f '${workDir}/claude-sidecar server' 2>/dev/null; true`)
  info('done. (Close this helper with Ctrl-C to drop the tunnel.)')
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2))

  if (options.stop) {
    stop(options)
    return
  }

  await deploy(options)

  const tunnel = openTunnel(options)
  const url = `http://127.0.0.1:${options.localPort}`

  const shutdown = () => {
    if (!tunnel.killed) tunnel.kill('SIGTERM')
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  tunnel.on('exit', (code) => {
    if (code !== 0 && code !== null) fail(`tunnel exited (code ${code}). Is the local port already in use?`)
  })

  const healthy = await waitForHealth(url)
  if (!healthy) {
    fail(`remote server did not become healthy at ${url}. Check the remote log (${options.workDir}/server.log).`)
  }

  console.log(`
[remote-workspace] ✓ Remote workspace is live.

  Server URL : ${url}
  SSH host   : ${options.host}
  Access token: ${remoteAccessToken}
  Working dir: ${options.workDir}

  In the desktop app: Settings ▸ Remote Workspace ▸ paste the URL above,
  enter the SSH host, paste the access token, and click "Switch to remote".
  The app reloads onto the remote machine — files, Bash, approvals and GPU
  all run on ${options.host}.

  This helper holds the tunnel open. Press Ctrl-C to disconnect.
`)

  if (options.noWait) {
    info('--no-wait: leaving the tunnel running in the background.')
    tunnel.unref()
    return
  }

  // Hold the foreground so the tunnel stays up until the user stops it.
  await new Promise<void>(() => {})
}

await main()
