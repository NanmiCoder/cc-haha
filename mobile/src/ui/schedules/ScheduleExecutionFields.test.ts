import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'

test('notification capability failures can be retried and configured remote channels enter the create payload', () => {
  const script = `
    import { mock } from 'bun:test'
    import assert from 'node:assert/strict'
    const React = require(${JSON.stringify(import.meta.resolve('react'))})
    let states = [], dependencies = [], cleanups = [], effects = [], cursor = 0
    mock.module(${JSON.stringify(import.meta.resolve('react'))}, () => ({
      ...React, default: React,
      useState(initial) {
        const i = cursor++
        if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial
        return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value }]
      },
      useEffect(effect, deps) {
        const i = cursor++
        if (!dependencies[i] || deps.some((value, index) => value !== dependencies[i][index])) {
          cleanups[i]?.()
          dependencies[i] = deps
          effects.push(() => { cleanups[i] = effect() })
        }
      },
    }))
    mock.module(${JSON.stringify(import.meta.resolve('react-native'))}, () => ({ View: 'View', FlatList: 'FlatList' }))
    mock.module(${JSON.stringify(import.meta.resolve('../Text'))}, () => ({ Text: 'Text' }))
    mock.module(${JSON.stringify(import.meta.resolve('../kit'))}, () => Object.fromEntries([
      ...['Group', 'InlineError', 'SearchField', 'Segmented', 'Sheet', 'Switch', 'TextButton'].map(name => [name, name]), ['useColors', () => ({})],
    ]))
    mock.module(${JSON.stringify(import.meta.resolve('../RuntimePicker'))}, () => ({ RuntimeSheet: 'RuntimeSheet' }))
    mock.module(${JSON.stringify(import.meta.resolve('../newtask/ChoiceRow'))}, () => ({ ChoiceRow: 'ChoiceRow' }))
    mock.module(${JSON.stringify(import.meta.resolve('./parts'))}, () => ({ FormRow: 'FormRow' }))
    mock.module(${JSON.stringify(import.meta.resolve('./ScheduleFields'))}, () => ({ ScheduleChoice: 'ScheduleChoice' }))
    const { ScheduleExecutionFields } = require(${JSON.stringify(import.meta.resolve('./ScheduleExecutionFields'))})
    const { createScheduleInput, newScheduleDraft } = require(${JSON.stringify(import.meta.resolve('../../core/scheduleDraft'))})
    let calls = [], attempts = 0
    const client = { async get(path) {
      calls.push(path)
      if (path === '/api/sessions?limit=100') return { sessions: [] }
      if (path === '/api/scheduled-tasks/notification-capabilities') {
        if (++attempts === 1) throw new Error('fixture temporarily offline')
        return { channels: { desktop: true, feishu: true, telegram: true } }
      }
      throw new Error('Desktop-only capability')
    } }
    let value = { name: 'Remote notifications', prompt: 'Check', execution: { kind: 'session', targetSessionId: 'fixture-chat' }, folderPath: '', useWorktree: false, notificationPolicy: 'failed', channels: ['desktop'] }
    const render = () => { cursor = 0; return ScheduleExecutionFields({ client, value, disabled: false, onChange: patch => { value = { ...value, ...patch } } }) }
    function find(root, predicate) {
      if (!root || typeof root !== 'object') return
      if (predicate(root)) return root
      for (const child of [root.props?.children].flat(Infinity)) { const found = find(child, predicate); if (found) return found }
    }
    async function flush() { effects.splice(0).forEach(effect => effect()); await new Promise(resolve => setTimeout(resolve, 0)) }
    render(); await flush()
    let root = render()
    assert.ok(find(root, item => item.type === 'InlineError' && item.props.text.includes('fixture temporarily offline')))
    assert.equal(find(root, item => item.type === 'ScheduleChoice' && item.props.label === '飞书').props.disabled, true)
    find(root, item => item.type === 'TextButton' && item.props.title === '重新读取通知渠道').props.onPress()
    render(); await flush(); root = render()
    for (const label of ['飞书', 'Telegram']) {
      const channel = find(root, item => item.type === 'ScheduleChoice' && item.props.label === label)
      assert.equal(channel.props.disabled, false)
      channel.props.onPress()
      root = render()
    }
    assert.deepEqual(value.channels, ['desktop', 'feishu', 'telegram'])
    assert.deepEqual(createScheduleInput(value, newScheduleDraft('UTC')).notification, { enabled: true, channels: ['desktop', 'feishu', 'telegram'] })
    assert.equal(attempts, 2)
    assert.ok(!calls.includes('/api/adapters'))
    assert.ok(!find(root, item => item.type === 'InlineError' && item.props.text))
    cleanups.forEach(cleanup => cleanup?.())
  `
  expect(() => execFileSync(process.execPath, ['--no-env-file', '-e', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).not.toThrow()
})
