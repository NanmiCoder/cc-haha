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
        { question: 'Color?', header: 'Color', options: [{ label: 'Blue' }, { label: 'Red (recommended)', description: 'More prominent' }] },
        { question: 'Device?', header: 'Device', multiSelect: true, options: [{ label: 'iOS' }, { label: 'Android' }] },
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
    assert.equal(has('Previous'), false)
    assert.equal(find('Next question').disabled, true)
    press('Blue')
    assert.equal(find('Blue').accessibilityState.checked, true)
    assert.equal(find('Next question').disabled, false)
    assert.equal(has('Device?'), false)
    press('Red, more prominent')
    assert.equal(find('Blue').accessibilityState.checked, false)
    press('Next question')

    // Question 2: multiple choice, last question submits.
    assert.equal(has('Previous'), true)
    assert.equal(find('Submit').disabled, true)
    press('iOS')
    press('Android')
    assert.equal(find('iOS').accessibilityState.checked, true)
    press('Previous')
    assert.equal(find('Red, more prominent').accessibilityState.checked, true, 'earlier answer is kept')
    press('Next question')
    assert.equal(submissions, 0, 'nothing is submitted before the final step')

    // A custom answer replaces the choices, and clearing it makes submit unavailable again.
    press('Other, I will say it myself')
    find('Your own answer 2').onChangeText('Only iOS')
    assert.equal(find('iOS').accessibilityState.checked, false)
    find('Your own answer 2').onChangeText('')
    assert.equal(find('Submit').disabled, true)
    find('Your own answer 2').onChangeText('Only iOS')

    props.ready = false
    assert.equal(find('Submit').disabled, true)
    assert.equal(find('Discuss first').disabled, true)
    props.ready = true
    press('Submit')
    assert.deepEqual(submitted, { 'Color?': 'Red (recommended)', 'Device?': 'Only iOS' })
    assert.equal(submissions, 1)
    assert.equal(closed, 1, 'page closes after a successful submit')
    assert.ok(activities > 0 && interactions === activities)

    // Once sent, the buttons give way to the submitted row.
    props.sent = true
    assert.equal(has('Submit'), false)
    assert.ok(render().some((n) => n.type === 'SubmittedRow'))
  `)
})

test('truncated Chinese and English details expand independently without choosing or submitting answers', () => {
  checkQuestionPage(`
    const chinese = 'This is a Chinese option description that needs to be read in full.'.repeat(16) + 'End of the Chinese description.'
    const english = 'Read the entire option before deciding; inspecting details must keep your answer unchanged. '.repeat(12) + 'End of English details.'
    let submissions = 0, closed = 0, activities = 0, interactions = 0, submitted
    const props = {
      visible: true, onClose: () => { closed++ },
      request: { requestId: 'details', toolName: 'AskUserQuestion' },
      input: { questions: [
        { question: 'Single choice?', options: [
          { label: 'Chinese', description: chinese }, { label: 'English', description: english },
          { label: 'Short description', description: 'Full short description' }, { label: 'No description' },
        ] },
        { question: 'Multiple choice?', multiSelect: true, options: [
          { label: 'Chinese', description: chinese }, { label: 'English', description: english },
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
    layout('Full short description', 18, 18)

    // Before this fix, both descriptions were permanently clamped at two lines.
    assert.equal(description(chinese).props.numberOfLines, 2)
    const expand = find('Expand details of “Chinese”')
    assert.equal(expand.props.accessibilityState.expanded, false)
    assert.equal(expand.props['aria-expanded'], false, 'RN Web needs the explicit expanded state')
    assert.ok(!expand.ancestors.some((node) => ['radio', 'checkbox'].includes(node.props?.accessibilityRole)), 'details must not be nested inside a choice control')
    assert.ok(!render().some((n) => n.props?.accessibilityLabel === 'Expand details of “Short description”'))
    assert.ok(!render().some((n) => n.props?.accessibilityLabel === 'Expand details of “No description”'))
    press('Expand details of “Chinese”')
    assert.ok(!description(chinese).props.numberOfLines, 'expanded Chinese text has no line limit')
    assert.equal(find('Collapse details of “Chinese”').props.accessibilityState.expanded, true)
    assert.equal(find('Collapse details of “Chinese”').props['aria-expanded'], true)
    assert.equal(choice('Chinese').accessibilityState.checked, false)
    assert.equal(find('Next question').props.disabled, true)
    assert.equal(activities, 1, 'inspection uses the existing human-activity signal')
    assert.equal(interactions, 1)
    assert.equal(description(english).props.numberOfLines, 2, 'each option expands separately')
    press('Expand details of “English”')
    assert.ok(!description(english).props.numberOfLines)
    assert.equal(submissions, 0)
    assert.equal(closed, 0)
    press('Collapse details of “Chinese”')
    assert.equal(description(chinese).props.numberOfLines, 2)
    assert.equal(find('Expand details of “Chinese”').props['aria-expanded'], false)
    choice('Chinese').onPress()
    press('Expand details of “Chinese”')
    assert.equal(choice('Chinese').accessibilityState.checked, true, 'inspecting selected option preserves selection')
    press('Next question')
    layout(chinese, 288, 36)
    layout(english, 324, 36)
    assert.equal(description(chinese).props.numberOfLines, 2, 'another question with the same labels starts collapsed')
    choice('Chinese').onPress()
    choice('English').onPress()
    press('Expand details of “Chinese”')
    assert.equal(choice('Chinese').accessibilityState.checked, true)
    assert.equal(choice('English').accessibilityState.checked, true)
    assert.equal(submissions, 0)
    press('Previous')
    assert.equal(choice('Chinese').accessibilityState.checked, true)
    press('Next question')
    press('Other, I will say it myself')
    find('Your own answer 2').props.onChangeText('Custom answer')
    assert.equal(choice('Chinese').accessibilityState.checked, false)
    assert.equal(choice('English').accessibilityState.checked, false)
    const toggle = render().find((n) => n.props?.accessibilityLabel === 'Expand details of “English”')
    toggle.props.onPress()
    assert.equal(find('Your own answer 2').props.value, 'Custom answer')
    assert.equal(choice('English').accessibilityState.checked, false)

    // Offline and submitted choices stay locked; details remain readable.
    props.ready = false
    assert.equal(choice('English').disabled, true)
    const beforeOffline = activities
    press('Collapse details of “English”')
    assert.equal(activities, beforeOffline)
    props.ready = true
    press('Submit')
    assert.deepEqual(submitted, { 'Single choice?': 'Chinese', 'Multiple choice?': 'Custom answer' })
    assert.equal(submissions, 1)
    props.sent = true
    assert.equal(choice('Chinese').disabled, true)
    press('Expand details of “English”')
    assert.ok(!description(english).props.numberOfLines)
    assert.equal(submissions, 1)

    // The same short text can become truncated in a smaller viewport / larger font.
    props.sent = false
    press('Previous')
    layout('Full short description', 72, 36, 90)
    assert.ok(find('Expand details of “Short description”'))
    layout('Full short description', 18, 18, 600)
    assert.ok(!render().some((n) => n.props?.accessibilityLabel === 'Expand details of “Short description”'))
    for (const node of render().filter((n) => n.props?.['aria-hidden'])) {
      assert.equal(node.props.accessible, false, 'measurement text is hidden from accessibility')
      assert.ok(node.ancestors.some((ancestor) => ancestor.props?.style?.overflow === 'hidden'), 'measurement text cannot extend collapsed scroll content')
    }
  `)
})
