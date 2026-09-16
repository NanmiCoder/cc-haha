import { spawn } from 'node:child_process'
import { copyFile, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createSandboxedTestEnvironment } from '../pr/test-environment'

const repoRoot = path.resolve(import.meta.dirname, '../..')

type SignedChainOptions = { signingIdentity?: string, signingKeychain?: string }
type PlannedCommand = { command: string, args: string[] }

function explicitSigningIdentity(identity: string): string {
  const value = identity.trim()
  if (!value || value.startsWith('-')) throw new Error('--signing-identity requires a nonempty certificate name; ad-hoc signing is not accepted')
  return value
}

function explicitSigningKeychain(options: SignedChainOptions): string | undefined {
  if (options.signingKeychain === undefined) return undefined
  if (options.signingIdentity === undefined || !path.isAbsolute(options.signingKeychain)) {
    throw new Error('--signing-keychain requires an absolute path and an explicit --signing-identity')
  }
  return options.signingKeychain
}

export function parseSignedChainArgs(args: string[]): SignedChainOptions & { output?: string } {
  const result: SignedChainOptions & { output?: string } = {}
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === '--signing-identity') {
      if (result.signingIdentity !== undefined) throw new Error('--signing-identity may only be supplied once')
      result.signingIdentity = explicitSigningIdentity(args[++index] ?? '')
    } else if (arg === '--signing-keychain') {
      if (result.signingKeychain !== undefined) throw new Error('--signing-keychain may only be supplied once')
      result.signingKeychain = args[++index] ?? ''
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown fixture option: ${arg}`)
    } else {
      if (result.output !== undefined) throw new Error('Only one output report path may be supplied')
      result.output = arg
    }
  }
  explicitSigningKeychain(result)
  return result
}

/** Pure command planning. Explicit identity mode is opt-in and never discovers
 * or imports identities. Running that mode requires separate user authorization
 * to use the named signing key; the default only uses our private keychain. */
export function planFixtureSigning(options: SignedChainOptions & { directory: string }) {
  if (!path.isAbsolute(options.directory)) throw new Error('The signing fixture directory must be absolute')
  const identity = options.signingIdentity === undefined ? undefined : explicitSigningIdentity(options.signingIdentity)
  const signingKeychain = explicitSigningKeychain(options)
  const keychain = path.join(options.directory, 'fixture.keychain-db')
  const privateSigner = path.join(options.directory, 'private-signer')
  return {
    mode: identity === undefined ? 'temporary' as const : 'explicit' as const,
    requiresPackagedInstall: identity !== undefined,
    setupCommands(password: string): PlannedCommand[] {
      return identity === undefined
        ? privateKeychainCommands(keychain, path.join(options.directory, 'identity.p12'), password)
          .map(args => ({ command: '/usr/bin/security', args }))
        : []
    },
    signCommand(file: string, identifier: string, entitlements?: string): PlannedCommand {
      return identity === undefined
        ? { command: privateSigner, args: [keychain, file, identifier, ...(entitlements ? [entitlements] : [])] }
        : {
          command: '/usr/bin/codesign',
          args: ['--force', '--sign', identity, '--identifier', identifier, '--options', 'runtime', '--timestamp=none',
            ...(signingKeychain ? ['--keychain', signingKeychain] : []),
            ...(entitlements ? ['--entitlements', entitlements] : []), file],
        }
    },
  }
}

/** Security's identity lookup still requires the keychain owner's HOME even
 * with --keychain. Only the explicitly authorized signing process receives it;
 * the helper, sidecar, compiler, CF preferences and config remain isolated. */
export function fixtureSigningEnvironment(
  mode: 'temporary' | 'explicit',
  isolated: Record<string, string>,
  userHome: string | undefined,
): Record<string, string> {
  if (mode === 'temporary') return isolated
  if (!userHome || !path.isAbsolute(userHome)) throw new Error('Explicit signing requires the authorized keychain owner HOME')
  return { ...isolated, HOME: userHome }
}

/** Every keychain operation must name our private file. Never enumerate or
 * update the user's default keychains/search list/trust settings. Apple’s
 * private-keychain creation policy leaves that search list unchanged. */
export function privateKeychainCommands(keychain: string, archive: string, password: string) {
  if (!path.isAbsolute(keychain) || path.basename(keychain).includes('login.keychain')) {
    throw new Error('A private absolute fixture keychain path is required')
  }
  return [
    ['create-keychain', '-p', password, keychain],
    ['unlock-keychain', '-p', password, keychain],
    ['import', archive, '-k', keychain, '-P', password, '-A'],
    ['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', password, keychain],
  ]
}

export function verifySignedChainReport(report: {
  signing?: { mode: 'temporary' | 'explicit', teamIdentifier?: string }
  result: {
    error?: string
    packagedInstall?: boolean
    ping?: { protocolVersion?: string }
    permissions?: { accessibility?: boolean, screenRecording?: boolean }
    first?: { isError?: boolean, content?: Array<{ text?: string }> }
    second?: { isError?: boolean, content?: Array<{ text?: string }> }
    nativeObservation?: { isError?: boolean }
    replay?: { isError?: boolean }
  }
  receiver: { completed?: number, held?: boolean, unpaired?: number }
  unauthorizedDirect: { ok?: boolean, error?: { code?: string } }
}) {
  const { result, receiver } = report
  if (result.error) throw new Error(result.error)
  if (report.signing?.mode === 'explicit'
    && (!report.signing.teamIdentifier?.trim() || report.signing.teamIdentifier === 'not set' || result.packagedInstall !== true)) {
    throw new Error('Explicit identity mode requires a Team ID and successful production packaged-helper installation')
  }
  if (result.ping?.protocolVersion !== 'CCHahaComputerUseIPC-2') throw new Error('Production daemon handshake was not proven')
  if (result.first?.isError || result.first?.content?.[0]?.text !== '1'
    || result.second?.isError || result.second?.content?.[0]?.text !== '2') {
    throw new Error('Compiled desktop worker did not preserve bindings across cells')
  }
  if (report.unauthorizedDirect.ok !== false || report.unauthorizedDirect.error?.code !== 'unauthorized_client') {
    throw new Error('The direct unsigned caller was not rejected')
  }
  const granted = result.permissions?.accessibility === true && result.permissions?.screenRecording === true
  if (granted) {
    if (!result.nativeObservation || result.nativeObservation.isError) throw new Error('Native app observation failed or did not run')
    if (!result.replay || result.replay.isError) throw new Error('Native gesture replay failed or did not run')
    if (receiver.completed !== 12 || receiver.held !== false || receiver.unpaired !== 0) {
      throw new Error('The receiving app did not consume exactly twelve complete gestures')
    }
    return 'passed_native_gui' as const
  }
  if (result.nativeObservation?.isError !== true || receiver.completed !== 0 || receiver.held !== false || receiver.unpaired !== 0) {
    throw new Error('The ungranted helper did not fail before injecting input')
  }
  return 'blocked_os_permissions' as const
}

/** Keep receiver/native failure evidence even when acceptance fails. */
export function evaluateSignedChainReport<T extends Parameters<typeof verifySignedChainReport>[0]>(report: T) {
  try {
    return { ...report, outcome: verifySignedChainReport(report), validationError: undefined }
  } catch (error) {
    return { ...report, outcome: 'failed_validation' as const, validationError: error instanceof Error ? error.message : String(error) }
  }
}

export async function runSignedComputerUseChain(options: SignedChainOptions = {}) {
  // Reject missing/empty explicit identities before any filesystem or process
  // side effects. No environment variable supplies a signing identity.
  if (options.signingIdentity !== undefined) explicitSigningIdentity(options.signingIdentity)
  explicitSigningKeychain(options)
  if (process.platform !== 'darwin') throw new Error('This integration fixture requires macOS')
  // Darwin sockaddr_un has a short fixed path limit. A normal per-user TMPDIR
  // plus the production .runtime socket suffix can exceed it before bind().
  const directory = await realpath(await mkdtemp('/tmp/cu-chain-'))
  const env = createSandboxedTestEnvironment(path.join(directory, 'home'))
  env.CFFIXED_USER_HOME = env.HOME!
  const commandResults: Array<{ command: string, code: number | null, stdout: string, stderr: string }> = []
  let keychainCreated = false
  let target: ReturnType<typeof spawn> | undefined
  let targetClosed: Promise<unknown> | undefined
  let targetBinary: string | undefined
  let targetPID: number | undefined
  const targetLifecycle: { pid?: number, launcherExited?: boolean, forcedTermination?: boolean } = {}
  const stopPath = path.join(directory, 'receiver-stop')
  const keychain = path.join(directory, 'fixture.keychain-db')
  const signingPlan = planFixtureSigning({ directory, ...options })
  let signingTeam: string | undefined
  async function run(command: string, args: string[], timeout = 120_000, allowFailure = false, commandEnv = env) {
    const child = spawn(command, args, { cwd: directory, env: commandEnv, stdio: ['ignore', 'pipe', 'pipe'], timeout })
    let stdout = ''
    let stderr = ''
    let signal: NodeJS.Signals | null = null
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, closedSignal) => { signal = closedSignal; resolve(code) })
    })
    // Command arguments include disposable private-key passwords. They are
    // deliberately never retained in artifacts or printed on failure.
    commandResults.push({ command: path.basename(command), code, stdout, stderr })
    if (code !== 0 && !allowFailure) throw new Error(`${path.basename(command)} failed (${code}, ${signal}): ${stderr}`)
    return { code, stdout, stderr }
  }
  try {
    const signingEnv = fixtureSigningEnvironment(signingPlan.mode, env, process.env.HOME)
    if (signingPlan.mode === 'temporary') {
      const certificateName = `CC Haha disposable CU ${randomUUID()}`
      const password = randomUUID()
      const config = path.join(directory, 'certificate.cnf')
      await writeFile(config, `[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=${certificateName}\n[ext]\nbasicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,codeSigning\n`)
      await run('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-config', config, '-keyout', 'key.pem', '-out', 'cert.pem'])
      await run('/usr/bin/openssl', ['pkcs12', '-export', '-inkey', 'key.pem', '-in', 'cert.pem', '-out', 'identity.p12', '-passout', `pass:${password}`])
      for (const { command, args } of signingPlan.setupCommands(password)) {
        await run(command, args)
        if (args[0] === 'create-keychain') keychainCreated = true
      }
      await run('/usr/bin/security', ['find-identity', '-p', 'codesigning', keychain])
      await run('/usr/bin/clang', ['-fobjc-arc', '-framework', 'Foundation', '-framework', 'Security',
        path.join(repoRoot, 'scripts/quality-gate/fixtures/computer-use-private-signer.m'), '-o', path.join(directory, 'private-signer')])
    }
    const sign = async (file: string, identifier: string, entitlements?: string) => {
      await run('/usr/bin/codesign', ['--remove-signature', file], 30_000, true)
      const command = signingPlan.signCommand(file, identifier, entitlements)
      await run(command.command, command.args, 120_000, false, signingEnv)
      await run('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', file])
      if (signingPlan.requiresPackagedInstall) {
        const details = await run('/usr/bin/codesign', ['-dv', '--verbose=4', file])
        const team = `${details.stdout}\n${details.stderr}`.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim()
        if (!team || team === 'not set' || (signingTeam !== undefined && signingTeam !== team)) {
          throw new Error('Explicit identity signatures must have the same nonempty Team ID')
        }
        signingTeam = team
      }
    }
    const hostApp = path.join(directory, 'Fixture Host.app')
    const macos = path.join(hostApp, 'Contents/MacOS')
    const binaries = path.join(hostApp, 'Contents/Resources/app.asar.unpacked/src-tauri/binaries')
    await mkdir(macos, { recursive: true })
    await mkdir(binaries, { recursive: true })
    const host = path.join(macos, 'FixtureHost')
    await writeFile(path.join(hostApp, 'Contents/Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>FixtureHost</string><key>CFBundleIdentifier</key><string>com.claude-code-haha.desktop</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`)
    await run('/usr/bin/clang', [path.join(repoRoot, 'scripts/quality-gate/fixtures/computer-use-signed-chain-host.c'), '-o', host])
    const executable = path.join(binaries, `claude-sidecar-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin`)
    const build = await Bun.build({
      entrypoints: [path.join(repoRoot, 'scripts/quality-gate/fixtures/computer-use-signed-chain-broker.ts')],
      features: ['TRANSCRIPT_CLASSIFIER'], target: 'bun',
      minify: { whitespace: true, identifiers: true, syntax: true },
      external: [
        '@opentelemetry/exporter-trace-otlp-grpc', '@opentelemetry/exporter-trace-otlp-http', '@opentelemetry/exporter-trace-otlp-proto',
        '@opentelemetry/exporter-logs-otlp-grpc', '@opentelemetry/exporter-logs-otlp-http', '@opentelemetry/exporter-logs-otlp-proto',
        '@opentelemetry/exporter-metrics-otlp-grpc', '@opentelemetry/exporter-metrics-otlp-http', '@opentelemetry/exporter-metrics-otlp-proto',
        '@opentelemetry/exporter-prometheus', '@aws-sdk/client-bedrock', '@aws-sdk/client-sts', '@anthropic-ai/bedrock-sdk',
        '@anthropic-ai/foundry-sdk', '@anthropic-ai/vertex-sdk', '@azure/identity', '@anthropic-ai/mcpb', 'fflate', 'sharp', 'react-devtools-core',
      ],
      compile: { outfile: executable, autoloadTsconfig: true, autoloadPackageJson: true },
    })
    if (!build.success) throw new Error(build.logs.join('\n'))
    const entitlements = path.join(directory, 'sidecar-entitlements.plist')
    await writeFile(entitlements, '<?xml version="1.0"?><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/><key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/></dict></plist>')
    await sign(executable, 'com.claude-code-haha.desktop.sidecar', entitlements)

    // Build current production Swift sources, with the production embedded
    // Info.plist. Avoid build.sh's automatic user-keychain identity discovery.
    const swiftBuild = path.join(directory, 'swift-build')
    const packagePath = path.join(repoRoot, 'native/cu-helper')
    const buildArgs = ['build', '-c', 'release', '--package-path', packagePath, '--scratch-path', swiftBuild]
    await run('/usr/bin/swift', [...buildArgs, '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist', '-Xlinker', path.join(packagePath, 'Info.plist')], 300_000)
    const binDir = (await run('/usr/bin/swift', [...buildArgs, '--show-bin-path'])).stdout.trim()
    const helperApp = path.join(directory, 'cc-haha-computer-use.app')
    await mkdir(path.join(helperApp, 'Contents/MacOS'), { recursive: true })
    await mkdir(path.join(helperApp, 'Contents/Resources'), { recursive: true })
    await copyFile(path.join(packagePath, 'Info.plist'), path.join(helperApp, 'Contents/Info.plist'))
    // LaunchServices does not inherit the caller's HOME. Keep AppKit's own
    // potential preference/cache writes inside the disposable home as well.
    await run('/usr/bin/plutil', ['-insert', 'LSEnvironment', '-json', JSON.stringify({
      HOME: env.HOME, CFFIXED_USER_HOME: env.HOME, TMPDIR: env.TMPDIR, TMP: env.TMP, TEMP: env.TEMP,
      CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR,
    }), path.join(helperApp, 'Contents/Info.plist')])
    await copyFile(path.join(binDir, 'cc-haha-computer-use'), path.join(helperApp, 'Contents/MacOS/cc-haha-computer-use'))
    await cp(path.join(binDir, 'cu-helper_cc-haha-computer-use.bundle'), path.join(helperApp, 'Contents/Resources/cu-helper_cc-haha-computer-use.bundle'), { recursive: true })
    await sign(helperApp, 'dev.cchaha.cu-helper')
    const nested = path.join(binaries, 'cc-haha-computer-use.app')
    await cp(helperApp, nested, { recursive: true })
    await sign(hostApp, 'com.claude-code-haha.desktop')
    const helperBinary = path.join(helperApp, 'Contents/MacOS/cc-haha-computer-use')
    if (signingPlan.requiresPackagedInstall) {
      env.CLAUDE_APP_ROOT = path.join(hostApp, 'Contents/Resources/app.asar')
      env.CU_FIXTURE_REQUIRE_PACKAGED_INSTALL = '1'
    } else {
      env.CC_HAHA_CU_HELPER_PATH = helperBinary
    }
    env.CU_FIXTURE_NESTED_HELPER = nested
    const targetApp = path.join(directory, 'Drag Receiver.app')
    await mkdir(path.join(targetApp, 'Contents/MacOS'), { recursive: true })
    targetBinary = path.join(targetApp, 'Contents/MacOS/DragReceiver')
    await writeFile(path.join(targetApp, 'Contents/Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>DragReceiver</string><key>CFBundleIdentifier</key><string>dev.cchaha.fixture.${randomUUID()}</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/></dict></plist>`)
    await run('/usr/bin/plutil', ['-insert', 'LSEnvironment', '-json', JSON.stringify({
      HOME: env.HOME, CFFIXED_USER_HOME: env.HOME, TMPDIR: env.TMPDIR, TMP: env.TMP, TEMP: env.TEMP,
      CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR,
    }), path.join(targetApp, 'Contents/Info.plist')])
    await run('/usr/bin/swiftc', ['-framework', 'AppKit', path.join(repoRoot, 'scripts/quality-gate/fixtures/computer-use-signed-chain-target.swift'), '-o', targetBinary])
    const receipt = path.join(directory, 'receiver.json')
    const helperPIDFile = path.join(directory, 'helper-pid')
    env.CU_FIXTURE_HELPER_PID_FILE = helperPIDFile
    // A direct spawn has no NSRunningApplication.launchDate, so production
    // process-lifetime validation correctly refuses it. Launch as a real App.
    target = spawn('/usr/bin/open', ['-g', '-n', '-W', targetApp, '--args', receipt, helperPIDFile, stopPath], { env, stdio: 'ignore' })
    targetClosed = new Promise(resolve => target!.once('close', resolve))
    target.on('error', () => {})
    const deadline = Date.now() + 10_000
    while (true) {
      try {
        const ready = JSON.parse(await readFile(receipt, 'utf8'))
        if (ready.ready === true && Number.isInteger(ready.pid) && ready.pid > 0) {
          targetPID = ready.pid
          targetLifecycle.pid = ready.pid
          break
        }
      } catch {}
      if (target.exitCode !== null || target.signalCode !== null || Date.now() > deadline) throw new Error('Temporary receiving app did not start')
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    env.CU_FIXTURE_TARGET_APP = targetApp
    // The test broker runs as the exact signed sidecar child; runtime relaunch
    // uses its real compiled desktop worker branch inside the OS sandbox.
    const execution = await run(host, [executable], 60_000)
    const result = JSON.parse(execution.stdout.trim().split('\n').at(-1)!)
    const direct = await run(helperBinary, ['check_permissions', '--payload', '{}'], 10_000, true)
    let receiver = JSON.parse(await readFile(receipt, 'utf8'))
    // A successful input call is not a receiving-app acknowledgement. Wait for
    // actual consumption; never repost gestures to make the count pass.
    if (result.replay && !result.replay.isError) {
      const receiveDeadline = Date.now() + 5_000
      while (receiver.completed !== 12 || receiver.held !== false || receiver.unpaired !== 0) {
        if (Date.now() >= receiveDeadline || target.exitCode !== null || target.signalCode !== null
          || receiver.completed > 12 || receiver.unpaired > 0) break
        await new Promise(resolve => setTimeout(resolve, 20))
        receiver = JSON.parse(await readFile(receipt, 'utf8'))
      }
    }
    return { signing: { mode: signingPlan.mode, teamIdentifier: signingTeam }, result, receiver, targetLifecycle, unauthorizedDirect: JSON.parse(direct.stdout.trim()), commands: commandResults }
  } finally {
    if (target && targetClosed) {
      await writeFile(stopPath, '')
      let stopTimer: ReturnType<typeof setTimeout> | undefined
      const exited = await Promise.race([
        targetClosed.then(() => true),
        new Promise<false>(resolve => { stopTimer = setTimeout(() => resolve(false), 5_000) }),
      ])
      clearTimeout(stopTimer)
      targetLifecycle.forcedTermination = !exited
      if (!exited) {
        // open -W's PID is not the App PID. Only terminate a receiver still
        // running our exact disposable binary; never signal a recycled PID.
        if (targetPID && targetBinary) {
          const current = await run('/bin/ps', ['-p', String(targetPID), '-o', 'comm='], 5_000, true)
          if (current.code === 0 && current.stdout.trim() === targetBinary) {
            try { process.kill(targetPID, 'SIGTERM') } catch {}
          }
        }
        target.kill('SIGTERM')
        await targetClosed
      }
      targetLifecycle.launcherExited = true
    }
    // Lock only our private keychain, then remove its disposable directory.
    // security delete-keychain may touch search-list preferences; avoid it.
    if (keychainCreated) await run('/usr/bin/security', ['lock-keychain', keychain], 10_000, true)
    await rm(directory, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  const { output, ...options } = parseSignedChainArgs(process.argv.slice(2))
  const report = await runSignedComputerUseChain(options)
  const completed = evaluateSignedChainReport(report)
  if (output) await writeFile(output, `${JSON.stringify(completed, null, 2)}\n`)
  console.log(JSON.stringify({ ...completed, commands: undefined }, null, 2))
  if (completed.outcome === 'failed_validation') process.exitCode = 1
}
