import { existsSync } from 'node:fs'
import type { App } from 'electron'

export type PackagedSmokeEnv = {
  CC_HAHA_ELECTRON_PACKAGED_SMOKE_QUIT_FILE?: string
}

type TimerHandle = ReturnType<typeof setInterval> & { unref?: () => void }

export function installPackagedSmokeQuitWatcher(
  app: Pick<App, 'quit'>,
  env: PackagedSmokeEnv = process.env,
  deps: {
    existsSyncFn?: typeof existsSync
    setIntervalFn?: typeof setInterval
    clearIntervalFn?: typeof clearInterval
  } = {},
): () => void {
  const quitFile = env.CC_HAHA_ELECTRON_PACKAGED_SMOKE_QUIT_FILE?.trim()
  if (!quitFile) return () => undefined

  const exists = deps.existsSyncFn ?? existsSync
  const setTimer = deps.setIntervalFn ?? setInterval
  const clearTimer = deps.clearIntervalFn ?? clearInterval
  let active = true
  const timer = setTimer(() => {
    if (!active || !exists(quitFile)) return
    active = false
    clearTimer(timer)
    app.quit()
  }, 100) as TimerHandle
  timer.unref?.()

  return () => {
    if (!active) return
    active = false
    clearTimer(timer)
  }
}
