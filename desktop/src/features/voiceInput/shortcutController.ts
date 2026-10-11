import { isDesktopRuntime } from '@/lib/desktopRuntime'
import { selectVoiceInputReady, useVoiceInputStore } from '@/stores/voiceInputStore'
import { isVoiceCaptureSupported } from './recorder'
import { ShortcutGesture } from './shortcutGesture'
import { selectActiveVoiceShortcut, useVoiceShortcutStore } from './shortcutPreference'
import type { VoiceShortcut } from './shortcut'

/** A composer the dictation shortcut can record into. */
export type DictationTarget = {
  hasFocus: () => boolean
  isActive: () => boolean
  start: () => void
  stop: () => void
  cancel: () => void
}

type Entry = { target: DictationTarget; focusedAt: number }

const entries: Entry[] = []
let focusClock = 0
let suspended = 0
let gesture: ShortcutGesture | null = null
let gestureShortcut: VoiceShortcut | null = null
/** The composer the current press started or stopped, so its release goes there too. */
let engaged: DictationTarget | null = null
let unsubscribePreference: (() => void) | null = null

function canStartDictation(): boolean {
  return isDesktopRuntime() && isVoiceCaptureSupported() && selectVoiceInputReady(useVoiceInputStore.getState())
}

/**
 * Where a new dictation goes: the composer holding focus, else the one focused
 * last (the main chat after the user clicked into the transcript), else the
 * newest.
 */
function pickTarget(): DictationTarget | null {
  const focused = entries.find(entry => entry.target.hasFocus())
  if (focused) return focused.target
  let best: Entry | null = null
  for (const entry of entries) {
    if (!best || entry.focusedAt >= best.focusedAt) best = entry
  }
  return best?.target ?? null
}

function activeTarget(): DictationTarget | null {
  return entries.find(entry => entry.target.isActive())?.target ?? null
}

const actions = {
  isActive: () => activeTarget() !== null,
  start: () => {
    const target = pickTarget()
    engaged = target
    target?.start()
  },
  stop: () => {
    const target = activeTarget() ?? engaged
    engaged = target
    target?.stop()
  },
  cancel: () => {
    const target = engaged ?? activeTarget()
    engaged = null
    target?.cancel()
  },
}

function currentGesture(): ShortcutGesture | null {
  const shortcut = selectActiveVoiceShortcut(useVoiceShortcutStore.getState())
  if (shortcut !== gestureShortcut) {
    gesture?.reset()
    gestureShortcut = shortcut
    gesture = shortcut ? new ShortcutGesture(shortcut, actions) : null
  }
  return gesture
}

function isEditable(element: Element | null): boolean {
  if (!element) return false
  if (element instanceof HTMLElement && element.isContentEditable) return true
  return element.matches('input, textarea, select') || element.closest('.xterm') !== null
}

/**
 * A press only starts dictation where it cannot be meant for something else:
 * not while an input method is composing, not while another text field, a
 * terminal or a dialog has focus.
 */
function pressIsForUs(event: KeyboardEvent): boolean {
  if (suspended > 0 || event.isComposing) return false
  const focus = document.activeElement
  if (focus?.closest('[role="dialog"], [aria-modal="true"]')) return false
  if (isEditable(focus) && !entries.some(entry => entry.target.hasFocus())) return false
  return true
}

function onKeyDown(event: KeyboardEvent): void {
  const current = currentGesture()
  if (!current) return
  // Mid-press keys always go to the gesture, so a combination can disarm it.
  if (!current.engaged && !(pressIsForUs(event) && (canStartDictation() || actions.isActive()))) return
  if (current.keyDown(event)) {
    event.preventDefault()
    event.stopPropagation()
  }
}

function onKeyUp(event: KeyboardEvent): void {
  gesture?.keyUp(event)
}

function onBlur(): void {
  gesture?.blur()
}

function onPointerDown(): void {
  gesture?.pointerDown()
}

function onFocusIn(): void {
  for (const entry of entries) {
    if (entry.target.hasFocus()) entry.focusedAt = ++focusClock
  }
}

function install(): void {
  window.addEventListener('keydown', onKeyDown, true)
  window.addEventListener('keyup', onKeyUp, true)
  window.addEventListener('blur', onBlur)
  window.addEventListener('pointerdown', onPointerDown, true)
  document.addEventListener('focusin', onFocusIn)
  // A changed or disabled shortcut must not leave a half-finished press behind.
  unsubscribePreference = useVoiceShortcutStore.subscribe(() => { currentGesture() })
}

function uninstall(): void {
  window.removeEventListener('keydown', onKeyDown, true)
  window.removeEventListener('keyup', onKeyUp, true)
  window.removeEventListener('blur', onBlur)
  window.removeEventListener('pointerdown', onPointerDown, true)
  document.removeEventListener('focusin', onFocusIn)
  unsubscribePreference?.()
  unsubscribePreference = null
  gesture?.reset()
  gesture = null
  gestureShortcut = null
  engaged = null
}

/** Listens for the shortcut only while some composer can take dictation. */
export function registerDictationTarget(target: DictationTarget): () => void {
  const entry: Entry = { target, focusedAt: ++focusClock }
  entries.push(entry)
  if (entries.length === 1) install()
  return () => {
    const index = entries.indexOf(entry)
    if (index === -1) return
    entries.splice(index, 1)
    if (engaged === target) engaged = null
    if (entries.length === 0) uninstall()
  }
}

/** While recording a new shortcut in Settings, presses must not dictate. */
export function suspendVoiceShortcut(): () => void {
  suspended += 1
  gesture?.reset()
  let released = false
  return () => {
    if (released) return
    released = true
    suspended -= 1
  }
}
