/**
 * Key combos that cross app boundaries or terminate processes. Gated behind
 * the `systemKeyCombos` grant flag. When that flag is off, the `key` tool
 * rejects these and returns a tool error telling the model to request the
 * flag; all other combos work normally.
 *
 * Matching is canonicalized: every modifier alias the Rust executor accepts
 * collapses to one canonical name. Without this, `command+q` / `meta+q` /
 * `cmd+alt+escape` bypass the gate — see keyBlocklist.test.ts for the three
 * bypass forms and the Rust parity check that catches future alias drift.
 */

/**
 * Every modifier alias enigo_wrap.rs accepts (two copies: :351-359, :564-572),
 * mapped to one canonical per Key:: variant. Left/right variants collapse —
 * the blocklist doesn't distinguish which Ctrl.
 *
 * Canonical names are Rust's own variant names lowercased. Blocklist entries
 * below use ONLY these. "meta" reads odd for Cmd+Q but it's honest: Rust
 * sends Key::Meta, which is Cmd on darwin and Win on win32.
 */
const CANONICAL_MODIFIER: Readonly<Record<string, string>> = {
  // Key::Meta — "meta"|"super"|"command"|"cmd"|"windows"|"win"
  meta: "meta",
  meta_l: 'meta',
  meta_r: 'meta',
  super: "meta",
  super_l: 'meta',
  super_r: 'meta',
  command: "meta",
  cmd: "meta",
  windows: "meta",
  win: "meta",
  // Key::Control + LControl + RControl
  ctrl: "ctrl",
  control: "ctrl",
  control_l: 'ctrl',
  control_r: 'ctrl',
  lctrl: "ctrl",
  lcontrol: "ctrl",
  rctrl: "ctrl",
  rcontrol: "ctrl",
  // Key::Shift + LShift + RShift
  shift: "shift",
  shift_l: 'shift',
  shift_r: 'shift',
  lshift: "shift",
  rshift: "shift",
  // Key::Alt and Key::Option — distinct Rust variants but same keycode on
  // darwin (kVK_Option). Collapse: cmd+alt+escape and cmd+option+escape
  // both Force Quit.
  alt: "alt",
  alt_l: 'alt',
  alt_r: 'alt',
  option: "alt",
  opt: "alt",
};

/**
 * Non-modifier key aliases. Same purpose as CANONICAL_MODIFIER: a blocklist
 * entry names one spelling, but callers reach the same physical key by several.
 * `cmd+opt+esc` and `cmd+option+escape` are the same Force Quit chord.
 *
 * `backspace` is deliberately NOT mapped to `delete` — on Windows they are
 * different keys, and Ctrl+Alt+Backspace is not the Secure Attention Sequence.
 */
const CANONICAL_KEY: Readonly<Record<string, string>> = {
  esc: "escape",
  spacebar: "space",
  del: "delete",
  forwarddelete: "delete",
  forward_delete: "delete",
  deletef: "delete",
};

/** Sort order for canonicals. ctrl < alt < shift < meta. */
const MODIFIER_ORDER = ["ctrl", "alt", "shift", "meta"];

/**
 * Canonical-form entries only. Every modifier must be a CANONICAL_MODIFIER
 * *value* (not key), modifiers must be in MODIFIER_ORDER, non-modifier last.
 * The self-consistency test enforces this.
 */
const BLOCKED_DARWIN = new Set([
  "meta+q", // Cmd+Q — quit frontmost app
  "shift+meta+q", // Cmd+Shift+Q — log out
  "alt+meta+escape", // Cmd+Option+Esc — Force Quit dialog
  "meta+tab", // Cmd+Tab — app switcher
  "meta+space", // Cmd+Space — Spotlight
  "ctrl+meta+q", // Ctrl+Cmd+Q — lock screen
]);

const BLOCKED_WIN32 = new Set([
  "ctrl+alt+delete", // Secure Attention Sequence
  "alt+f4", // close window
  "alt+tab", // window switcher
  "meta+l", // Win+L — lock
  "meta+d", // Win+D — show desktop
]);

/**
 * Partition into sorted-canonical modifiers and non-modifier keys.
 * Shared by normalizeKeySequence (join for display) and isSystemKeyCombo
 * (check mods+each-key to catch the cmd+q+a suffix bypass).
 */
function partitionKeys(seq: string): { mods: string[]; keys: string[] } {
  const parts = seq
    .toLowerCase()
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  const mods: string[] = [];
  const keys: string[] = [];
  for (const p of parts) {
    const canonical = CANONICAL_MODIFIER[p];
    if (canonical !== undefined) {
      mods.push(canonical);
    } else {
      keys.push(CANONICAL_KEY[p] ?? p);
    }
  }
  // Dedupe: "cmd+command+q" → "meta+q", not "meta+meta+q".
  const uniqueMods = [...new Set(mods)];
  uniqueMods.sort(
    (a, b) => MODIFIER_ORDER.indexOf(a) - MODIFIER_ORDER.indexOf(b),
  );
  return { mods: uniqueMods, keys };
}

/**
 * Normalize "Cmd + Shift + Q" → "shift+meta+q": lowercase, trim, alias →
 * canonical, dedupe, sort modifiers, non-modifiers last.
 */
export function normalizeKeySequence(seq: string): string {
  const { mods, keys } = partitionKeys(seq);
  return [...mods, ...keys].join("+");
}

/**
 * True if the sequence would fire a blocked OS shortcut.
 *
 * Checks mods + EACH non-modifier key individually, not just the full
 * joined string. `cmd+q+a` → Rust presses Cmd, then Q (Cmd+Q fires here),
 * then A. Exact-match against "meta+q+a" misses; checking "meta+q" and
 * "meta+a" separately catches the Q.
 *
 * Modifiers-only sequences ("cmd+shift") are checked as-is — no key to
 * pair with, and no blocklist entry is modifier-only, so this is a no-op
 * that falls through to false. Covers the click-modifier case where
 * `left_click(text="cmd")` is legitimate.
 */
/** A blocklist entry split into the modifiers it needs and the key it fires. */
interface BlockedChord {
  mods: string[];
  key: string;
}

/** Parse the canonical-form blocklist strings once, at module load. */
function parseBlocklist(entries: ReadonlySet<string>): BlockedChord[] {
  const chords: BlockedChord[] = [];
  for (const entry of entries) {
    const { mods, keys } = partitionKeys(entry);
    // Every entry is "<mods…>+<one key>"; a modifier-only entry has no chord
    // to fire and is skipped rather than silently matching everything.
    if (keys.length === 1) chords.push({ mods, key: keys[0] });
  }
  return chords;
}

const BLOCKED_DARWIN_CHORDS = parseBlocklist(BLOCKED_DARWIN);
const BLOCKED_WIN32_CHORDS = parseBlocklist(BLOCKED_WIN32);

/**
 * Split a request into the chords it will actually press.
 *
 * Two spellings collide here and both must work:
 *   "cmd + q"                    → ONE chord (spaces padding a `+`)
 *   "super+a cmd+opt+esc ctrl+v" → THREE chords (spaces separating them)
 *
 * Collapsing whitespace around `+` first disambiguates them: after that, any
 * remaining whitespace is a chord separator.
 */
function splitChords(seq: string): string[] {
  return seq
    .replace(/\s*\+\s*/g, "+")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * True if the sequence would fire a blocked OS shortcut.
 *
 * Matching is by SUBSET, not equality: a blocked chord fires whenever its
 * modifiers are all held and its key is pressed, regardless of what else is
 * held. `shift+cmd+tab` still switches apps, so `meta+tab` must catch it —
 * exact-matching "shift+meta+tab" against the blocklist would let the extra
 * modifier walk straight through the gate.
 *
 * Each non-modifier key is checked separately for the same reason: `cmd+q+a`
 * presses Cmd, then Q (Cmd+Q fires right there), then A.
 *
 * A modifiers-only sequence ("cmd+shift", e.g. click modifiers) has no key to
 * pair with and falls through to false.
 */
export function isSystemKeyCombo(
  seq: string,
  platform: "darwin" | "win32",
): boolean {
  const blocklist =
    platform === "darwin" ? BLOCKED_DARWIN_CHORDS : BLOCKED_WIN32_CHORDS;

  for (const chord of splitChords(seq)) {
    const { mods, keys } = partitionKeys(chord);
    if (keys.length === 0) continue;
    const held = new Set(mods);
    for (const blocked of blocklist) {
      if (!blocked.mods.every((mod) => held.has(mod))) continue;
      if (keys.includes(blocked.key)) return true;
    }
  }
  return false;
}

export const _test = {
  CANONICAL_MODIFIER,
  BLOCKED_DARWIN,
  BLOCKED_WIN32,
  MODIFIER_ORDER,
};
