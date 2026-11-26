import { execFileSync } from 'node:child_process'
import { test } from 'bun:test'

test('PlanDecision hides bypassPermissions and clamps selected mode for Antigravity sessions', () => {
  const script = `
    import { mock } from 'bun:test'
    import assert from 'node:assert/strict'
    const React = require(${JSON.stringify(import.meta.resolve('react'))})
    let cursor = 0, states = []
    mock.module(${JSON.stringify(import.meta.resolve('react'))}, () => ({
      ...React, default: React,
      useState(initial) {
        const slot = cursor++
        if (!(slot in states)) states[slot] = typeof initial === 'function' ? initial() : initial
        return [states[slot], next => { states[slot] = typeof next === 'function' ? next(states[slot]) : next }]
      },
    }))
    mock.module(${JSON.stringify(import.meta.resolve('react-native'))}, () => ({
      Pressable: 'Pressable',
      ScrollView: 'ScrollView',
      View: 'View',
    }))
    mock.module(${JSON.stringify(import.meta.resolve('../KeyboardViewport'))}, () => ({ KeyboardViewport: 'KeyboardViewport' }))
    mock.module(${JSON.stringify(import.meta.resolve('../kit'))}, () => ({
      ...Object.fromEntries(['Button', 'Callout', 'Icon', 'InlineError', 'Mono', 'PageSheet', 'Segmented', 'TextButton'].map(name => [name, name])),
      useColors: () => ({}),
    }))
    mock.module(${JSON.stringify(import.meta.resolve('../RuntimePicker'))}, () => ({ RuntimeSheet: 'RuntimeSheet' }))
    mock.module(${JSON.stringify(import.meta.resolve('../EffortControl'))}, () => ({ EffortControl: 'EffortControl', EffortSheet: 'EffortSheet' }))
    mock.module(${JSON.stringify(import.meta.resolve('../Text'))}, () => ({ Text: 'Text' }))
    mock.module(${JSON.stringify(import.meta.resolve('./parts'))}, () => ({
      DecisionHeader: 'DecisionHeader',
      DecisionSurface: 'DecisionSurface',
      NoteInput: 'NoteInput',
      SubmittedRow: 'SubmittedRow',
      useBottomInset: () => 20,
    }))
    mock.module(${JSON.stringify(import.meta.resolve('./PlanDocument'))}, () => ({ PlanDocument: 'PlanDocument' }))
    const { PlanDecision } = require(${JSON.stringify(import.meta.resolve('./PlanDecision'))})
    const flat = (node) => {
      if (!node || typeof node !== 'object') return []
      if (Array.isArray(node)) return node.flatMap(flat)
      return [node, ...flat(node.props?.children), ...flat(node.props?.overlay)]
    }
    const render = (props) => { cursor = 0; return flat(PlanDecision(props)) }

    // 1. Non-Antigravity session keeps bypassPermissions and can select it
    let approved
    states = []
    const claudeProps = {
      input: { plan: '# Plan' },
      ready: true,
      sent: false,
      runtime: { providerId: null, modelId: 'claude-sonnet-4-5' },
      approve: (plan) => { approved = plan; return true },
      revise: () => true,
    }
    let nodes = render(claudeProps)
    let seg = nodes.find(n => n.type === 'Segmented')
    assert.deepEqual(seg.props.options.map(o => o.value), ['default', 'acceptEdits', 'bypassPermissions'])
    seg.props.onChange('bypassPermissions')
    nodes = render(claudeProps)
    assert.equal(nodes.find(n => n.type === 'Segmented').props.value, 'bypassPermissions')
    assert.equal(nodes.some(n => n.type === 'Callout'), true)

    // 2. If runtime becomes Antigravity while mode was bypassPermissions, it clamps away from bypassPermissions
    const agProps = { ...claudeProps, runtime: { providerId: 'antigravity-acp', modelId: 'agent-default' } }
    nodes = render(agProps)
    seg = nodes.find(n => n.type === 'Segmented')
    assert.deepEqual(seg.props.options.map(o => o.value), ['default', 'acceptEdits'])
    assert.equal(seg.props.value, 'acceptEdits', 'clamped away from bypassPermissions')
    assert.equal(nodes.some(n => n.type === 'Callout'), false, 'bypass warning callout hidden')
    nodes.find(n => n.type === 'Button' && n.props?.title === '批准并执行').props.onPress()
    assert.deepEqual(approved, { mode: 'acceptEdits' })

    // 3. Direct onChange('bypassPermissions') on Antigravity also clamps, while 'default' works normally
    seg.props.onChange('bypassPermissions')
    nodes = render(agProps)
    assert.equal(nodes.find(n => n.type === 'Segmented').props.value, 'acceptEdits')
    seg.props.onChange('default')
    nodes = render(agProps)
    assert.equal(nodes.find(n => n.type === 'Segmented').props.value, 'default')
    nodes.find(n => n.type === 'Button' && n.props?.title === '批准并执行').props.onPress()
    assert.deepEqual(approved, { mode: 'default' })
  `
  try {
    execFileSync(process.execPath, ['--no-env-file', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    throw new Error(String((error as { stderr?: Buffer }).stderr || error))
  }
})
