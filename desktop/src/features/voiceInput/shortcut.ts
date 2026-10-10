import { getAppZoomKeyboardAction } from '@/lib/appZoom'
import { matchWorkspaceShortcut } from '@/lib/workspace/shortcuts'

export type ShortcutPlatform = 'mac' | 'windows' | 'linux'

export type ShortcutModifier = 'ctrl' | 'alt' | 'shift' | 'meta'

export const SOLO_MODIFIER_CODES = [
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'ShiftLeft',
  'ShiftRight',
  'MetaLeft',
  'MetaRight',
] as const

export type SoloModifierCode = typeof SOLO_MODIFIER_CODES[number]

/**
 * A dictation shortcut, by physical key (`KeyboardEvent.code`) so it means the
 * same key under every keyboard layout and input method.
 *
 * `modifier` is one modifier pressed on its own; tapping or holding it never
 * collides with a combination, because pressing anything else with it turns
 * the press back into an ordinary combination. `chord` is modifiers plus one
 * other key.
 */
export type VoiceShortcut =
  | { kind: 'modifier'; code: SoloModifierCode }
  | { kind: 'chord'; modifiers: ShortcutModifier[]; code: string }

/**
 * Right Option on macOS, right Ctrl elsewhere. Right Alt is left alone off the
 * Mac: many European layouts make it AltGr, the key for typing special
 * characters.
 */
export function defaultVoiceShortcut(platform: ShortcutPlatform): VoiceShortcut {
  // Shared objects: store selectors return this, and a fresh one every call
  // would re-render their subscribers forever.
  return DEFAULT_SHORTCUTS[platform]
}

const DEFAULT_SHORTCUTS: Record<ShortcutPlatform, VoiceShortcut> = {
  mac: { kind: 'modifier', code: 'AltRight' },
  windows: { kind: 'modifier', code: 'ControlRight' },
  linux: { kind: 'modifier', code: 'ControlRight' },
}

export function detectShortcutPlatform(): ShortcutPlatform {
  if (typeof navigator === 'undefined') return 'linux'
  const value = `${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`
  if (/mac/i.test(value)) return 'mac'
  if (/win/i.test(value)) return 'windows'
  return 'linux'
}

const MODIFIER_ORDER: ShortcutModifier[] = ['ctrl', 'alt', 'shift', 'meta']

export function isSoloModifierCode(code: string): code is SoloModifierCode {
  return (SOLO_MODIFIER_CODES as readonly string[]).includes(code)
}

/** Every modifier key, including the ones a shortcut can never be made of. */
export function isModifierCode(code: string): boolean {
  return isSoloModifierCode(code) || code === 'CapsLock' || code === 'Fn' || code === 'FnLock' || code === 'OSLeft' || code === 'OSRight'
}

type ModifierState = Pick<KeyboardEvent, 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>

export function modifiersOf(event: ModifierState): ShortcutModifier[] {
  return MODIFIER_ORDER.filter(modifier => event[`${modifier}Key` as const])
}

/** The chord a key press makes, or null for a modifier on its own. */
export function chordFromKeyEvent(event: ModifierState & Pick<KeyboardEvent, 'code'>): VoiceShortcut | null {
  if (!event.code || isModifierCode(event.code)) return null
  return { kind: 'chord', modifiers: modifiersOf(event), code: event.code }
}

export function matchesChord(shortcut: VoiceShortcut, event: ModifierState & Pick<KeyboardEvent, 'code'>): boolean {
  if (shortcut.kind !== 'chord' || event.code !== shortcut.code) return false
  const held = modifiersOf(event)
  return held.length === shortcut.modifiers.length && held.every(modifier => shortcut.modifiers.includes(modifier))
}

/** The modifier flag a modifier key sets, so releasing it can end a chord. */
export function modifierOfCode(code: string): ShortcutModifier | null {
  if (code.startsWith('Control')) return 'ctrl'
  if (code.startsWith('Alt')) return 'alt'
  if (code.startsWith('Shift')) return 'shift'
  if (code.startsWith('Meta') || code.startsWith('OS')) return 'meta'
  return null
}

export function sameShortcut(a: VoiceShortcut | null, b: VoiceShortcut | null): boolean {
  if (!a || !b) return a === b
  if (a.kind === 'modifier' || b.kind === 'modifier') return a.kind === b.kind && a.code === b.code
  return a.code === b.code && a.modifiers.length === b.modifiers.length && a.modifiers.every(modifier => b.modifiers.includes(modifier))
}

/** Reads a stored shortcut; anything malformed is `null` so the default applies. */
export function parseVoiceShortcut(value: unknown): VoiceShortcut | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (record.kind === 'modifier') {
    return typeof record.code === 'string' && isSoloModifierCode(record.code)
      ? { kind: 'modifier', code: record.code }
      : null
  }
  if (record.kind === 'chord') {
    if (typeof record.code !== 'string' || !record.code || isModifierCode(record.code)) return null
    if (!Array.isArray(record.modifiers)) return null
    const modifiers = MODIFIER_ORDER.filter(modifier => (record.modifiers as unknown[]).includes(modifier))
    if (modifiers.length !== record.modifiers.length) return null
    return { kind: 'chord', modifiers, code: record.code }
  }
  return null
}

// ─── Labels ──────────────────────────────────────────────────────────────

export type ShortcutKeyLabel = { text: string; side?: 'left' | 'right' }

const MODIFIER_GLYPHS: Record<ShortcutPlatform, Record<ShortcutModifier, string>> = {
  mac: { ctrl: '⌃', alt: '⌥', shift: '⇧', meta: '⌘' },
  windows: { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Win' },
  linux: { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Super' },
}

const CODE_LABELS: Record<string, string> = {
  Space: 'Space',
  Enter: 'Enter',
  Tab: 'Tab',
  Escape: 'Esc',
  Backspace: '⌫',
  Delete: 'Del',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
}

function codeLabel(code: string): string {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit\d$/.test(code)) return code.slice(5)
  if (/^Numpad\d$/.test(code)) return `Num${code.slice(6)}`
  return CODE_LABELS[code] ?? code
}

/** Keycaps in the platform's own order (⌃⌥⇧⌘ on the Mac, Ctrl Alt Shift Win elsewhere). */
export function shortcutKeyLabels(shortcut: VoiceShortcut, platform: ShortcutPlatform): ShortcutKeyLabel[] {
  const glyphs = MODIFIER_GLYPHS[platform]
  if (shortcut.kind === 'modifier') {
    const modifier = modifierOfCode(shortcut.code) ?? 'ctrl'
    return [{ text: glyphs[modifier], side: shortcut.code.endsWith('Right') ? 'right' : 'left' }]
  }
  return [
    ...shortcut.modifiers.map(modifier => ({ text: glyphs[modifier] })),
    { text: codeLabel(shortcut.code) },
  ]
}

// ─── Conflicts ───────────────────────────────────────────────────────────

/** Doubles as the suffix of the `voice.settings.shortcut.reason.*` translation keys. */
export type ShortcutConflictReason =
  | 'typing'
  | 'editing'
  | 'app'
  | 'system'
  | 'unsupported'
  | 'inputMethod'
  | 'altGr'
  | 'launcher'
  | 'menuBar'
  | 'desktopShortcut'

/**
 * `blocked` keys are refused: cc-haha's own shortcuts, the system's, and keys
 * that would eat ordinary typing. `warning` keys are known to be taken by input
 * methods, layouts or common tools on some machines, so they may never reach
 * cc-haha; the user can still keep them.
 */
export type ShortcutVerdict =
  | { level: 'ok' }
  | { level: 'blocked' | 'warning'; reason: ShortcutConflictReason }

const OK: ShortcutVerdict = { level: 'ok' }
const blocked = (reason: ShortcutConflictReason): ShortcutVerdict => ({ level: 'blocked', reason })
const warning = (reason: ShortcutConflictReason): ShortcutVerdict => ({ level: 'warning', reason })

type ChordRule = { modifiers: ShortcutModifier[]; code: string | RegExp; verdict: ShortcutVerdict }

const rule = (modifiers: ShortcutModifier[], code: string | RegExp, verdict: ShortcutVerdict): ChordRule =>
  ({ modifiers, code, verdict })

const SYSTEM_CHORDS: Record<ShortcutPlatform, ChordRule[]> = {
  mac: [
    rule(['meta'], 'Space', blocked('system')), // Spotlight
    rule(['ctrl', 'meta'], 'Space', blocked('system')), // Emoji & Symbols
    rule(['shift', 'meta'], /^Digit[3-6]$/, blocked('system')), // screenshots
    rule(['meta'], /^(Tab|Backquote|KeyQ|KeyH|KeyM)$/, blocked('system')),
    rule(['alt', 'meta'], /^(Escape|KeyH|KeyM)$/, blocked('system')),
    rule(['ctrl', 'meta'], 'KeyQ', blocked('system')), // lock screen
    rule(['ctrl'], 'Space', warning('inputMethod')),
    rule(['ctrl', 'alt'], 'Space', warning('inputMethod')),
    rule(['alt'], 'Space', warning('launcher')),
  ],
  windows: [
    rule(['alt'], /^(Tab|F4|Space|Escape)$/, blocked('system')),
    rule(['ctrl', 'shift'], 'Escape', blocked('system')), // Task Manager
    rule(['ctrl', 'alt'], 'Delete', blocked('system')),
    rule(['ctrl'], 'Space', warning('inputMethod')),
    rule(['shift'], 'Space', warning('inputMethod')),
  ],
  linux: [
    rule(['alt'], /^(Tab|F1|F2|F4|Space|Backquote)$/, blocked('system')),
    rule(['ctrl', 'alt'], /^(KeyT|Delete|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Backspace)$/, blocked('system')),
    rule(['meta'], 'Space', blocked('system')), // GNOME input source switch
    rule(['ctrl'], 'Space', warning('inputMethod')),
    rule(['shift'], 'Space', warning('inputMethod')),
  ],
}

function ruleMatches(candidate: ChordRule, shortcut: { modifiers: ShortcutModifier[]; code: string }): boolean {
  if (candidate.modifiers.length !== shortcut.modifiers.length) return false
  if (!candidate.modifiers.every(modifier => shortcut.modifiers.includes(modifier))) return false
  return typeof candidate.code === 'string' ? candidate.code === shortcut.code : candidate.code.test(shortcut.code)
}

const KEY_FOR_CODE: Record<string, string> = {
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
}

/** The `key` a US layout would report, for feeding cc-haha's own matchers. */
function keyForCode(code: string): string {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase()
  if (/^Digit\d$/.test(code)) return code.slice(5)
  return KEY_FOR_CODE[code] ?? code
}

/**
 * cc-haha's own shortcuts. The workspace and zoom keys come from the matchers
 * that handle them, so adding one there is caught here without a second list.
 */
function isAppShortcut(shortcut: { modifiers: ShortcutModifier[]; code: string }, platform: ShortcutPlatform): boolean {
  const event = {
    key: keyForCode(shortcut.code),
    code: shortcut.code,
    ctrlKey: shortcut.modifiers.includes('ctrl'),
    altKey: shortcut.modifiers.includes('alt'),
    shiftKey: shortcut.modifiers.includes('shift'),
    metaKey: shortcut.modifiers.includes('meta'),
  }
  if (matchWorkspaceShortcut(event, { platform: platform === 'mac' ? 'mac' : 'other', context: 'chat' })) return true
  if (getAppZoomKeyboardAction(event, platform === 'mac' ? 'MacIntel' : 'Win32')) return true

  const primary: ShortcutModifier = platform === 'mac' ? 'meta' : 'ctrl'
  const only = (...modifiers: ShortcutModifier[]) =>
    shortcut.modifiers.length === modifiers.length && modifiers.every(modifier => shortcut.modifiers.includes(modifier))
  // useKeyboardShortcuts: new session, search, find, stop; the menu's Settings.
  if (only(primary) && /^(KeyN|KeyK|KeyF|Period|Comma)$/.test(shortcut.code)) return true
  if (platform === 'mac' && only('ctrl', 'meta') && shortcut.code === 'KeyF') return true // full screen
  if (platform !== 'mac' && only() && shortcut.code === 'F11') return true // full screen
  return false
}

const TEXT_KEYS = /^(Key[A-Z]|Digit\d|Numpad\d|Space|Enter|NumpadEnter|Tab|Backspace|Delete|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash|IntlBackslash|IntlRo|IntlYen)$/
const CARET_KEYS = /^(Arrow(Up|Down|Left|Right)|Home|End|PageUp|PageDown)$/

function classifyModifier(code: SoloModifierCode, platform: ShortcutPlatform): ShortcutVerdict {
  if (code === 'ShiftLeft' || code === 'ShiftRight') return warning('inputMethod')
  if (code === 'MetaLeft' || code === 'MetaRight') return platform === 'mac' ? OK : blocked('system')
  if (code === 'AltRight' && platform !== 'mac') return warning('altGr')
  if (code === 'AltLeft' && platform === 'windows') return warning('menuBar')
  return OK
}

function classifyChord(shortcut: { modifiers: ShortcutModifier[]; code: string }, platform: ShortcutPlatform): ShortcutVerdict {
  const { modifiers, code } = shortcut
  const has = (modifier: ShortcutModifier) => modifiers.includes(modifier)
  const primary: ShortcutModifier = platform === 'mac' ? 'meta' : 'ctrl'

  // Esc cancels a recording and closes overlays; Enter, Tab and Backspace are
  // the composer's own keys under every modifier.
  if (/^(Escape|Enter|NumpadEnter|Tab|Backspace)$/.test(code) && !(platform !== 'mac' && code === 'Tab' && has('alt'))) {
    return modifiers.length === 0 || (modifiers.length === 1 && has('shift')) ? blocked('typing') : blocked('editing')
  }
  if (isAppShortcut(shortcut, platform)) return blocked('app')

  for (const candidate of SYSTEM_CHORDS[platform]) {
    if (ruleMatches(candidate, shortcut)) return candidate.verdict
  }

  const isFunctionKey = /^F([1-9]|1\d|2[0-4])$/.test(code)
  if (!isFunctionKey) {
    // Typed characters: bare, shifted, or (on the Mac) Option-composed.
    if (modifiers.every(modifier => modifier === 'shift')) return blocked('typing')
    if (platform === 'mac' && modifiers.every(modifier => modifier === 'shift' || modifier === 'alt') && TEXT_KEYS.test(code)) {
      return blocked('typing')
    }
    if (CARET_KEYS.test(code) && modifiers.every(modifier => modifier === 'shift' || modifier === 'alt' || modifier === primary)) {
      return blocked('editing')
    }
  }
  // Copy, paste, cut, undo, redo, select all.
  if (has(primary) && /^Key[ACVXZY]$/.test(code) && modifiers.every(modifier => modifier === primary || modifier === 'shift')) {
    return blocked('editing')
  }
  // macOS text fields take Emacs-style ⌃ letters (⌃A, ⌃E, ⌃K…).
  if (platform === 'mac' && modifiers.length === 1 && has('ctrl') && /^Key[A-Z]$/.test(code)) return blocked('editing')

  if (platform === 'windows' && has('meta')) return blocked('system')
  if (platform === 'linux' && has('meta')) return warning('desktopShortcut')
  if (platform !== 'mac' && has('ctrl') && has('alt')) return warning('altGr')
  if (platform === 'windows' && modifiers.length === 1 && has('alt')) return warning('menuBar')
  return OK
}

export function classifyVoiceShortcut(shortcut: VoiceShortcut, platform: ShortcutPlatform): ShortcutVerdict {
  if (shortcut.kind === 'modifier') return classifyModifier(shortcut.code, platform)
  if (isModifierCode(shortcut.code)) return blocked('unsupported')
  return classifyChord(shortcut, platform)
}
