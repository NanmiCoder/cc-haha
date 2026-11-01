import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { test } from 'bun:test'

function checkQuestionPage(body: string) {
  const dir = mkdtempSync(join(tmpdir(), 'mobile-question-render-'))
  const script = `
    import { mock } from 'bun:test'
    import assert from 'node:assert/strict'
    let cursor = 0
    let values = []
    const instances = new Map()
    mock.module(${JSON.stringify(import.meta.resolve('react'))}, () => ({
      useEffect: () => {},
      useState: (initial) => {
        const slot = cursor++
        const state = values
        if (!(slot in state)) state[slot] = typeof initial === 'function' ? initial() : initial
        return [state[slot], (next) => { state[slot] = typeof next === 'function' ? next(state[slot]) : next }]
      },
    }))
    const jsx = (type, props, key) => ({ type, props, key })
    mock.module(${JSON.stringify(import.meta.resolve('react/jsx-dev-runtime'))}, () => ({ jsxDEV: jsx, Fragment: 'Fragment' }))
    mock.module(${JSON.stringify(import.meta.resolve('react/jsx-runtime'))}, () => ({ jsx, jsxs: jsx, Fragment: 'Fragment' }))
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
    // Keep each function component's hooks separate, including keyed option rows.
    const flat = (node, path = 'root', ancestors = []) => {
      if (!node || typeof node !== 'object') return []
      if (Array.isArray(node)) return node.flatMap((child, index) => flat(child, path + '/' + (child?.key ?? index), ancestors))
      if (typeof node.type === 'function') {
        const identity = path + '/' + node.type.name
        if (!instances.has(identity)) instances.set(identity, [])
        values = instances.get(identity)
        cursor = 0
        return flat(node.type(node.props), identity, ancestors)
      }
      return [{ ...node, ancestors }, ...flat(node.props?.children, path + '/children', [...ancestors, node])]
    }
    const renderPage = (props) => flat({ type: QuestionPage, props })
    ${body}
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
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('real question page steps through, goes back, takes a custom answer and submits everything once', () => {
  checkQuestionPage(`
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
    const render = () => renderPage(props)
    const find = (label) => {
      const node = render().find((n) => n.props?.accessibilityLabel === label)
      assert.ok(node, 'missing ' + label)
      return node.props
    }
    const has = (label) => render().some((n) => n.props?.accessibilityLabel === label)
    const press = (label) => { const node = find(label); assert.ok(!node.disabled, label + ' is disabled'); node.onPress() }

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
  `)
})

test('truncated Chinese and English details expand independently without choosing or submitting answers', () => {
  checkQuestionPage(`
    const chinese = '这是一段需要完整阅读的中文选项说明。'.repeat(16) + '中文说明末尾。'
    const english = 'Read the entire option before deciding; inspecting details must keep your answer unchanged. '.repeat(12) + 'End of English details.'
    let submissions = 0, closed = 0, activities = 0, interactions = 0, submitted
    const props = {
      visible: true, onClose: () => { closed++ },
      request: { requestId: 'details', toolName: 'AskUserQuestion' },
      input: { questions: [
        { question: '单选？', options: [
          { label: '中文', description: chinese }, { label: 'English', description: english },
          { label: '短说明', description: '完整短说明' }, { label: '无说明' },
        ] },
        { question: '多选？', multiSelect: true, options: [
          { label: '中文', description: chinese }, { label: 'English', description: english },
        ] },
      ] },
      ready: true, sent: false,
      signalActivity: () => { activities++; return true },
      onInteract: () => { interactions++ },
      submit: (answers) => { submissions++; submitted = answers; return true }, discuss: () => true,
    }
    const render = () => renderPage(props)
    const find = (label) => {
      const node = render().find((n) => n.props?.accessibilityLabel === label)
      assert.ok(node, 'missing ' + label)
      return node
    }
    const press = (label) => { const { props: node } = find(label); assert.ok(!node.disabled); node.onPress() }
    const choice = (label) => render().find((n) => ['radio', 'checkbox'].includes(n.props?.accessibilityRole) && n.props.accessibilityLabel.startsWith(label)).props
    const description = (text) => render().find((n) => n.type === 'Text' && n.props.children === text && !n.props['aria-hidden'])
    const layout = (text, full, preview, width = 260) => {
      for (const node of render().filter((n) => n.type === 'Text' && n.props.children === text)) {
        node.props.onLayout?.({ nativeEvent: { layout: { width, height: node.props['aria-hidden'] ? full : preview } } })
      }
    }
    layout(chinese, 288, 36)
    layout(english, 324, 36)
    layout('完整短说明', 18, 18)

    // Before this fix, both descriptions were permanently clamped at two lines.
    assert.equal(description(chinese).props.numberOfLines, 2)
    const expand = find('展开“中文”的详细说明')
    assert.equal(expand.props.accessibilityState.expanded, false)
    assert.equal(expand.props['aria-expanded'], false, 'RN Web needs the explicit expanded state')
    assert.ok(!expand.ancestors.some((node) => ['radio', 'checkbox'].includes(node.props?.accessibilityRole)), 'details must not be nested inside a choice control')
    assert.ok(!render().some((n) => n.props?.accessibilityLabel === '展开“短说明”的详细说明'))
    assert.ok(!render().some((n) => n.props?.accessibilityLabel === '展开“无说明”的详细说明'))
    press('展开“中文”的详细说明')
    assert.ok(!description(chinese).props.numberOfLines, 'expanded Chinese text has no line limit')
    assert.equal(find('收起“中文”的详细说明').props.accessibilityState.expanded, true)
    assert.equal(find('收起“中文”的详细说明').props['aria-expanded'], true)
    assert.equal(choice('中文').accessibilityState.checked, false)
    assert.equal(find('下一题').props.disabled, true)
    assert.equal(activities, 1, 'inspection uses the existing human-activity signal')
    assert.equal(interactions, 1)
    assert.equal(description(english).props.numberOfLines, 2, 'each option expands separately')
    press('展开“English”的详细说明')
    assert.ok(!description(english).props.numberOfLines)
    assert.equal(submissions, 0)
    assert.equal(closed, 0)
    press('收起“中文”的详细说明')
    assert.equal(description(chinese).props.numberOfLines, 2)
    assert.equal(find('展开“中文”的详细说明').props['aria-expanded'], false)
    choice('中文').onPress()
    press('展开“中文”的详细说明')
    assert.equal(choice('中文').accessibilityState.checked, true, 'inspecting selected option preserves selection')
    press('下一题')
    layout(chinese, 288, 36)
    layout(english, 324, 36)
    assert.equal(description(chinese).props.numberOfLines, 2, 'another question with the same labels starts collapsed')
    choice('中文').onPress()
    choice('English').onPress()
    press('展开“中文”的详细说明')
    assert.equal(choice('中文').accessibilityState.checked, true)
    assert.equal(choice('English').accessibilityState.checked, true)
    assert.equal(submissions, 0)
    press('上一题')
    assert.equal(choice('中文').accessibilityState.checked, true)
    press('下一题')
    press('其他，我自己说')
    find('自己写的回答 2').props.onChangeText('自填答案')
    assert.equal(choice('中文').accessibilityState.checked, false)
    assert.equal(choice('English').accessibilityState.checked, false)
    const toggle = render().find((n) => n.props?.accessibilityLabel === '展开“English”的详细说明')
    toggle.props.onPress()
    assert.equal(find('自己写的回答 2').props.value, '自填答案')
    assert.equal(choice('English').accessibilityState.checked, false)

    // Offline and submitted choices stay locked; details remain readable.
    props.ready = false
    assert.equal(choice('English').disabled, true)
    const beforeOffline = activities
    press('收起“English”的详细说明')
    assert.equal(activities, beforeOffline)
    props.ready = true
    press('提交')
    assert.deepEqual(submitted, { '单选？': '中文', '多选？': '自填答案' })
    assert.equal(submissions, 1)
    props.sent = true
    assert.equal(choice('中文').disabled, true)
    press('展开“English”的详细说明')
    assert.ok(!description(english).props.numberOfLines)
    assert.equal(submissions, 1)

    // The same short text can become truncated in a smaller viewport / larger font.
    props.sent = false
    press('上一题')
    layout('完整短说明', 72, 36, 90)
    assert.ok(find('展开“短说明”的详细说明'))
    layout('完整短说明', 18, 18, 600)
    assert.ok(!render().some((n) => n.props?.accessibilityLabel === '展开“短说明”的详细说明'))
    for (const node of render().filter((n) => n.props?.['aria-hidden'])) {
      assert.equal(node.props.accessible, false, 'measurement text is hidden from accessibility')
      assert.ok(node.ancestors.some((ancestor) => ancestor.props?.style?.overflow === 'hidden'), 'measurement text cannot extend collapsed scroll content')
    }
  `)
})
