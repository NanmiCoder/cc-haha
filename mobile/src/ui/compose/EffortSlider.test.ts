import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'bun:test'

// Isolated native substitutes exercise the real component, responder callbacks,
// and Animated graph without leaking module mocks into other mobile suites.
function runSliderCase(modulePath: string, exportName: string, body: string) {
  const dir = mkdtempSync(join(tmpdir(), 'mobile-effort-slider-'))
  const script = `
    import { mock } from 'bun:test'
    import assert from 'node:assert/strict'
    const React = await import(${JSON.stringify(import.meta.resolve('react'))})
    let cursor = 0, dirty = false
    const slots = []
    let effects = []
    const same = (a, b) => a && b && a.length === b.length && a.every((item, index) => Object.is(item, b[index]))
    const useState = initial => {
      const id = cursor++
      if (!(id in slots)) slots[id] = typeof initial === 'function' ? initial() : initial
      return [slots[id], next => {
        const value = typeof next === 'function' ? next(slots[id]) : next
        if (!Object.is(value, slots[id])) { slots[id] = value; dirty = true }
      }]
    }
    const useEffect = (effect, deps) => {
      const id = cursor++
      if (!slots[id] || !same(slots[id].deps, deps)) effects.push(() => {
        slots[id]?.cleanup?.()
        slots[id] = { deps, cleanup: effect() }
      })
    }
    mock.module(${JSON.stringify(import.meta.resolve('react'))}, () => ({
      ...React, default: React, useState, useEffect, useLayoutEffect: useEffect,
      useRef: initial => useState(() => ({ current: initial }))[0],
      useMemo: (make, deps) => {
        const id = cursor++
        if (!slots[id] || !same(slots[id].deps, deps)) slots[id] = { deps, value: make() }
        return slots[id].value
      },
      useCallback: callback => callback,
    }))
    const calls = []
    let animations = []
    const read = value => typeof value === 'number' ? value : value?.read?.() ?? value
    class Value {
      constructor(value) { this.value = value }
      read() { return this.value }
      setValue(value) { calls.push({ kind: 'set', node: this, from: this.value, to: value }); this.value = value }
      stopAnimation(callback) {
        animations = animations.filter(item => item.node !== this)
        callback?.(this.value)
      }
      interpolate({ inputRange, outputRange }) {
        return { read: () => {
          const fraction = (this.value - inputRange[0]) / (inputRange[inputRange.length - 1] - inputRange[0])
          return outputRange[0] + fraction * (outputRange[outputRange.length - 1] - outputRange[0])
        } }
      }
    }
    const animate = kind => (node, config) => ({
      start(callback) {
        calls.push({ kind, node, from: read(node), to: read(config.toValue) })
        animations.push({ node, target: read(config.toValue), callback })
      },
      stop() { animations = animations.filter(item => item.node !== node) },
    })
    mock.module(${JSON.stringify(import.meta.resolve('react-native'))}, () => ({
      View: 'View', PanResponder: { create: config => ({ panHandlers: config }) },
      Animated: {
        Value, View: 'AnimatedView', spring: animate('spring'), timing: animate('timing'),
        add: (a, b) => ({ read: () => read(a) + read(b) }),
        subtract: (a, b) => ({ read: () => read(a) - read(b) }),
      },
    }))
    mock.module(${JSON.stringify(import.meta.resolve('expo-linear-gradient'))}, () => ({ LinearGradient: 'Gradient' }))
    mock.module(${JSON.stringify(import.meta.resolve('../Text'))}, () => ({ Text: 'Text' }))
    mock.module(${JSON.stringify(import.meta.resolve('../kit'))}, () => ({
      useColors: () => ({ ink: '#222222', fill: '#eeeeee', chevron: '#aaaaaa', btnInk: '#ffffff', card: '#ffffff' }),
    }))
    const Component = (await import(${JSON.stringify(modulePath)}))[${JSON.stringify(exportName)}]
    const options = [
      { value: 'minimal', label: '最少' }, { value: 'low', label: '低' },
      { value: 'medium', label: '中' }, { value: 'high', label: '高' }, { value: 'max', label: '最高' },
    ]
    const changes = []
    let props = { label: '思考强度', options, value: 'medium', disabled: false, onChange: value => changes.push(value) }
    let tree
    const render = () => {
      for (let attempt = 0; attempt < 20; attempt++) {
        cursor = 0; dirty = false; effects = []
        tree = Component(props)
        if (dirty) continue
        const pending = effects; effects = []
        pending.forEach(effect => effect())
        if (!dirty) return tree
      }
      throw new Error('component did not settle')
    }
    const update = patch => { props = { ...props, ...patch }; return render() }
    const walk = (node, parents = []) => {
      if (Array.isArray(node)) return node.flatMap(child => walk(child, parents))
      if (!node || typeof node !== 'object') return []
      return [{ node, parents }, ...walk(node.props?.children, [...parents, node])]
    }
    const all = () => walk(tree)
    const style = node => Object.assign({}, ...[node?.props?.style].flat(Infinity).filter(Boolean))
    const control = () => all().find(({ node }) => node.props.accessibilityRole === 'adjustable').node
    const thumb = () => all().find(({ node }) => node.type === 'AnimatedView' && style(node).transform)?.node
    const thumbCenter = () => {
      const appearance = style(thumb())
      return (appearance.left ?? 0) + read(appearance.transform[0].translateX) + read(appearance.width) / 2
    }
    const fillRight = () => {
      const gradient = all().find(({ node }) => node.type === 'Gradient')
      assert.ok(gradient, 'a selected effort should have an active fill')
      const clip = gradient.parents.findLast(node => style(node).overflow === 'hidden' && style(node).width !== undefined)
      assert.ok(clip, 'the gradient must be clipped to an animated width, not paint the full track')
      const appearance = style(clip)
      return (appearance.left ?? 0) + read(appearance.width)
    }
    const finish = () => {
      const pending = animations; animations = []
      pending.forEach(item => { item.node.value = item.target; item.callback?.({ finished: true }) })
    }
    const event = x => ({ nativeEvent: { locationX: x } })
    const state = dx => ({ dx, dy: 0, vx: 0, vy: 0 })
    const position = (index, count = props.options.length) => 22 + index * (340 - 44) / Math.max(1, count - 1)
    const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 0.01, message + ': ' + actual + ' !== ' + expected)
    const mount = patch => {
      update(patch ?? {})
      control().props.onLayout({ nativeEvent: { layout: { width: 340 } } })
      render(); finish(); calls.length = 0
    }
    ${body}
  `
  try {
    const path = join(dir, 'slider.ts')
    writeFileSync(path, script)
    execFileSync(process.execPath, [path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

for (const [path, name] of [
  ['./EffortSlider', 'EffortSlider'],
  ['../computer/EffortTrack', 'EffortTrack'],
]) {
  const modulePath = import.meta.resolve(path)
  describe(name, () => {
    test('middle effort fills only through the thumb and leaves later stops inactive', () => {
      runSliderCase(modulePath, name, `
        mount()
        close(thumbCenter(), position(2), 'middle thumb position')
        const edge = fillRight()
        assert.ok(edge >= thumbCenter() && edge <= thumbCenter() + 22, 'active fill should end underneath the thumb')
        assert.ok(edge < position(3), 'higher effort stops must remain outside the active fill')
        update({ value: '' })
        assert.equal(thumb(), undefined, 'default effort has no selected thumb')
        assert.equal(all().some(({ node }) => node.type === 'Gradient'), false, 'default effort must not show a fully active gradient')
      `)
    })

    test('tapping a distant stop animates from the old position without jumping on touch down', () => {
      runSliderCase(modulePath, name, `
        mount({ value: 'low' })
        const previous = thumbCenter(), target = position(4)
        control().props.onPanResponderGrant(event(target), state(0))
        render()
        close(thumbCenter(), previous, 'touch down must preserve the animation start position')
        assert.equal(calls.some(call => call.kind === 'set' && call.to !== previous), false, 'touch down must not setValue at the tapped stop')
        assert.deepEqual(changes, [], 'touch down must not save effort')
        control().props.onPanResponderMove(event(target + 2), state(2))
        render()
        close(thumbCenter(), previous, 'small tap jitter must not turn into a jumping drag')
        control().props.onPanResponderRelease(event(target + 2), state(2))
        assert.deepEqual(changes, ['max'])
        update({ value: changes[0] })
        assert.ok(calls.some(call => call.kind !== 'set' && call.from === previous && call.to === target), 'tap should animate from the previous stop to the new stop')
        finish()
        close(thumbCenter(), target, 'tap animation destination')
      `)
    })

    test('dragging follows the finger and submits once on release before snapping', () => {
      runSliderCase(modulePath, name, `
        mount({ value: 'low' })
        const start = thumbCenter(), initialFill = fillRight(), distance = 63
        control().props.onPanResponderGrant(event(start), state(0))
        control().props.onPanResponderMove(event(start + distance), state(distance))
        render()
        close(thumbCenter(), start + distance, 'drag must follow the finger')
        close(fillRight() - initialFill, distance, 'fill must travel with the thumb during drag')
        assert.ok(fillRight() <= thumbCenter() + 22, 'drag fill must stay underneath the thumb')
        assert.deepEqual(changes, [], 'dragging must not repeatedly save effort')
        control().props.onPanResponderRelease(event(start + distance), state(distance))
        assert.deepEqual(changes, ['medium'])
        update({ value: changes[0] })
        assert.ok(calls.some(call => call.kind !== 'set' && call.from === start + distance && call.to === position(2)), 'release should animate the final snap')
        finish()
        close(thumbCenter(), position(2), 'drag snap destination')
      `)
    })

    test('cancelling a drag restores the selected stop without saving', () => {
      runSliderCase(modulePath, name, `
        mount()
        const start = thumbCenter()
        control().props.onPanResponderGrant(event(start), state(0))
        control().props.onPanResponderMove(event(start + 60), state(60))
        control().props.onPanResponderTerminate(event(start + 60), state(60))
        render()
        assert.deepEqual(changes, [])
        assert.ok(calls.some(call => call.kind !== 'set' && call.from === start + 60 && call.to === start), 'cancel should animate back to the saved effort')
        finish()
        close(thumbCenter(), start, 'cancel destination')
      `)
    })

    test('disabled controls reject touches and accessibility changes, including an active drag', () => {
      runSliderCase(modulePath, name, `
        mount({ disabled: true })
        assert.equal(control().props.onStartShouldSetPanResponder(), false)
        assert.equal(control().props.onMoveShouldSetPanResponder(), false)
        control().props.onAccessibilityAction({ nativeEvent: { actionName: 'increment' } })
        assert.deepEqual(changes, [])
        update({ disabled: false })
        const start = thumbCenter()
        control().props.onPanResponderGrant(event(start), state(0))
        control().props.onPanResponderMove(event(start + 100), state(100))
        update({ disabled: true })
        control().props.onPanResponderRelease(event(start + 100), state(100))
        render(); finish()
        assert.deepEqual(changes, [], 'becoming disabled must cancel an in-progress gesture')
        close(thumbCenter(), start, 'disabled drag should restore selected effort')
      `)
    })

    test('changing option count repositions an unchanged index and empty options cannot start gestures', () => {
      runSliderCase(modulePath, name, `
        mount({ value: 'low' })
        close(thumbCenter(), position(1), 'five-stop position')
        update({ options: options.slice(0, 3) }); finish()
        close(thumbCenter(), position(1, 3), 'three-stop position must update even when selection index is unchanged')
        assert.ok(fillRight() < position(2, 3), 'fill must use the new stop geometry')
        assert.deepEqual(changes, [], 'layout changes must not save an effort')
        update({ options: [] })
        assert.equal(control().props.onStartShouldSetPanResponder(), false, 'empty options cannot start a gesture')
        assert.equal(control().props.onMoveShouldSetPanResponder(), false)
        control().props.onAccessibilityAction({ nativeEvent: { actionName: 'increment' } })
        assert.deepEqual(changes, [])
      `)
    })
  })
}
