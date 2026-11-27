import { execFileSync } from 'node:child_process'
import { expect, test } from 'bun:test'

test('provider and model popup searches large lists, drills down, and applies without an effort section', () => {
  // Render the actual component with isolated native substitutes. Exercise its
  // search and row actions; the device smoke check proves native popup sizing.
  const script = `
    import { mock } from 'bun:test'
    import assert from 'node:assert/strict'
    const React = require(${JSON.stringify(import.meta.resolve('react'))})
    let states = [], cursor = 0
    mock.module(${JSON.stringify(import.meta.resolve('react'))}, () => ({
      ...React, default: React,
      useState(initial) {
        const i = cursor++
        if (!(i in states)) states[i] = initial
        return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value }]
      },
    }))
    mock.module(${JSON.stringify(import.meta.resolve('react-native'))}, () => ({
      View: 'View', FlatList: 'FlatList', useWindowDimensions: () => ({ height: 844 }),
    }))
    mock.module(${JSON.stringify(import.meta.resolve('./Text'))}, () => ({ Text: 'Text' }))
    mock.module(${JSON.stringify(import.meta.resolve('./kit'))}, () => ({
      Button: 'Button', Callout: 'Callout', InlineError: 'InlineError', Loading: 'Loading',
      Sheet: 'Sheet', SearchField: 'SearchField', TextButton: 'TextButton', useColors: () => ({}),
    }))
    mock.module(${JSON.stringify(import.meta.resolve('./newtask/ChoiceRow'))}, () => ({ ChoiceRow: 'ChoiceRow' }))
    mock.module(${JSON.stringify(import.meta.resolve('./theme'))}, () => ({ errorText: String }))
    const { RuntimeChoiceView } = require(${JSON.stringify(import.meta.resolve('./RuntimePicker'))})
    const { runtimeModelSelection } = require(${JSON.stringify(import.meta.resolve('../core/runtimeCatalog'))})
    const choice = {
      directory: { sources: Array.from({ length: 100 }, (_, i) => ({ id: 'p' + i, name: 'Provider ' + i, auth: 'ready' })) },
      providerId: 'p0', source: { name: 'Provider 0', auth: 'ready' }, modelId: '',
      models: [{ id: 'fast', name: 'Fast', supportedReasoningEfforts: ['low', 'high'] }, { id: 'deep', name: 'Deep' }],
      catalogReady: true, error: '', loading: false,
      selectProvider(id) { choice.providerId = id; choice.source = choice.directory.sources.find(s => s.id === id) },
      selectModel(id) { choice.modelId = id },
      selectConfig(model) { return runtimeModelSelection(choice.providerId, model, { effortLevel: 'high' }) },
      reload() {},
    }
    let applied
    function render() { cursor = 0; return RuntimeChoiceView({ choice, onApply: (value) => { applied = value } }) }
    function find(root, type) {
      if (!root || typeof root !== 'object') return
      if (root.type === type) return root
      for (const child of [root.props?.children].flat(Infinity)) { const result = find(child, type); if (result) return result }
    }
    let root = render()
    assert.ok(root.props.style.height < 844 * 0.6)
    assert.equal(find(root, 'FlatList').props.data.length, 100)
    find(root, 'SearchField').props.onChangeText('Provider 99')
    root = render()
    const providers = find(root, 'FlatList')
    assert.equal(providers.props.data.length, 1)
    providers.props.renderItem({ item: providers.props.data[0] }).props.onPress()
    root = render()
    assert.equal(find(root, 'SearchField').props.value, '')
    assert.equal(find(root, 'SearchField').props.placeholder, '搜索模型')
    const models = find(root, 'FlatList')
    assert.equal(models.props.data.length, 2)
    models.props.renderItem({ item: models.props.data[0] }).props.onPress()
    assert.deepEqual(applied, { providerId: 'p99', modelId: 'fast', effortLevel: 'high' })
    assert.ok(!JSON.stringify(root).includes('思考强度'))
    find(root, 'SearchField').props.onChangeText('missing')
    assert.equal(find(render(), 'FlatList').props.data.length, 0)
    // Missing auth shows its explanation and no selectable models.
    choice.source.auth = 'missing'
    assert.equal(find(render(), 'FlatList'), undefined)
  `
  expect(() => execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })).not.toThrow()
})

test('locked Antigravity view starts on models, hides provider back button, shows login guidance and refreshes on demand', () => {
  const script = `
    import { mock } from 'bun:test'
    import assert from 'node:assert/strict'
    const React = require(${JSON.stringify(import.meta.resolve('react'))})
    let states = [], cursor = 0
    mock.module(${JSON.stringify(import.meta.resolve('react'))}, () => ({
      ...React, default: React,
      useState(initial) {
        const i = cursor++
        if (!(i in states)) states[i] = initial
        return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value }]
      },
    }))
    mock.module(${JSON.stringify(import.meta.resolve('react-native'))}, () => ({
      View: 'View', FlatList: 'FlatList', useWindowDimensions: () => ({ height: 844 }),
    }))
    mock.module(${JSON.stringify(import.meta.resolve('./Text'))}, () => ({ Text: 'Text' }))
    mock.module(${JSON.stringify(import.meta.resolve('./kit'))}, () => ({
      Button: 'Button', Callout: 'Callout', InlineError: 'InlineError', Loading: 'Loading',
      Sheet: 'Sheet', SearchField: 'SearchField', TextButton: 'TextButton', useColors: () => ({}),
    }))
    mock.module(${JSON.stringify(import.meta.resolve('./newtask/ChoiceRow'))}, () => ({ ChoiceRow: 'ChoiceRow' }))
    mock.module(${JSON.stringify(import.meta.resolve('./theme'))}, () => ({ errorText: String }))
    const { RuntimeChoiceView } = require(${JSON.stringify(import.meta.resolve('./RuntimePicker'))})
    const { ANTIGRAVITY_LOGIN_GUIDANCE, ANTIGRAVITY_PROVIDER_ID, runtimeModelSelection } = require(${JSON.stringify(import.meta.resolve('../core/runtimeCatalog'))})
    let refreshed = 0
    const choice = {
      locked: true,
      antigravity: { id: ANTIGRAVITY_PROVIDER_ID, kind: 'acp', status: 'ready', models: [] },
      sources: [{ id: ANTIGRAVITY_PROVIDER_ID, name: 'Antigravity', auth: 'ready', kind: 'acp', runtimeStatus: 'ready' }],
      directory: { sources: [{ id: ANTIGRAVITY_PROVIDER_ID, name: 'Antigravity', auth: 'ready', kind: 'acp', runtimeStatus: 'ready' }] },
      providerId: ANTIGRAVITY_PROVIDER_ID,
      source: { id: ANTIGRAVITY_PROVIDER_ID, name: 'Antigravity', auth: 'ready', kind: 'acp', runtimeStatus: 'ready' },
      modelId: 'gemini-4-neon',
      models: [{ id: 'gemini-4-neon', name: 'Gemini 4 Neon', supportedReasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high' }],
      catalogReady: true, error: '', loading: false, refreshingAntigravity: false,
      selectProvider() {},
      selectModel(id) { choice.modelId = id },
      selectConfig(model) { return runtimeModelSelection(choice.providerId, model, { effortLevel: 'high' }) },
      refreshAntigravity() { refreshed++ },
      reload() {},
    }
    let applied
    function render() { cursor = 0; return RuntimeChoiceView({ choice, onApply: (value) => { applied = value } }) }
    function findAll(root, pred, out = []) {
      if (!root || typeof root !== 'object') return out
      if (pred(root)) out.push(root)
      for (const child of [root.props?.children].flat(Infinity)) findAll(child, pred, out)
      return out
    }
    let root = render()
    // Locked starts directly on models and never renders the provider back button.
    assert.equal(findAll(root, n => n.type === 'SearchField')[0].props.placeholder, '搜索模型')
    assert.equal(findAll(root, n => n.type === 'TextButton' && n.props.title === '‹ 供应商').length, 0)
    const refreshBtn = findAll(root, n => n.type === 'TextButton' && n.props.title === '刷新 Antigravity')[0]
    assert.ok(refreshBtn)
    refreshBtn.props.onPress()
    assert.equal(refreshed, 1)
    const list = findAll(root, n => n.type === 'FlatList')[0]
    list.props.renderItem({ item: list.props.data[0] }).props.onPress()
    assert.deepEqual(applied, { providerId: ANTIGRAVITY_PROVIDER_ID, modelId: 'gemini-4-neon', effortLevel: 'high' })

    // When login_required, renders explicit agy acp --login guidance instead of a model list.
    choice.source.auth = 'missing'
    choice.source.runtimeStatus = 'login_required'
    root = render()
    assert.equal(findAll(root, n => n.type === 'FlatList').length, 0)
    assert.ok(JSON.stringify(root).includes(ANTIGRAVITY_LOGIN_GUIDANCE))
  `
  expect(() => execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })).not.toThrow()
})
