import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { expect, test } from 'bun:test'

test('real question component navigates, reviews, edits and submits all answers together', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mobile-question-render-'))
  const script = `
    import { mock } from 'bun:test'
    import assert from 'node:assert/strict'
    let cursor = 0
    const values = []
    mock.module(${JSON.stringify(import.meta.resolve('react'))}, () => ({
      useEffect: () => {},
      useState: (initial) => {
        const slot = cursor++
        if (!(slot in values)) values[slot] = typeof initial === 'function' ? initial() : initial
        return [values[slot], (next) => { values[slot] = typeof next === 'function' ? next(values[slot]) : next }]
      },
    }))
    mock.module(${JSON.stringify(import.meta.resolve('react/jsx-dev-runtime'))}, () => ({ jsxDEV: (type, props) => ({ type, props }), Fragment: 'Fragment' }))
    mock.module(${JSON.stringify(import.meta.resolve('react/jsx-runtime'))}, () => ({ jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: 'Fragment' }))
    mock.module(${JSON.stringify(import.meta.resolve('react-native'))}, () => ({
      Platform: { OS: 'ios', select: (values) => values.ios ?? values.default }, Pressable: 'Pressable', ScrollView: 'ScrollView', TextInput: 'TextInput', View: 'View',
      useWindowDimensions: () => ({ height: 844 }),
    }))
    mock.module(${JSON.stringify(import.meta.resolve('../kit'))}, () => ({
      Button: 'Button', CheckMark: 'CheckMark', OptionCard: 'OptionCard', RadioMark: 'RadioMark', Sheet: 'Sheet', TextButton: 'TextButton', useColors: () => ({}),
    }))
    mock.module(${JSON.stringify(import.meta.resolve('../Text'))}, () => ({ Text: 'Text' }))
    mock.module(${JSON.stringify(import.meta.resolve('./parts'))}, () => ({
      CountdownPill: 'CountdownPill', DecisionHeader: 'DecisionHeader', DecisionSurface: 'DecisionSurface', NoteInput: 'NoteInput', QuietButton: 'QuietButton', SubmittedRow: 'SubmittedRow', webNoOutline: {},
    }))
    const { QuestionDecision } = require(${JSON.stringify(import.meta.resolve('./QuestionDecision'))})
    let submitted, activities = 0
    const props = {
      request: { requestId: 'request', toolName: 'AskUserQuestion' },
      input: { questions: [
        { question: '颜色？', header: '颜色', options: [{ label: '蓝色' }, { label: '红色' }] },
        { question: '设备？', header: '设备', multiSelect: true, options: [{ label: 'iOS' }, { label: 'Android' }] },
      ] }, ready: true, sent: false,
      signalActivity: () => { activities++; return true },
      submit: (answers) => { submitted = answers; return true }, discuss: () => true,
    }
    const flat = (node) => !node || typeof node !== 'object' ? [] : Array.isArray(node)
      ? node.flatMap(flat) : [node, ...flat(node.props?.children)]
    const render = () => { cursor = 0; return flat(QuestionDecision(props)) }
    const find = (type, key, value) => {
      const node = render().find((n) => n.type === type && n.props[key] === value)
      assert.ok(node, 'missing ' + value)
      return node.props
    }
    const press = (type, key, value) => { const node = find(type, key, value); assert.ok(!node.disabled); node.onPress() }
    assert.equal(find('Button', 'title', '下一题').disabled, true)
    press('OptionCard', 'title', '蓝色')
    press('Button', 'title', '下一题')
    press('OptionCard', 'title', 'iOS')
    press('OptionCard', 'title', 'Android')
    press('Button', 'title', '确认全部回答')
    assert.equal(submitted, undefined, 'review must not submit')
    assert.equal(find('Button', 'title', '提交回答').disabled, false)
    press('Pressable', 'accessibilityLabel', '修改回答：颜色？')
    press('Pressable', 'accessibilityLabel', '都不对，我自己说')
    find('TextInput', 'accessibilityLabel', '自己写的回答 1').onChangeText('绿色')
    find('TextInput', 'accessibilityLabel', '自己写的回答 1').onChangeText('')
    assert.equal(find('Button', 'title', '下一题').disabled, true)
    assert.equal(find('OptionCard', 'title', '蓝色').selected, false)
    find('TextInput', 'accessibilityLabel', '自己写的回答 1').onChangeText('绿色')
    press('Button', 'title', '下一题')
    assert.equal(find('OptionCard', 'title', 'iOS').selected, true)
    assert.equal(find('OptionCard', 'title', 'Android').selected, true)
    press('Button', 'title', '确认全部回答')
    props.ready = false
    assert.equal(find('Button', 'title', '提交回答').disabled, true)
    props.ready = true
    press('Button', 'title', '提交回答')
    assert.deepEqual(submitted, { '颜色？': '绿色', '设备？': 'iOS, Android' })
    assert.ok(activities > 0)
  `
  const scriptPath = join(dir, 'render.ts')
  writeFileSync(scriptPath, script)
  try {
    try {
      execFileSync(process.execPath, [scriptPath], { cwd: dir, encoding: 'utf8' })
    } catch (error) {
      const failure = error as { stderr?: string; stdout?: string; signal?: string; status?: number }
      throw new Error(`${failure.status} ${failure.signal || ''} ${failure.stderr || ''} ${failure.stdout || ''}`)
    }
    expect(true).toBe(true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
