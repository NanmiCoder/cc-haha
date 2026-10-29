import { execFileSync } from 'node:child_process'
import { test } from 'bun:test'

test('the recording surface gives measured audio its own wide trace and freezes it during transcription', () => {
  // Native primitives and time are isolated; the production recording surface,
  // sampling effects and phase transitions run together without a microphone.
  const script = `
    import { mock } from 'bun:test'
    import assert from 'node:assert/strict'
    const React = await import(${JSON.stringify(import.meta.resolve('react'))})
    const slots = new Map(), timers = new Map()
    let path = '', cursor = 0, effects = [], nextTimer = 0, now = 1000
    Date.now = () => now
    globalThis.setInterval = (callback, ms) => { const id = ++nextTimer; timers.set(id, { callback, ms }); return id }
    globalThis.clearInterval = id => timers.delete(id)
    const key = () => path + ':' + cursor++
    mock.module(${JSON.stringify(import.meta.resolve('react'))}, () => ({
      ...React, default: React,
      useState: initial => {
        const id = key()
        if (!slots.has(id)) slots.set(id, typeof initial === 'function' ? initial() : initial)
        return [slots.get(id), next => slots.set(id, typeof next === 'function' ? next(slots.get(id)) : next)]
      },
      useEffect: (effect, deps) => {
        const id = key(), previous = slots.get(id)
        if (!previous || deps.some((value, index) => !Object.is(value, previous.deps[index]))) {
          effects.push(() => { previous?.cleanup?.(); slots.set(id, { deps, cleanup: effect() }) })
        }
      },
    }))
    mock.module(${JSON.stringify(import.meta.resolve('react-native'))}, () => ({ Linking: {}, Pressable: 'Pressable', View: 'View' }))
    mock.module(${JSON.stringify(import.meta.resolve('../Text'))}, () => ({ Text: 'Text' }))
    mock.module(${JSON.stringify(import.meta.resolve('../kit'))}, () => ({
      Icon: 'Icon', Mono: 'Mono', Spinner: 'Spinner',
      useColors: () => ({ run: 'blue', runTint: 'pale-blue', ink2: 'gray', faint: 'faint' }),
    }))
    const { VoiceRecordingBar } = await import(${JSON.stringify(import.meta.resolve('./VoiceInput'))})
    let level = 0, reads = 0
    let voice = {
      phase: 'starting', startedAt: 1000, limitSeconds: 60, sendRequested: false,
      getLevel: () => { reads++; return level }, cancel() {}, stop() {}, stopAndSend() {},
    }
    let nodes
    const walk = (node, at, parents = []) => {
      if (Array.isArray(node)) return node.flatMap((child, index) => walk(child, at + '/' + index, parents))
      if (!node || typeof node !== 'object') return []
      if (typeof node.type === 'function') {
        path = at; cursor = 0
        return walk(node.type(node.props), at + '/component', parents)
      }
      return [{ node, parents }, ...walk(node.props?.children, at + '/children', [...parents, node])]
    }
    const render = () => {
      effects = []
      nodes = walk(React.createElement(VoiceRecordingBar, { voice, canSend: true }), 'root')
      effects.forEach(effect => effect())
    }
    const byId = id => nodes.find(({ node }) => node.props.testID === id)?.node
    const button = label => nodes.find(({ node }) => node.type === 'Pressable' && node.props.accessibilityLabel === label)?.node
    const sample = () => [...timers.values()].filter(timer => timer.ms === 80).forEach(timer => timer.callback())
    const bars = () => nodes.filter(({ node }) => node.props.testID === 'voice-wave-bar').map(({ node }) => node)
    render()
    assert.equal(button('转写后发送').props.disabled, true)
    assert.equal(timers.size, 0, 'starting must not pretend to hear the microphone')

    voice = { ...voice, phase: 'recording' }
    render()
    const trace = nodes.find(({ node }) => node.props.accessibilityLabel === '麦克风音量').node
    assert.ok(trace.props.style.height >= 64, 'audio needs more than the former 32pt toolbar strip')
    assert.notEqual(byId('voice-recording-panel').props.style.flexDirection, 'row')
    trace.props.onLayout({ nativeEvent: { layout: { width: 300 } } })
    sample(); render()
    assert.ok(bars().length >= 45, 'use the full composer width instead of the gap between buttons')
    assert.ok(bars().every(bar => bar.props.style.height <= 4), 'silence stays quiet')
    level = 0.8
    for (let index = 0; index < 12; index++) sample()
    render()
    assert.ok(bars().some(bar => bar.props.style.height > 40), 'the trace reacts visibly to actual microphone input')
    assert.ok(bars().every(bar => Number.isFinite(bar.props.style.height) && bar.props.style.height <= trace.props.style.height))

    level = NaN
    sample(); render()
    assert.ok(bars().every(bar => Number.isFinite(bar.props.style.height)), 'invalid levels cannot break native layout')
    now = 49000
    for (const timer of timers.values()) if (timer.ms === 250) timer.callback()
    render()
    assert.ok(nodes.some(({ node }) => node.props.children === '剩余 0:12'))
    const heights = bars().map(bar => bar.props.style.height)
    const readsBefore = reads
    voice = { ...voice, phase: 'transcribing' }
    render()
    sample(); render()
    assert.equal(reads, readsBefore, 'recognition must release the level polling timer')
    assert.deepEqual(bars().map(bar => bar.props.style.height), heights, 'recognition keeps the actual recorded trace')
    assert.ok(nodes.some(({ node }) => node.props.children === '正在转成文字…'))
    assert.equal(button('停止录音并转成文字').props.disabled, true)
    assert.equal(button('取消语音输入').props.disabled, undefined)
    voice = { ...voice, sendRequested: true }
    render()
    assert.equal(button('转写后发送').props.disabled, true)
    assert.equal(timers.size, 0)
    for (const slot of slots.values()) slot?.cleanup?.()
  `
  try {
    execFileSync(process.execPath, ['--no-env-file', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    throw new Error(String((error as { stderr?: Buffer }).stderr || error))
  }
})
