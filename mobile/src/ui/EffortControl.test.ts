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
    const choice = { source: {auth:'ready'}, loading:false, catalogReady:true, canSetEffort:true, model: {id:'reasoner',name:'Reasoner',supportedReasoningEfforts:['low','high'],defaultReasoningEffort:'low'}, reload() {} }
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
    choice.source.auth='ready'; choice.model=undefined
    assert.ok(JSON.stringify(render()).includes('当前模型已不在供应商列表'))
    choice.model={id:'plain',name:'Plain',supportedReasoningEfforts:[]}
    assert.ok(JSON.stringify(render()).includes('当前模型没有可调的思考强度'))
  `
  expect(() => execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })).not.toThrow()
})
