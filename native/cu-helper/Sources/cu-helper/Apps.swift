//
//  Apps.swift
//  cu-helper
//
//  App + clipboard commands, backed by NSWorkspace / NSPasteboard / CGWindowList.
//
//  Parity target: runtime/mac_helper.py (frontmost_app / app_under_point /
//  installed_apps / running_apps / open_app / read_clipboard / write_clipboard /
//  paste_clipboard). The TS result shapes are in
//  src/vendor/computer-use-mcp/executor.ts:
//
//    FrontmostApp / RunningApp = { bundleId, displayName }
//    InstalledApp              = { bundleId, displayName, path, iconDataUrl? }
//
//  ABSOLUTE INJECTION RULE (see Injection.swift): clipboard paste posts cmd+V to
//  a *specific* app process via CGEvent.postToPid — never .cghidEventTap, never a
//  cursor warp. The real OS cursor is never touched anywhere in this file.
//
//  Isolation: NSWorkspace's `frontmostApplication`, `runningApplications`, and
//  `icon(forFile:)` are main-actor-affined AppKit surfaces, so both enums are
//  @MainActor (the contract requires it). CGWindowList / FileManager calls are
//  thread-agnostic but stay on the main actor here for simplicity and because the
//  CommandRouter that drives them is itself @MainActor.
//

import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import UniformTypeIdentifiers

// MARK: - Apps

/// App-introspection and app-launching commands.
///
/// All members are pure/read-only except `open(bundleId:)`, which launches an
/// application via the modern `NSWorkspace.openApplication(at:configuration:)`
/// API (the deprecated `launchApplicationAtURL_options_configuration_error_`
/// that mac_helper.py used is intentionally avoided).
@MainActor
public enum Apps {
    // MARK: frontmost_app

    /// The frontmost (active) application, or `nil` when there is no frontmost
    /// app or it has no bundle identifier (matches mac_helper.frontmost_app).
    public static func frontmost() -> AppRef? {
        guard let app = NSWorkspace.shared.frontmostApplication,
              let bundleId = app.bundleIdentifier, !bundleId.isEmpty
        else { return nil }
        return AppRef(
            bundleId: bundleId,
            displayName: app.localizedName ?? bundleId
        )
    }

    // MARK: app_under_point

    /// The application owning the front-most on-screen window under the given
    /// logical (top-left, global) point. Falls back to `frontmost()` when no
    /// window matches — exactly like mac_helper.app_under_point. Returns `nil`
    /// only when there is no frontmost app either.
    ///
    /// Coordinates are the logical, already-scaled top-left points the TS layer
    /// passes through; they are compared verbatim against `CGWindowBounds`
    /// (which are also top-left, global, in points).
    public static func underPoint(x: Double, y: Double) -> AppRef? {
        let point = CGPoint(x: x, y: y)

        // Map running owner-name -> bundleId. mac_helper keys this map by the
        // app's localizedName (falling back to bundleId), because CGWindowList
        // only exposes the owner *name*, not its bundle id.
        var bundleByOwnerName: [String: String] = [:]
        for app in NSWorkspace.shared.runningApplications {
            guard let bundleId = app.bundleIdentifier, !bundleId.isEmpty else { continue }
            let ownerName = app.localizedName ?? bundleId
            // First writer wins, mirroring the dict-comprehension in Python where
            // a later duplicate name would overwrite — but in practice owner
            // names are unique enough; keep the first to be deterministic.
            if bundleByOwnerName[ownerName] == nil {
                bundleByOwnerName[ownerName] = bundleId
            }
        }

        // `onScreenWindows()` (shared with Displays/Injection) returns layer-0,
        // on-screen, non-degenerate windows in front-to-back z-order — the same
        // filtering mac_helper.list_windows applies. First hit wins.
        for window in Displays.onScreenWindows() where window.bounds.contains(point) {
            let owner = window.ownerName
            guard !owner.isEmpty else { continue }
            if let bundleId = bundleByOwnerName[owner] {
                return AppRef(bundleId: bundleId, displayName: owner)
            }
        }

        return frontmost()
    }

    // MARK: list_installed_apps

    /// All `.app` bundles discovered under the standard application roots,
    /// deduped by bundle identifier and sorted case-insensitively by display
    /// name (matches mac_helper.installed_apps). `iconDataUrl` is populated with
    /// a PNG data URL — the desktop UI renders it (the plan resolves the
    /// latency open-question in favor of including it).
    public static func listInstalled() -> [InstalledApp] {
        var seen = Set<String>()
        return installedTargets().compactMap { target in
            guard seen.insert(target.bundleIdentifier).inserted else {
                return nil
            }
            return InstalledApp(
                    bundleId: target.bundleIdentifier,
                    displayName: target.displayName,
                    path: target.bundleURL.path,
                    iconDataUrl: appIconDataURL(path: target.bundleURL.path)
                )
        }
    }

    /// Installed-app metadata used by `resolve_app_target`. This deliberately
    /// avoids icon rendering: permission preflight must be read-only and fast.
    static func installedTargets() -> [InstalledAppTarget] {
        let fm = FileManager.default
        let home = fm.homeDirectoryForCurrentUser

        // Order matters only for which path "wins" a duplicate bundle id; we
        // keep the FIRST seen, so list user/regular apps before the system ones
        // (mac_helper iterates /Applications, ~/Applications, then /System/...).
        let roots: [URL] = [
            URL(fileURLWithPath: "/Applications", isDirectory: true),
            home.appendingPathComponent("Applications", isDirectory: true),
            URL(fileURLWithPath: "/System/Applications", isDirectory: true),
            URL(fileURLWithPath: "/System/Applications/Utilities", isDirectory: true),
        ]

        var byPath: [String: InstalledAppTarget] = [:]

        for root in roots {
            var isDir: ObjCBool = false
            guard fm.fileExists(atPath: root.path, isDirectory: &isDir), isDir.boolValue else {
                continue
            }
            for appURL in enumerateAppBundles(under: root, fileManager: fm) {
                guard let bundleId = bundleIdentifier(forAppAt: appURL, fileManager: fm),
                      !bundleId.isEmpty
                else { continue }
                let displayName = displayName(forAppAt: appURL, fileManager: fm)
                let standardized = appURL.standardizedFileURL
                byPath[standardized.path] = InstalledAppTarget(
                    bundleIdentifier: bundleId,
                    displayName: displayName,
                    bundleURL: standardized
                )
            }
        }

        return byPath.values.sorted {
            let lhsName = $0.displayName.lowercased()
            let rhsName = $1.displayName.lowercased()
            if lhsName != rhsName { return lhsName < rhsName }
            return $0.bundleURL.path < $1.bundleURL.path
        }
    }

    /// Add the exact Launch Services/path candidate for a selector. This keeps
    /// resolution correct for registered apps outside the standard scan roots
    /// while the pure resolver still performs the final exact/ambiguity check.
    static func installedTargets(
        for selector: AppTargetSelector
    ) -> [InstalledAppTarget] {
        var candidates = installedTargets()
        let directURL: URL?
        switch selector {
        case .pid:
            directURL = nil
        case .bundleIdentifier(let identifier):
            directURL = NSWorkspace.shared.urlForApplication(
                withBundleIdentifier: identifier
            )
        case .app(let identifier):
            if identifier.hasPrefix("/") {
                directURL = URL(fileURLWithPath: identifier)
            } else if let byBundle = NSWorkspace.shared.urlForApplication(
                withBundleIdentifier: identifier
            ) {
                directURL = byBundle
            } else {
                directURL = nil
            }
        }
        if let directURL,
           let direct = installedTarget(at: directURL),
           !candidates.contains(where: {
               $0.bundleURL.standardizedFileURL.path
                    == direct.bundleURL.standardizedFileURL.path
           }) {
            candidates.append(direct)
        }
        return candidates
    }

    // MARK: list_running_apps

    /// Native discovery includes recently used apps even when they are closed.
    /// Approval and exact process authorization are enforced when selecting or
    /// controlling a target, not by making forbidden apps disappear here.
    static func listApps() async throws -> [AppInventoryEntry] {
        let recent = try await RecentAppCatalog.shared.entries()
        let running = NSWorkspace.shared.runningApplications.compactMap { app -> AppRef? in
            guard app.activationPolicy == .regular,
                  let bundleId = app.bundleIdentifier, !bundleId.isEmpty else { return nil }
            return AppRef(bundleId: bundleId, displayName: app.localizedName ?? bundleId)
        }
        return AppInventory.merge(running: running, recent: recent)
    }

    /// Running applications that carry a bundle identifier, deduped and sorted
    /// case-insensitively by display name (matches mac_helper.running_apps).
    public static func listRunning() -> [AppRef] {
        var seen = Set<String>()
        var apps: [AppRef] = []
        for app in NSWorkspace.shared.runningApplications {
            // Only user-facing apps (Dock icon / regular activation). This drops the
            // dozens of background agents (Accessibility Services, *AppAgent,
            // AuthenticationServicesAgent, …) that buried the real targets and left
            // the model unable to find e.g. NeteaseMusic in the list.
            guard app.activationPolicy == .regular else { continue }
            guard let bundleId = app.bundleIdentifier, !bundleId.isEmpty else { continue }
            if !seen.insert(bundleId).inserted { continue }
            apps.append(AppRef(
                bundleId: bundleId,
                displayName: app.localizedName ?? bundleId
            ))
        }
        return apps.sorted { $0.displayName.lowercased() < $1.displayName.lowercased() }
    }

    // MARK: open_app

    /// Launch (or activate) the application with the given bundle identifier.
    ///
    /// Uses the modern async `NSWorkspace.openApplication(at:configuration:)`
    /// (macOS 10.15+) — the deprecated `launchApplicationAtURL...` the Python
    /// helper used is avoided. Throws `CUError("window_not_found", ...)` when no
    /// installed app matches the bundle id (the canonical "target missing" code;
    /// there is no app-specific code in the CUError table, and the bridge only
    /// surfaces the message), and rethrows any launch failure as a CUError.
    public static func open(bundleId: String) async throws {
        let trimmed = bundleId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw CUError("bad_payload", "open_app requires a non-empty bundleId")
        }
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: trimmed) else {
            throw CUError("window_not_found", "App not found for bundle identifier: \(trimmed)")
        }

        let config = NSWorkspace.OpenConfiguration()
        config.activates = true
        // Reuse a running instance rather than spawning a second copy.
        config.createsNewApplicationInstance = false

        do {
            _ = try await NSWorkspace.shared.openApplication(at: url, configuration: config)
        } catch {
            throw CUError(
                "window_not_found",
                "Failed to open app \(trimmed): \(error.localizedDescription)"
            )
        }
    }

    // MARK: icon -> PNG data URL

    /// A `data:image/png;base64,...` URL for the icon of the file/app at `path`,
    /// or `nil` when the icon cannot be rendered/encoded. Sized to a compact
    /// 64×64 so the per-app cost (and the resulting payload) stays small.
    public static func appIconDataURL(path: String) -> String? {
        guard !path.isEmpty, FileManager.default.fileExists(atPath: path) else { return nil }

        let icon = NSWorkspace.shared.icon(forFile: path)
        let target = NSSize(width: 64, height: 64)

        // Render into a fresh, known-size RGBA bitmap. `icon(forFile:)` returns a
        // multi-representation NSImage; drawing it gives us a single, predictable
        // raster to PNG-encode regardless of the source representations.
        guard let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil,
            pixelsWide: Int(target.width),
            pixelsHigh: Int(target.height),
            bitsPerSample: 8,
            samplesPerPixel: 4,
            hasAlpha: true,
            isPlanar: false,
            colorSpaceName: .deviceRGB,
            bytesPerRow: 0,
            bitsPerPixel: 0
        ) else { return nil }
        rep.size = target

        guard let ctx = NSGraphicsContext(bitmapImageRep: rep) else { return nil }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = ctx
        ctx.imageInterpolation = .high
        icon.draw(
            in: NSRect(origin: .zero, size: target),
            from: .zero,
            operation: .copy,
            fraction: 1.0
        )
        NSGraphicsContext.restoreGraphicsState()

        guard let png = rep.representation(using: .png, properties: [:]) else { return nil }
        return "data:image/png;base64,\(png.base64EncodedString())"
    }

    // MARK: - Private install-scan helpers

    /// Enumerate `.app` bundles under `root` without descending *into* any
    /// `.app` (a bundle is a leaf — descending would surface thousands of nested
    /// helper apps inside frameworks, which mac_helper's `rglob("*.app")` would
    /// also match but far more slowly). Symlinks are not followed to avoid
    /// cycles and cross-volume blowups.
    private static func enumerateAppBundles(under root: URL, fileManager fm: FileManager) -> [URL] {
        guard let enumerator = fm.enumerator(
            at: root,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles, .skipsPackageDescendants]
        ) else {
            return []
        }

        var results: [URL] = []
        for case let url as URL in enumerator {
            if url.pathExtension == "app" {
                results.append(url)
                // Do not recurse into the bundle we just matched.
                enumerator.skipDescendants()
            }
        }
        return results
    }

    private static func installedTarget(at rawURL: URL) -> InstalledAppTarget? {
        let url = rawURL.standardizedFileURL
        let fm = FileManager.default
        var isDirectory: ObjCBool = false
        guard url.pathExtension.caseInsensitiveCompare("app") == .orderedSame,
              fm.fileExists(atPath: url.path, isDirectory: &isDirectory),
              isDirectory.boolValue,
              let bundleID = bundleIdentifier(forAppAt: url, fileManager: fm),
              !bundleID.isEmpty else {
            return nil
        }
        return InstalledAppTarget(
            bundleIdentifier: bundleID,
            displayName: displayName(forAppAt: url, fileManager: fm),
            bundleURL: url
        )
    }

    /// Resolve an app bundle's identifier. mac_helper.py reached for the private
    /// `NSWorkspace bundleIdentifierForURL:` selector (only callable because
    /// PyObjC dispatches dynamically — it is NOT a publicly declared API and
    /// will not link from Swift). We use the fully-public, authoritative path
    /// instead: `Bundle(url:)` reads `CFBundleIdentifier` straight off the
    /// bundle, with a raw Info.plist read as the fallback for unusual layouts.
    private static func bundleIdentifier(forAppAt url: URL, fileManager fm: FileManager) -> String? {
        if let bundleId = Bundle(url: url)?.bundleIdentifier, !bundleId.isEmpty {
            return bundleId
        }
        if let plist = infoPlist(forAppAt: url, fileManager: fm),
           let bundleId = plist["CFBundleIdentifier"] as? String, !bundleId.isEmpty {
            return bundleId
        }
        return nil
    }

    /// Best display name for an app bundle: `CFBundleDisplayName`, then
    /// `CFBundleName`, then the file stem — matching mac_helper.
    private static func displayName(forAppAt url: URL, fileManager fm: FileManager) -> String {
        if let plist = infoPlist(forAppAt: url, fileManager: fm) {
            if let name = plist["CFBundleDisplayName"] as? String, !name.isEmpty { return name }
            if let name = plist["CFBundleName"] as? String, !name.isEmpty { return name }
        }
        return url.deletingPathExtension().lastPathComponent
    }

    private static func infoPlist(forAppAt url: URL, fileManager fm: FileManager) -> [String: Any]? {
        let plistURL = url.appendingPathComponent("Contents/Info.plist")
        guard fm.fileExists(atPath: plistURL.path),
              let data = try? Data(contentsOf: plistURL),
              let obj = try? PropertyListSerialization.propertyList(from: data, options: [], format: nil),
              let dict = obj as? [String: Any]
        else { return nil }
        return dict
    }
}

// MARK: - Clipboard

/// Clipboard read/write plus a paste helper. Read/write are TCC-free; paste
/// posts cmd+V to the frontmost app and therefore needs Accessibility (it goes
/// through `Injection.key`, which enforces the trust gate).
@MainActor
public enum Clipboard {
    /// The general pasteboard's string contents, or `""` when empty/unset
    /// (matches mac_helper.read_clipboard, which never returns null).
    public static func read() -> String {
        NSPasteboard.general.string(forType: .string) ?? ""
    }

    /// Replace the general pasteboard contents with `text`
    /// (clearContents + setString, matching mac_helper.write_clipboard).
    public static func write(_ text: String) {
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(text, forType: .string)
    }

    /// Post cmd+V to the frontmost application (mac_helper pastes via an
    /// AppleScript keystroke; we go through the unified CGEvent.postToPid path
    /// in Injection instead). Throws `CUError("not_trusted", ...)` when
    /// Accessibility has not been granted.
    public static func paste() async throws {
        try await Injection.key("cmd+v", repeat: 1)
    }

    static func paste(target: ProvenProcessTarget) async throws {
        try await Injection.key(
            "cmd+v",
            repeat: 1,
            target: target
        )
    }
}
