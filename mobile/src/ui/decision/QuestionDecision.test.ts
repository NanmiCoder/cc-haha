import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { test } from 'bun:test'

function checkQuestionPage(body: string, platform: 'ios' | 'android' | 'web' = 'ios') {
  const dir = mkdtempSync(join(tmpdir(), 'mobile-question-render-'))
  const script = `
    import { mock } from 'bun:test'
    import assert from 'node:assert/strict'
    let cursor = 0
    let values = []
    const instances = new Map()
    mock.module(${JSON.stringify(import.meta.resolve('react'))}, () => ({
      useEffect: () => {},
      useRef: (initial) => {
        const slot = cursor++
        const state = values
        if (!(slot in state)) state[slot] = { current: initial }
        return state[slot]
      },
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
      Platform: { OS: ${JSON.stringify(platform)}, select: (values) => values[${JSON.stringify(platform)}] ?? values.default }, Modal: 'Modal', Pressable: 'Pressable', ScrollView: 'ScrollView', TextInput: 'TextInput', View: 'View',
    }))
    mock.module(${JSON.stringify(import.meta.resolve('react-native-safe-area-context'))}, () => ({ SafeAreaView: 'SafeAreaView', useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }))
    mock.module(${JSON.stringify(import.meta.resolve('../kit'))}, () => ({
      Button: 'Button', HaloDot: 'HaloDot', Icon: 'Icon', InlineError: 'InlineError', Sheet: 'Sheet', Spinner: 'Spinner', TextButton: 'TextButton', useColors: () => ({ bg: '#F4F3F0' }),
    }))
    mock.module(${JSON.stringify(import.meta.resolve('../theme'))}, () => ({
      useTheme: () => ({ colors: { bg: '#F4F3F0' }, shadows: {}, dark: false, scheme: 'light' }),
    }))
    mock.module(${JSON.stringify(import.meta.resolve('../KeyboardViewport'))}, () => ({ KeyboardViewport: 'KeyboardViewport' }))
    mock.module(${JSON.stringify(import.meta.resolve('../Text'))}, () => ({ Text: 'Text' }))
    mock.module(${JSON.stringify(import.meta.resolve('./parts'))}, () => ({
      CountdownPill: 'CountdownPill', NoteInput: 'NoteInput', SubmittedRow: 'SubmittedRow', webNoOutline: {},
    }))
    const { QuestionDecision, QuestionPage } = require(${JSON.stringify(import.meta.resolve('./QuestionDecision'))})
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
    const renderDecision = (props) => flat({ type: QuestionDecision, props })
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

test('discuss sheet renders inline as a sibling of SafeAreaView/KeyboardViewport, resets on close, and reports send failures in-page', () => {
  checkQuestionPage(`
    let closed = 0, allowSubmit = true, allowDiscuss = true
    const notes = []
    const props = {
      visible: true,
      onClose: () => { closed++ },
      request: { requestId: 'discuss', toolName: 'AskUserQuestion' },
      input: { questions: [{ question: '怎么改？', options: [{ label: '方案 A' }] }] },
      ready: true,
      sent: false,
      signalActivity: () => true,
      submit: () => allowSubmit,
      discuss: (text) => { notes.push(text); return allowDiscuss },
    }
    const render = () => renderPage(props)
    const modal = () => render().find((n) => n.type === 'Modal')
    const sheet = () => render().find((n) => n.type === 'Sheet')
    const safeArea = () => render().find((n) => n.type === 'SafeAreaView')
    const errors = () => render().filter((n) => n.type === 'InlineError' && n.props?.text)

    // iOS uses overFullScreen + themed backdropColor so root view stays attached without white flash.
    assert.equal(modal().props.presentationStyle, 'overFullScreen')
    assert.equal(modal().props.backdropColor, '#F4F3F0')
    assert.equal(sheet().props.inline, true, 'discuss sheet must stay inline inside QuestionPage Modal')
    assert.equal(sheet().props.visible, false)
    assert.ok(!sheet().ancestors.some((a) => a.type === 'SafeAreaView' || a.type === 'KeyboardViewport'), 'inline Sheet must stay outside SafeAreaView and KeyboardViewport')

    // Failed submit keeps page open and renders in-page error; choosing again clears it.
    render().find((n) => n.props?.accessibilityLabel === '方案 A').props.onPress()
    allowSubmit = false
    render().find((n) => n.props?.accessibilityLabel === '提交').props.onPress()
    assert.equal(closed, 0)
    assert.equal(errors().length, 1)
    assert.ok(errors()[0].props.text.includes('尚未发出'))
    render().find((n) => n.props?.accessibilityLabel === '方案 A').props.onPress()
    assert.equal(errors().length, 0)

    // Opening discuss hides underlying question tree from accessibility and intercepts back close first.
    render().find((n) => n.props?.accessibilityLabel === '先讨论一下').props.onPress()
    assert.equal(sheet().props.visible, true)
    assert.equal(safeArea().props.accessibilityElementsHidden, true)
    assert.equal(safeArea().props.importantForAccessibility, 'no-hide-descendants')
    assert.equal(safeArea().props['aria-hidden'], true)

    // Whitespace-only note keeps 发送说明 disabled; offline/sent also disables it.
    render().find((n) => n.props?.accessibilityLabel === '告诉它还需要澄清什么').props.onChangeText('   ')
    assert.equal(sheet().props.footer.props.disabled, true)
    render().find((n) => n.props?.accessibilityLabel === '告诉它还需要澄清什么').props.onChangeText('先别改，按方案 B 来')
    assert.equal(sheet().props.footer.props.disabled, false)
    props.ready = false
    assert.equal(sheet().props.footer.props.disabled, true)
    props.ready = true
    props.sent = true
    assert.equal(sheet().props.footer.props.disabled, true)
    props.sent = false

    // Failed discuss keeps sheet open, preserves note, does not close QuestionPage, and renders InlineError.
    allowDiscuss = false
    sheet().props.footer.props.onPress()
    assert.equal(sheet().props.visible, true)
    assert.equal(closed, 0)
    assert.equal(render().find((n) => n.props?.accessibilityLabel === '告诉它还需要澄清什么').props.value, '先别改，按方案 B 来')
    assert.equal(errors().length, 1)

    // First back/requestClose dismisses the inline discuss sheet and restores underlying accessibility.
    modal().props.onRequestClose()
    assert.equal(sheet().props.visible, false)
    assert.equal(safeArea().props.accessibilityElementsHidden, false)
    assert.equal(safeArea().props.importantForAccessibility, 'auto')
    assert.equal(safeArea().props['aria-hidden'], false)
    assert.equal(errors().length, 0)
    assert.equal(closed, 0)

    // External visible=false or pressing 收起 resets discussOpen so reopening starts clean.
    render().find((n) => n.props?.accessibilityLabel === '先讨论一下').props.onPress()
    assert.equal(sheet().props.visible, true)
    props.visible = false
    assert.equal(sheet().props.visible, false, 'setting visible=false resets discussOpen')
    props.visible = true
    assert.equal(sheet().props.visible, false)

    render().find((n) => n.props?.accessibilityLabel === '先讨论一下').props.onPress()
    render().find((n) => n.props?.accessibilityLabel === '收起').props.onPress()
    assert.equal(sheet().props.visible, false, 'pressing 收起 resets discussOpen')
    assert.equal(closed, 1)

    // Submitting a discuss note sends it, closes the inline sheet, and closes QuestionPage.
    allowDiscuss = true
    render().find((n) => n.props?.accessibilityLabel === '先讨论一下').props.onPress()
    sheet().props.footer.props.onPress()
    assert.deepEqual(notes, ['先别改，按方案 B 来', '先别改，按方案 B 来'])
    assert.equal(sheet().props.visible, false)
    assert.equal(closed, 2)
  `)

  // Non-iOS leaves presentationStyle undefined; Web sets inert on the underlying SafeAreaView.
  checkQuestionPage(`
    const props = {
      visible: true, onClose: () => {},
      request: { requestId: 'android', toolName: 'AskUserQuestion' },
      input: { questions: [{ question: '平台？', options: [{ label: 'Android' }] }] },
      ready: true, sent: false, signalActivity: () => true, submit: () => true, discuss: () => true,
    }
    const modal = renderPage(props).find((n) => n.type === 'Modal')
    assert.equal(modal.props.presentationStyle, undefined)
  `, 'android')

  checkQuestionPage(`
    const props = {
      visible: true, onClose: () => {},
      request: { requestId: 'web', toolName: 'AskUserQuestion' },
      input: { questions: [{ question: '网页？', options: [{ label: '是' }] }] },
      ready: true, sent: false, signalActivity: () => true, submit: () => true, discuss: () => true,
    }
    const safeArea = () => renderPage(props).find((n) => n.type === 'SafeAreaView')
    assert.equal(safeArea().props.inert, undefined)
    renderPage(props).find((n) => n.props?.accessibilityLabel === '先讨论一下').props.onPress()
    assert.equal(safeArea().props.inert, true, 'web marks underlying SafeAreaView inert while inline sheet is open')
    assert.equal(safeArea().props['aria-hidden'], true)
  `, 'web')
})

test('QuestionDecision defers iOS reopen during mid-dismissal animation until onDismiss completes', () => {
  checkQuestionPage(`
    const props = {
      request: { requestId: 'reopen', toolName: 'AskUserQuestion' },
      input: { questions: [{ question: '确认？', options: [{ label: '好' }] }] },
      ready: true, sent: false, signalActivity: () => true, submit: () => true, discuss: () => true,
    }
    const modal = () => renderDecision(props).find((n) => n.type === 'Modal')
    const prompt = () => renderDecision(props).find((n) => n.props?.accessibilityLabel === '有 1 个问题等你回答')

    assert.equal(modal().props.visible, false)
    prompt().props.onPress()
    assert.equal(modal().props.visible, true)

    // Close starts iOS native dismissal; tapping prompt before onDismiss must defer, not force visible=true mid-transition.
    renderDecision(props).find((n) => n.props?.accessibilityLabel === '收起').props.onPress()
    assert.equal(modal().props.visible, false)
    prompt().props.onPress()
    assert.equal(modal().props.visible, false, 'wait for native onDismiss before reopening on iOS')

    // Once onDismiss fires, the pending reopen opens cleanly.
    modal().props.onDismiss()
    assert.equal(modal().props.visible, true)
  `)
})

test('allowFreeText: false hides custom input and discuss button while still submitting fixed options and showing subagent attribution', () => {
  checkQuestionPage(`
    let submitted
    const props = {
      visible: true,
      onClose: () => {},
      request: { requestId: 'ag-q', toolName: 'AskUserQuestion', subagentName: '@verifier' },
      input: {
        allowFreeText: false,
        questions: [{ question: '选择方案？', options: [{ label: '方案 A' }, { label: '方案 B' }] }],
      },
      ready: true,
      sent: false,
      signalActivity: () => true,
      submit: (answers) => { submitted = answers; return true },
      discuss: () => true,
    }
    const render = () => renderPage(props)
    const has = (label) => render().some((n) => n.props?.accessibilityLabel === label)
    assert.equal(has('其他，我自己说'), false, 'fixed-option question hides free text option')
    assert.equal(has('先讨论一下'), false, 'fixed-option question hides discuss action')
    assert.ok(JSON.stringify(render()).includes('来自 @verifier'), 'page shows subagent attribution')
    render().find((n) => n.props?.accessibilityLabel === '方案 B').props.onPress()
    render().find((n) => n.props?.accessibilityLabel === '提交').props.onPress()
    assert.deepEqual(submitted, { '选择方案？': '方案 B' })

    const decisionTree = renderDecision(props)
    assert.ok(
      decisionTree.some((n) => n.props?.accessibilityLabel === '@verifier：有 1 个问题等你回答'),
      'prompt row includes subagent attribution'
    )
  `)
})

test('real QuestionPage + real Sheet mounts only one native Modal and unmounts NoteInput when discuss is closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mobile-sheet-inline-'))
  const script = `
    import { mock } from 'bun:test'
    import assert from 'node:assert/strict'
    let cursor = 0
    let values = []
    const instances = new Map()
    const effects = []
    mock.module(${JSON.stringify(import.meta.resolve('react'))}, () => ({
      default: {
        useRef: (initial) => {
          const slot = cursor++
          const state = values
          if (!(slot in state)) state[slot] = { current: initial }
          return state[slot]
        },
      },
      useEffect: (fn) => { effects.push(fn) },
      useMemo: (fn) => fn(),
      useRef: (initial) => {
        const slot = cursor++
        const state = values
        if (!(slot in state)) state[slot] = { current: initial }
        return state[slot]
      },
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
      AccessibilityInfo: { announceForAccessibility: () => {} },
      ActivityIndicator: 'ActivityIndicator',
      Animated: { Value: class {}, timing: () => ({ start: () => {} }), loop: () => ({ start: () => {}, stop: () => {} }), View: 'AnimatedView' },
      Easing: { inOut: () => () => 0, sin: () => 0 },
      FlatList: 'FlatList',
      Modal: 'Modal',
      Platform: { OS: 'ios', select: (values) => values.ios ?? values.default },
      Pressable: 'Pressable',
      ScrollView: 'ScrollView',
      TextInput: 'TextInput',
      View: 'View',
      useWindowDimensions: () => ({ width: 390, height: 844 }),
    }))
    mock.module(${JSON.stringify(import.meta.resolve('react-native-safe-area-context'))}, () => ({
      SafeAreaView: 'SafeAreaView',
      useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
    }))
    mock.module(${JSON.stringify(import.meta.resolve('react-native-svg'))}, () => ({
      default: 'Svg',
      Circle: 'Circle',
      Path: 'Path',
      Rect: 'Rect',
    }))
    mock.module(${JSON.stringify(import.meta.resolve('expo-router'))}, () => ({ router: { canGoBack: () => false, back: () => {}, replace: () => {} } }))
    mock.module(${JSON.stringify(import.meta.resolve('../theme'))}, () => ({
      useTheme: () => ({ colors: { bg: '#F4F3F0', card: '#fff', cardRaised: '#fff', scrim: 'rgba(0,0,0,0.4)', sheet: '#fff', chevron: '#999', ink: '#111', ink2: '#333', ink3: '#666', hair: '#ddd', fill: '#eee', run: '#2563eb', btn: '#111', btnInk: '#fff' }, shadows: { sheetUp: '0 -8px 28px rgba(0,0,0,0.10)' }, dark: false, scheme: 'light' }),
    }))
    mock.module(${JSON.stringify(import.meta.resolve('../KeyboardViewport'))}, () => ({ KeyboardViewport: 'KeyboardViewport' }))
    mock.module(${JSON.stringify(import.meta.resolve('../Text'))}, () => ({ Text: 'Text' }))
    mock.module(${JSON.stringify(import.meta.resolve('../icons'))}, () => ({ Icon: 'Icon' }))
    const { PageSheet, Sheet } = require(${JSON.stringify(import.meta.resolve('../kit'))})
    const { QuestionPage } = require(${JSON.stringify(import.meta.resolve('./QuestionDecision'))})
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

    // 1. Standalone Sheet inline vs default Modal
    assert.equal(flat({ type: Sheet, props: { visible: false, inline: true, onClose: () => {}, children: 'body' } }).length, 0)
    let closed = 0
    const inlineTree = flat({ type: Sheet, props: { visible: true, inline: true, onClose: () => { closed++ }, title: '先讨论一下', children: 'body' } })
    assert.equal(inlineTree.some((n) => n.type === 'Modal'), false, 'inline Sheet must not mount a nested native Modal')
    assert.equal(inlineTree[0].props.style.position, 'absolute')
    const dialog = inlineTree.find((n) => n.props?.role === 'dialog')
    assert.ok(dialog && dialog.props['aria-modal'] === true && dialog.props['aria-label'] === '先讨论一下')
    inlineTree.find((n) => n.props?.accessibilityLabel === '关闭').props.onPress()
    assert.equal(closed, 1)

    const lockedTree = flat({ type: Sheet, props: { visible: true, inline: true, dismissable: false, onClose: () => { closed++ }, children: 'body' } })
    lockedTree.find((n) => n.props?.accessibilityLabel === '关闭').props.onPress()
    assert.equal(closed, 1, 'inline Sheet respects dismissable=false')

    const modalTree = flat({ type: Sheet, props: { visible: true, onClose: () => {}, title: '普通弹层', children: 'body' } })
    assert.equal(modalTree[0].type, 'Modal', 'default Sheet still renders Modal')

    // 2. Integrated QuestionPage + real Sheet: always exactly 1 Modal, NoteInput unmounted until discuss opens
    const qProps = {
      visible: true, onClose: () => {},
      request: { requestId: 'real', toolName: 'AskUserQuestion' },
      input: { questions: [{ question: '继续？', options: [{ label: '是' }] }] },
      ready: true, sent: false, signalActivity: () => true, submit: () => true, discuss: () => true,
    }
    let tree = flat({ type: QuestionPage, props: qProps })
    assert.equal(tree.filter((n) => n.type === 'Modal').length, 1)
    assert.equal(tree.some((n) => n.props?.accessibilityLabel === '告诉它还需要澄清什么'), false, 'NoteInput must not mount while discuss is closed')

    tree.find((n) => n.props?.accessibilityLabel === '先讨论一下').props.onPress()
    tree = flat({ type: QuestionPage, props: qProps })
    assert.equal(tree.filter((n) => n.type === 'Modal').length, 1, 'opening discuss still mounts only 1 native Modal')
    assert.equal(tree.some((n) => n.props?.accessibilityLabel === '告诉它还需要澄清什么'), true, 'NoteInput mounts once discuss opens')

    // 3. PageSheet overlay slot closes overlay before closing PageSheet
    let overlayClosed = 0, pageClosed = 0
    const psTree = flat({
      type: PageSheet,
      props: {
        visible: true,
        onClose: () => { pageClosed++ },
        title: '计划',
        overlayOpen: true,
        onOverlayClose: () => { overlayClosed++ },
        overlay: { type: Sheet, props: { inline: true, visible: true, onClose: () => {}, title: '执行模型', children: 'pick' } },
        children: 'plan',
      },
    })
    assert.equal(psTree.filter((n) => n.type === 'Modal').length, 1, 'PageSheet with inline overlay renders only 1 Modal')
    psTree.find((n) => n.type === 'Modal').props.onRequestClose()
    assert.equal(overlayClosed, 1)
    assert.equal(pageClosed, 0)
  `
  const scriptPath = join(dir, 'sheet.ts')
  writeFileSync(scriptPath, script)
  try {
    execFileSync(process.execPath, [scriptPath], { cwd: dir, encoding: 'utf8' })
  } catch (error) {
    const failure = error as { stderr?: string; stdout?: string; signal?: string; status?: number }
    throw new Error(`${failure.status} ${failure.signal || ''} ${failure.stderr || ''} ${failure.stdout || ''}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
