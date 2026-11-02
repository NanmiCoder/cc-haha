import { execFileSync } from 'node:child_process'
import { test } from 'bun:test'

test('computer selection uses existing authorization and remains selected when the material sheet confirms other skills', () => {
  const script = `
    import { mock } from 'bun:test'
    import assert from 'node:assert/strict'
    const React = require(${JSON.stringify(import.meta.resolve('react'))})
    let slots = [], cursor = 0, selections = 0, mutations = 0
    mock.module(${JSON.stringify(import.meta.resolve('react'))}, () => ({
      ...React, default: React,
      useState(initial) { const id = cursor++; if (!(id in slots)) slots[id] = typeof initial === 'function' ? initial() : initial; return [slots[id], next => { slots[id] = typeof next === 'function' ? next(slots[id]) : next }] },
      useMemo: fn => fn(), useEffect: () => {}, useRef: current => ({ current }),
    }))
    mock.module(${JSON.stringify(import.meta.resolve('react-native'))}, () => ({ View: 'View', Pressable: 'Pressable', TextInput: 'TextInput' }))
    mock.module(${JSON.stringify(import.meta.resolve('./Text'))}, () => ({ Text: 'Text' }))
    mock.module(${JSON.stringify(import.meta.resolve('./kit'))}, () => ({
      ...Object.fromEntries(['Button', 'Callout', 'Dot', 'Icon', 'InlineError', 'Mono', 'Sheet', 'Spinner', 'Switch'].map(name => [name, name])), useColors: () => ({}),
    }))
    mock.module(${JSON.stringify(import.meta.resolve('./DetentSheet'))}, () => ({ DetentSheet: 'DetentSheet' }))
    mock.module(${JSON.stringify(import.meta.resolve('./ConnectorIcon'))}, () => ({ ConnectorIcon: 'ConnectorIcon' }))
    mock.module(${JSON.stringify(import.meta.resolve('./compose/glyphs'))}, () => ({ Glyph: 'Glyph' }))
    mock.module(${JSON.stringify(import.meta.resolve('./compose/recentStore'))}, () => ({ recentRepository: { load: async () => [], record: async () => {} } }))
    mock.module(${JSON.stringify(import.meta.resolve('./compose/useBringExtras'))}, () => ({ useBringExtras: () => ({ agents: [], connectors: [], workflows: [] }) }))
    mock.module(${JSON.stringify(import.meta.resolve('./compose/RunToggles'))}, () => ({ RunToggles: 'RunToggles' }))
    const { ComputerUseRow } = require(${JSON.stringify(import.meta.resolve('./ComputerUseControl'))})
    const { BringSheet } = require(${JSON.stringify(import.meta.resolve('./compose/BringSheet'))})
    const { withComputerUseReference } = require(${JSON.stringify(import.meta.resolve('../core/computerUse'))})
    const flatten = node => {
      if (Array.isArray(node)) return node.flatMap(flatten)
      if (!node || typeof node !== 'object') return []
      return [node, ...flatten(node.props?.children)]
    }
    const computer = { supported: true, enabled: true, busy: false, toggle: () => mutations++, selectForMessage: done => { selections++; done() } }
    const rowProps = { computer, selected: false, onSelected: value => { rowProps.selected = value } }
    let row = flatten(ComputerUseRow(rowProps)).find(node => node.type === 'Switch')
    assert.equal(row.props.value, false, 'an authorized computer must not automatically select itself for every message')
    row.props.onValueChange(true)
    assert.equal(selections, 1)
    assert.equal(rowProps.selected, true)
    row = flatten(ComputerUseRow(rowProps)).find(node => node.type === 'Switch')
    row.props.onValueChange(false)
    assert.equal(rowProps.selected, false)
    assert.equal(mutations, 0, 'deselecting the message must not revoke global authorization')
    const skill = { kind: 'skill', id: 'review', name: 'review', displayName: '检查', description: '', modelText: 'Use the Skill tool with skill: "review" for this request.' }
    let applied
    const props = { visible: true, onClose() {}, client: null, workDir: '/fixture', lean: false, candidates: [], loading: false, error: '',
      references: [skill], draft: '检查页面', picking: null, onPick() {}, team: false, onTeam() {}, computer,
      onComputerSelected: value => { props.references = withComputerUseReference(props.references, value) }, onApply: next => { applied = next },
    }
    const render = () => { cursor = 0; return BringSheet(props) }
    render()
    let sheet = render()
    flatten(sheet).find(node => node.type === 'RunToggles').props.onComputerSelected(true)
    sheet = render()
    assert.equal(flatten(sheet).find(node => node.type === 'RunToggles').props.computerSelected, true)
    assert.ok(sheet.props.footer)
    sheet.props.footer.props.onPress()
    assert.deepEqual(applied.references.map(reference => reference.id), ['review', 'computer-use'], 'confirming the material sheet must preserve both staged skills and the computer request')
    assert.equal(applied.draft, '检查页面')
    assert.equal(mutations, 0)
  `
  try {
    execFileSync(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    throw new Error(String((error as { stderr?: Buffer }).stderr || error))
  }
})
