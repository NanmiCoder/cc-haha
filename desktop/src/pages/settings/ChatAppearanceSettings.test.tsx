import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useSettingsStore } from '@/stores/settingsStore'
import { useChatAppearanceStore } from '@/stores/chatAppearanceStore'
import { CHAT_APPEARANCE_STORAGE_KEY, DEFAULT_CHAT_APPEARANCE } from '@/lib/chatAppearance'
import { ChatAppearanceSettings } from './ChatAppearanceSettings'

describe('Chat appearance settings', () => {
  beforeEach(() => {
    localStorage.clear()
    useSettingsStore.setState({ locale: 'en' })
    useChatAppearanceStore.setState({ appearance: { ...DEFAULT_CHAT_APPEARANCE } })
  })

  afterEach(() => {
    cleanup()
    localStorage.clear()
    useChatAppearanceStore.setState(useChatAppearanceStore.getInitialState(), true)
    useSettingsStore.setState(useSettingsStore.getInitialState(), true)
    for (const property of ['--chat-font-family', '--chat-font-size', '--chat-content-max-width']) {
      document.documentElement.style.removeProperty(property)
    }
  })

  it('updates real Markdown preview and saves independent controls immediately', () => {
    render(<ChatAppearanceSettings />)
    const preview = screen.getByRole('region', { name: 'Font preview' })
    expect(preview.querySelector('.chat-reading-markdown')).toBeInTheDocument()
    expect(preview.querySelector('h3')).toHaveTextContent('A clearer conversation')
    expect(preview.querySelector('table')).toBeInTheDocument()
    expect(preview.querySelector('code')).toHaveTextContent('const answer = 42')

    fireEvent.change(screen.getByRole('combobox', { name: 'Chat font' }), { target: { value: 'serif' } })
    fireEvent.change(screen.getByRole('slider', { name: 'Chat font size' }), { target: { value: '24' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Conversation width' }), { target: { value: 'full' } })

    expect(useChatAppearanceStore.getState().appearance).toEqual({ font: 'serif', fontSize: 24, width: 'full' })
    expect(preview.style.getPropertyValue('--chat-font-family')).toContain('Songti SC')
    expect(preview.style.getPropertyValue('--chat-font-size')).toBe('24px')
    expect(document.documentElement.style.getPropertyValue('--chat-content-max-width')).toBe('100%')
    expect(JSON.parse(localStorage.getItem(CHAT_APPEARANCE_STORAGE_KEY)!)).toMatchObject({ font: 'serif', fontSize: 24, width: 'full' })
    expect(useSettingsStore.getState().uiZoom).toBe(useSettingsStore.getInitialState().uiZoom)
  })

  it('restores all controls, saved values and preview together', () => {
    useChatAppearanceStore.getState().setAppearance({ font: 'mono', fontSize: 12, width: 'wide' })
    render(<ChatAppearanceSettings />)
    expect(screen.getByRole('slider')).toHaveAttribute('min', '12')
    expect(screen.getByRole('slider')).toHaveAttribute('max', '24')
    expect(screen.getByRole('slider')).toHaveAttribute('step', '1')

    fireEvent.click(screen.getByRole('button', { name: 'Reset chat appearance' }))

    expect(screen.getByRole('combobox', { name: 'Chat font' })).toHaveValue('system')
    expect(screen.getByRole('slider')).toHaveValue('14')
    expect(screen.getByRole('combobox', { name: 'Conversation width' })).toHaveValue('standard')
    expect(screen.getByRole('region').style.getPropertyValue('--chat-font-size')).toBe('14px')
    expect(JSON.parse(localStorage.getItem(CHAT_APPEARANCE_STORAGE_KEY)!)).toMatchObject(DEFAULT_CHAT_APPEARANCE)
  })
})
