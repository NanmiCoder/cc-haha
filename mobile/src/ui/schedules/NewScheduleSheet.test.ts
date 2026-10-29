import { execFileSync } from 'node:child_process'
import { expect, test } from 'bun:test'

test('new schedule defaults distinguish native settings from an explicit model selection', () => {
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
      useRef(initial) { const i = cursor++; return states[i] ??= { current: initial } },
      useEffect(effect, deps) {
        const i = cursor++
        if (states[i] && deps?.every((value, index) => Object.is(value, states[i].deps?.[index]))) return
        states[i]?.cleanup?.()
        states[i] = { deps, cleanup: effect() }
      },
    }))
    mock.module(${JSON.stringify(import.meta.resolve('react-native'))}, () => ({ View: 'View', TextInput: 'TextInput', ScrollView: 'ScrollView', Pressable: 'Pressable' }))
    mock.module(${JSON.stringify(import.meta.resolve('react-native-safe-area-context'))}, () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }))
    mock.module(${JSON.stringify(import.meta.resolve('../kit'))}, () => Object.fromEntries([
      ...['Button','Chevron','Group','InlineError','PageSheet','Separator','TextButton'].map(name => [name, name]), ['useColors', () => ({})],
    ]))
    mock.module(${JSON.stringify(import.meta.resolve('../Text'))}, () => ({ Text: 'Text' }))
    mock.module(${JSON.stringify(import.meta.resolve('../KeyboardViewport'))}, () => ({ KeyboardViewport: 'KeyboardViewport' }))
    mock.module(${JSON.stringify(import.meta.resolve('./parts'))}, () => ({ FormRow: 'FormRow' }))
    mock.module(${JSON.stringify(import.meta.resolve('./ProjectPickerSheet'))}, () => ({ ProjectPickerSheet: 'ProjectPickerSheet' }))
    mock.module(${JSON.stringify(import.meta.resolve('./ScheduleFields'))}, () => ({ ScheduleFields: 'ScheduleFields' }))
    mock.module(${JSON.stringify(import.meta.resolve('./ScheduleExecutionFields'))}, () => ({ ScheduleExecutionFields: 'ScheduleExecutionFields' }))
    const { NewScheduleSheet } = require(${JSON.stringify(import.meta.resolve('./NewScheduleSheet'))})
    const requests = []
    const client = {
      async get(path) {
        if (path.includes('recent-projects')) return { projects: [{ realPath: '/fixture/project', projectName: 'Fixture project' }] }
        if (path === '/api/models/current') return { model: { id: 'native-fixture' } }
        if (path === '/api/models') return { provider: null, runtimeSource: 'standalone' }
        throw new Error('Unexpected request ' + path)
      },
      async post(path, body) { requests.push({ path, body }); return { task: { id: 'task' } } },
    }
    let created = 0
    function find(root, predicate) {
      if (!root || typeof root !== 'object') return
      if (predicate(root)) return root
      for (const child of [root.props?.children].flat(Infinity)) { const found = find(child, predicate); if (found) return found }
    }
    const render = () => { cursor = 0; return NewScheduleSheet({ visible: true, client, onClose() {}, onCreated() { created++ } }) }
    let root = render()
    for (let i = 0; i < 5; i++) await Promise.resolve()
    root = render()
    find(root, node => node.type === 'TextInput' && node.props.accessibilityLabel === '要做什么').props.onChangeText('Check native build')
    root = render()
    find(root, node => node.type === 'Button').props.onPress()
    for (let i = 0; i < 5; i++) await Promise.resolve()
    assert.equal(created, 1)
    assert.equal(requests[0].path, '/api/scheduled-tasks')
    assert.deepEqual(requests[0].body.execution, { kind: 'new-session' })
    assert.equal(requests[0].body.folderPath, '/fixture/project')
    assert.ok(!('providerId' in requests[0].body))
    assert.ok(!('model' in requests[0].body))
    // Choosing a concrete source must turn off default inheritance.
    states = []; root = render()
    for (let i = 0; i < 5; i++) await Promise.resolve()
    root = render()
    find(root, node => node.type === 'TextInput' && node.props.accessibilityLabel === '要做什么').props.onChangeText('Check explicit model')
    find(root, node => node.type === 'TextButton' && node.props.title.startsWith('执行设置')).props.onPress()
    root = render()
    find(root, node => node.type === 'ScheduleExecutionFields').props.onChange({ runtime: { providerId: 'selected-provider', modelId: 'selected-model' } })
    root = render()
    find(root, node => node.type === 'Button').props.onPress()
    for (let i = 0; i < 5; i++) await Promise.resolve()
    assert.equal(created, 2)
    assert.equal(requests[1].body.providerId, 'selected-provider')
    assert.equal(requests[1].body.model, 'selected-model')
  `
  expect(() => execFileSync(process.execPath, ['--no-env-file', '-e', script], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
  })).not.toThrow()
})
