import { matchesChord, modifierOfCode, type VoiceShortcut } from './shortcut'

/**
 * Shorter than this is a tap (start, and keep recording until the next press);
 * longer is hold-to-talk (stop on release).
 */
export const HOLD_THRESHOLD_MS = 300

export type ShortcutGestureActions = {
  /** A dictation is running, however it was started; the next press ends it. */
  isActive: () => boolean
  start: () => void
  /** End the recording and transcribe it. */
  stop: () => void
  /** Drop the recording without transcribing it. */
  cancel: () => void
}

type KeyInput = Pick<KeyboardEvent, 'code' | 'repeat' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>

type GestureState =
  /** Nothing of ours is pressed. */
  | 'idle'
  /** A lone modifier is down: a tap, a hold, or the start of a combination. */
  | 'armed'
  /** A lone modifier was held past the threshold; recording until release. */
  | 'holding'
  /** The chord is down and recording started on the press. */
  | 'pressed'
  /** The press stopped a dictation; its release must not start another. */
  | 'swallow'

/**
 * Turns presses of the dictation shortcut into start/stop calls.
 *
 * A lone modifier only starts once it is known not to be part of a
 * combination: on release (a tap), or after being held alone past the
 * threshold. That keeps ordinary right-Ctrl/Option combinations from opening
 * the microphone. A chord is unambiguous, so it starts on the press.
 */
export class ShortcutGesture {
  private state: GestureState = 'idle'
  private pressedAt = 0
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly shortcut: VoiceShortcut,
    private readonly actions: ShortcutGestureActions,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Whether a press of ours is in progress (keyup/blur still need to come here). */
  get engaged(): boolean {
    return this.state !== 'idle'
  }

  /** Returns true when the key belongs to the shortcut and its default should be prevented. */
  keyDown(event: KeyInput): boolean {
    const { shortcut } = this
    if (shortcut.kind === 'modifier') {
      if (event.code !== shortcut.code) {
        this.interrupt()
        return false
      }
      if (event.repeat) return false
      if (this.actions.isActive()) {
        this.actions.stop()
        this.state = 'swallow'
        return false
      }
      this.clearTimer()
      this.state = 'armed'
      this.pressedAt = this.now()
      this.timer = setTimeout(() => {
        this.timer = null
        if (this.state !== 'armed') return
        this.state = 'holding'
        this.actions.start()
      }, HOLD_THRESHOLD_MS)
      return false
    }

    if (!matchesChord(shortcut, event)) return false
    if (event.repeat) return true
    if (this.actions.isActive()) {
      this.actions.stop()
      this.state = 'swallow'
      return true
    }
    this.state = 'pressed'
    this.pressedAt = this.now()
    this.actions.start()
    return true
  }

  keyUp(event: Pick<KeyboardEvent, 'code'>): void {
    if (!this.releases(event.code)) return
    const held = this.now() - this.pressedAt
    const state = this.state
    this.reset()
    if (state === 'armed') this.actions.start()
    else if (state === 'holding') this.actions.stop()
    // A short chord press latches like a tap: recording runs until the next press.
    else if (state === 'pressed' && held >= HOLD_THRESHOLD_MS) this.actions.stop()
  }

  /** Focus left the window mid-press; its release will never arrive. */
  blur(): void {
    const state = this.state
    const held = this.now() - this.pressedAt
    this.reset()
    if (state === 'holding' || (state === 'pressed' && held >= HOLD_THRESHOLD_MS)) this.actions.stop()
  }

  /** A click while a lone modifier is down is a modifier-click, not dictation. */
  pointerDown(): void {
    this.interrupt()
  }

  reset(): void {
    this.clearTimer()
    this.state = 'idle'
  }

  private interrupt(): void {
    if (this.state === 'armed') {
      this.reset()
    } else if (this.state === 'holding') {
      this.reset()
      this.actions.cancel()
    }
  }

  private releases(code: string): boolean {
    if (this.state === 'idle') return false
    const { shortcut } = this
    if (shortcut.kind === 'modifier') return code === shortcut.code
    if (code === shortcut.code) return true
    const modifier = modifierOfCode(code)
    return modifier !== null && shortcut.modifiers.includes(modifier)
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}
