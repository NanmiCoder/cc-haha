import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'

import { AdapterSettings } from './AdapterSettings'
import { useAdapterStore } from '../stores/adapterStore'
import { useSettingsStore } from '../stores/settingsStore'
import type { AdapterFileConfig } from '../types/adapter'

const FEISHU_CREATE_BOT_URL = 'https://open.feishu.cn/page/openclaw?form=multiAgent'
const IM_CONFIG_DOCS_URL = 'https://cchaha.ai/im/'

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

// #1191: the access boundary is its own setting, separate from the default
// project, and it round-trips through the config patch.
describe('AdapterSettings allowed project roots', () => {
  it('explains the default when no roots are configured', () => {
    renderAdapterSettings({})

    expect(screen.getByText('Allowed project directories')).toBeInTheDocument()
    expect(
      screen.getByText('Default: your home directory (plus the default project, if it is outside home).'),
    ).toBeInTheDocument()
  })

  it('lists configured roots and saves them after removing one', async () => {
    const updateConfig = vi.fn(async (_patch: Partial<AdapterFileConfig>) => {})
    renderAdapterSettings(
      { allowedProjectRoots: ['/Users/me/work', '/Users/me/side'] },
      { updateConfig },
    )

    expect(screen.getByText('/Users/me/work')).toBeInTheDocument()
    expect(screen.getByText('/Users/me/side')).toBeInTheDocument()

    const sideRow = screen.getByText('/Users/me/side').closest('li')!
    fireEvent.click(within(sideRow).getByRole('button', { name: 'Remove' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(updateConfig).toHaveBeenCalledTimes(1)
    })
    expect(updateConfig.mock.calls[0]![0]).toMatchObject({
      allowedProjectRoots: ['/Users/me/work'],
    })
  })

  // A platform-level list replaces the global one, so a save here would silently
  // not apply to that platform.
  it('warns when a platform overrides the global roots', () => {
    renderAdapterSettings({
      allowedProjectRoots: ['/Users/me/work'],
      whatsapp: { allowedProjectRoots: ['/Users/me/work/sandbox'] },
    })

    expect(
      screen.getByText(
        'Overridden for WhatsApp by a per-platform setting in adapters.json — changes here do not affect WhatsApp.',
      ),
    ).toBeInTheDocument()
  })

  it('shows no override warning when only the global roots are set', () => {
    renderAdapterSettings({ allowedProjectRoots: ['/Users/me/work'] })

    expect(screen.queryByText(/per-platform setting/)).not.toBeInTheDocument()
  })

  it('keeps the default when nothing is configured instead of pinning the default project', async () => {
    const updateConfig = vi.fn(async (_patch: Partial<AdapterFileConfig>) => {})
    renderAdapterSettings({ defaultProjectDir: '/Users/me/work/my-app' }, { updateConfig })

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(updateConfig).toHaveBeenCalledTimes(1)
    })
    const patch = updateConfig.mock.calls[0]![0]
    expect(patch.defaultProjectDir).toBe('/Users/me/work/my-app')
    expect(patch.allowedProjectRoots).toEqual([])
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

describe('AdapterSettings config saving', () => {
  it('does not send WeChat binding-owned fields when saving editable settings', async () => {
    const updateConfig = vi.fn(async (_patch: Partial<AdapterFileConfig>) => {})
    renderAdapterSettings(
      {
        wechat: {
          accountId: 'wx-account',
          botToken: '****oken',
          baseUrl: 'https://ilinkai.weixin.qq.com',
          userId: 'wx-user',
          allowedUsers: ['wx-allowed'],
          pairedUsers: [{ userId: 'wx-user', displayName: 'WeChat User', pairedAt: 1 }],
        },
      },
      { updateConfig },
    )

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(updateConfig).toHaveBeenCalledTimes(1)
    })
    const patch = updateConfig.mock.calls[0]![0]
    expect(patch).toMatchObject({
      wechat: {
        allowedUsers: ['wx-allowed'],
      },
    })
    expect(patch.wechat).toEqual({
      allowedUsers: ['wx-allowed'],
    })
  })

  it('does not send WhatsApp binding-owned fields when saving editable settings', async () => {
    const updateConfig = vi.fn(async (_patch: Partial<AdapterFileConfig>) => {})
    renderAdapterSettings(
      {
        whatsapp: {
          accountJid: '15551234567@s.whatsapp.net',
          authDir: '/tmp/whatsapp-auth',
          allowedUsers: ['15550000000@s.whatsapp.net'],
          pairedUsers: [{
            userId: '15551234567@s.whatsapp.net',
            displayName: 'WhatsApp User',
            pairedAt: 1,
          }],
        },
      },
      { updateConfig },
    )

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(updateConfig).toHaveBeenCalledTimes(1)
    })
    const patch = updateConfig.mock.calls[0]![0]
    expect(patch.whatsapp).toEqual({
      allowedUsers: ['15550000000@s.whatsapp.net'],
    })
  })

  it('submits empty strings when clearing editable configuration', async () => {
    const updateConfig = vi.fn(async (_patch: Partial<AdapterFileConfig>) => {})
    renderAdapterSettings(
      {
        defaultProjectDir: '/tmp/existing-project',
        telegram: { botToken: '****oken' },
        feishu: {
          appId: 'cli_existing',
          appSecret: '****cret',
          encryptKey: '****-key',
          verificationToken: '****oken',
        },
        dingtalk: {
          clientId: 'ding-client',
          clientSecret: '****cret',
          endpoint: 'https://custom.example.com',
          permissionCardTemplateId: 'permission-template',
        },
      },
      { updateConfig },
    )

    fireEvent.click(screen.getByRole('button', { name: 'Clear default project' }))
    fireEvent.change(screen.getByLabelText('Bot Token'), { target: { value: '' } })

    fireEvent.click(screen.getByRole('tab', { name: 'Feishu' }))
    fireEvent.change(screen.getByLabelText('App ID'), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('App Secret'), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('Encrypt Key'), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('Verification Token'), { target: { value: '' } })

    fireEvent.click(screen.getByRole('tab', { name: 'DingTalk' }))
    fireEvent.change(screen.getByLabelText('Client ID'), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('Client Secret'), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('Stream Endpoint'), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('Permission Card Template ID'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(updateConfig).toHaveBeenCalledTimes(1)
    })
    const patch = updateConfig.mock.calls[0]![0]
    expect(patch).toMatchObject({
      defaultProjectDir: '',
      telegram: {
        botToken: '',
        allowedUsers: [],
      },
      feishu: {
        appId: '',
        appSecret: '',
        encryptKey: '',
        verificationToken: '',
        allowedUsers: [],
        streamingCard: false,
      },
      dingtalk: {
        clientId: '',
        clientSecret: '',
        allowedUsers: [],
        endpoint: '',
        permissionCardTemplateId: '',
      },
    })
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
