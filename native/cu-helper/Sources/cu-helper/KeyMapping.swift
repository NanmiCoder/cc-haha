//
//  KeyMapping.swift
//  cu-helper
//
//  xdotool-style key-sequence parsing for the native Computer Use helper's
//  `press_key` tool. This is the single source of truth for turning a Codex
//  `key` string (e.g. "super+c", "cmd+shift+a", "Return", "Page_Up", "KP_0",
//  "shift+Return") into the `(keyCode, flags)` chord(s) that AXAction.pressKey
//  posts with `CGEvent.postToPid`.
//
//  ──────────────────────────────────────────────────────────────────────────
//  CONTRACT (from docs/features/computer-use-codex-impl-blueprint.md §4):
//
//    public enum KeyMapping {                       // NON-@MainActor, pure
//      public struct Chord: Sendable {
//        public let keyCode: CGKeyCode
//        public let flags: CGEventFlags
//      }
//      public static func parse(_ sequence: String) throws -> [Chord]
//    }
//
//  Modifier vocabulary (xdotool + mac_helper aliases):
//    super / cmd / command / meta / win  → .maskCommand
//    ctrl / control                      → .maskControl
//    shift                               → .maskShift
//    alt / option / opt                  → .maskAlternate
//    fn                                  → .maskSecondaryFn
//
//  Named keys resolve via the Carbon `kVK_*` table; a single printable
//  character resolves via a reverse `UCKeyTranslate` over the CURRENT keyboard
//  layout (so layout-specific punctuation maps to the right physical key).
//  Anything that resolves to neither throws `CUError("unknown_key", …)`.
//  ──────────────────────────────────────────────────────────────────────────
//
//  WHY THIS IS SEPARATE FROM `KeySym` (in Injection.swift):
//    `KeySym` is the legacy single-chord parser bound into `Injection`'s
//    own `key`/`holdKey`/`type` verbs and returns a flat `(flags, keyCode)`.
//    The new AXAction-based injection gradient consumes `KeyMapping.Chord`
//    instead, supports multi-chord sequences (space-separated), and lives off
//    the main actor so the daemon can pre-parse a request on its IO queue
//    before hopping to @MainActor to post. The two intentionally do NOT share
//    a type name to avoid a symbol clash while both exist.
//
//  IP NOTE: written from scratch against the Carbon kVK_* constants and the
//  blueprint contract. The xdotool keysym aliasing is an interop convention
//  (the wire vocabulary Codex emits), not copied source.
//

import Carbon.HIToolbox
import CoreGraphics
import Foundation

/// Pure (non-`@MainActor`) parser from xdotool-style key strings to the
/// `(keyCode, flags)` chords the injection layer posts. Stateless apart from
/// the immutable lookup tables; every method is a free function over its input.
public enum KeyMapping {

    // MARK: - Chord

    /// One key press: a virtual keycode plus the modifier flags held during it.
    /// A `press_key` sequence parses to one chord (the common case, e.g.
    /// "super+c") or several (a space-separated macro, e.g. "ctrl+c ctrl+v").
    public struct Chord: Sendable, Equatable {
        /// The physical virtual keycode of the non-modifier key.
        public let keyCode: CGKeyCode
        /// The combined `CGEventFlags` of every modifier in the chord (empty
        /// for a bare key like "Return").
        public let flags: CGEventFlags
        /// Layout-independent semantic key token used by native safety policy.
        /// Named-key aliases collapse here (`esc` -> `escape`, `spacebar` ->
        /// `space`) while `keyCode` remains the physical injection value.
        public let semanticKey: String

        public init(
            keyCode: CGKeyCode,
            flags: CGEventFlags,
            semanticKey: String = ""
        ) {
            self.keyCode = keyCode
            self.flags = flags
            self.semanticKey = semanticKey
        }
    }

    // MARK: - Public API

    /// Parse a full xdotool-style key sequence into an ordered list of chords.
    ///
    /// A sequence is split on whitespace into one or more *chords*; each chord
    /// is split on `+` where every token but the last is a modifier and the
    /// last is the key. Examples:
    ///   - `"super+c"`            → `[⌘C]`
    ///   - `"cmd+shift+a"`        → `[⌘⇧A]`
    ///   - `"Return"`             → `[↩]`
    ///   - `"KP_0"`               → `[keypad-0]`
    ///   - `"shift+Return"`       → `[⇧↩]`
    ///   - `"ctrl+c ctrl+v"`      → `[⌃C, ⌃V]`  (two chords)
    ///
    /// - Throws: `CUError("unknown_key", …)` if the sequence is empty, a chord
    ///   has no key token, a modifier token is unrecognized, or the key token
    ///   maps to no keycode via the named table or the current layout.
    public static func parse(_ sequence: String) throws -> [Chord] {
        // xdotool separates successive key events with whitespace; a single
        // chord uses `+` between modifiers and the key. We honor both so a
        // macro like "ctrl+c ctrl+v" yields two chords.
        let normalized = sequence.replacingOccurrences(
            of: #"\s*\+\s*"#,
            with: "+",
            options: .regularExpression
        )
        let chordTokens = normalized
            .split(whereSeparator: { $0 == " " || $0 == "\t" || $0 == "\n" })
            .map(String.init)

        guard !chordTokens.isEmpty else {
            throw CUError(CUError.Code.unknownKey, "Empty key sequence.")
        }

        return try chordTokens.map(parseChord(_:))
    }

    /// Parse a single chord (`"cmd+shift+a"`, `"Return"`). Every token but the
    /// last contributes a modifier flag; the last is the key. A trailing `+`
    /// or stray empty token is ignored so `"cmd+"` is treated as a malformed
    /// chord with no key (and throws) rather than silently succeeding.
    public static func parseChord(_ chord: String) throws -> Chord {
        let tokens = chord
            .split(separator: "+", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }

        guard let keyToken = tokens.last else {
            throw CUError(CUError.Code.unknownKey, "Empty key chord in sequence: \"\(chord)\".")
        }

        var flags: CGEventFlags = []
        for token in tokens.dropLast() {
            guard let flag = modifierFlag(for: token) else {
                // A non-modifier before the final token is malformed (e.g.
                // "a+b"): surface it rather than silently dropping the token.
                throw CUError(
                    CUError.Code.unknownKey,
                    "Unexpected modifier token \"\(token)\" in key chord: \"\(chord)\"."
                )
            }
            flags.insert(flag)
        }

        let keyCode = try keyCode(for: keyToken)
        // XKeysym names denote the resulting key, including the modifier
        // required to produce it. The official macOS receiver gets Shift for
        // both `A` and `question`; dropping it changes the requested input.
        if shiftedNamedKeys.contains(keyToken.lowercased()) {
            flags.insert(.maskShift)
        } else if keyToken.count == 1, let character = keyToken.first,
                  let mapping = characterMapping(character) {
            flags.formUnion(mapping.flags)
        }
        return Chord(
            keyCode: keyCode,
            flags: flags,
            semanticKey: semanticKey(for: keyToken)
        )
    }

    /// Resolve a single non-modifier key token to a virtual keycode.
    ///
    /// Resolution order:
    ///   1. The named table (`Return`, `Tab`, arrows, `Page_Up`/`Prior`,
    ///      `KP_0`, `F1`…`F12`, punctuation keysyms…), matched case-insensitively.
    ///   2. A single printable character, reverse-mapped through
    ///      `UCKeyTranslate` on the CURRENT keyboard layout (so `;`, `=`, `é`
    ///      land on the right physical key whatever the layout).
    ///
    /// - Throws: `CUError("unknown_key", …)` when neither path resolves.
    public static func keyCode(for token: String) throws -> CGKeyCode {
        let trimmed = token.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else {
            throw CUError(CUError.Code.unknownKey, "Empty key token.")
        }

        // 1. Named / special keys (case-insensitive against the alias table).
        if let code = namedKeys[trimmed.lowercased()] {
            return code
        }

        // 2. Single printable character → reverse layout lookup. Try the token
        //    verbatim first (preserves a shifted glyph like "?"), then its
        //    lowercased form (covers "A" when the layout only maps "a").
        if trimmed.count == 1, let ch = trimmed.first, let code = keyCodeForCharacter(ch) {
            return code
        }
        let lowered = trimmed.lowercased()
        if lowered.count == 1, let ch = lowered.first, let code = keyCodeForCharacter(ch) {
            return code
        }

        throw CUError(CUError.Code.unknownKey, "Unsupported key: \"\(token)\".")
    }

    // MARK: - Modifiers

    /// Map a modifier token to its `CGEventFlags` bit, or `nil` if the token is
    /// not a modifier. Matches the xdotool + mac_helper alias vocabulary.
    public static func modifierFlag(for token: String) -> CGEventFlags? {
        switch token.lowercased() {
        case "super", "super_l", "super_r", "cmd", "command", "meta", "meta_l", "meta_r", "win":
            return .maskCommand
        case "ctrl", "control", "control_l", "control_r":
            return .maskControl
        case "shift", "shift_l", "shift_r":
            return .maskShift
        case "alt", "alt_l", "alt_r", "option", "opt":
            return .maskAlternate
        case "fn":
            return .maskSecondaryFn
        default:
            return nil
        }
    }

    private static func semanticKey(for token: String) -> String {
        switch token.trimmingCharacters(in: .whitespaces).lowercased() {
        case "esc": return "escape"
        case "spacebar": return "space"
        default: return token.trimmingCharacters(in: .whitespaces).lowercased()
        }
    }

    // MARK: - Named key table

    /// Named, non-printable / special keys → virtual keycode, stored lowercased
    /// (lookups lowercase first). Carries both the X11/xdotool spelling Codex
    /// emits (`Return`, `Prior`, `Page_Up`, `BackSpace`, `KP_0`) and the
    /// mac_helper spelling (`enter`, `pageup`, `backspace`) so either resolves.
    /// Built once; the `kVK_*` constants come from Carbon.HIToolbox.
    static let namedKeys: [String: CGKeyCode] = {
        var t: [String: CGKeyCode] = [:]
        func put(_ code: Int, _ names: String...) {
            for n in names { t[n.lowercased()] = CGKeyCode(code) }
        }

        // ── Editing / whitespace ──────────────────────────────────────────
        put(kVK_Return, "return", "enter")
        put(kVK_Tab, "tab")
        put(kVK_Space, "space", "spacebar")
        put(kVK_Escape, "escape", "esc")
        // kVK_Delete is the Backspace (delete-left) key in Carbon naming.
        put(kVK_Delete, "backspace", "back_space")
        put(kVK_ForwardDelete, "delete", "forwarddelete", "forward_delete", "del", "deletef")

        // ── Navigation ────────────────────────────────────────────────────
        put(kVK_UpArrow, "up", "uparrow", "up_arrow")
        put(kVK_DownArrow, "down", "downarrow", "down_arrow")
        put(kVK_LeftArrow, "left", "leftarrow", "left_arrow")
        put(kVK_RightArrow, "right", "rightarrow", "right_arrow")
        put(kVK_Home, "home", "begin")
        put(kVK_End, "end")
        // xdotool: Prior == Page_Up, Next == Page_Down. Codex emits both.
        put(kVK_PageUp, "prior", "page_up", "pageup")
        put(kVK_PageDown, "next", "page_down", "pagedown")

        // ── Locks / misc ──────────────────────────────────────────────────
        put(kVK_CapsLock, "capslock", "caps_lock")
        // macOS has no dedicated Insert; xdotool "Insert" maps to Help/fn-Help.
        put(kVK_Help, "help", "insert")

        // ── Function keys (F1–F20) ────────────────────────────────────────
        put(kVK_F1, "f1");   put(kVK_F2, "f2");   put(kVK_F3, "f3");   put(kVK_F4, "f4")
        put(kVK_F5, "f5");   put(kVK_F6, "f6");   put(kVK_F7, "f7");   put(kVK_F8, "f8")
        put(kVK_F9, "f9");   put(kVK_F10, "f10"); put(kVK_F11, "f11"); put(kVK_F12, "f12")
        put(kVK_F13, "f13"); put(kVK_F14, "f14"); put(kVK_F15, "f15"); put(kVK_F16, "f16")
        put(kVK_F17, "f17"); put(kVK_F18, "f18"); put(kVK_F19, "f19"); put(kVK_F20, "f20")

        // ── Keypad (xdotool KP_* spellings + numeric/aliases) ─────────────
        put(kVK_ANSI_Keypad0, "kp_0", "kp0", "kp_insert")
        put(kVK_ANSI_Keypad1, "kp_1", "kp1", "kp_end")
        put(kVK_ANSI_Keypad2, "kp_2", "kp2", "kp_down")
        put(kVK_ANSI_Keypad3, "kp_3", "kp3", "kp_next", "kp_page_down")
        put(kVK_ANSI_Keypad4, "kp_4", "kp4", "kp_left")
        put(kVK_ANSI_Keypad5, "kp_5", "kp5", "kp_begin")
        put(kVK_ANSI_Keypad6, "kp_6", "kp6", "kp_right")
        put(kVK_ANSI_Keypad7, "kp_7", "kp7", "kp_home")
        put(kVK_ANSI_Keypad8, "kp_8", "kp8", "kp_up")
        put(kVK_ANSI_Keypad9, "kp_9", "kp9", "kp_prior", "kp_page_up")
        put(kVK_ANSI_KeypadDecimal, "kp_decimal", "kp_separator", "kp_delete")
        put(kVK_ANSI_KeypadPlus, "kp_add", "kp_plus")
        put(kVK_ANSI_KeypadMinus, "kp_subtract", "kp_minus")
        put(kVK_ANSI_KeypadMultiply, "kp_multiply")
        put(kVK_ANSI_KeypadDivide, "kp_divide")
        put(kVK_ANSI_KeypadEquals, "kp_equal")
        put(kVK_ANSI_KeypadEnter, "kp_enter")
        put(kVK_ANSI_KeypadClear, "kp_clear", "clear", "num_lock")

        // ── Punctuation keysyms (xdotool names → ANSI physical keys) ──────
        // These let a model address a physical key by name regardless of the
        // active layout; single-char tokens still go through the layout
        // reverse-map first, this is the fallback alias surface.
        put(kVK_ANSI_Grave, "grave", "quoteleft", "asciitilde")
        put(kVK_ANSI_Minus, "minus", "underscore")
        put(kVK_ANSI_Equal, "equal", "plus")
        put(kVK_ANSI_LeftBracket, "bracketleft", "braceleft")
        put(kVK_ANSI_RightBracket, "bracketright", "braceright")
        put(kVK_ANSI_Backslash, "backslash", "bar")
        put(kVK_ANSI_Semicolon, "semicolon", "colon")
        put(kVK_ANSI_Quote, "apostrophe", "quoteright", "quotedbl")
        put(kVK_ANSI_Comma, "comma", "less")
        put(kVK_ANSI_Period, "period", "greater")
        put(kVK_ANSI_Slash, "slash", "question")
        put(kVK_ANSI_1, "exclam")
        put(kVK_ANSI_2, "at")
        put(kVK_ANSI_3, "numbersign")
        put(kVK_ANSI_4, "dollar")
        put(kVK_ANSI_5, "percent")
        put(kVK_ANSI_6, "asciicircum")
        put(kVK_ANSI_7, "ampersand")
        put(kVK_ANSI_8, "asterisk")
        put(kVK_ANSI_9, "parenleft")
        put(kVK_ANSI_0, "parenright")

        return t
    }()

    private static let shiftedNamedKeys: Set<String> = [
        "asciitilde", "underscore", "plus", "braceleft", "braceright",
        "bar", "colon", "quotedbl", "less", "greater", "question",
        "exclam", "at", "numbersign", "dollar", "percent", "asciicircum",
        "ampersand", "asterisk", "parenleft", "parenright",
    ]

    // MARK: - Layout reverse-map

    /// Reverse-map a single character to the physical keycode that produces it
    /// on the CURRENT keyboard layout. Walks every virtual keycode under the
    /// plausible modifier combinations (none / shift / option / shift+option)
    /// and translates via `UCKeyTranslate`, returning the first keycode whose
    /// output equals `ch`. Returns `nil` for characters not reachable on the
    /// active layout (the caller then throws `unknown_key`).
    ///
    /// Callers needing a physical code use this compatibility wrapper. Chord
    /// parsing also keeps the layout modifiers from `characterMapping`.
    static func keyCodeForCharacter(_ ch: Character) -> CGKeyCode? {
        characterMapping(ch)?.keyCode
    }

    private static func characterMapping(_ ch: Character) -> (keyCode: CGKeyCode, flags: CGEventFlags)? {
        guard
            let inputSource = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
            let layoutPtr = TISGetInputSourceProperty(inputSource, kTISPropertyUnicodeKeyLayoutData)
        else {
            return nil
        }
        let layoutData = unsafeBitCast(layoutPtr, to: CFData.self)
        guard let bytes = CFDataGetBytePtr(layoutData) else { return nil }
        let kbType = UInt32(LMGetKbdType())

        let target = String(ch)
        // UCKeyTranslate wants the Carbon modifier bits shifted right by 8.
        let modifierStates: [UInt32] = [
            0,
            UInt32(shiftKey >> 8),
            UInt32(optionKey >> 8),
            UInt32((shiftKey | optionKey) >> 8),
        ]

        // Rebind the raw layout bytes to `UCKeyboardLayout` for the scope of
        // the lookup rather than an unchecked top-level `unsafeBitCast` (which
        // the compiler flags as potential UB under strict concurrency).
        return bytes.withMemoryRebound(to: UCKeyboardLayout.self, capacity: 1) { keyLayout in
            for vk in 0..<UInt16(128) {
                for mod in modifierStates {
                    var deadKeyState: UInt32 = 0
                    var chars = [UniChar](repeating: 0, count: 4)
                    var length = 0
                    let status = UCKeyTranslate(
                        keyLayout,
                        vk,
                        UInt16(kUCKeyActionDown),
                        mod,
                        kbType,
                        OptionBits(kUCKeyTranslateNoDeadKeysBit),
                        &deadKeyState,
                        chars.count,
                        &length,
                        &chars
                    )
                    if status == noErr, length > 0 {
                        let produced = String(utf16CodeUnits: chars, count: length)
                        if produced == target {
                            var flags: CGEventFlags = []
                            if mod & UInt32(shiftKey >> 8) != 0 { flags.insert(.maskShift) }
                            if mod & UInt32(optionKey >> 8) != 0 { flags.insert(.maskAlternate) }
                            return (CGKeyCode(vk), flags)
                        }
                    }
                }
            }
            return nil
        }
    }
}
