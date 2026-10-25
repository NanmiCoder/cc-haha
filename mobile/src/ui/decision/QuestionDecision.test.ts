import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { expect, test } from 'bun:test'

test('real question page steps through, goes back, takes a custom answer and submits everything once', () => {
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
      Platform: { OS: 'ios', select: (values) => values.ios ?? values.default }, Modal: 'Modal', Pressable: 'Pressable', ScrollView: 'ScrollView', TextInput: 'TextInput', View: 'View',
    }))
    mock.module(${JSON.stringify(import.meta.resolve('react-native-safe-area-context'))}, () => ({ SafeAreaView: 'SafeAreaView', useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }))
    mock.module(${JSON.stringify(import.meta.resolve('../kit'))}, () => ({
      Button: 'Button', HaloDot: 'HaloDot', Icon: 'Icon', Sheet: 'Sheet', Spinner: 'Spinner', TextButton: 'TextButton', useColors: () => ({}),
    }))
    mock.module(${JSON.stringify(import.meta.resolve('../KeyboardViewport'))}, () => ({ KeyboardViewport: 'KeyboardViewport' }))
    mock.module(${JSON.stringify(import.meta.resolve('../Text'))}, () => ({ Text: 'Text' }))
    mock.module(${JSON.stringify(import.meta.resolve('./parts'))}, () => ({
      CountdownPill: 'CountdownPill', NoteInput: 'NoteInput', SubmittedRow: 'SubmittedRow', webNoOutline: {},
    }))
    const { QuestionPage } = require(${JSON.stringify(import.meta.resolve('./QuestionDecision'))})
    let submitted, submissions = 0, closed = 0, activities = 0, interactions = 0
    const props = {
      visible: true, onClose: () => { closed++ },
      request: { requestId: 'request', toolName: 'AskUserQuestion' },
      input: { questions: [
        { question: '颜色？', header: '颜色', options: [{ label: '蓝色' }, { label: '红色（推荐）', description: '更醒目' }] },
        { question: '设备？', header: '设备', multiSelect: true, options: [{ label: 'iOS' }, { label: 'Android' }] },
      ] }, ready: true, sent: false,
      signalActivity: () => { activities++; return true },
      onInteract: () => { interactions++ },
      submit: (answers) => { submissions++; submitted = answers; return true }, discuss: () => true,
    }
    // Function components (option rows, marks) are expanded the way React would.
    const flat = (node) => !node || typeof node !== 'object' ? [] : Array.isArray(node)
      ? node.flatMap(flat) : typeof node.type === 'function' ? flat(node.type(node.props)) : [node, ...flat(node.props?.children)]
    const render = () => { cursor = 0; return flat(QuestionPage(props)) }
    const find = (label) => {
      const node = render().find((n) => n.props?.accessibilityLabel === label)
      assert.ok(node, 'missing ' + label)
      return node.props
    }
    const has = (label) => render().some((n) => n.props?.accessibilityLabel === label)
    const press = (label) => { const node = find(label); assert.ok(!node.disabled, label + ' is disabled'); node.onPress() }
    const titleOf = () => render().find((n) => n.props?.accessibilityRole === 'header' && n.props.numberOfLines === 1)

    // Question 1: single choice does not advance by itself.
    assert.equal(has('上一题'), false)
    assert.equal(find('下一题').disabled, true)
    press('蓝色')
    assert.equal(find('蓝色').accessibilityState.checked, true)
    assert.equal(find('下一题').disabled, false)
    assert.equal(has('设备？'), false)
    press('红色，更醒目')
    assert.equal(find('蓝色').accessibilityState.checked, false)
    press('下一题')

    // Question 2: multiple choice, last question submits.
    assert.equal(has('上一题'), true)
    assert.equal(find('提交').disabled, true)
    press('iOS')
    press('Android')
    assert.equal(find('iOS').accessibilityState.checked, true)
    press('上一题')
    assert.equal(find('红色，更醒目').accessibilityState.checked, true, 'earlier answer is kept')
    press('下一题')
    assert.equal(submissions, 0, 'nothing is submitted before the final step')

    // A custom answer replaces the choices, and clearing it makes submit unavailable again.
    press('其他，我自己说')
    find('自己写的回答 2').onChangeText('只要 iOS')
    assert.equal(find('iOS').accessibilityState.checked, false)
    find('自己写的回答 2').onChangeText('')
    assert.equal(find('提交').disabled, true)
    find('自己写的回答 2').onChangeText('只要 iOS')

    props.ready = false
    assert.equal(find('提交').disabled, true)
    assert.equal(find('先讨论一下').disabled, true)
    props.ready = true
    press('提交')
    assert.deepEqual(submitted, { '颜色？': '红色（推荐）', '设备？': '只要 iOS' })
    assert.equal(submissions, 1)
    assert.equal(closed, 1, 'page closes after a successful submit')
    assert.ok(activities > 0 && interactions === activities)

    // Once sent, the buttons give way to the submitted row.
    props.sent = true
    assert.equal(has('提交'), false)
    assert.ok(render().some((n) => n.type === 'SubmittedRow'))
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
