export type WorkspaceShortcutAction =
  | 'quick-open-file'
  | 'new-browser-tab'
  | 'toggle-bottom-panel'
  | 'toggle-terminal'
  | 'new-terminal'
  | 'toggle-workspace'
  | 'toggle-fullscreen'
  | 'open-review'
  | 'close-tab'
  | 'reopen-closed-tab'
  | 'next-tab'
  | 'previous-tab'

export type WorkspaceKeyEvent = {
  key: string
  code?: string
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
}

/**
 * Where the keystroke happened. A global handler that fires regardless of focus
 * is how a browser page loses `Cmd+F` to the app and how a terminal stops being
 * able to send `Ctrl+\``. Native content keeps its own keys.
 */
export type WorkspaceFocusContext = 'chat' | 'file' | 'review' | 'browser' | 'terminal' | 'other'

/**
 * Keys that belong to whatever is focused rather than to the app.
 *
 * `close-tab` is the interesting one: `Cmd+W` in a terminal is a perfectly
 * normal thing to type at a shell, and stealing it would make the terminal
 * unusable for anyone who uses readline's word-erase. A terminal is closed from
 * its tab, not from the keyboard.
 */
const CONTEXT_RESERVED: Partial<Record<WorkspaceFocusContext, ReadonlySet<WorkspaceShortcutAction>>> = {
  terminal: new Set<WorkspaceShortcutAction>(['close-tab', 'new-terminal']),
}

function isPrimaryModifier(event: WorkspaceKeyEvent, platform: 'mac' | 'other') {
  return platform === 'mac' ? event.metaKey : event.ctrlKey
}

/**
 * Match a keystroke to a workspace action, or `null` when the keystroke is not
 * ours. Pure so the mapping can be tested without a DOM.
 */
export function matchWorkspaceShortcut(
  event: WorkspaceKeyEvent,
  options: { platform: 'mac' | 'other'; context: WorkspaceFocusContext },
): WorkspaceShortcutAction | null {
  const primary = isPrimaryModifier(event, options.platform)
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key
  // Ctrl+J sends a newline at the shell, including on macOS.
  if (options.context === 'terminal' && event.ctrlKey && !event.metaKey && key === 'j') return null
  let action: WorkspaceShortcutAction | null = null

  // `Ctrl+\`` everywhere, including on macOS: it is the terminal key users
  // already know from other editors, and Cmd+` is taken by window cycling.
  if (event.ctrlKey && !event.metaKey && !event.altKey && (key === '`' || event.code === 'Backquote')) {
    action = event.shiftKey ? 'new-terminal' : 'toggle-terminal'
  } else if (event.ctrlKey && event.shiftKey && !event.metaKey && key === 'g') {
    action = 'open-review'
  } else if (primary && !event.ctrlKey && event.altKey && !event.shiftKey && (key === 'b' || event.code === 'KeyB') && options.platform === 'mac') {
    action = 'toggle-workspace'
  } else if (primary && event.shiftKey && !event.altKey && key === 'b') {
    action = 'toggle-workspace'
  } else if (primary && event.shiftKey && !event.altKey && key === 'f') {
    action = 'toggle-fullscreen'
  } else if (primary && event.shiftKey && !event.altKey && key === 't') {
    action = 'reopen-closed-tab'
  } else if (primary && !event.shiftKey && !event.altKey && key === 'p') {
    action = 'quick-open-file'
  } else if (primary && !event.shiftKey && !event.altKey && key === 't') {
    action = 'new-browser-tab'
  } else if (primary && !event.shiftKey && !event.altKey && key === 'j') {
    action = 'toggle-bottom-panel'
  } else if (primary && !event.shiftKey && !event.altKey && key === 'w') {
    action = 'close-tab'
  } else if (event.ctrlKey && !event.metaKey && !event.altKey && key === 'Tab') {
    action = event.shiftKey ? 'previous-tab' : 'next-tab'
  }

  if (!action) return null
  if (CONTEXT_RESERVED[options.context]?.has(action)) return null
  return action
}

/** Display form for the launcher and menus; matches the platform's own habits. */
export function formatWorkspaceShortcut(
  action: WorkspaceShortcutAction,
  platform: 'mac' | 'other',
): string | null {
  const primary = platform === 'mac' ? '⌘' : 'Ctrl+'
  const shift = platform === 'mac' ? '⇧' : 'Shift+'
  const ctrl = platform === 'mac' ? '⌃' : 'Ctrl+'
  switch (action) {
    case 'quick-open-file':
      return `${primary}P`
    case 'new-browser-tab':
      return `${primary}T`
    case 'toggle-terminal':
      return `${ctrl}\``
    case 'toggle-bottom-panel':
      return `${primary}J`
    case 'open-review':
      return `${ctrl}${shift}G`
    case 'toggle-workspace':
      return platform === 'mac' ? '⌥⌘B' : `${primary}${shift}B`
    case 'toggle-fullscreen':
      return `${primary}${shift}F`
    default:
      return null
  }
}

export function detectPlatform(): 'mac' | 'other' {
  if (typeof navigator === 'undefined') return 'other'
  const value = `${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`
  return /mac/i.test(value) ? 'mac' : 'other'
}
