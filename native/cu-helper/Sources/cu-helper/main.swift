//
//  main.swift
//  cu-helper
//
//  Process entry point for the native Computer Use helper.
//
//  Two modes, ONE binary (see the process-model decision in the plan):
//
//    1. DAEMON   `cu-helper daemon --socket <path>`
//       Long-lived AppKit `.accessory` process that owns the main run loop,
//       the animated virtual-cursor overlay and the capture-glow overlay, and
//       serves an NDJSON request/response stream over an AF_UNIX socket. It
//       writes exactly ONE readiness line to stdout, then `app.run()` takes
//       over forever. Stdout is kept pristine (one line) so a bridge can await
//       readiness; all request/response traffic rides the private socket.
//
//    2. CLI ONE-SHOT   `cu-helper <command> --payload '<json>'`
//       Back-compat path for the existing TS bridge (pythonBridge.ts), which
//       spawns `<helper> <command> --payload '<json>'`, reads exactly ONE
//       stdout line `{ok,result?,error?}`, and lets the process exit. We build
//       a HEADLESS CommandRouter (no overlay, no animation; cursor state is
//       best-effort disk-persisted), dispatch the single command, print exactly
//       ONE `{ok,...}` JSON line, and exit(0).
//
//  HARD OUTPUT CONTRACT (CLI mode): the bridge does `JSON.parse(stdout)` and
//  only tolerates a non-zero exit code when stdout is EMPTY. Therefore:
//    - We ALWAYS emit exactly one JSON line and ALWAYS exit(0), even on error
//      (errors become `{"ok":false,"error":{...}}`), so the bridge can read a
//      structured failure instead of throwing on a raw stderr string.
//    - We must not let AppKit/CoreGraphics/os_log chatter reach stdout. In CLI
//      mode we never spin up an NSApplication/NSWindow, and we write our single
//      line and exit before anything else can print to fd 1.
//
//  Concurrency note: `CommandRouter.handle` is `@MainActor` and `async` (it
//  touches AppKit, ScreenCaptureKit, and posts CGEvents in main-run-loop
//  order). Top-level code in `main.swift` already runs on the main thread but
//  WITHOUT a live run loop, so a suspended `@MainActor` continuation (e.g. an
//  `await` inside SCScreenshotManager) would never be resumed. We therefore
//  kick the work off in a `Task` and pump `RunLoop.main` until that task
//  signals completion, then print and exit on the main thread.
//

import Foundation
import CDisclaim

#if canImport(AppKit)
import AppKit
#endif

// MARK: - Argument / path helpers (file-private)

/// Returns the value following `--<name>` in `argv`, or `nil` if absent.
/// Accepts both `--name value` and `--name=value` forms.
func parseFlag(_ name: String, in argv: [String]) -> String? {
    let longFlag = "--\(name)"
    var index = 0
    while index < argv.count {
        let arg = argv[index]
        if arg == longFlag {
            let next = index + 1
            if next < argv.count {
                return argv[next]
            }
            return nil
        }
        if arg.hasPrefix(longFlag + "=") {
            return String(arg.dropFirst(longFlag.count + 1))
        }
        index += 1
    }
    return nil
}

/// `~/.claude/.runtime`, created (mkdir -p) if missing.
///
/// Mirrors the TS bridge's `runtimeStateRoot` (envUtils.getClaudeConfigHomeDir
/// → `<CLAUDE_CONFIG_DIR | ~/.claude>/.runtime`) so the daemon socket and the
/// headless cursor-persist file land exactly where the Node side looks.
func runtimeDir() -> String {
    let env = ProcessInfo.processInfo.environment
    let configHome: String
    if let override = env["CLAUDE_CONFIG_DIR"], !override.isEmpty {
        configHome = (override as NSString).expandingTildeInPath
    } else {
        configHome = (NSHomeDirectory() as NSString).appendingPathComponent(".claude")
    }
    let runtime = (configHome as NSString).appendingPathComponent(".runtime")
    try? FileManager.default.createDirectory(
        atPath: runtime,
        withIntermediateDirectories: true,
        attributes: nil
    )
    return runtime
}

/// Default daemon socket path when `--socket` is not supplied:
/// `~/.claude/.runtime/cu-helper.<pid>.sock`.
func defaultSocketPath() -> String {
    let pid = ProcessInfo.processInfo.processIdentifier
    return (runtimeDir() as NSString).appendingPathComponent("cu-helper.\(pid).sock")
}

// MARK: - Single-line stdout emission

/// Writes one `{...}\n` line to stdout using a raw `write(2)` so nothing
/// buffers and nothing else can interleave before we exit. We deliberately do
/// NOT use `print` (which can be retargeted) for the final payload.
@inline(__always)
private func emitLine(_ data: Data) {
    var payload = data
    if payload.last != UInt8(ascii: "\n") {
        payload.append(UInt8(ascii: "\n"))
    }
    payload.withUnsafeBytes { raw in
        guard let base = raw.baseAddress else { return }
        var offset = 0
        let total = raw.count
        while offset < total {
            let n = write(STDOUT_FILENO, base.advanced(by: offset), total - offset)
            if n <= 0 {
                if errno == EINTR { continue }
                break
            }
            offset += n
        }
    }
}

/// Emits the success/failure envelope for CLI mode and exits the process.
/// ALWAYS exits 0 so the bridge reads the JSON instead of treating a non-zero
/// code as a hard failure.
@MainActor
private func emitEnvelopeAndExit(_ envelope: Envelope) -> Never {
    Injection.releaseAllHeldSync()
    emitLine(envelope.line())
    exit(0)
}

/// Last-ditch fallback: if even `Envelope` encoding were to fail, hand-roll a
/// guaranteed-valid JSON error line so the bridge never sees empty stdout.
@MainActor
private func emitHardFailureAndExit(message: String) -> Never {
    Injection.releaseAllHeldSync()
    let escaped = message
        .replacingOccurrences(of: "\\", with: "\\\\")
        .replacingOccurrences(of: "\"", with: "\\\"")
        .replacingOccurrences(of: "\n", with: " ")
        .replacingOccurrences(of: "\r", with: " ")
    let line = "{\"ok\":false,\"error\":{\"message\":\"\(escaped)\"}}\n"
    emitLine(Data(line.utf8))
    exit(0)
}

// MARK: - Mode dispatch

@MainActor
private func runDaemonMode(argv: [String]) -> Never {
    let socketPath = parseFlag("socket", in: argv) ?? defaultSocketPath()
    // HID-counter epoch source: permission-free, cannot fail, no worker
    // thread. Constructed before the router so every lease reads one source.
    let inputMonitor = PhysicalInputEpochMonitor()
    _ = inputMonitor.startAndWait()
    // Daemon owns the main thread + run loop; .run() never returns.
    let daemon = Daemon(
        socketPath: socketPath,
        inputMonitor: inputMonitor
    )
    daemon.run()
}

/// Onboarding mode: show the native permission card (Accessibility + Screen
/// Recording) with one-click grant buttons + drag-into-Settings, no shell. Owns
/// its own NSApplication run loop; emits a final permission snapshot line on
/// close. See PermissionCard.swift.
@MainActor
private func runRequestAccessMode() -> Never {
    #if canImport(AppKit)
    PermissionCard.run()
    #else
    emitHardFailureAndExit(message: "request-access requires macOS AppKit")
    #endif
}

@MainActor
private func runCLIMode(argv: [String]) -> Never {
    // argv layout: [exePath, <command>, "--payload", "<json>", ...]
    guard argv.count >= 2 else {
        emitEnvelopeAndExit(.fail("missing command argument", code: "bad_command"))
    }

    let command = argv[1]

    // A bare `--help` / `-h` is the only non-command we special-case; it still
    // prints exactly one JSON line so the contract holds.
    if command == "--help" || command == "-h" || command == "help" {
        let usage = JSONValue.object([
            "usage": .string("cu-helper <command> --payload '<json>'  |  cu-helper daemon --socket <path>")
        ])
        emitEnvelopeAndExit(.ok(usage))
    }

    // The stateless CLI transport is not a Computer Use command channel. The
    // sole private exception is the fresh-process permission probe spawned by
    // the already-authenticated permission card. Every screenshot, mutation,
    // clipboard/app command and direct terminal invocation fails closed.
    guard (command == "check_permissions" || command == "attest_daemon_peer"),
          HelperRuntimeAuthorization.authorizeOneShot(command: command) else {
        emitEnvelopeAndExit(.fail(
            "This helper command requires the signed Claude Code Haha desktop app.",
            code: "unauthorized_client"
        ))
    }

    // Decode the payload up front so a malformed payload fails cleanly with a
    // structured error rather than blowing up mid-dispatch.
    let payloadString = parseFlag("payload", in: argv) ?? "{}"
    let payload: JSONValue
    do {
        if payloadString.isEmpty {
            payload = .object([:])
        } else {
            payload = try JSONValue(jsonString: payloadString)
        }
    } catch {
        emitEnvelopeAndExit(.fail("invalid --payload JSON: \(error.localizedDescription)", code: "bad_payload"))
    }

    if command == "attest_daemon_peer" {
        guard let object = payload.asObject,
              let executablePath = object["executablePath"]?.asString,
              !executablePath.isEmpty else {
            emitEnvelopeAndExit(.fail(
                "invalid daemon peer attestation payload",
                code: "bad_payload"
            ))
        }
        guard let attestation = HelperRuntimeAuthorization.authorizeDaemonPeer(
            fd: 3,
            expectedExecutablePath: executablePath
        ) else {
            emitEnvelopeAndExit(.fail(
                "daemon peer credentials are unavailable",
                code: "peer_credentials_unavailable"
            ))
        }
        emitEnvelopeAndExit(.ok(.object([
            "trusted": .bool(attestation.trusted),
            "pid": .int(Int(attestation.pid)),
        ])))
    }

    // CLI mode is HEADLESS: no NSApplication, no overlay windows, instant
    // cursor moves, disk-persisted cursor position. We do NOT call
    // NSApplication.shared here — touching it would attach AppKit machinery and
    // risk leaking diagnostics onto stdout before our single line. The router
    // and its collaborators are @MainActor; top-level code is already on the
    // main thread, so we may construct and drive them from here.

    // The result is delivered out of an async @MainActor Task. We can't simply
    // `await` at top level and then exit, because the suspension points inside
    // (SCScreenshotManager capture, Task.sleep pacing) need the main run loop
    // to resume their continuations. So: run the Task, and pump RunLoop.main
    // until it parks the final envelope here, then emit + exit on the main
    // thread (where we still are).
    nonisolated(unsafe) var finalEnvelope: Envelope?

    // One-shot mode has the same isolation contract as daemon mode: establish
    // the dedicated monitor before constructing CommandRouter.
    let inputMonitor = PhysicalInputEpochMonitor()
    _ = inputMonitor.startAndWait()

    let work = Task { @MainActor in
        let envelope: Envelope
        do {
            let cursor = VirtualCursor(headless: true)
            let capabilities = Capabilities(headless: true)
            let router = CommandRouter(
                cursor: cursor,
                capabilities: capabilities,
                inputMonitor: inputMonitor
            )
            let result = try await router.handle(cmd: command, payload: payload)
            envelope = .ok(result)
        } catch let cuError as CUError {
            envelope = .fail(cuError.message, code: cuError.code)
        } catch {
            envelope = .fail(error.localizedDescription, code: "unknown")
        }
        finalEnvelope = envelope
    }

    // Pump the main run loop until the work task has parked its envelope.
    // CFRunLoopRunInMode returns after each input source / timer fires (or the
    // 0.02s window elapses); we re-check the completion flag each pass. This is
    // the canonical "drive an async task to completion from synchronous main"
    // pattern for a CLI that must outlive AppKit/CoreGraphics callbacks without
    // a full NSApplication event loop.
    let pollInterval: CFTimeInterval = 0.02
    while finalEnvelope == nil {
        _ = CFRunLoopRunInMode(CFRunLoopMode.defaultMode, pollInterval, true)
    }

    // The task is done; cancel defensively (no-op if already finished) so we
    // don't leave anything dangling, then emit and exit on the main thread.
    work.cancel()
    inputMonitor.stop()

    if let envelope = finalEnvelope {
        emitEnvelopeAndExit(envelope)
    } else {
        // Unreachable in practice (loop only exits once finalEnvelope is set),
        // but keep stdout non-empty no matter what.
        emitHardFailureAndExit(message: "internal error: no result produced for command \(command)")
    }
}

// MARK: - Entry

/// Only TCC-facing one-shot commands need their own responsible process.
/// `attest_daemon_peer` is intentionally direct: it reads kernel socket
/// credentials and code signatures only, and a disclaim supervisor would make
/// the verifier timeout unable to kill the entire process tree with SIGKILL.
func shouldDisclaimHelper(command: String?) -> Bool {
    guard let command else { return true }
    return command != "daemon"
        && command != "help"
        && command != "--help"
        && command != "-h"
        && command != "attest_daemon_peer"
}

// `@main` is expressed as top-level code here. Argument 0 is the executable
// path; argument 1 selects the mode.
let argv = CommandLine.arguments
let entryCommand = argv.count >= 2 ? argv[1] : nil
let isDaemonMode = entryCommand == "daemon"

// Public, input-free package diagnostic. Resolve and decode exactly the same
// optional assets used by the first visible click, before TCC disclaim, client
// authorization, NSApplication creation, runtime files, or injection cleanup.
// This permits testing a relocated release app with no user permissions/state.
if entryCommand == "--probe-cursor-resources" {
    let resources = VirtualCursor.loadLensSequence()
    let report = JSONValue.object([
        "resourceDirectory": resources.directory.map { .string($0.path) } ?? .null,
        "frameCount": .int(resources.frames?.count ?? 0),
        "proceduralFallback": .bool(resources.frames == nil),
    ])
    do {
        emitLine(try JSONEncoder().encode(report))
        exit(0)
    } catch {
        emitLine(Data("{\"error\":\"cursor resource diagnostic encoding failed\"}".utf8))
        exit(1)
    }
}

// disclaim re-exec — for the BARE-EXEC'd modes only (one-shot CLI + onboarding
// card, which the Electron app spawns directly). It re-execs us once with
// responsibility_spawnattrs_setdisclaim so the process becomes its OWN TCC
// "responsible process" (cu-helper's identity) instead of inheriting the host
// app's, so the permission prompt + attribution use cu-helper. No-ops if already
// disclaimed / the private symbol is missing / the spawn fails.
//
// EXCEPTIONS — the daemon (LaunchServices already gives the standalone helper
// its own TCC identity), public help, and the fd-3 peer verifier. The verifier
// needs no TCC access and must remain a single process so its timeout can reap
// every holder of the inherited daemon socket.
if shouldDisclaimHelper(command: entryCommand) {
    cuhelper_disclaim_reexec(CommandLine.argc, CommandLine.unsafeArgv)
}

if isDaemonMode {
    runDaemonMode(argv: argv)
} else if argv.count >= 2 && (argv[1] == "request-access" || argv[1] == "request_access") {
    guard HelperRuntimeAuthorization.authorizeOneShot(command: argv[1]) else {
        emitEnvelopeAndExit(.fail(
            "Permission setup requires the signed Claude Code Haha desktop app.",
            code: "unauthorized_client"
        ))
    }
    runRequestAccessMode()
} else {
    runCLIMode(argv: argv)
}
