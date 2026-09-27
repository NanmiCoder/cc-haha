export function createScenePlayback({ start, stop, draw }) {
  const state = {
    ready: false,
    visible: true,
    hidden: false,
    paused: false,
    reduced: false
  }
  let live = false
  let disposed = false

  const canDraw = () => state.ready && state.visible && !state.hidden

  function invalidate() {
    if (!disposed && !live && canDraw()) draw()
  }

  function update(partial) {
    if (disposed) return

    let changed = false
    for (const key of Object.keys(state)) {
      if (Object.hasOwn(partial, key) && state[key] !== partial[key]) {
        state[key] = partial[key]
        changed = true
      }
    }
    if (!changed) return

    const shouldRun = canDraw() && !state.paused && !state.reduced
    if (shouldRun !== live) {
      live = shouldRun
      if (live) start()
      else stop()
    }
    invalidate()
  }

  function dispose() {
    if (disposed) return
    disposed = true
    if (live) {
      live = false
      stop()
    }
  }

  return { update, invalidate, dispose }
}
