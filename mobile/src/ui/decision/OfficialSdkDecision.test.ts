import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

test('native SDK decision renderer validates typed fields, locks offline actions and requires opening a safe URL', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mobile-sdk-dialog-'))
  const script = `
    import { mock } from 'bun:test'
    import assert from 'node:assert/strict'
    let cursor = 0
    let values = []
    mock.module(${JSON.stringify(import.meta.resolve('react'))}, () => ({ useState: initial => {
      const slot = cursor++
      if (!(slot in values)) values[slot] = typeof initial === 'function' ? initial() : initial
      return [values[slot], next => { values[slot] = typeof next === 'function' ? next(values[slot]) : next }]
    } }))
    const jsx = (type, props) => ({ type, props })
    mock.module(${JSON.stringify(import.meta.resolve('react/jsx-dev-runtime'))}, () => ({ jsxDEV: jsx }))
    mock.module(${JSON.stringify(import.meta.resolve('react/jsx-runtime'))}, () => ({ jsx, jsxs: jsx }))
    mock.module(${JSON.stringify(import.meta.resolve('react-native'))}, () => ({ ScrollView: 'ScrollView', View: 'View', useWindowDimensions: () => ({ height: 800 }) }))
    const opened = []
    mock.module(${JSON.stringify(import.meta.resolve('expo-linking'))}, () => ({ openURL: async url => { opened.push(url) } }))
    mock.module(${JSON.stringify(import.meta.resolve('../kit'))}, () => ({ Button: 'Button', Checkbox: 'Checkbox', Mono: 'Mono', useColors: () => ({}) }))
    mock.module(${JSON.stringify(import.meta.resolve('../Text'))}, () => ({ Text: 'Text' }))
    mock.module(${JSON.stringify(import.meta.resolve('./parts'))}, () => ({ DecisionHeader: 'Header', DecisionSurface: 'Surface', NoteInput: 'Input', SubmittedRow: 'Submitted' }))
    const { OfficialSdkDecision } = await import(${JSON.stringify(import.meta.resolve('./OfficialSdkDecision'))})
    const sent = []
    const props = { requestId: 'dialog-fixture', ready: true, sent: false, send: message => { sent.push(message); return true },
      dialog: { sdkDialog: true, kind: 'elicitation', mode: 'form', title: 'Details', message: '', fields: [
        { name: 'wire_name', title: 'Name', type: 'string', required: true, minLength: 2 },
        { name: 'wire_count', title: 'Count', type: 'integer', required: true, minimum: 1, maximum: 3 },
      ] } }
    const flat = node => !node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(flat) : [node, ...flat(node.props?.children)]
    const render = () => { cursor = 0; return flat(OfficialSdkDecision(props)) }
    const button = title => { const value = render().find(n => n.type === 'Button' && n.props.title === title); assert.ok(value); return value.props }
    const field = label => { const value = render().find(n => n.type === 'Input' && n.props.accessibilityLabel === label); assert.ok(value); return value.props }
    button('提交').onPress()
    assert.equal(sent.length, 0)
    field('Name *').onChangeText('Alice')
    field('Count *').onChangeText('2')
    props.ready = false
    assert.equal(button('提交').disabled, true)
    button('提交').onPress()
    assert.equal(sent.length, 0)
    props.ready = true
    button('提交').onPress()
    assert.deepEqual(sent[0], { type: 'permission_response', requestId: 'dialog-fixture', allowed: true,
      updatedInput: { sdkDialogResult: { action: 'accept', content: { wire_name: 'Alice', wire_count: 2 } } } })
    props.sent = true
    assert.ok(render().some(n => n.type === 'Submitted'))
    values = []; props.sent = false
    props.dialog = { sdkDialog: true, kind: 'elicitation', mode: 'url', title: 'Login', message: '', url: 'https://login.fixture.invalid/confirm' }
    assert.equal(button('已完成网页操作').disabled, true)
    button('打开网页').onPress()
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.deepEqual(opened, ['https://login.fixture.invalid/confirm'])
    assert.equal(button('已完成网页操作').disabled, false)
    button('已完成网页操作').onPress()
    assert.deepEqual(sent[1].updatedInput, { sdkDialogResult: { action: 'accept', openedUrl: props.dialog.url } })
  `
  const path = join(dir, 'render.ts')
  writeFileSync(path, script)
  try { expect(execFileSync(process.execPath, [path], { cwd: dir, encoding: 'utf8' })).toBe('') }
  finally { rmSync(dir, { recursive: true, force: true }) }
})
