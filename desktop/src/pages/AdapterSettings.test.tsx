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
    // The scan-to-bind flows and the Slack manifest all reach the server, so
    // every one of them is stubbed by default; a test that cares overrides it.
    beginFeishuRegistration: vi.fn(async () => ({
      sessionKey: 'feishu-session',
      verificationUri: 'https://open.feishu.cn/page/launcher',
      expiresInSeconds: 600,
      // The hook polls at whatever cadence the server reports, so a short one
      // keeps these tests inside a normal waitFor window.
      intervalSeconds: 0.02,
      message: 'scan me',
      qrDataUrl: 'data:image/png;base64,feishu',
    })),
    pollFeishuRegistration: vi.fn(async () => ({ status: 'waiting' })),
    cancelFeishuRegistration: vi.fn(async () => {}),
    unbindFeishuApp: vi.fn(async () => {}),
    startWecomLogin: vi.fn(async () => ({
      sessionKey: 'wecom-session',
      verificationUrl: 'https://work.weixin.qq.com/ai/qc/confirm',
      pollIntervalMs: 20,
      message: 'scan me',
      qrDataUrl: 'data:image/png;base64,wecom',
    })),
    pollWecomLogin: vi.fn(async () => ({ connected: false, status: 'waiting' })),
    unbindWecomBot: vi.fn(async () => {}),
    startQqLogin: vi.fn(async () => ({
      sessionKey: 'qq-session',
      verificationUrl: 'https://qq.example/scan',
      pollIntervalMs: 20,
      message: 'scan me',
      qrDataUrl: 'data:image/png;base64,qq',
    })),
    pollQqLogin: vi.fn(async () => ({ connected: false, status: 'waiting' })),
    unbindQqBot: vi.fn(async () => {}),
    getSlackManifest: vi.fn(async () => ({
      manifest: '{\n  "settings": {\n    "socket_mode_enabled": true\n  }\n}',
      createAppUrl: 'https://api.slack.com/apps?new_app=1&manifest_json=%7B%7D',
    })),
    unbindSlackApp: vi.fn(async () => {}),
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
    expect(tabs).toEqual([
      'Telegram',
      'Feishu',
      'WeChat',
      'DingTalk',
      'WhatsApp',
      'WeCom',
      'QQ',
      'Slack',
    ])
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

describe('AdapterSettings scan-to-bind panels', () => {
  it('renders the Feishu QR after starting a scan and clears it on success', async () => {
    const beginFeishuRegistration = vi.fn(async () => ({
      sessionKey: 'feishu-session',
      verificationUri: 'https://open.feishu.cn/page/launcher',
      expiresInSeconds: 600,
      intervalSeconds: 0.02,
      message: 'Waiting for the Feishu scan...',
      qrDataUrl: 'data:image/png;base64,feishu',
    }))
    const pollFeishuRegistration = vi.fn(async () => ({ status: 'success' }))
    renderAdapterSettings({}, { beginFeishuRegistration, pollFeishuRegistration })

    fireEvent.click(screen.getByRole('tab', { name: 'Feishu' }))
    fireEvent.click(screen.getByRole('button', { name: 'Scan to Create' }))

    await waitFor(() => {
      expect(screen.getByAltText('Feishu authorization QR code')).toHaveAttribute(
        'src',
        'data:image/png;base64,feishu',
      )
    })
    expect(beginFeishuRegistration).toHaveBeenCalledTimes(1)

    await waitFor(() => {
      expect(pollFeishuRegistration).toHaveBeenCalledWith('feishu-session')
    })
    // Success clears the code: leaving it on screen invites a second scan that
    // would create a second bot.
    await waitFor(() => {
      expect(screen.queryByAltText('Feishu authorization QR code')).not.toBeInTheDocument()
    })
    expect(screen.getByText('Feishu bot created and bound.')).toBeInTheDocument()
  })

  it('stops polling and reports the reason when the Feishu code expires', async () => {
    const pollFeishuRegistration = vi.fn(async () => ({
      status: 'expired',
      message: 'QR expired, generate a new one.',
    }))
    renderAdapterSettings({}, { pollFeishuRegistration })

    fireEvent.click(screen.getByRole('tab', { name: 'Feishu' }))
    fireEvent.click(screen.getByRole('button', { name: 'Scan to Create' }))

    await waitFor(() => {
      expect(screen.getByText('QR expired, generate a new one.')).toBeInTheDocument()
    })
    await waitFor(() => {
      expect(screen.queryByAltText('Feishu authorization QR code')).not.toBeInTheDocument()
    })
    const callsAfterExpiry = pollFeishuRegistration.mock.calls.length
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(pollFeishuRegistration.mock.calls.length).toBe(callsAfterExpiry)
  })

  it('offers a rebind label and an unbind button once Feishu is configured', () => {
    renderAdapterSettings({ feishu: { appId: 'cli_1', appSecret: '****cret' } })

    fireEvent.click(screen.getByRole('tab', { name: 'Feishu' }))

    expect(screen.getByRole('button', { name: 'Scan Again' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Unbind Feishu bot' })).toBeInTheDocument()
  })

  it('renders the WeCom QR and shows the bound bot id', async () => {
    renderAdapterSettings({ wecom: { botId: 'bot-42' } })

    fireEvent.click(screen.getByRole('tab', { name: 'WeCom' }))
    expect(screen.getByText('bot-42')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Scan Again' }))

    await waitFor(() => {
      expect(screen.getByAltText('WeCom authorization QR code')).toBeInTheDocument()
    })
  })

  it('redraws the QQ QR when the connector rotates the code', async () => {
    let polls = 0
    const pollQqLogin = vi.fn(async () => {
      polls += 1
      return polls === 1
        ? { connected: false, status: 'waiting', qrDataUrl: 'data:image/png;base64,rotated' }
        : { connected: false, status: 'waiting' }
    })
    renderAdapterSettings({}, { pollQqLogin })

    fireEvent.click(screen.getByRole('tab', { name: 'QQ' }))
    fireEvent.click(screen.getByRole('button', { name: 'Scan to Bind' }))

    await waitFor(() => {
      expect(screen.getByAltText('QQ authorization QR code')).toHaveAttribute(
        'src',
        'data:image/png;base64,qq',
      )
    })
    await waitFor(() => {
      expect(screen.getByAltText('QQ authorization QR code')).toHaveAttribute(
        'src',
        'data:image/png;base64,rotated',
      )
    })
    // A later poll that carries no new image must not blank the one on screen.
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(screen.getByAltText('QQ authorization QR code')).toHaveAttribute(
      'src',
      'data:image/png;base64,rotated',
    )
  })

  it('shows the Slack manifest link and JSON only after the tab is opened', async () => {
    const getSlackManifest = vi.fn(async () => ({
      manifest: '{"settings":{"socket_mode_enabled":true}}',
      createAppUrl: 'https://api.slack.com/apps?new_app=1',
    }))
    renderAdapterSettings({}, { getSlackManifest })

    expect(getSlackManifest).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('tab', { name: 'Slack' }))

    await waitFor(() => {
      expect(screen.getByRole('link', { name: /create app from manifest/i })).toHaveAttribute(
        'href',
        'https://api.slack.com/apps?new_app=1',
      )
    })
    expect(screen.getByText('{"settings":{"socket_mode_enabled":true}}')).toBeInTheDocument()
    expect(screen.getByLabelText('Bot Token')).toBeInTheDocument()
    expect(screen.getByLabelText('App-Level Token')).toBeInTheDocument()
  })
})

describe('AdapterSettings saving the new platforms', () => {
  it('sends only the editable allowlist for the QR-bound platforms', async () => {
    const updateConfig = vi.fn(async (_patch: Partial<AdapterFileConfig>) => {})
    renderAdapterSettings(
      {
        wecom: { botId: 'bot-1', secret: '****cret', allowedUsers: ['zhangsan'] },
        qq: { appId: 'app-1', appSecret: '****cret', allowedUsers: ['openid-1'] },
      },
      { updateConfig },
    )

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(updateConfig).toHaveBeenCalledTimes(1)
    })
    const patch = updateConfig.mock.calls[0]![0]
    // Credentials belong to the scan flow. Echoing them back on every Save is
    // how a masked value overwrites a real one.
    expect(patch.wecom).toEqual({ allowedUsers: ['zhangsan'] })
    expect(patch.qq).toEqual({ allowedUsers: ['openid-1'] })
  })

  it('saves both Slack tokens because they are typed by hand', async () => {
    const updateConfig = vi.fn(async (_patch: Partial<AdapterFileConfig>) => {})
    renderAdapterSettings({}, { updateConfig })

    fireEvent.click(screen.getByRole('tab', { name: 'Slack' }))
    fireEvent.change(screen.getByLabelText('Bot Token'), { target: { value: 'xoxb-typed' } })
    fireEvent.change(screen.getByLabelText('App-Level Token'), { target: { value: 'xapp-typed' } })
    fireEvent.change(screen.getByLabelText('Allowed Users'), { target: { value: 'U1, U2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(updateConfig).toHaveBeenCalledTimes(1)
    })
    expect(updateConfig.mock.calls[0]![0].slack).toEqual({
      botToken: 'xoxb-typed',
      appToken: 'xapp-typed',
      allowedUsers: ['U1', 'U2'],
    })
  })
})

describe('AdapterSettings unbind confirmation for the new platforms', () => {
  it.each([
    ['WeCom', { wecom: { botId: 'bot-1' } }, 'Unbind bot account', 'unbindWecomBot'],
    ['QQ', { qq: { appId: 'app-1' } }, 'Unbind bot account', 'unbindQqBot'],
    ['Slack', { slack: { botToken: 'xoxb-1' } }, 'Unbind Slack app', 'unbindSlackApp'],
    ['Feishu', { feishu: { appId: 'cli_1', appSecret: 's' } }, 'Unbind Feishu bot', 'unbindFeishuApp'],
  ] as const)('confirms before unbinding on the %s tab', async (tab, config, buttonName, action) => {
    const unbind = vi.fn(async () => {})
    renderAdapterSettings(config as AdapterFileConfig, { [action]: unbind })

    fireEvent.click(screen.getByRole('tab', { name: tab }))
    fireEvent.click(screen.getByRole('button', { name: buttonName }))

    expect(unbind).not.toHaveBeenCalled()
    const dialog = screen.getByRole('dialog', { name: buttonName })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(unbind).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: buttonName }))
    fireEvent.click(
      within(screen.getByRole('dialog', { name: buttonName })).getByRole('button', { name: buttonName }),
    )

    await waitFor(() => {
      expect(unbind).toHaveBeenCalledTimes(1)
    })
  })
})

describe('AdapterSettings scan resilience', () => {
  // A poll travels through the local server out to the vendor, so a 5xx or a
  // timeout is ordinary. Tearing the code down on the first one makes the user
  // rescan for a blip — the two older loops in this page ride it out.
  it('keeps the QR on screen and retries after a transient poll failure', async () => {
    let polls = 0
    const pollQqLogin = vi.fn(async () => {
      polls += 1
      if (polls === 1) throw new Error('gateway timeout')
      return { connected: false, status: 'waiting', message: 'still waiting' }
    })
    renderAdapterSettings({}, { pollQqLogin })

    fireEvent.click(screen.getByRole('tab', { name: 'QQ' }))
    fireEvent.click(screen.getByRole('button', { name: 'Scan to Bind' }))

    await waitFor(() => {
      expect(screen.getByText('gateway timeout')).toBeInTheDocument()
    })
    expect(screen.getByAltText('QQ authorization QR code')).toBeInTheDocument()

    await waitFor(() => {
      expect(screen.getByText('still waiting')).toBeInTheDocument()
    })
    expect(screen.getByAltText('QQ authorization QR code')).toBeInTheDocument()
  })

  it('gives up once the failures stop looking transient', async () => {
    const pollQqLogin = vi.fn(async () => {
      throw new Error('vendor down')
    })
    renderAdapterSettings({}, { pollQqLogin })

    fireEvent.click(screen.getByRole('tab', { name: 'QQ' }))
    fireEvent.click(screen.getByRole('button', { name: 'Scan to Bind' }))

    // Wait for the code to actually appear first — asserting its absence
    // straight away would pass before the scan even started.
    await waitFor(() => {
      expect(screen.getByAltText('QQ authorization QR code')).toBeInTheDocument()
    })

    await waitFor(() => {
      expect(screen.getByText('vendor down')).toBeInTheDocument()
    })
    await waitFor(() => {
      expect(screen.queryByAltText('QQ authorization QR code')).not.toBeInTheDocument()
    })
    expect(pollQqLogin.mock.calls.length).toBe(3)

    const settled = pollQqLogin.mock.calls.length
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(pollQqLogin.mock.calls.length).toBe(settled)
  })

  // The QR image is drawn server-side and that can fail silently. Without the
  // URL the panel shows no image, no link, and a permanently disabled button.
  it('falls back to the scannable URL when the server sent no image', async () => {
    const startQqLogin = vi.fn(async () => ({
      sessionKey: 'qq-session',
      verificationUrl: 'https://qq.example/scan?token=1',
      pollIntervalMs: 20,
      message: 'scan me',
    }))
    renderAdapterSettings({}, { startQqLogin })

    fireEvent.click(screen.getByRole('tab', { name: 'QQ' }))
    fireEvent.click(screen.getByRole('button', { name: 'Scan to Bind' }))

    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'https://qq.example/scan?token=1' }))
        .toHaveAttribute('href', 'https://qq.example/scan?token=1')
    })
    expect(screen.queryByAltText('QQ authorization QR code')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Scan to Bind' })).toBeEnabled()
  })

  it('reports a failed Slack unbind instead of closing the dialog silently', async () => {
    const unbindSlackApp = vi.fn(async () => {
      throw new Error('server said no')
    })
    renderAdapterSettings({ slack: { botToken: 'xoxb-1' } }, { unbindSlackApp })

    fireEvent.click(screen.getByRole('tab', { name: 'Slack' }))
    fireEvent.click(screen.getByRole('button', { name: 'Unbind Slack app' }))
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Unbind Slack app' }))
        .getByRole('button', { name: 'Unbind Slack app' }),
    )

    await waitFor(() => {
      expect(screen.getByText('server said no')).toBeInTheDocument()
    })
  })
})

describe('AdapterSettings unbind dialog busy state', () => {
  // `loading` is not cosmetic: it is what stops the user dismissing and
  // re-firing an unbind that is still in flight. Pairing a row with another
  // platform's flag would leave the dialog dismissable mid-request.
  it.each([
    ['WeCom', { wecom: { botId: 'bot-1' } }, 'Unbind bot account', 'unbindWecomBot'],
    ['QQ', { qq: { appId: 'app-1' } }, 'Unbind bot account', 'unbindQqBot'],
    ['Feishu', { feishu: { appId: 'cli_1', appSecret: 's' } }, 'Unbind Feishu bot', 'unbindFeishuApp'],
    ['Slack', { slack: { botToken: 'xoxb-1' } }, 'Unbind Slack app', 'unbindSlackApp'],
  ] as const)('keeps the %s dialog busy until its own request settles', async (tab, config, buttonName, action) => {
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    const unbind = vi.fn(() => pending)
    renderAdapterSettings(config as AdapterFileConfig, { [action]: unbind })

    fireEvent.click(screen.getByRole('tab', { name: tab }))
    fireEvent.click(screen.getByRole('button', { name: buttonName }))
    const dialog = screen.getByRole('dialog', { name: buttonName })
    fireEvent.click(within(dialog).getByRole('button', { name: buttonName }))

    await waitFor(() => {
      expect(unbind).toHaveBeenCalledTimes(1)
    })
    // Still in flight: cancelling must not dismiss it, and confirming again
    // must not fire a second request.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('dialog', { name: buttonName })).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: buttonName }))
    expect(unbind).toHaveBeenCalledTimes(1)

    release()
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: buttonName })).not.toBeInTheDocument()
    })
  })
})
