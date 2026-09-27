import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createScenePlayback } from './scenePlayback.js'

function fixture() {
  const calls = []
  const playback = createScenePlayback({
    start: () => calls.push('start'),
    stop: () => calls.push('stop'),
    draw: () => calls.push('draw')
  })
  return { calls, ...playback }
}

describe('scene playback', () => {
  it('waits for resources and starts only one loop for repeated updates', () => {
    const scene = fixture()
    scene.invalidate()
    scene.update({ visible: true, ready: false })
    assert.deepEqual(scene.calls, [])

    scene.update({ ready: true })
    scene.update({ ready: true, visible: true })
    scene.update({})
    scene.invalidate()
    assert.deepEqual(scene.calls, ['start'])
  })

  it('preserves pause across offscreen, hidden, and reduced-motion changes', () => {
    const scene = fixture()
    scene.update({ ready: true })
    scene.update({ paused: true })
    assert.deepEqual(scene.calls, ['start', 'stop', 'draw'])

    scene.update({ visible: false })
    scene.update({ reduced: true })
    scene.update({ hidden: true })
    scene.update({ visible: true })
    scene.invalidate()
    assert.deepEqual(scene.calls, ['start', 'stop', 'draw'])

    scene.update({ hidden: false })
    scene.update({ reduced: false })
    assert.deepEqual(scene.calls, ['start', 'stop', 'draw', 'draw', 'draw'])
    scene.update({ paused: false })
    assert.equal(scene.calls.at(-1), 'start')
    assert.equal(scene.calls.filter(call => call === 'start').length, 2)
  })

  it('requires all run conditions before resuming a stopped loop', () => {
    const scene = fixture()
    scene.update({ ready: true })
    scene.update({ visible: false })
    scene.update({ hidden: true })
    scene.update({ visible: true })
    assert.deepEqual(scene.calls, ['start', 'stop'])

    scene.update({ hidden: false })
    scene.update({ ready: false })
    scene.invalidate()
    assert.deepEqual(scene.calls, ['start', 'stop', 'start', 'stop'])
    scene.update({ ready: true })
    assert.equal(scene.calls.at(-1), 'start')
  })

  it('renders reduced-motion content once when ready and redraws on invalidation', () => {
    const scene = fixture()
    scene.update({ reduced: true })
    scene.update({ ready: true })
    scene.update({ ready: true, reduced: true })
    assert.deepEqual(scene.calls, ['draw'])

    scene.invalidate()
    assert.deepEqual(scene.calls, ['draw', 'draw'])
    scene.update({ visible: false })
    scene.invalidate()
    assert.deepEqual(scene.calls, ['draw', 'draw'])
    scene.update({ visible: true })
    assert.deepEqual(scene.calls, ['draw', 'draw', 'draw'])
  })

  it('stops live motion when reduced motion is enabled and keeps pause authoritative', () => {
    const scene = fixture()
    scene.update({ ready: true })
    scene.update({ reduced: true })
    scene.update({ paused: true })
    scene.update({ reduced: false })
    assert.deepEqual(scene.calls, ['start', 'stop', 'draw', 'draw', 'draw'])

    scene.update({ paused: false })
    scene.invalidate()
    assert.equal(scene.calls.at(-1), 'start')
  })

  it('permanently stops a live scene on disposal and ignores subsequent work', () => {
    const scene = fixture()
    scene.update({ ready: true })
    scene.dispose()
    scene.dispose()
    scene.update({ ready: false, paused: true })
    scene.update({ ready: true, paused: false })
    scene.invalidate()
    assert.deepEqual(scene.calls, ['start', 'stop'])
  })

  it('ignores resources that finish loading after disposal', () => {
    const scene = fixture()
    scene.dispose()
    scene.update({ ready: true })
    scene.invalidate()
    assert.deepEqual(scene.calls, [])
  })
})
