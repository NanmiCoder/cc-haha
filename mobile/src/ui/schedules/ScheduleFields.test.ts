import { execFileSync } from 'node:child_process'
import { expect, test } from 'bun:test'

test('mobile schedule controls preserve weekday aliases, explicit execution targets and unchanged edits', () => {
  const script = `
    import { mock } from 'bun:test'
    import assert from 'node:assert/strict'
    const React = require(${JSON.stringify(import.meta.resolve('react'))})
    let states = [], cursor = 0
    mock.module(${JSON.stringify(import.meta.resolve('react'))}, () => ({
      ...React, default: React, useEffect() {},
      useState(initial) {
        const i = cursor++
        if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial
        return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value }]
      },
    }))
    mock.module(${JSON.stringify(import.meta.resolve('react-native'))}, () => ({ View: 'View', Pressable: 'Pressable', TextInput: 'TextInput', ScrollView: 'ScrollView', FlatList: 'FlatList' }))
    mock.module(${JSON.stringify(import.meta.resolve('react-native-safe-area-context'))}, () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }))
    mock.module(${JSON.stringify(import.meta.resolve('../kit'))}, () => Object.fromEntries([
      ...['Group', 'InlineError', 'Separator', 'TextButton', 'Button', 'Callout', 'PageSheet', 'SearchField', 'Segmented', 'Sheet', 'Switch'].map(name => [name, name]),
      ['useColors', () => ({})],
    ]))
    mock.module(${JSON.stringify(import.meta.resolve('../Text'))}, () => ({ Text: 'Text' }))
    mock.module(${JSON.stringify(import.meta.resolve('../KeyboardViewport'))}, () => ({ KeyboardViewport: 'KeyboardViewport' }))
    mock.module(${JSON.stringify(import.meta.resolve('../RuntimePicker'))}, () => ({ RuntimeSheet: 'RuntimeSheet' }))
    mock.module(${JSON.stringify(import.meta.resolve('../newtask/ChoiceRow'))}, () => ({ ChoiceRow: 'ChoiceRow' }))
    mock.module(${JSON.stringify(import.meta.resolve('./parts'))}, () => ({ FormRow: 'FormRow', TimeField: 'TimeField' }))
    const { ScheduleFields, ScheduleChoice } = require(${JSON.stringify(import.meta.resolve('./ScheduleFields'))})
    const { ScheduleExecutionFields } = require(${JSON.stringify(import.meta.resolve('./ScheduleExecutionFields'))})
    const { EditTimeSheet } = require(${JSON.stringify(import.meta.resolve('./EditTimeSheet'))})
    const { newScheduleDraft, scheduleDraftForTask } = require(${JSON.stringify(import.meta.resolve('../../core/scheduleDraft'))})
    function find(root, predicate) {
      if (!root || typeof root !== 'object') return
      if (predicate(root)) return root
      for (const child of [root.props?.children].flat(Infinity)) { const found = find(child, predicate); if (found) return found }
    }
    let value = { ...newScheduleDraft('UTC'), frequency: 'specificDays', selectedDays: [7] }
    const render = () => { cursor = 0; return ScheduleFields({ value, onChange: next => { value = next } }) }
    let root = render()
    assert.equal(find(root, item => item.type === ScheduleChoice && item.props.label === '周日').props.selected, true)
    find(root, item => item.type === ScheduleChoice && item.props.label === '周日').props.onPress()
    assert.deepEqual(value.selectedDays, [])
    root = render()
    find(root, item => item.type === ScheduleChoice && item.props.label === '周一').props.onPress()
    assert.deepEqual(value.selectedDays, [1])
    find(root, item => item.type === 'TextButton' && item.props.title === '更多').props.onPress()
    root = render()
    for (const label of ['每月', '每隔几分钟', '每隔几小时', '自定义 Cron']) assert.ok(find(root, item => item.type === ScheduleChoice && item.props.label === label))
    find(root, item => item.type === ScheduleChoice && item.props.label === '30 分钟后').props.onPress()
    assert.equal(value.frequency, 'once')
    assert.ok(new Date(value.runAt + 'Z').getTime() > Date.now())
    const compact = ScheduleChoice({ label: '1', compact: true, onPress() {} }).props.style({ pressed: false })
    assert.equal(compact.minWidth, 0)
    assert.equal(compact.minHeight, 44)
    states = []; cursor = 0
    const completed = { kind: 'once', runAt: '2020-01-01T09:00:23Z', timeZone: 'UTC' }
    root = ScheduleFields({ value: { ...newScheduleDraft('UTC'), frequency: 'once', runAt: '2020-01-01T09:00' }, originalSchedule: completed, onChange() {} })
    assert.equal(find(root, item => item.type === 'InlineError').props.text, '')
    states = []; cursor = 0
    let changed = []
    root = ScheduleExecutionFields({ client: null, value: { execution: { kind: 'session', targetSessionId: 'chosen-chat' }, channels: [], notificationPolicy: 'none' }, disabled: false, onChange: patch => changed.push(patch) })
    const selector = find(root, item => item.type === 'Segmented')
    selector.props.onChange('session')
    assert.equal(changed.length, 0)
    selector.props.onChange('new-session')
    assert.deepEqual(changed, [{ execution: { kind: 'new-session' } }])
    states = []; cursor = 0
    const task = { id: 'legacy', prompt: 'check', cron: '0 9 * * 5,1', recurring: false, revision: 3, createdAt: 0 }
    let saves = [], closes = 0
    root = EditTimeSheet({ visible: true, task, busy: false, error: '', onSave: update => saves.push(update), onClose: () => closes++ })
    find(root, item => item.type === 'Button').props.onPress()
    assert.equal(closes, 1)
    assert.equal(saves.length, 0)
    find(root, item => item.type === ScheduleFields).props.onChange({ ...scheduleDraftForTask(task), time: '11:30' })
    cursor = 0
    root = EditTimeSheet({ visible: true, task: { ...task, revision: 9 }, busy: false, error: '', onSave: update => saves.push(update), onClose: () => closes++ })
    find(root, item => item.type === 'Button').props.onPress()
    assert.deepEqual(saves, [{ cron: '30 11 * * 1,5', expectedRevision: 3 }])
  `
  expect(() => execFileSync(process.execPath, ['--no-env-file', '-e', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).not.toThrow()
})
