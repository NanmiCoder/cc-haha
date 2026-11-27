import { execFileSync } from 'node:child_process'
import { test } from 'bun:test'

test('TeamPlanSheet excludes Antigravity from RuntimeSheet model pickers', () => {
  const script = `
    import { mock } from 'bun:test'
    import assert from 'node:assert/strict'
    const React = require(${JSON.stringify(import.meta.resolve('react'))})
    let states = [], cursor = 0
    mock.module(${JSON.stringify(import.meta.resolve('react'))}, () => ({
      ...React, default: React,
      useState(initial) {
        const i = cursor++
        if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial
        return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value }]
      },
      useEffect() {},
    }))
    mock.module(${JSON.stringify(import.meta.resolve('react-native'))}, () => ({
      Alert: { alert() {} },
      Pressable: 'Pressable',
      View: 'View',
    }))
    mock.module(${JSON.stringify(import.meta.resolve('../DetentSheet'))}, () => ({ DetentSheet: 'DetentSheet' }))
    mock.module(${JSON.stringify(import.meta.resolve('../EffortControl'))}, () => ({ EffortControl: 'EffortControl' }))
    mock.module(${JSON.stringify(import.meta.resolve('../kit'))}, () => ({
      ...Object.fromEntries(['Button', 'Callout', 'Icon', 'InlineError', 'Mono', 'Sheet', 'TextButton'].map(name => [name, name])),
      useColors: () => ({}),
    }))
    mock.module(${JSON.stringify(import.meta.resolve('../newtask/ChoiceRow'))}, () => ({ ChoiceRow: 'ChoiceRow' }))
    mock.module(${JSON.stringify(import.meta.resolve('../RuntimePicker'))}, () => ({ RuntimeSheet: 'RuntimeSheet' }))
    mock.module(${JSON.stringify(import.meta.resolve('../Text'))}, () => ({ Text: 'Text' }))
    mock.module(${JSON.stringify(import.meta.resolve('../decision/parts'))}, () => ({ NoteInput: 'NoteInput', QuietButton: 'QuietButton' }))
    const { TeamPlanSheet } = require(${JSON.stringify(import.meta.resolve('./TeamPlanSheet'))})
    function find(node, type) {
      if (!node || typeof node !== 'object') return
      if (node.type === type) return node
      for (const child of [node.props?.children, node.props?.overlay, node.props?.footer, node.props?.left].flat(Infinity)) {
        const match = find(child, type)
        if (match) return match
      }
    }
    const plan = {
      planId: 'plan-1',
      revision: 1,
      state: 'review_pending',
      teamName: 'review-team',
      leaderRuntime: { providerId: null, modelId: 'claude-sonnet-4-5' },
      members: [
        {
          id: 'm1',
          name: 'worker',
          agentType: 'general-purpose',
          prompt: 'Do work',
          runtime: { providerId: null, modelId: 'claude-sonnet-4-5' },
        },
      ],
      tasks: [],
    }
    cursor = 0
    const tree = TeamPlanSheet({
      visible: true,
      onClose() {},
      plan,
      team: { plan, pending: null, error: '', edit: async () => true, act: async () => true },
      client: null,
      ready: true,
    })
    const runtimeSheet = find(tree, 'RuntimeSheet')
    assert.ok(runtimeSheet, 'TeamPlanSheet renders RuntimeSheet in its overlay')
    assert.deepEqual(runtimeSheet.props.excludeProviderIds, ['antigravity-acp'])
  `
  try {
    execFileSync(process.execPath, ['--no-env-file', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    throw new Error(String((error as { stderr?: Buffer }).stderr || error))
  }
})
