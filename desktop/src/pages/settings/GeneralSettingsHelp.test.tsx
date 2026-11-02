import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useOpenTargetStore } from '@/stores/openTargetStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { GeneralSettings } from './GeneralSettings'

// The settings people ask about in the group chat, each with a "?" beside it.
const HELP_TRIGGERS = [
  { name: '思考模式是什么？', row: '启用思考模式' },
  { name: '精简模式是什么？', row: '启用精简模式' },
  { name: 'Ultracode 是什么？', row: '启用 Ultracode 关键词触发' },
  { name: '智能体团队是什么？', row: '启用 智能体团队' },
  { name: 'SubAgent 是什么？', row: '普通 SubAgent 并发上限' },
  { name: '自动回答问题是什么？', row: '等待超时后自动选择答案' },
  { name: '自动做梦是什么？', row: '启用自动做梦' },
  { name: 'WebFetch 域名预检是什么？', row: '跳过 WebFetch 域名预检' },
  { name: 'Agent Trace 是什么？', row: '收集 Agent Trace' },
]

describe('General settings help cards', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      locale: 'zh',
      fetchOutputStyles: async () => {},
      fetchAppMode: async () => {},
    })
    useOpenTargetStore.setState({ ensureTargets: async () => {} })
  })
  afterEach(() => {
    cleanup()
    useSettingsStore.setState(useSettingsStore.getInitialState(), true)
    useOpenTargetStore.setState(useOpenTargetStore.getInitialState(), true)
  })

  it.each(HELP_TRIGGERS)('puts "$name" right after the "$row" title', ({ name, row }) => {
    render(<GeneralSettings />)
    const trigger = screen.getByRole('button', { name })
    expect(trigger.previousElementSibling).toHaveTextContent(row)
  })

  it('adds exactly these help triggers and none to self-explanatory settings', () => {
    render(<GeneralSettings />)
    const triggers = screen.getAllByRole('button', { name: /是什么？$/ })
    expect(triggers.map((trigger) => trigger.getAttribute('aria-label')).sort())
      .toEqual(HELP_TRIGGERS.map(({ name }) => name).sort())
  })

  it('explains Auto-dream in plain words when its "?" is clicked', () => {
    render(<GeneralSettings />)
    fireEvent.click(screen.getByRole('button', { name: '自动做梦是什么？' }))
    const card = screen.getByRole('dialog', { name: '自动做梦是什么？' })
    expect(within(card).getByText('是什么')).toBeInTheDocument()
    expect(within(card).getByText('适合')).toBeInTheDocument()
    expect(within(card).getByText('代价')).toBeInTheDocument()
    expect(card).toHaveTextContent('满 24 小时')
    expect(card).toHaveTextContent('不碰代码')
  })

  it('uses the "why" label for the WebFetch preflight card', () => {
    render(<GeneralSettings />)
    fireEvent.click(screen.getByRole('button', { name: 'WebFetch 域名预检是什么？' }))
    const card = screen.getByRole('dialog', { name: 'WebFetch 域名预检是什么？' })
    expect(within(card).getByText('为什么')).toBeInTheDocument()
    expect(within(card).queryByText('代价')).not.toBeInTheDocument()
  })

  it('follows the interface language', () => {
    useSettingsStore.setState({ locale: 'en' })
    render(<GeneralSettings />)
    fireEvent.click(screen.getByRole('button', { name: 'What is Auto-dream?' }))
    const card = screen.getByRole('dialog', { name: 'What is Auto-dream?' })
    expect(within(card).getByText('Trade-off')).toBeInTheDocument()
    expect(within(card).getByRole('button', { name: 'Close' })).toBeInTheDocument()
  })
})
