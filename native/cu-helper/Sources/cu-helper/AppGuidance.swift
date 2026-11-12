// AppGuidance.swift — per-app Computer Use guidance for cu-helper.
//
// Two responsibilities, both keyed off the target app's bundle identifier:
//
//   1. `frameReliability(bundleId:)` — a coarse classifier returning
//      "high" | "medium" | "low". It tells the actuation layer how much it can
//      trust an element's reported on-screen frame (its global Quartz rect).
//      Native AppKit apps report pixel-accurate frames (high); Electron / custom
//      WebKit-drawn shells (Slack, Discord, WeChat, Feishu/Lark) frequently
//      report stale or zeroed frames (low), so coordinate clicks and the virtual
//      cursor anchor should defer to AX-index actuation and pasteboard input.
//
//   2. `instructions(bundleId:)` — returns the inner body of the
//      `<app_specific_instructions>` block that CommandRouter folds into
//      `AXTree.Result.appInstructions`, which the TS MCP server injects on the
//      first get_app_state of a session for that app (returns nil when we have
//      nothing app-specific to say, so the block is omitted entirely).
//
// IP note: the instruction *format* (H2 title / H3 topics / <Key> chord
// notation / friendly element ids / parallel-call encouragement) is the
// interop convention Codex established, but every word below is original to
// this project — none of it is copied from any reference corpus.
//
// @MainActor: matches the cu-helper AX contract (every AX-touching enum is
// main-actor isolated). These two entry points are pure string lookups today,
// but staying on the main actor keeps the door open for future snapshot-aware
// heuristics without re-annotating call sites.

import Foundation

@MainActor
public enum AppGuidance {

    // MARK: - Frame reliability

    /// Coarse trust level for an element's reported global frame.
    ///
    /// - "high": native AppKit apps (Finder, System Settings, Notes, Mail,
    ///   Numbers, Music, …) report pixel-accurate frames. Coordinate fallbacks
    ///   and the virtual-cursor anchor can rely on them.
    /// - "medium": browsers and JetBrains-family IDEs expose a real AX tree but
    ///   mix in large web/canvas surfaces whose frames drift across navigation
    ///   or rendering passes. Prefer index actuation; treat frames as hints.
    /// - "low": Electron and other custom-drawn shells (Slack, Discord, VS Code,
    ///   WeChat, Feishu/Lark, …) frequently report stale, zeroed, or
    ///   window-origin frames. Avoid coordinate clicks; favour AX-index
    ///   actuation, pasteboard text injection, and anchoring the virtual cursor
    ///   to the window centre rather than a claimed element rect.
    ///
    /// Returns "high" for an unknown / nil bundle id: unknown apps are assumed
    /// native until proven otherwise, which keeps the default actuation path
    /// (index first, coordinates as fallback) intact.
    public static func frameReliability(bundleId: String?) -> String {
        switch classify(bundleId: bundleId) {
        case .browser, .jetbrains:
            return "medium"
        case .electron:
            return "low"
        case .finder, .native:
            return "high"
        }
    }

    // MARK: - App-specific instructions

    /// The inner body of `<app_specific_instructions>` for `bundleId`, or nil
    /// when we have nothing app-specific to add (the caller then omits the
    /// block). Bundle-id matching is case-insensitive.
    public static func instructions(bundleId: String?) -> String? {
        guard let id = bundleId?.lowercased(), !id.isEmpty else { return nil }

        // Exact native-app matches first.
        if id == "com.apple.safari" || id == "com.apple.safaritechnologypreview" {
            return safariInstructions
        }
        if id == "com.apple.finder" {
            return finderInstructions
        }

        // Generic Electron / custom-shell guidance for the apps our classifier
        // recognises as Electron-like. These share the same input quirks, so a
        // single profile covers them well.
        if classify(bundleId: bundleId) == .electron {
            return electronInstructions
        }

        return nil
    }

    // MARK: - Classification

    enum Profile {
        case browser
        case finder
        case jetbrains
        case electron
        case native
    }

    /// Buckets a bundle id into a coarse app profile. Order matters: Finder is
    /// checked before the generic Apple-native fallthrough, and the Electron
    /// markers are checked before `.native` so custom shells that happen to ship
    /// an AppKit-looking bundle id still land in `.electron`.
    static func classify(bundleId: String?) -> Profile {
        guard let id = bundleId?.lowercased(), !id.isEmpty else {
            // No bundle id (e.g. frontmost-by-pid with a stripped binary):
            // assume native so the standard index-first path applies.
            return .native
        }

        if id == "com.apple.finder" {
            return .finder
        }
        if isBrowser(id) {
            return .browser
        }
        if isElectronLike(id) {
            return .electron
        }
        if isJetBrains(id) {
            return .jetbrains
        }
        return .native
    }

    private static func isBrowser(_ id: String) -> Bool {
        // Apple, Chromium family, Gecko, and the common WebKit/Chromium wrappers.
        // (Chromium-based browsers are still browsers, not "Electron apps" — the
        // page AX tree is rich, so frame reliability is medium, not low.)
        if id.hasPrefix("com.apple.safari") { return true }
        let exact: Set<String> = [
            "com.google.chrome",
            "com.google.chrome.canary",
            "com.google.chrome.beta",
            "com.chromium.chromium",
            "com.microsoft.edgemac",
            "com.microsoft.edgemac.beta",
            "org.mozilla.firefox",
            "org.mozilla.firefoxdeveloperedition",
            "org.mozilla.nightly",
            "com.brave.browser",
            "com.brave.browser.beta",
            "com.operasoftware.opera",
            "com.vivaldi.vivaldi",
            "company.thebrowser.browser", // Arc
            "ai.perplexity.comet",
            "com.kagi.kagimacos",         // Orion
        ]
        return exact.contains(id)
    }

    private static func isJetBrains(_ id: String) -> Bool {
        // JetBrains ships every IDE under com.jetbrains.* / com.google.android.studio.
        return id.contains("jetbrains")
            || id == "com.google.android.studio"
    }

    private static func isElectronLike(_ id: String) -> Bool {
        // Substring markers covering Electron apps and other custom-drawn shells
        // (WeChat / Feishu / Lark render their own surfaces and are just as
        // frame-unreliable). VS Code is Electron despite its "microsoft" vendor
        // prefix, so it is matched explicitly.
        let exact: Set<String> = [
            "com.microsoft.vscode",
            "com.microsoft.vscodeinsiders",
            "com.vscodium",
            "com.todesktop.230313mzl4w4u92", // Cursor
            "com.exafunction.windsurf",
            "md.obsidian",
            "com.figma.desktop",
            "com.postmanlabs.mac",
            "com.tinyspeck.slackmacgap",     // Slack
        ]
        if exact.contains(id) { return true }

        let markers = [
            "electron",
            "slack",
            "discord",
            "notion",
            // Chinese CEF clients: custom-drawn shells whose accessibility tree
            // is window chrome only. NetEase Music is the app this whole
            // shell-tree path was debugged against, and it was falling through
            // to `.native` — which reports frame reliability "high" (wrong) and
            // hands the model no app guidance at all.
            "netease",
            "163music",
            "kugou",
            "kuwo",
            "qqmusic",
            "tencent.qqmusic",
            "spotify",      // desktop Spotify is a custom CEF shell
            "wechat",       // WeChat
            "wework",       // WeCom
            "wexin",
            "tencent.xinwen",
            "feishu",       // Feishu
            "lark",         // Lark (international Feishu)
            "dingtalk",     // DingTalk
            "qq",           // QQ / TIM custom shells
            "linear",
            "1password",    // Electron rewrite
            "github.desktop",
        ]
        return markers.contains(where: { id.contains($0) })
    }

    // MARK: - Instruction bodies (original content)

    /// Safari — a browser shell wrapping a web AX tree.
    private static let safariInstructions = """
    ## Safari Computer Use

    ### Orienting

    The toolbar (address field, reload, tab strip, back/forward) is reliable \
    native chrome. The page itself is a `web area` whose elements come and go as \
    the page renders, so re-run get_app_state after any navigation, page load, \
    or in-page action before trusting indices.

    ### Navigating

    Drive the address field rather than clicking links by coordinate. Focus it \
    with <cmd+l>, then `set_value` the destination — the field submits on its \
    own once focused, so you do not need a separate Return in most cases.

    Use <cmd+f> to find on-page text, <cmd+r> to reload, <cmd+t> for a new tab, \
    <cmd+w> to close one, and <cmd+shift+]> / <cmd+shift+[> to step through open \
    tabs. Prefer these chords over hunting for the matching toolbar button.

    ### Working with the page

    Click links and buttons by their element index, not by coordinate — the \
    page frame can shift between snapshots. When a link element renders as \
    `[label](url)`, clicking it follows the link.

    For long pages, scroll the `web area` by pages and re-snapshot after a big \
    jump; only a window's worth of content is described at a time. If a control \
    you expect is missing, the page may still be loading — re-run get_app_state \
    before changing approach instead of retrying the same click.

    ### Forms

    Use `set_value` on text fields when the field reports it is settable; that \
    is faster and more reliable than typing key by key. Use parallel tool calls \
    to fill several independent fields in one turn, then submit.
    """

    /// Finder — a native AppKit app with strong AX coverage.
    private static let finderInstructions = """
    ## Finder Computer Use

    ### Selecting and opening items

    Sidebar entries and file rows are `row` elements. Selecting a row highlights \
    it; opening a folder or file takes a double click. After you open a folder \
    the visible file list is replaced, so re-run get_app_state before acting on \
    the new contents — the old indices no longer apply.

    Favourites, tags, and locations in the sidebar are also rows. Prefer \
    selecting them by index over clicking a coordinate in the sidebar.

    ### Navigating the hierarchy

    Use <cmd+shift+g> to open the "Go to Folder" sheet and `set_value` an \
    absolute path when tree navigation is noisy or the target is deep — this is \
    usually faster than expanding folders one level at a time. Use <cmd+up> to \
    go to the enclosing folder and <cmd+down> to open the selection.

    Switch view modes with <cmd+1> (icon), <cmd+2> (list), <cmd+3> (column), \
    and <cmd+4> (gallery). List and column views expose the cleanest row tree \
    for selection.

    ### Sheets and dialogs

    Open/Save panels and rename sheets appear as their own window and replace \
    the main Finder tree in the snapshot. When one is up, act on the sheet's \
    elements; do not assume the underlying window's indices are still valid.

    ### File operations

    Standard chords apply once items are selected: <cmd+c> / <cmd+v> to copy and \
    paste, <cmd+delete> to move to Trash, <Return> to rename, <space> for Quick \
    Look. Re-snapshot after any operation that changes the listing.
    """

    /// Generic Electron / custom-shell apps (Slack, Discord, VS Code, WeChat,
    /// Feishu/Lark, …) — partial AX coverage and unreliable frames.
    private static let electronInstructions = """
    ## Custom-Shell App Computer Use

    This app draws its own interface (Electron or a similar custom renderer), so \
    its Accessibility tree is partial and reported element frames are often \
    stale or wrong. Work index-first and lean on keyboard shortcuts.

    ### What is and isn't visible

    Window chrome, the menu bar, and top-level navigation are usually present in \
    the tree, but the main content area — message lists, editors, chat panes — \
    may be missing or sparse. Run get_app_state often; only a slice of the UI is \
    described at any moment, and what you need may appear only after you focus \
    or scroll the right region.

    ### Acting reliably

    Prefer element index WHILE the tree still describes real controls — a \
    reported frame may point at the wrong place. But when get_app_state shows \
    only the window frame and menu bar, element handles cannot reach the \
    content at all: read the screenshot and pass explicit x and y. \
    When an action seems to do nothing, re-run get_app_state before retrying: \
    the change may have landed even though the tree had not yet refreshed. Do \
    not repeat a handle that already reported success without changing anything.

    Reach for keyboard chords first: <cmd+k> commonly opens a command or quick \
    switcher, <cmd+f> searches, and the app's own shortcuts are more dependable \
    than locating a button in a thin tree.

    ### Entering text

    Custom input fields can mangle character-by-character key injection. Prefer \
    `set_value` when the field reports it is settable; otherwise focus the field \
    first, then type. For longer text, paste-style entry is more reliable than \
    long key sequences. Send one line per turn and use parallel tool calls when \
    several independent fields need filling.
    """
}
