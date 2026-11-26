import { execFileSync } from 'node:child_process'
import { expect, test } from 'bun:test'

test('effort control distinguishes unavailable sources and applies only effort to the selected runtime', () => {
  const script = `
    import { mock } from 'bun:test'
    import assert from 'node:assert/strict'
    const React = require(${JSON.stringify(import.meta.resolve('react'))})
    mock.module(${JSON.stringify(import.meta.resolve('react'))}, () => ({ ...React, default: React, useState: (value) => [value, () => {}] }))
    mock.module(${JSON.stringify(import.meta.resolve('react-native'))}, () => ({ Pressable: 'Pressable', View: 'View' }))
    mock.module(${JSON.stringify(import.meta.resolve('./Text'))}, () => ({ Text: 'Text' }))
    mock.module(${JSON.stringify(import.meta.resolve('./kit'))}, () => ({ Callout:'Callout', InlineError:'InlineError', Loading:'Loading', Sheet:'Sheet', TextButton:'TextButton', useColors:()=>({}) }))
    mock.module(${JSON.stringify(import.meta.resolve('./newtask/ChoiceRow'))}, () => ({ ChoiceRow:'ChoiceRow' }))
    const choice = { source: {auth:'ready'}, loading:false, catalogReady:true, canSetEffort:true, models: [{id:'reasoner',name:'Reasoner',supportedReasoningEfforts:['low','high'],defaultReasoningEffort:'low'}], reload() {} }
    mock.module(${JSON.stringify(import.meta.resolve('./RuntimePicker'))}, () => ({ useRuntimeChoice: () => choice }))
    const { EffortControl } = require(${JSON.stringify(import.meta.resolve('./EffortControl'))})
    const runtime = { providerId:'openai-official',modelId:'reasoner',effortLevel:'low',openAIFastMode:true }
    let applied
    const render = () => EffortControl({client:{}, runtime, onApply:value=>{applied=value}})
    function all(root, type) {
      if (!root || typeof root !== 'object') return []
      return [...(root.type === type ? [root] : []), ...[root.props?.children].flat(Infinity).flatMap(child => all(child,type))]
    }
    all(render(),'ChoiceRow')[1].props.onPress()
    assert.deepEqual(applied,{...runtime,effortLevel:'high'})
    choice.source.auth='missing'
    assert.equal(all(render(),'ChoiceRow').length,0)
    assert.ok(JSON.stringify(render()).includes('请先在电脑上登录'))
    assert.ok(all(render(),'TextButton').some(row=>row.props.title==='重新读取'))
    choice.source.auth='error'
    assert.ok(JSON.stringify(render()).includes('尚未确认此供应商的授权状态'))
    // 当前模型不在列表里：和桌面端一样给通用档位（不含「超高」），不再要求先重选模型。
    choice.source.auth='ready'; choice.models=[]
    assert.deepEqual(all(render(),'ChoiceRow').map(row=>row.key),['low','medium','high','max'])
    all(render(),'ChoiceRow')[3].props.onPress()
    assert.deepEqual(applied,{...runtime,effortLevel:'max'})
    choice.models=[{id:'reasoner',name:'Plain',supportedReasoningEfforts:[]}]
    assert.equal(all(render(),'ChoiceRow').length,0)
    assert.ok(JSON.stringify(render()).includes('当前模型没有可调的思考强度'))
  `
  expect(() => execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })).not.toThrow()
})

test('EffortControl and EffortSheet wire Antigravity refresh button to refreshAntigravity instead of cached reload', () => {
  const script = `
    import { mock } from 'bun:test'
    import assert from 'node:assert/strict'
    const React = require(${JSON.stringify(import.meta.resolve('react'))})
    mock.module(${JSON.stringify(import.meta.resolve('react'))}, () => ({ ...React, default: React, useState: (value) => [value, () => {}] }))
    mock.module(${JSON.stringify(import.meta.resolve('react-native'))}, () => ({ Pressable: 'Pressable', View: 'View' }))
    mock.module(${JSON.stringify(import.meta.resolve('./Text'))}, () => ({ Text: 'Text' }))
    mock.module(${JSON.stringify(import.meta.resolve('./kit'))}, () => ({ Callout:'Callout', InlineError:'InlineError', Loading:'Loading', Sheet:'Sheet', TextButton:'TextButton', useColors:()=>({}) }))
    mock.module(${JSON.stringify(import.meta.resolve('./newtask/ChoiceRow'))}, () => ({ ChoiceRow:'ChoiceRow' }))
    let reloads = 0, refreshes = 0
    const choice = {
      directory: { sources: [] },
      providerId: 'antigravity-acp',
      source: { id: 'antigravity-acp', auth: 'missing', runtimeStatus: 'login_required' },
      loading: false,
      refreshingAntigravity: false,
      catalogReady: true,
      canSetEffort: true,
      models: [],
      reload() { reloads++ },
      async refreshAntigravity() { refreshes++ },
    }
    mock.module(${JSON.stringify(import.meta.resolve('./RuntimePicker'))}, () => ({ useRuntimeChoice: () => choice }))
    const { EffortControl, EffortSheet } = require(${JSON.stringify(import.meta.resolve('./EffortControl'))})
    const runtime = { providerId: 'antigravity-acp', modelId: 'agent-default', effortLevel: 'high' }
    function all(root, type) {
      if (!root || typeof root !== 'object') return []
      return [...(root.type === type ? [root] : []), ...[root.props?.children].flat(Infinity).flatMap(child => all(child, type))]
    }
    for (const [status, auth] of [['login_required', 'missing'], ['error', 'error'], ['unchecked', 'ready'], ['ready', 'ready']]) {
      choice.source = { id: 'antigravity-acp', auth, runtimeStatus: status }
      const before = refreshes
      const controlBtn = all(EffortControl({ client: {}, runtime, onApply: () => {} }), 'TextButton')[0]
      assert.equal(controlBtn.props.title, '重新读取')
      controlBtn.props.onPress()
      assert.equal(refreshes, before + 1, 'EffortControl must call refreshAntigravity for ' + status)
      const sheetBtn = all(EffortSheet({ visible: true, onClose: () => {}, client: {}, runtime, onApply: () => {} }), 'TextButton')[0]
      assert.equal(sheetBtn.props.title, '重新读取')
      sheetBtn.props.onPress()
      assert.equal(refreshes, before + 2, 'EffortSheet must call refreshAntigravity for ' + status)
    }
    assert.equal(reloads, 0, 'Antigravity refresh must not call cached reload when directory is present')

    // Falls back to reload when directory failed to load (null) or for non-Antigravity providers
    choice.directory = null
    all(EffortSheet({ visible: true, onClose: () => {}, client: {}, runtime, onApply: () => {} }), 'TextButton')[0].props.onPress()
    assert.equal(reloads, 1)
    choice.directory = { sources: [] }
    choice.providerId = 'openai-official'
    choice.source = { id: 'openai-official', auth: 'missing' }
    all(EffortControl({ client: {}, runtime: { providerId: 'openai-official', modelId: 'o3' }, onApply: () => {} }), 'TextButton')[0].props.onPress()
    assert.equal(reloads, 2)
  `
  expect(() => execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })).not.toThrow()
})
