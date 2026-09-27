import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createAmbientPlayback } from './ambientPlayback.js'

function fixture() {
  const attempts = []
  const reports = []
  let pauses = 0
  let paused = true
  const controller = createAmbientPlayback({
    media: {
      get paused() { return paused },
      play: () => new Promise((resolve, reject) => attempts.push({
        resolve: () => { paused = false; resolve() },
        staleResolve: resolve,
        reject
      })),
      pause: () => { pauses += 1; paused = true }
    },
    onPlaybackChange: value => reports.push(value)
  })
  return { ...controller, attempts, reports, pauses: () => pauses }
}

const flush = () => new Promise(resolve => queueMicrotask(resolve))

describe('ambient video playback', () => {
  it('waits for playing and preserves user pause through overlapping environment changes', async () => {
    const video = fixture()
    video.update({ ready: true, visible: true })
    video.update({ ready: true, visible: true })
    assert.equal(video.attempts.length, 1)
    video.attempts[0].resolve()
    await flush()
    assert.deepEqual(video.reports, [])
    video.onPlaying()
    video.update({ paused: true })
    video.update({ hidden: true, visible: false, reduced: true })
    video.update({ hidden: false, visible: true, reduced: false })
    assert.deepEqual(video.reports, [true, false])
    assert.equal(video.attempts.length, 1)
    video.update({ paused: false })
    assert.equal(video.attempts.length, 2)
  })

  it('does not let late autoplay resolution override pause or reduced motion', async () => {
    const video = fixture()
    video.update({ ready: true, visible: true })
    video.update({ reduced: true })
    video.onPlaying()
    video.attempts[0].resolve()
    await flush()
    assert.deepEqual(video.reports, [])
    assert.equal(video.attempts.length, 1)
    assert.ok(video.pauses() >= 2)
  })

  it('resumes after an aborted pending play without concurrent attempts', async () => {
    const video = fixture()
    video.update({ ready: true, visible: true })
    video.update({ paused: true })
    video.update({ paused: false })
    assert.equal(video.attempts.length, 1)
    video.attempts[0].reject(new Error('play interrupted by pause'))
    await flush()
    assert.equal(video.attempts.length, 2)
    video.attempts[1].resolve()
    await flush()
    video.onPlaying()
    assert.deepEqual(video.reports, [true])
  })

  it('keeps rejected autoplay static until a new eligibility transition', async () => {
    const video = fixture()
    video.update({ ready: true, visible: true })
    video.attempts[0].reject(new Error('autoplay unavailable'))
    await flush()
    video.update({ ready: true })
    video.update({ visible: true })
    assert.equal(video.attempts.length, 1)
    assert.deepEqual(video.reports, [])
    video.update({ visible: false })
    video.update({ visible: true })
    assert.equal(video.attempts.length, 2)
  })

  it('retries an already-resolved play whose callback arrives after pause and resume', async () => {
    const video = fixture()
    video.update({ ready: true, visible: true })
    video.attempts[0].staleResolve()
    video.update({ paused: true })
    video.update({ paused: false })
    await flush()
    assert.equal(video.attempts.length, 2)
  })

  it('ignores pending playback after disposal and permanent media failure', async () => {
    const video = fixture()
    video.update({ ready: true, visible: true })
    video.update({ failed: true })
    video.update({ visible: false })
    video.update({ visible: true })
    video.dispose()
    const pausesAfterDispose = video.pauses()
    video.attempts[0].resolve()
    await flush()
    assert.equal(video.pauses(), pausesAfterDispose)
    video.update({ failed: false, ready: true })
    assert.equal(video.attempts.length, 1)
    assert.deepEqual(video.reports, [])
  })
})
