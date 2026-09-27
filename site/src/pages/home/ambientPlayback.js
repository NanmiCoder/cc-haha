/**
 * Coordinates the asynchronous HTMLMediaElement.play() request with overlapping
 * visibility and user preferences. Native `playing` is the only success signal.
 * @param {{ media: Pick<HTMLMediaElement, 'play' | 'pause' | 'paused'>, onPlaybackChange: (playing: boolean) => void }} options
 */
export function createAmbientPlayback({ media, onPlaybackChange }) {
  const state = { ready: false, visible: false, hidden: false, paused: false, reduced: false, failed: false }
  let wanted = false
  let playing = false
  let disposed = false
  let revision = 0
  /** @type {object | null} */
  let pending = null

  function report(value) {
    if (playing === value) return
    playing = value
    onPlaybackChange(value)
  }

  function requestPlay() {
    if (disposed || !wanted || pending) return
    const attempt = {}
    const requestedAt = revision
    pending = attempt

    const settle = (failed) => {
      if (pending !== attempt) return
      pending = null
      // A replacement source may already own this same DOM element.
      if (disposed) return
      if (!wanted) {
        media.pause()
        report(false)
        return
      }
      if (failed) {
        report(false)
        // pause() may reject a pending play(). A later explicit resume should
        // still work, but an autoplay rejection must not create a retry loop.
        if (requestedAt !== revision) requestPlay()
      } else if (requestedAt !== revision && media.paused) requestPlay()
    }

    try {
      Promise.resolve(media.play()).then(() => settle(false), () => settle(true))
    } catch {
      settle(true)
    }
  }

  /** @param {Partial<typeof state>} partial */
  function update(partial) {
    if (disposed) return
    Object.assign(state, partial)
    const next = state.ready && state.visible && !state.hidden && !state.paused && !state.reduced && !state.failed
    if (next === wanted) return
    wanted = next
    revision += 1
    if (wanted) requestPlay()
    else {
      media.pause()
      report(false)
    }
  }

  function onPlaying() {
    if (disposed || !wanted) {
      media.pause()
      report(false)
    } else report(true)
  }

  function onPause() {
    report(false)
  }

  function dispose() {
    if (disposed) return
    disposed = true
    wanted = false
    media.pause()
    report(false)
  }

  return { update, onPlaying, onPause, dispose }
}
