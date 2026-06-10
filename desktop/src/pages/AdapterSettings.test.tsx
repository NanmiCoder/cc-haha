import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'

import { AdapterSettings } from './AdapterSettings'
import { useAdapterStore } from '../stores/adapterStore'
import { useSettingsStore } from '../stores/settingsStore'
import type { AdapterFileConfig } from '../types/adapter'

const FEISHU_CREATE_BOT_URL = 'https://open.feishu.cn/page/openclaw?form=multiAgent'
const IM_CONFIG_DOCS_URL = 'https://claudecode-haha.relakkesyang.org/im/'

function renderAdapterSettings(
  config: AdapterFileConfig,
  overrides: Partial<ReturnType<typeof useAdapterStore.getState>> = {},
) {
  useSettingsStore.setState({ locale: 'en' })
  useAdapterStore.setState({
    config,
    isLoading: false,
    fetchConfig: vi.fn(async () => {}),
    updateConfig: vi.fn(async () => {}),
    startWhatsAppLogin: vi.fn(async () => ({ message: 'ok', sessionKey: 'whatsapp-session' })),
    pollWhatsAppLogin: vi.fn(async () => ({ connected: false })),
    unbindWechatAccount: vi.fn(async () => {}),
    unbindWhatsAppAccount: vi.fn(async () => {}),
    unbindDingtalkBot: vi.fn(async () => {}),
    removePairedUser: vi.fn(async () => {}),
    beginDingtalkRegistration: vi.fn(async () => ({
      deviceCode: 'device-code',
      verificationUriComplete: 'https://example.com/auth',
      intervalSeconds: 1,
      expiresInSeconds: 60,
    })),
    pollDingtalkRegistration: vi.fn(async () => ({ status: 'PENDING' })),
    ...overrides,
  } as Partial<ReturnType<typeof useAdapterStore.getState>>)

  render(<AdapterSettings />)
}

afterEach(() => {
  cleanup()
  useAdapterStore.setState(useAdapterStore.getInitialState(), true)
  useSettingsStore.setState(useSettingsStore.getInitialState(), true)
})

describe('AdapterSettings IM setup entry', () => {
  it('shows Telegram first by default and links to the unified documentation URL', () => {
    renderAdapterSettings({})

    const tabs = screen.getAllByRole('tab').map((tab) => tab.textContent)
    expect(tabs).toEqual(['Telegram', 'Feishu', 'WeChat', 'DingTalk', 'WhatsApp'])
    expect(screen.getByRole('tab', { name: 'Telegram' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByLabelText('Bot Token')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'documentation link' })).toHaveAttribute(
      'href',
      IM_CONFIG_DOCS_URL,
    )
  })
})

describe('AdapterSettings Feishu onboarding', () => {
  it('shows the documented one-click Feishu bot link before credentials are configured', () => {
    renderAdapterSettings({})
    fireEvent.click(screen.getByRole('tab', { name: 'Feishu' }))

    expect(screen.getByText('Need a Feishu bot?')).toBeInTheDocument()
    expect(screen.getByText(/OpenClaw template/)).toBeInTheDocument()
    expect(screen.getByText('1. Create the bot from the template.')).toBeInTheDocument()
    expect(screen.getByText('2. Copy its App ID and App Secret, then fill them in here.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /create feishu bot/i })).toHaveAttribute(
      'href',
      FEISHU_CREATE_BOT_URL,
    )
  })

  it('hides the one-click Feishu bot prompt once saved credentials exist', () => {
    renderAdapterSettings({
      feishu: {
        appId: 'cli_existing',
        appSecret: '****cret',
      },
    })
    fireEvent.click(screen.getByRole('tab', { name: 'Feishu' }))

    expect(screen.queryByRole('link', { name: /create feishu bot/i })).not.toBeInTheDocument()
    expect(screen.queryByText('Need a Feishu bot?')).not.toBeInTheDocument()
  })
})

describe('AdapterSettings account unbind confirmation', () => {
  it('confirms before unbinding a WeChat account', async () => {
    const unbindWechatAccount = vi.fn(async () => {})
    renderAdapterSettings(
      { wechat: { accountId: 'wx-account' } },
      { unbindWechatAccount },
    )

    fireEvent.click(screen.getByRole('tab', { name: 'WeChat' }))
    fireEvent.click(screen.getByRole('button', { name: 'Unbind WeChat account' }))

    expect(unbindWechatAccount).not.toHaveBeenCalled()
    const dialog = screen.getByRole('dialog', { name: 'Unbind WeChat account' })
    expect(within(dialog).getByText(/You will need to scan again/)).toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(unbindWechatAccount).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Unbind WeChat account' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Unbind WeChat account' })).getByRole('button', { name: 'Unbind WeChat account' }))

    await waitFor(() => {
      expect(unbindWechatAccount).toHaveBeenCalledTimes(1)
    })
  })

  it('confirms before unbinding a DingTalk bot account', async () => {
    const unbindDingtalkBot = vi.fn(async () => {})
    renderAdapterSettings(
      { dingtalk: { clientId: 'dt-client' } },
      { unbindDingtalkBot },
    )

    fireEvent.click(screen.getByRole('tab', { name: 'DingTalk' }))
    fireEvent.click(screen.getByRole('button', { name: 'Unbind bot account' }))

    expect(unbindDingtalkBot).not.toHaveBeenCalled()
    const dialog = screen.getByRole('dialog', { name: 'Unbind bot account' })
    expect(within(dialog).getByText(/You will need to scan again/)).toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Unbind bot account' }))

    await waitFor(() => {
      expect(unbindDingtalkBot).toHaveBeenCalledTimes(1)
    })
  })

  it('shows WhatsApp QR binding controls', () => {
    renderAdapterSettings({})

    fireEvent.click(screen.getByRole('tab', { name: 'WhatsApp' }))

    expect(screen.getByText('WhatsApp is not bound')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Scan to Bind' })).toBeInTheDocument()
    expect(screen.getByPlaceholderText('e.g. 15551234567@s.whatsapp.net')).toBeInTheDocument()
  })
})
