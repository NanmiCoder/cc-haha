import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'bun:test'

test('notification diagnostics open on demand and preserve actions, feedback and busy state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mobile-delivery-card-'))
  const script = `
    import { mock } from 'bun:test'
    import assert from 'node:assert/strict'
    let expanded = false
    const React = await import(${JSON.stringify(import.meta.resolve('react'))})
    mock.module(${JSON.stringify(import.meta.resolve('react'))}, () => ({
      ...React,
      useState: () => [expanded, (next) => { expanded = typeof next === 'function' ? next(expanded) : next }],
    }))
    mock.module(${JSON.stringify(import.meta.resolve('react-native'))}, () => ({
      View: 'View', Pressable: 'Pressable', ActivityIndicator: 'ActivityIndicator',
    }))
    mock.module(${JSON.stringify(import.meta.resolve('react-native-svg'))}, () => ({ default: 'Svg', Circle: 'Circle', Path: 'Path' }))
    mock.module(${JSON.stringify(import.meta.resolve('../kit'))}, () => ({
      Button: 'Button', Chevron: 'Chevron', Group: 'Group', Icon: 'Icon',
      InlineError: 'InlineError', Separator: 'Separator', useColors: () => ({}),
    }))
    mock.module(${JSON.stringify(import.meta.resolve('../Text'))}, () => ({ Text: 'Text' }))
    const { DeliveryCard } = await import(${JSON.stringify(import.meta.resolve('./DeliveryCard'))})
    const { deliveryStatus } = await import(${JSON.stringify(import.meta.resolve('./deliveryModel'))})
    const base = {
      platform: 'android', permission: { status: 'granted', canAskAgain: true },
      push: { status: 'notConfigured' }, hostName: 'Fixture', hasHost: true,
      decisions: true, liveActivity: 'running',
    }
    const actions = []
    let guide = 0
    const props = {
      delivery: deliveryStatus(base), busy: null,
      note: '只测试手机通知，未验证电脑推送。', error: '',
      onAction: kind => actions.push(kind), onGuide: () => guide++,
    }
    const flatten = node => {
      if (Array.isArray(node)) return node.flatMap(flatten)
      if (!node || typeof node !== 'object') return []
      return [node, ...flatten(node.props?.children)]
    }
    const nodes = () => flatten(DeliveryCard(props))
    const header = tree => tree.find(node => node.type === 'Pressable' && node.props.accessibilityState?.expanded !== undefined)
    let tree = nodes()
    assert.equal(header(tree).props.accessibilityState.expanded, false)
    assert.equal(tree.some(node => node.type === 'Button'), false, 'test should not occupy settings before opening diagnostics')
    assert.equal(tree.some(node => node.props.children === props.note), false, 'technical feedback stays inside details')
    header(tree).props.onPress()
    tree = nodes()
    assert.equal(header(tree).props.accessibilityState.expanded, true)
    assert.ok(tree.some(node => node.props.children === props.note))
    const testButton = tree.find(node => node.type === 'Button' && node.props.title === '测试通知')
    assert.ok(testButton)
    testButton.props.onPress()
    assert.deepEqual(actions, ['test'])
    tree.find(node => node.props.accessibilityLabel === '推送设置说明').props.onPress()
    assert.equal(guide, 1)
    props.busy = 'test'
    tree = nodes()
    assert.ok(tree.filter(node => node.type === 'Button').every(node => node.props.disabled))
    assert.ok(tree.find(node => node.type === 'Button').props.busy)
    props.error = '测试未完成，请重试。'
    assert.ok(nodes().some(node => node.type === 'InlineError' && node.props.text === props.error))
    header(tree).props.onPress()
    assert.equal(nodes().some(node => node.type === 'Button'), false)
    props.busy = null
    props.delivery = deliveryStatus({ ...base, permission: { status: 'denied', canAskAgain: false } })
    header(nodes()).props.onPress()
    const permissionButton = nodes().find(node => node.type === 'Button')
    permissionButton.props.onPress()
    assert.deepEqual(actions, ['test', 'settings'])
  `
  try {
    const path = join(dir, 'card.ts')
    writeFileSync(path, script)
    execFileSync(process.execPath, [path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
