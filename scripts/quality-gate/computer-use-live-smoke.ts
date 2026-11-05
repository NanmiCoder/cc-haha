#!/usr/bin/env bun

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { callHelper } from '../../src/utils/computerUse/helperBridge.js'
import {
  isNestedInHostApp,
  ensureInstalledHelper,
  type InstalledHelper,
} from '../../src/utils/computerUse/cuHelperInstall.js'
import {
  overlayHide,
  shutdownDaemon,
} from '../../src/utils/computerUse/cuHelperDaemon.js'
import { getRuntimePaths } from '../../src/utils/computerUse/pythonBridge.js'
import {
  releaseComputerUseLock,
  tryAcquireComputerUseLock,
  type AcquireResult,
} from '../../src/utils/computerUse/computerUseLock.js'

const TARGET_BUNDLE_ID = 'com.apple.TextEdit'
const TARGET_APP_CANDIDATES = [
  '/System/Applications/TextEdit.app',
  '/Applications/TextEdit.app',
] as const
const TARGET_EXECUTABLE_RELATIVE = path.join(
  'Contents',
  'MacOS',
  'TextEdit',
)
const HELPER_IDENTIFIER = 'dev.cchaha.cu-helper'
const RUN_DIRECTORY_PREFIX = '/tmp/cc-haha-cu-live-smoke-'
const FIXTURE_BASENAME = 'computer-use-smoke-fixture.txt'
const STABLE_TOKEN = 'CC_HAHA_SMOKE_STABLE_TOKEN'
const MUTATED_TOKEN = 'CC_HAHA_SMOKE_MUTATED_VALUE'
const INITIAL_FIXTURE = `${STABLE_TOKEN}\ninitial-value\n`
const MUTATED_FIXTURE = `${STABLE_TOKEN}\n${MUTATED_TOKEN}\n`
const EXACT_NO_CHANGE_PREFIX =
  'There has been no change in the accessibility tree for Window: "'
const POLL_INTERVAL_MS = 150
const STATE_TIMEOUT_MS = 18_000
const CLEANUP_TIMEOUT_MS = 8_000
// This CLI runs in a fresh Bun process. Its first callHelper invocation owns
// generation 1 of cuHelperDaemon's generation-scoped socket namespace.
const LIVE_SMOKE_DAEMON_GENERATION = 1

type JsonObject = Record<string, unknown>

export interface ProcessIdentity {
  pid: number
  bundleId: string
  executablePath: string
  launchTime: number
}

export interface PhysicalPointer {
  x: number
  y: number
}

export interface HeldInputSnapshot {
  flags: string
  buttons: boolean[]
}

export interface SystemSnapshot {
  frontmost: ProcessIdentity
  pointer: PhysicalPointer
  input: HeldInputSnapshot
}

export interface InputMonitorSnapshot {
  epoch: bigint
  available: true
  continuityGeneration: bigint
}

export interface LiveStateElement {
  index: number
  windowIndex?: number
  role: string
  title?: string
  value?: string
  settable: boolean
  rawActions?: string[]
}

export interface LiveAppState {
  pid: number
  appName?: string
  bundleId?: string
  windowTitle?: string
  windowID?: number
  elementCount: number
  truncated: boolean
  durationMs: number
  axText: string
  elements?: LiveStateElement[]
  screenshot?: {
    base64: string
    width: number
    height: number
  }
}

export interface LiveSmokePaths {
  runDirectory: string
  fixturePath: string
  targetIdentityPath: string
  daemonSocket: string
  daemonPidfile: string
}

export interface CleanupEvidence {
  daemonSocketExists: boolean
  daemonPidfileExists: boolean
  daemonProcessStillMatches: boolean
  inputBefore: HeldInputSnapshot
  inputAfter: HeldInputSnapshot
}

type SetValueResult = {
  before?: string
  after?: string
}

type PermissionSnapshot = {
  accessibility: boolean
  screenRecording: boolean
}

type ResolvedTargetSnapshot = {
  pid: number | null
  bundleId: string
  displayName: string
  path: string
  executablePath: string | null
  launchTime: number | null
}

type HelperHeldInputSnapshot = {
  keys: unknown[]
  buttons: unknown[]
}

type SmokeResult = {
  target: ProcessIdentity
  initialFrontmost: ProcessIdentity
  finalFrontmost: ProcessIdentity
  pointerDriftPx: number
  pointerSamples: number
  stableHandle: string
  staleTopologyHandle: string
  fullElementCount: number
  changedScreenshot: { width: number; height: number; base64Bytes: number }
  physicalInputEpoch: string
  physicalInputContinuityGeneration: string
  fixtureSavedAndRestored: true
  daemonPid: number
  cleanup: {
    daemonSocketRemoved: true
    daemonPidfileRemoved: true
    ownedDaemonExited: true
    heldInputRestored: true
    dedicatedTextEditExited: true
  }
}

type SmokeLifecycle = {
  target?: ProcessIdentity
  daemonPid?: number
  initialSystem?: SystemSnapshot
  pointerMonitor?: PointerMonitor
}

export interface PointerTrace {
  samples: number
  maxDriftPx: number
}

type PointerMonitor = {
  process: ChildProcessWithoutNullStreams
  stopPath: string
  result: Promise<PointerTrace>
  stopped: boolean
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

export function errorMessage(error: unknown): string {
  if (error instanceof AggregateError) {
    const details = Array.from(error.errors, nested => errorMessage(nested))
    return details.length > 0
      ? `${error.message}: ${details.join(' | ')}`
      : error.message
  }
  return error instanceof Error ? error.message : String(error)
}

function sameProcessIdentity(
  left: ProcessIdentity,
  right: ProcessIdentity,
): boolean {
  return left.pid === right.pid
    && left.bundleId === right.bundleId
    && left.executablePath === right.executablePath
    && left.launchTime === right.launchTime
}

function targetPayload(identity: ProcessIdentity): Record<string, unknown> {
  return {
    pid: identity.pid,
    expectedProcessIdentity: {
      pid: identity.pid,
      bundleId: identity.bundleId,
      executablePath: identity.executablePath,
      launchTime: identity.launchTime,
    },
  }
}

function assertHelperHeldInputIdle(value: unknown): void {
  if (
    !isObject(value)
    || !Array.isArray(value.keys)
    || !Array.isArray(value.buttons)
    || value.keys.length > 0
    || value.buttons.length > 0
  ) {
    throw new Error('Native helper reports synthetic held input')
  }
}

function sameHeldInput(
  left: HeldInputSnapshot,
  right: HeldInputSnapshot,
): boolean {
  return left.flags === right.flags
    && left.buttons.length === right.buttons.length
    && left.buttons.every((pressed, index) => pressed === right.buttons[index])
}

export function parseLiveSmokeArgs(
  argv: readonly string[],
): { targetBundleId: typeof TARGET_BUNDLE_ID } {
  let target = TARGET_BUNDLE_ID
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg !== '--target') {
      throw new Error(`Unknown argument '${arg}'. This smoke accepts only --target.`)
    }
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) {
      throw new Error('--target requires a value')
    }
    target = value
    index += 1
  }

  if (target !== TARGET_BUNDLE_ID) {
    throw new Error(
      `The live smoke controls only its dedicated TextEdit instance (${TARGET_BUNDLE_ID}); `
        + `refusing target '${target}'. Finder, terminals, system apps, and user apps are never controls.`,
    )
  }
  return { targetBundleId: TARGET_BUNDLE_ID }
}

/** Acquire the same cross-process lock as production before installing or
 * starting any helper. A blocked smoke performs no helper or UI work. */
export async function acquireLiveSmokeLock(
  acquire: () => Promise<AcquireResult> = tryAcquireComputerUseLock,
  release: () => Promise<boolean> = releaseComputerUseLock,
): Promise<() => Promise<void>> {
  const result = await acquire()
  if (result.kind === 'blocked') {
    throw new Error(
      `Computer Use is active in another session (${result.by}); live smoke did not start.`,
    )
  }
  return async () => {
    if (!(await release())) {
      throw new Error('Live smoke no longer owned the Computer Use lock at cleanup')
    }
  }
}

export function assertSafeRunDirectory(runDirectory: string): void {
  // This fixture belongs exclusively to macOS TextEdit, even when its policy
  // is unit-tested on Windows. Interpret its paths using the target OS.
  const resolved = path.posix.resolve(runDirectory)
  const basename = path.posix.basename(resolved)
  const exactGeneratedName = /^cc-haha-cu-live-smoke-[A-Za-z0-9]{6}$/
  if (
    path.posix.dirname(resolved) !== '/tmp'
    || !exactGeneratedName.test(basename)
    || resolved !== runDirectory
  ) {
    throw new Error(`Unsafe live-smoke run directory: ${runDirectory}`)
  }
}

export function deriveLiveSmokePaths(
  runDirectory: string,
  runtimeStateRoot: string,
  ownerPid: number,
): LiveSmokePaths {
  assertSafeRunDirectory(runDirectory)
  if (!path.posix.isAbsolute(runtimeStateRoot)) {
    throw new Error(`Runtime state root must be absolute: ${runtimeStateRoot}`)
  }
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) {
    throw new Error(`Invalid daemon owner PID: ${ownerPid}`)
  }
  const daemonSocket = path.posix.join(
    runtimeStateRoot,
    `cu-helper.daemon.${ownerPid}.${LIVE_SMOKE_DAEMON_GENERATION}.sock`,
  )
  return {
    runDirectory,
    fixturePath: path.posix.join(runDirectory, FIXTURE_BASENAME),
    targetIdentityPath: path.posix.join(runDirectory, '.textedit-identity.json'),
    daemonSocket,
    daemonPidfile: `${daemonSocket}.pid`,
  }
}

function parseProcessIdentity(value: unknown, label: string): ProcessIdentity {
  if (!isObject(value)) throw new Error(`${label} identity is missing`)
  const { pid, bundleId, executablePath, launchTime } = value
  if (
    !Number.isSafeInteger(pid)
    || (pid as number) <= 0
    || !nonEmptyString(bundleId)
    || !nonEmptyString(executablePath)
    || !path.isAbsolute(executablePath)
    || !finiteNumber(launchTime)
  ) {
    throw new Error(`${label} identity is not proven by pid/bundle/path/launch time`)
  }
  return {
    pid: pid as number,
    bundleId,
    executablePath,
    launchTime,
  }
}

function parseHeldInput(value: unknown): HeldInputSnapshot {
  if (!isObject(value)) throw new Error('Held input snapshot is missing')
  const { flags, buttons } = value
  if (
    !nonEmptyString(flags)
    || !/^\d+$/.test(flags)
    || !Array.isArray(buttons)
    || buttons.length !== 5
    || !buttons.every(button => typeof button === 'boolean')
  ) {
    throw new Error('Held input snapshot is invalid')
  }
  return { flags, buttons: [...buttons] as boolean[] }
}

export function parseSystemSnapshot(raw: string): SystemSnapshot {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error('System snapshot probe returned invalid JSON')
  }
  if (!isObject(value) || !isObject(value.pointer)) {
    throw new Error('System snapshot is incomplete')
  }
  const { x, y } = value.pointer
  if (!finiteNumber(x) || !finiteNumber(y)) {
    throw new Error('Physical pointer snapshot is invalid')
  }
  return {
    frontmost: parseProcessIdentity(value.frontmost, 'Frontmost'),
    pointer: { x, y },
    input: parseHeldInput(value.input),
  }
}

export function assertSystemStatePreserved(
  before: SystemSnapshot,
  after: SystemSnapshot,
): void {
  if (!sameProcessIdentity(before.frontmost, after.frontmost)) {
    throw new Error(
      'The real frontmost identity changed; refusing to overwrite a third app or reused PID.',
    )
  }
  const drift = Math.hypot(
    after.pointer.x - before.pointer.x,
    after.pointer.y - before.pointer.y,
  )
  if (drift > 1) {
    throw new Error(`Physical pointer drift was ${drift.toFixed(3)} px (> 1 px)`)
  }
  if (!sameHeldInput(before.input, after.input)) {
    throw new Error('Held input state changed; a key or mouse button may be stuck')
  }
}

export function assertPointerTrace(trace: PointerTrace): void {
  if (!Number.isSafeInteger(trace.samples) || trace.samples < 2) {
    throw new Error('Physical pointer monitor collected too few samples')
  }
  if (!Number.isFinite(trace.maxDriftPx) || trace.maxDriftPx > 1) {
    throw new Error(
      `Physical pointer moved transiently by ${trace.maxDriftPx.toFixed(3)} px (> 1 px)`,
    )
  }
}

export function parseInputMonitorSnapshot(
  value: unknown,
): InputMonitorSnapshot {
  if (!isObject(value)) {
    throw new Error('Physical-input monitor state is missing')
  }
  const { epoch, available, continuityGeneration } = value
  if (
    available !== true
    || !nonEmptyString(epoch)
    || !/^\d+$/.test(epoch)
    || !nonEmptyString(continuityGeneration)
    || !/^\d+$/.test(continuityGeneration)
  ) {
    throw new Error(
      'Physical-input monitor is unavailable or returned unprovable continuity evidence',
    )
  }
  return {
    epoch: BigInt(epoch),
    available: true,
    continuityGeneration: BigInt(continuityGeneration),
  }
}

export function assertMonitorContinuity(
  before: InputMonitorSnapshot,
  after: InputMonitorSnapshot,
): void {
  if (before.continuityGeneration !== after.continuityGeneration) {
    throw new Error('Physical-input monitor continuity changed during the smoke')
  }
  if (before.epoch !== after.epoch) {
    throw new Error('Physical input occurred during the smoke; no restoration is safe')
  }
}

function matchingEditableElements(
  state: LiveAppState,
  matchesValue: (value: string) => boolean,
): LiveStateElement[] {
  return (state.elements ?? []).filter(element => {
    const editableRole = element.role === 'AXTextArea'
      || element.role === 'AXTextField'
      || element.role === 'AXTextView'
    return editableRole
      && element.settable === true
      && typeof element.value === 'string'
      && matchesValue(element.value)
  })
}

function handleForElement(state: LiveAppState, element: LiveStateElement): string {
  const handlePattern = new RegExp(`\\bg\\d+:${element.index}\\b`, 'g')
  const handles = new Set(state.axText.match(handlePattern) ?? [])
  if (handles.size !== 1) {
    throw new Error(
      `Expected one rendered opaque handle for editable element ${element.index}, found ${handles.size}`,
    )
  }
  return [...handles][0]
}

export function findEditableHandle(
  state: LiveAppState,
  expectedToken: string,
): string {
  const matches = matchingEditableElements(
    state,
    value => value.includes(expectedToken),
  )
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one settable editable element containing '${expectedToken}', found ${matches.length}`,
    )
  }
  return handleForElement(state, matches[0])
}

function findExactEditableHandle(state: LiveAppState, value: string): string {
  const matches = matchingEditableElements(state, candidate => candidate === value)
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one settable editable element with exact value ${JSON.stringify(value)}, found ${matches.length}`,
    )
  }
  return handleForElement(state, matches[0])
}

function screenshotBytes(state: LiveAppState, label: string): Buffer {
  const shot = state.screenshot
  if (
    !shot
    || !nonEmptyString(shot.base64)
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(shot.base64)
    || shot.base64.length % 4 !== 0
    || !Number.isSafeInteger(shot.width)
    || shot.width <= 0
    || !Number.isSafeInteger(shot.height)
    || shot.height <= 0
  ) {
    throw new Error(
      `${label} did not include a fresh non-empty screenshot; state=${JSON.stringify({
        pid: state.pid,
        bundleId: state.bundleId,
        windowTitle: state.windowTitle,
        windowID: state.windowID,
        elementCount: state.elementCount,
        screenshot: shot
          ? { width: shot.width, height: shot.height, base64Length: shot.base64?.length }
          : null,
      })}`,
    )
  }
  const bytes = Buffer.from(shot.base64, 'base64')
  const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  if (
    bytes.length < 33
    || !bytes.subarray(0, 8).equals(pngSignature)
    || bytes.toString('ascii', 12, 16) !== 'IHDR'
    || bytes.readUInt32BE(16) !== shot.width
    || bytes.readUInt32BE(20) !== shot.height
    || bytes.indexOf(Buffer.from('IEND')) < 0
  ) {
    throw new Error(`${label} screenshot is not a dimension-matched PNG`)
  }
  return bytes
}

function assertScreenshot(state: LiveAppState, label: string): void {
  screenshotBytes(state, label)
}

export function hasFreshScreenshot(state: LiveAppState): boolean {
  try {
    screenshotBytes(state, 'Candidate state')
    return true
  } catch {
    return false
  }
}

export function assertScreenshotChanged(
  before: LiveAppState,
  after: LiveAppState,
): void {
  const beforeHash = createHash('sha256')
    .update(screenshotBytes(before, 'Before-mutation state'))
    .digest('hex')
  const afterHash = createHash('sha256')
    .update(screenshotBytes(after, 'After-mutation state'))
    .digest('hex')
  if (beforeHash === afterHash) {
    throw new Error('Mutation screenshot was reused instead of freshly changed')
  }
}

export function assertNoChangeState(state: LiveAppState): void {
  if (!state.axText.startsWith(EXACT_NO_CHANGE_PREFIX)) {
    throw new Error('Expected the exact native no-change state header')
  }
  assertScreenshot(state, 'No-change state')
}

export function hasExactNoChangeState(state: LiveAppState): boolean {
  return state.axText.startsWith(EXACT_NO_CHANGE_PREFIX)
    && hasFreshScreenshot(state)
}

export function assertChangedState(
  state: LiveAppState,
  expectedToken: string,
): void {
  if (
    !state.axText.startsWith(
      'The following is a diff from the previous accessibility tree for Window: "',
    )
    || !state.axText.includes(expectedToken)
  ) {
    throw new Error('Expected a native changed diff containing the mutation token')
  }
  assertScreenshot(state, 'Changed state')
}

export function assertStaleHandleFailure(error: unknown): void {
  const message = errorMessage(error)
  if (!/(?:stale|not found in snapshot|No snapshot element|user changed).*?(?:get_app_state|Re-query|call get_app_state)/i.test(message)) {
    throw new Error(`Failure was not a stale-handle rejection: ${message}`)
  }
}

export function assertCleanupEvidence(evidence: CleanupEvidence): void {
  if (evidence.daemonSocketExists) {
    throw new Error('Owned daemon socket still exists after shutdown')
  }
  if (evidence.daemonPidfileExists) {
    throw new Error('Owned daemon pidfile still exists after shutdown')
  }
  if (evidence.daemonProcessStillMatches) {
    throw new Error('Owned cu-helper daemon process still exists after shutdown')
  }
  if (!sameHeldInput(evidence.inputBefore, evidence.inputAfter)) {
    throw new Error('Held input state was not restored during cleanup')
  }
}

function runChecked(
  executable: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): { stdout: string; stderr: string } {
  const result = spawnSync(executable, [...args], {
    encoding: 'utf8',
    env: options.env ?? process.env,
    timeout: options.timeoutMs ?? 20_000,
    maxBuffer: 10 * 1024 * 1024,
  })
  if (result.error || result.status !== 0) {
    throw new Error(
      `${executable} ${args.join(' ')} failed: ${
        result.error?.message
          ?? result.stderr?.trim()
          ?? result.stdout?.trim()
          ?? `status ${String(result.status)}`
      }`,
    )
  }
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function requireSignedHelper(): InstalledHelper {
  const installed = ensureInstalledHelper()
  if (!installed) {
    throw new Error(
      'Signed native helper is missing. Run native/cu-helper/build.sh first.',
    )
  }
  if (isNestedInHostApp(installed.appBundle)) {
    throw new Error(
      `Refusing nested helper at ${installed.appBundle}; Screen Recording must be granted to a standalone helper app.`,
    )
  }
  accessSync(installed.binary, fsConstants.X_OK)
  const relativeBinary = path.relative(installed.appBundle, installed.binary)
  if (
    relativeBinary.startsWith('..')
    || path.isAbsolute(relativeBinary)
    || relativeBinary !== path.join('Contents', 'MacOS', 'cc-haha-computer-use')
  ) {
    throw new Error('Installed helper executable is not inside the expected app bundle')
  }

  runChecked('/usr/bin/codesign', [
    '--verify',
    '--deep',
    '--strict',
    '--verbose=2',
    installed.appBundle,
  ])
  const details = runChecked('/usr/bin/codesign', [
    '-dv',
    '--verbose=4',
    installed.appBundle,
  ])
  const output = `${details.stdout}\n${details.stderr}`
  const identifier = output.match(/^Identifier=(.+)$/m)?.[1]?.trim()
  if (identifier !== HELPER_IDENTIFIER) {
    throw new Error(
      `Native helper signature identifier is '${identifier ?? 'missing'}', expected '${HELPER_IDENTIFIER}'`,
    )
  }
  if (/^Signature=adhoc$/m.test(output) || !/^Authority=.+$/m.test(output)) {
    throw new Error('Native helper must carry a stable non-ad-hoc signing authority')
  }
  return installed
}

export const SWIFT_SYSTEM_PROBE = String.raw`
import AppKit
import CoreGraphics
import Foundation

let env = ProcessInfo.processInfo.environment

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(2)
}

func emit(_ value: Any) -> Never {
    guard JSONSerialization.isValidJSONObject(value),
          let data = try? JSONSerialization.data(withJSONObject: value)
    else { fail("could not encode probe result") }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0a]))
    exit(0)
}

func processIdentity(_ app: NSRunningApplication) -> [String: Any]? {
    guard app.processIdentifier > 0,
          let bundleID = app.bundleIdentifier, !bundleID.isEmpty,
          let executablePath = app.executableURL?.standardizedFileURL.path,
          let launchTime = app.launchDate?.timeIntervalSinceReferenceDate
    else { return nil }
    return [
        "pid": Int(app.processIdentifier),
        "bundleId": bundleID,
        "executablePath": executablePath,
        "launchTime": launchTime,
    ]
}

func matchesExpected(_ app: NSRunningApplication) -> Bool {
    guard let expectedPID = env["CC_HAHA_SMOKE_PID"].flatMap(Int32.init),
          let expectedBundle = env["CC_HAHA_SMOKE_BUNDLE"],
          let expectedExecutable = env["CC_HAHA_SMOKE_EXECUTABLE"],
          let expectedLaunch = env["CC_HAHA_SMOKE_LAUNCH_TIME"].flatMap(Double.init),
          let identity = processIdentity(app),
          let pid = identity["pid"] as? Int,
          let bundle = identity["bundleId"] as? String,
          let executable = identity["executablePath"] as? String,
          let launch = identity["launchTime"] as? Double
    else { return false }
    return pid == Int(expectedPID)
        && bundle == expectedBundle
        && executable == expectedExecutable
        && abs(launch - expectedLaunch) < 0.000001
}

switch env["CC_HAHA_SMOKE_MODE"] {
case "state":
    guard let app = NSWorkspace.shared.frontmostApplication,
          let identity = processIdentity(app),
          let pointerEvent = CGEvent(source: nil)
    else { fail("could not prove the real frontmost app and pointer") }
    let point = pointerEvent.location
    let heldMask: CGEventFlags = [
        .maskShift, .maskControl, .maskAlternate, .maskCommand, .maskSecondaryFn,
    ]
    let flags = CGEventSource.flagsState(.combinedSessionState).intersection(heldMask)
    let buttons = (0..<5).map { raw -> Bool in
        guard let button = CGMouseButton(rawValue: UInt32(raw)) else { return true }
        return CGEventSource.buttonState(.combinedSessionState, button: button)
    }
    emit([
        "frontmost": identity,
        "pointer": ["x": Double(point.x), "y": Double(point.y)],
        "input": ["flags": String(flags.rawValue), "buttons": buttons],
    ])

case "launch":
    guard let fixture = env["CC_HAHA_SMOKE_FIXTURE"],
          let appPath = env["CC_HAHA_SMOKE_APP"],
          let identityPath = env["CC_HAHA_SMOKE_IDENTITY_FILE"]
    else { fail("launch probe paths are missing") }
    let existing = Set(
        NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.TextEdit")
            .map { $0.processIdentifier }
    )
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = false
    configuration.addsToRecentItems = false
    configuration.createsNewApplicationInstance = true
    configuration.allowsRunningApplicationSubstitution = false
    configuration.promptsUserIfNeeded = false
    NSWorkspace.shared.open(
        [URL(fileURLWithPath: fixture)],
        withApplicationAt: URL(fileURLWithPath: appPath),
        configuration: configuration
    ) { app, error in
        if let error { fail("TextEdit background launch failed: \(error)") }
        guard let app else { fail("TextEdit background launch returned no process") }
        guard !existing.contains(app.processIdentifier) else {
            fail("TextEdit launch substituted an existing process")
        }
        guard var identity = processIdentity(app) else {
            _ = app.forceTerminate()
            fail("Dedicated TextEdit process identity was not provable")
        }
        identity["dedicated"] = true
        guard JSONSerialization.isValidJSONObject(identity),
              let identityData = try? JSONSerialization.data(withJSONObject: identity),
              (try? identityData.write(
                  to: URL(fileURLWithPath: identityPath),
                  options: .atomic
              )) != nil
        else {
            _ = app.forceTerminate()
            fail("could not persist dedicated TextEdit identity")
        }
        emit(identity)
    }
    RunLoop.current.run()
    fail("TextEdit launch run loop exited unexpectedly")

case "terminate":
    guard let pid = env["CC_HAHA_SMOKE_PID"].flatMap(Int32.init) else {
        fail("termination PID is missing")
    }
    guard let app = NSRunningApplication(processIdentifier: pid) else {
        emit(["terminated": true, "alreadyExited": true])
    }
    guard matchesExpected(app) else {
        emit(["terminated": true, "identityReplaced": true])
    }
    // Never request a graceful quit: an error may have left an unsaved document,
    // and TextEdit's save dialog would steal the user's foreground. The exact
    // pid/bundle/path/launch-time proof above makes a direct force-terminate safe.
    _ = app.forceTerminate()
    let deadline = Date().addingTimeInterval(3.0)
    while !app.isTerminated && Date() < deadline {
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
    }
    guard app.isTerminated else { fail("dedicated TextEdit did not terminate") }
    emit(["terminated": true])

default:
    fail("unknown system probe mode")
}
`

const SWIFT_POINTER_MONITOR = String.raw`
import CoreGraphics
import Darwin
import Foundation

let env = ProcessInfo.processInfo.environment
guard let initialX = env["CC_HAHA_SMOKE_POINTER_X"].flatMap(Double.init),
      let initialY = env["CC_HAHA_SMOKE_POINTER_Y"].flatMap(Double.init),
      let stopPath = env["CC_HAHA_SMOKE_POINTER_STOP"]
else { exit(2) }

func emit(_ value: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: value)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0a]))
}

emit(["ready": true])
var samples = 0
var maxDrift = 0.0
while !FileManager.default.fileExists(atPath: stopPath) {
    autoreleasepool {
        if let event = CGEvent(source: nil) {
            let point = event.location
            maxDrift = max(maxDrift, hypot(point.x - initialX, point.y - initialY))
            samples += 1
        }
    }
    usleep(5_000)
}
emit(["samples": samples, "maxDriftPx": maxDrift])
`

async function startPointerMonitor(
  initial: PhysicalPointer,
  stopPath: string,
): Promise<PointerMonitor> {
  const child = spawn('/usr/bin/swift', ['-e', SWIFT_POINTER_MONITOR], {
    env: {
      ...process.env,
      CC_HAHA_SMOKE_POINTER_X: String(initial.x),
      CC_HAHA_SMOKE_POINTER_Y: String(initial.y),
      CC_HAHA_SMOKE_POINTER_STOP: stopPath,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdin.end()
  let stdout = ''
  let stderr = ''
  let readyResolve!: () => void
  let readyReject!: (error: Error) => void
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve
    readyReject = reject
  })
  let resultResolve!: (trace: PointerTrace) => void
  let resultReject!: (error: Error) => void
  const result = new Promise<PointerTrace>((resolve, reject) => {
    resultResolve = resolve
    resultReject = reject
  })
  let sawReady = false
  child.stdout.on('data', chunk => {
    stdout += chunk.toString()
    const lines = stdout.split('\n')
    stdout = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const value = JSON.parse(line) as Record<string, unknown>
        if (value.ready === true && !sawReady) {
          sawReady = true
          readyResolve()
        } else if (finiteNumber(value.samples) && finiteNumber(value.maxDriftPx)) {
          resultResolve({
            samples: value.samples,
            maxDriftPx: value.maxDriftPx,
          })
        }
      } catch {
        // Exit handler below reports the complete invalid output.
      }
    }
  })
  child.stderr.on('data', chunk => { stderr += chunk.toString() })
  child.once('error', error => {
    const wrapped = new Error(`pointer monitor failed to start: ${error.message}`)
    readyReject(wrapped)
    resultReject(wrapped)
  })
  child.once('exit', code => {
    if (!sawReady) {
      readyReject(new Error(
        `pointer monitor exited before ready (${String(code)}): ${stderr || stdout}`,
      ))
    }
    if (code !== 0) {
      resultReject(new Error(
        `pointer monitor exited with ${String(code)}: ${stderr || stdout}`,
      ))
    }
  })

  await Promise.race([
    ready,
    Bun.sleep(20_000).then(() => {
      throw new Error('pointer monitor did not become ready within 20s')
    }),
  ]).catch(error => {
    child.kill('SIGKILL')
    throw error
  })

  return { process: child, stopPath, result, stopped: false }
}

async function stopPointerMonitor(monitor: PointerMonitor): Promise<PointerTrace> {
  if (!monitor.stopped) {
    monitor.stopped = true
    writeFileSync(monitor.stopPath, 'stop\n', { flag: 'wx', mode: 0o600 })
  }
  const trace = await Promise.race([
    monitor.result,
    Bun.sleep(10_000).then(() => {
      throw new Error('pointer monitor did not stop within 10s')
    }),
  ]).catch(error => {
    monitor.process.kill('SIGKILL')
    throw error
  })
  assertPointerTrace(trace)
  return trace
}

function runSystemProbe(
  mode: 'state' | 'launch' | 'terminate',
  extraEnv: NodeJS.ProcessEnv = {},
): unknown {
  const result = runChecked('/usr/bin/swift', ['-e', SWIFT_SYSTEM_PROBE], {
    env: {
      ...process.env,
      ...extraEnv,
      CC_HAHA_SMOKE_MODE: mode,
    },
    timeoutMs: mode === 'launch' ? 30_000 : 20_000,
  })
  try {
    return JSON.parse(result.stdout)
  } catch {
    throw new Error(`System probe returned invalid JSON: ${result.stdout}`)
  }
}

function captureSystemSnapshot(): SystemSnapshot {
  return parseSystemSnapshot(JSON.stringify(runSystemProbe('state')))
}

function targetAppPath(): string {
  const candidate = TARGET_APP_CANDIDATES.find(existsSync)
  if (!candidate) throw new Error('TextEdit.app was not found on this macOS host')
  return candidate
}

function launchDedicatedTextEdit(
  fixturePath: string,
  appPath: string,
  initialFrontmost: ProcessIdentity,
  identityPath: string,
): ProcessIdentity {
  let raw: unknown
  try {
    raw = runSystemProbe('launch', {
      CC_HAHA_SMOKE_FIXTURE: fixturePath,
      CC_HAHA_SMOKE_APP: appPath,
      CC_HAHA_SMOKE_IDENTITY_FILE: identityPath,
    })
  } catch (error) {
    const launched = readPersistedTargetIdentity(identityPath)
    if (launched) terminateDedicatedTextEdit(launched)
    throw error
  }
  if (!isObject(raw) || raw.dedicated !== true) {
    throw new Error('TextEdit launch did not prove a dedicated process')
  }
  const identity = parseProcessIdentity(raw, 'Dedicated TextEdit')
  const persisted = readPersistedTargetIdentity(identityPath)
  if (!persisted || !sameProcessIdentity(identity, persisted)) {
    terminateDedicatedTextEdit(identity)
    throw new Error('Dedicated TextEdit identity sidecar did not match launch output')
  }
  const expectedExecutable = path.join(appPath, TARGET_EXECUTABLE_RELATIVE)
  if (
    identity.bundleId !== TARGET_BUNDLE_ID
    || identity.executablePath !== expectedExecutable
    || identity.pid === initialFrontmost.pid
  ) {
    terminateDedicatedTextEdit(identity)
    throw new Error(
      `Dedicated TextEdit identity was unsafe: ${JSON.stringify(identity)}`,
    )
  }
  return identity
}

function readPersistedTargetIdentity(
  identityPath: string,
): ProcessIdentity | undefined {
  try {
    return parseProcessIdentity(
      JSON.parse(readFileSync(identityPath, 'utf8')),
      'Persisted dedicated TextEdit',
    )
  } catch {
    return undefined
  }
}

function terminateDedicatedTextEdit(identity: ProcessIdentity): void {
  const raw = runSystemProbe('terminate', {
    CC_HAHA_SMOKE_PID: String(identity.pid),
    CC_HAHA_SMOKE_BUNDLE: identity.bundleId,
    CC_HAHA_SMOKE_EXECUTABLE: identity.executablePath,
    CC_HAHA_SMOKE_LAUNCH_TIME: String(identity.launchTime),
  })
  if (!isObject(raw) || raw.terminated !== true) {
    throw new Error('Dedicated TextEdit cleanup did not complete')
  }
}

function createRunPaths(): LiveSmokePaths {
  const runDirectory = mkdtempSync(RUN_DIRECTORY_PREFIX)
  assertSafeRunDirectory(runDirectory)
  const paths = deriveLiveSmokePaths(
    runDirectory,
    getRuntimePaths().runtimeStateRoot,
    process.pid,
  )
  writeFileSync(paths.fixturePath, INITIAL_FIXTURE, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  })
  return paths
}

function removeRunDirectory(runDirectory: string): void {
  assertSafeRunDirectory(runDirectory)
  if (!existsSync(runDirectory)) return
  const realTmp = realpathSync('/tmp')
  const realRun = realpathSync(runDirectory)
  if (
    path.dirname(realRun) !== realTmp
    || !/^cc-haha-cu-live-smoke-[A-Za-z0-9]{6}$/.test(path.basename(realRun))
  ) {
    throw new Error(`Refusing cleanup after run directory escaped /tmp: ${realRun}`)
  }
  rmSync(runDirectory, { recursive: true, force: true })
}

async function waitFor<T>(
  label: string,
  read: () => T | Promise<T>,
  accept: (value: T) => boolean,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let latest: T | undefined
  let latestError: unknown
  while (Date.now() < deadline) {
    try {
      latest = await read()
      latestError = undefined
      if (accept(latest)) return latest
    } catch (error) {
      latestError = error
    }
    await Bun.sleep(POLL_INTERVAL_MS)
  }
  throw new Error(
    `${label} did not settle within ${timeoutMs}ms${
      latestError ? `: ${errorMessage(latestError)}` : `; latest=${JSON.stringify(latest)}`
    }`,
  )
}

async function waitForFileContent(
  fixturePath: string,
  expected: string,
): Promise<void> {
  await waitFor(
    `fixture ${JSON.stringify(expected)}`,
    () => readFileSync(fixturePath, 'utf8'),
    value => value === expected,
    STATE_TIMEOUT_MS,
  )
}

async function getState(
  target: ProcessIdentity,
  disableDiff?: boolean,
): Promise<LiveAppState> {
  const payload: Record<string, unknown> = targetPayload(target)
  if (disableDiff !== undefined) payload.disableDiff = disableDiff
  const state = await callHelper<LiveAppState>('get_app_state', payload)
  if (state.pid !== target.pid || state.bundleId !== TARGET_BUNDLE_ID) {
    throw new Error(
      `Helper resolved the wrong target: expected PID ${target.pid}/${TARGET_BUNDLE_ID}, received ${state.pid}/${state.bundleId ?? 'unknown'}`,
    )
  }
  return state
}

async function pressTargetKey(target: ProcessIdentity, key: string): Promise<void> {
  await callHelper('press_key', {
    ...targetPayload(target),
    key,
    systemKeyCombos: false,
  })
}

function readDaemonPid(pidfile: string): number | undefined {
  try {
    const raw = readFileSync(pidfile, 'utf8').trim()
    if (!/^[1-9]\d*$/.test(raw)) return undefined
    const pid = Number(raw)
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

function processCommand(pid: number): string {
  const result = spawnSync('/bin/ps', ['-ww', '-p', String(pid), '-o', 'command='], {
    encoding: 'utf8',
  })
  return result.status === 0 ? (result.stdout ?? '').trim() : ''
}

function daemonProcessMatches(
  pid: number | undefined,
  socketPath: string,
): boolean {
  if (!pid) return false
  const command = processCommand(pid)
  const helper = ensureInstalledHelper()?.binary
  if (!helper) return false
  const suffix = ` daemon --socket ${socketPath}`
  if (!command.endsWith(suffix)) return false
  const executable = command.slice(0, -suffix.length)
  try {
    return realpathSync(executable) === realpathSync(helper)
  } catch {
    return false
  }
}

async function readOwnedDaemonPid(paths: LiveSmokePaths): Promise<number> {
  return waitFor(
    'owned daemon pidfile',
    () => readDaemonPid(paths.daemonPidfile),
    (pid): pid is number => pid !== undefined
      && existsSync(paths.daemonSocket)
      && daemonProcessMatches(pid, paths.daemonSocket),
    CLEANUP_TIMEOUT_MS,
  ) as Promise<number>
}

async function waitForDaemonCleanup(
  paths: LiveSmokePaths,
  daemonPid: number | undefined,
): Promise<void> {
  await waitFor(
    'owned daemon shutdown',
    () => ({
      socket: existsSync(paths.daemonSocket),
      pidfile: existsSync(paths.daemonPidfile),
      process: daemonProcessMatches(daemonPid, paths.daemonSocket),
    }),
    evidence => !evidence.socket && !evidence.pidfile && !evidence.process,
    CLEANUP_TIMEOUT_MS,
  )
}

function assertIdleInput(input: HeldInputSnapshot): void {
  if (input.flags !== '0' || input.buttons.some(Boolean)) {
    throw new Error(
      'Start the live smoke with no Command/Control/Option/Shift/Fn key or mouse button held.',
    )
  }
}

async function executeSmoke(
  paths: LiveSmokePaths,
  lifecycle: SmokeLifecycle,
): Promise<Omit<SmokeResult, 'cleanup'>> {
  const initialSystem = captureSystemSnapshot()
  lifecycle.initialSystem = initialSystem
  assertIdleInput(initialSystem.input)

  const permissions = await callHelper<PermissionSnapshot>('check_permissions', {})
  if (!permissions.accessibility || !permissions.screenRecording) {
    throw new Error(
      `Computer Use permissions are incomplete: Accessibility=${permissions.accessibility}, Screen Recording=${permissions.screenRecording}`,
    )
  }
  const monitorBefore = parseInputMonitorSnapshot(
    await callHelper('input_monitor_state', {}),
  )
  const afterDaemonStart = captureSystemSnapshot()
  assertSystemStatePreserved(initialSystem, afterDaemonStart)
  const daemonPid = await readOwnedDaemonPid(paths)
  lifecycle.daemonPid = daemonPid

  const appPath = targetAppPath()
  const target = launchDedicatedTextEdit(
    paths.fixturePath,
    appPath,
    initialSystem.frontmost,
    paths.targetIdentityPath,
  )
  lifecycle.target = target
  const afterTargetLaunch = captureSystemSnapshot()
  assertSystemStatePreserved(initialSystem, afterTargetLaunch)
  const helperTarget = await callHelper<ResolvedTargetSnapshot>(
    'resolve_app_target',
    targetPayload(target),
  )
  if (
    helperTarget.pid !== target.pid
    || helperTarget.bundleId !== target.bundleId
    || helperTarget.executablePath !== target.executablePath
    || helperTarget.launchTime !== target.launchTime
  ) {
    throw new Error(
      `Native target identity mismatch: ${JSON.stringify(helperTarget)}`,
    )
  }
  assertHelperHeldInputIdle(
    await callHelper<HelperHeldInputSnapshot>('held_input_state', {}),
  )
  const pointerMonitor = await startPointerMonitor(
    initialSystem.pointer,
    path.join(paths.runDirectory, '.pointer-monitor-stop'),
  )
  lifecycle.pointerMonitor = pointerMonitor

  const full = await waitFor(
    'dedicated TextEdit initial full state',
    () => getState(target, true),
    candidate => candidate.axText.includes(STABLE_TOKEN)
      && (candidate.elements ?? []).some(element => element.value?.includes(STABLE_TOKEN))
      && hasFreshScreenshot(candidate),
    STATE_TIMEOUT_MS,
  )
  assertScreenshot(full, 'Initial full state')
  const stableHandle = findEditableHandle(full, STABLE_TOKEN)

  // TextEdit may restore additional windows after the fixture window first
  // becomes readable. Preserve those real native diffs, then require the AX
  // tree to converge before asserting the no-change protocol frame.
  const noChange = await waitFor(
    'dedicated TextEdit initial no-change state',
    () => getState(target),
    hasExactNoChangeState,
    STATE_TIMEOUT_MS,
  )
  assertNoChangeState(noChange)

  // Exercise a real semantic pointer action. It must animate only the helper's
  // virtual cursor; the independent monitor observes the physical pointer for
  // transient movement, including move-away-then-restore bugs.
  await callHelper('click', {
    ...targetPayload(target),
    index: stableHandle,
    click_count: 1,
    button: 'left',
  })
  const interactionFull = await getState(target, true)
  const interactionHandle = findEditableHandle(interactionFull, STABLE_TOKEN)

  const unchangedReceipt = await callHelper<SetValueResult>('set_value', {
    ...targetPayload(target),
    index: interactionHandle,
    value: INITIAL_FIXTURE,
  })
  if (
    unchangedReceipt.before !== INITIAL_FIXTURE
    || unchangedReceipt.after !== INITIAL_FIXTURE
  ) {
    throw new Error(
      `Old stable handle returned an unexpected unchanged receipt: ${JSON.stringify(unchangedReceipt)}`,
    )
  }

  const changedReceipt = await callHelper<SetValueResult>('set_value', {
    ...targetPayload(target),
    index: interactionHandle,
    value: MUTATED_FIXTURE,
  })
  if (changedReceipt.after !== MUTATED_FIXTURE) {
    throw new Error(`Controlled mutation did not land: ${JSON.stringify(changedReceipt)}`)
  }
  const changed = await getState(target)
  assertChangedState(changed, MUTATED_TOKEN)
  assertScreenshotChanged(interactionFull, changed)

  await pressTargetKey(target, 'super+s')
  await waitForFileContent(paths.fixturePath, MUTATED_FIXTURE)

  const fixtureWindowTitle = changed.windowTitle ?? full.windowTitle
  await pressTargetKey(target, 'super+n')
  const addedWindow = await waitFor(
    'TextEdit topology addition',
    () => getState(target, true),
    candidate => candidate.windowTitle !== fixtureWindowTitle
      && matchingEditableElements(candidate, value => value === '').length === 1,
    STATE_TIMEOUT_MS,
  )
  const topologyHandle = findExactEditableHandle(addedWindow, '')

  await pressTargetKey(target, 'super+w')
  const restoredWindow = await waitFor(
    'TextEdit topology restoration',
    () => getState(target, true),
    candidate => candidate.axText.includes(MUTATED_TOKEN)
      && !candidate.axText.includes(topologyHandle),
    STATE_TIMEOUT_MS,
  )

  let staleFailure: unknown
  try {
    await callHelper('set_value', {
      ...targetPayload(target),
      index: topologyHandle,
      value: 'must-not-land',
    })
  } catch (error) {
    staleFailure = error
  }
  if (!staleFailure) {
    throw new Error(`Removed topology handle ${topologyHandle} unexpectedly remained actionable`)
  }
  assertStaleHandleFailure(staleFailure)

  const restoreHandle = findEditableHandle(restoredWindow, MUTATED_TOKEN)
  const restoreReceipt = await callHelper<SetValueResult>('set_value', {
    ...targetPayload(target),
    index: restoreHandle,
    value: INITIAL_FIXTURE,
  })
  if (restoreReceipt.after !== INITIAL_FIXTURE) {
    throw new Error(`Fixture restore did not land: ${JSON.stringify(restoreReceipt)}`)
  }
  await pressTargetKey(target, 'super+s')
  await waitForFileContent(paths.fixturePath, INITIAL_FIXTURE)

  const finalFull = await getState(target, true)
  if (!finalFull.axText.includes(STABLE_TOKEN) || finalFull.axText.includes(MUTATED_TOKEN)) {
    throw new Error('Final TextEdit UI did not return to the fixture baseline')
  }
  assertScreenshot(finalFull, 'Final restored full state')
  const finalNoChange = await waitFor(
    'dedicated TextEdit final no-change state',
    () => getState(target),
    hasExactNoChangeState,
    STATE_TIMEOUT_MS,
  )
  assertNoChangeState(finalNoChange)
  assertHelperHeldInputIdle(
    await callHelper<HelperHeldInputSnapshot>('held_input_state', {}),
  )

  const monitorAfter = parseInputMonitorSnapshot(
    await callHelper('input_monitor_state', {}),
  )
  assertMonitorContinuity(monitorBefore, monitorAfter)
  const finalSystem = captureSystemSnapshot()
  assertSystemStatePreserved(initialSystem, finalSystem)
  const pointerDriftPx = Math.hypot(
    finalSystem.pointer.x - initialSystem.pointer.x,
    finalSystem.pointer.y - initialSystem.pointer.y,
  )
  const pointerTrace = await stopPointerMonitor(pointerMonitor)
  lifecycle.pointerMonitor = undefined

  return {
    target,
    initialFrontmost: initialSystem.frontmost,
    finalFrontmost: finalSystem.frontmost,
    pointerDriftPx,
    pointerSamples: pointerTrace.samples,
    stableHandle,
    staleTopologyHandle: topologyHandle,
    fullElementCount: full.elementCount,
    changedScreenshot: {
      width: changed.screenshot!.width,
      height: changed.screenshot!.height,
      base64Bytes: screenshotBytes(changed, 'Changed state').length,
    },
    physicalInputEpoch: monitorAfter.epoch.toString(),
    physicalInputContinuityGeneration:
      monitorAfter.continuityGeneration.toString(),
    fixtureSavedAndRestored: true,
    daemonPid,
  }
}

async function cleanupSmoke(args: {
  paths: LiveSmokePaths
  target?: ProcessIdentity
  daemonPid?: number
  initialSystem?: SystemSnapshot
  pointerMonitor?: PointerMonitor
}): Promise<SmokeResult['cleanup']> {
  const errors: Error[] = []
  let daemonPid = args.daemonPid ?? readDaemonPid(args.paths.daemonPidfile)

  if (args.pointerMonitor) {
    try {
      await stopPointerMonitor(args.pointerMonitor)
    } catch (error) {
      errors.push(new Error(`pointer monitor cleanup failed: ${errorMessage(error)}`))
    }
  }

  try {
    await overlayHide()
  } catch (error) {
    errors.push(new Error(`overlay cleanup failed: ${errorMessage(error)}`))
  }
  try {
    await shutdownDaemon()
  } catch (error) {
    errors.push(new Error(`daemon shutdown failed: ${errorMessage(error)}`))
  }
  try {
    await waitForDaemonCleanup(args.paths, daemonPid)
  } catch (error) {
    errors.push(error instanceof Error ? error : new Error(String(error)))
  }

  const cleanupTarget = args.target
    ?? readPersistedTargetIdentity(args.paths.targetIdentityPath)
  if (cleanupTarget) {
    try {
      terminateDedicatedTextEdit(cleanupTarget)
    } catch (error) {
      errors.push(new Error(`dedicated TextEdit cleanup failed: ${errorMessage(error)}`))
    }
  }

  if (args.initialSystem) {
    try {
      const after = captureSystemSnapshot()
      assertSystemStatePreserved(args.initialSystem, after)
      assertCleanupEvidence({
        daemonSocketExists: existsSync(args.paths.daemonSocket),
        daemonPidfileExists: existsSync(args.paths.daemonPidfile),
        daemonProcessStillMatches: daemonProcessMatches(
          daemonPid,
          args.paths.daemonSocket,
        ),
        inputBefore: args.initialSystem.input,
        inputAfter: after.input,
      })
    } catch (error) {
      errors.push(new Error(`post-shutdown proof failed: ${errorMessage(error)}`))
    }
  }

  try {
    removeRunDirectory(args.paths.runDirectory)
  } catch (error) {
    errors.push(new Error(`temporary fixture cleanup failed: ${errorMessage(error)}`))
  }

  if (errors.length > 0) {
    throw new AggregateError(errors, 'Computer Use live-smoke cleanup failed')
  }
  return {
    daemonSocketRemoved: true,
    daemonPidfileRemoved: true,
    ownedDaemonExited: true,
    heldInputRestored: true,
    dedicatedTextEditExited: true,
  }
}

export async function runComputerUseLiveSmoke(
  argv: readonly string[] = process.argv.slice(2),
): Promise<SmokeResult> {
  if (process.platform !== 'darwin') {
    throw new Error('Computer Use live smoke is macOS-only')
  }
  parseLiveSmokeArgs(argv)
  const releaseLock = await acquireLiveSmokeLock()
  try {
    requireSignedHelper()
    const paths = createRunPaths()
    const lifecycle: SmokeLifecycle = {}
    let body: Omit<SmokeResult, 'cleanup'> | undefined
    let primaryError: unknown

    try {
      body = await executeSmoke(paths, lifecycle)
    } catch (error) {
      primaryError = error
      lifecycle.daemonPid = lifecycle.daemonPid
        ?? readDaemonPid(paths.daemonPidfile)
    }

    let cleanup: SmokeResult['cleanup'] | undefined
    let cleanupError: unknown
    try {
      cleanup = await cleanupSmoke({
        paths,
        target: lifecycle.target,
        daemonPid: lifecycle.daemonPid,
        initialSystem: lifecycle.initialSystem,
        pointerMonitor: lifecycle.pointerMonitor,
      })
    } catch (error) {
      cleanupError = error
    }

    if (primaryError || cleanupError) {
      const errors = [primaryError, cleanupError]
        .filter((error): error is NonNullable<typeof error> => error !== undefined)
        .map(error => error instanceof Error ? error : new Error(String(error)))
      throw errors.length === 1
        ? errors[0]
        : new AggregateError(errors, 'Computer Use live smoke and cleanup failed')
    }
    if (!body || !cleanup) throw new Error('Computer Use live smoke produced no result')
    return { ...body, cleanup }
  } finally {
    await releaseLock()
  }
}

if (import.meta.main) {
  try {
    const result = await runComputerUseLiveSmoke()
    console.log(JSON.stringify(result, null, 2))
  } catch (error) {
    console.error(`Computer Use live smoke failed: ${errorMessage(error)}`)
    process.exitCode = 1
  }
}
