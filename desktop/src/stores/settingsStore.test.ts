import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/client'
import { browserHost } from '../lib/desktopHost/browserHost'

describe('settingsStore locale defaults', () => {
  beforeEach(() => {
    vi.resetModules()
    window.localStorage.clear()
  })

  it('defaults to Chinese when no locale is stored', async () => {
    const { useSettingsStore } = await import('./settingsStore')

    expect(useSettingsStore.getState().locale).toBe('zh')
  })

  it('keeps a stored locale override', async () => {
    window.localStorage.setItem('cc-haha-locale', 'en')

    const { useSettingsStore } = await import('./settingsStore')

    expect(useSettingsStore.getState().locale).toBe('en')
  })
})

describe('settingsStore UI zoom', () => {
  beforeEach(() => {
    vi.resetModules()
    window.localStorage.clear()
    document.documentElement.removeAttribute('data-app-zoom-percent')
    document.documentElement.style.removeProperty('--app-zoom')
    document.body.style.removeProperty('zoom')
  })

  it('hydrates from the app zoom storage key', async () => {
    window.localStorage.setItem('cc-haha-app-zoom', '1.25')

    const { useSettingsStore } = await import('./settingsStore')

    expect(useSettingsStore.getState().uiZoom).toBe(1.25)
  })

  it('applies and persists UI zoom changes through the shared app zoom controller', async () => {
    const { useSettingsStore } = await import('./settingsStore')

    useSettingsStore.getState().setUiZoom(1.25)

    await vi.waitFor(() => {
      expect(window.localStorage.getItem('cc-haha-app-zoom')).toBe('1.25')
    })
    expect(useSettingsStore.getState().uiZoom).toBe(1.25)
    expect(document.documentElement.getAttribute('data-app-zoom-percent')).toBe('125')
  })

  it('clamps UI zoom changes to the supported range', async () => {
    const { useSettingsStore } = await import('./settingsStore')

    useSettingsStore.getState().setUiZoom(9)

    await vi.waitFor(() => {
      expect(window.localStorage.getItem('cc-haha-app-zoom')).toBe('2')
    })
    expect(useSettingsStore.getState().uiZoom).toBe(2)
  })
})

describe('settingsStore update proxy persistence', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    window.localStorage.clear()
  })

  it('defaults old user settings to automatic system proxy mode', async () => {
    vi.doMock('../api/settings', () => ({
      settingsApi: {
        getUser: vi.fn().mockResolvedValue({}),
        updateUser: vi.fn(),
        getPermissionMode: vi.fn().mockResolvedValue({ mode: 'default' }),
        setPermissionMode: vi.fn(),
        getCliLauncherStatus: vi.fn(),
      },
    }))
    vi.doMock('../api/models', () => ({
      modelsApi: {
        list: vi.fn().mockResolvedValue({ models: [] }),
        getCurrent: vi.fn().mockResolvedValue({ model: null }),
        setCurrent: vi.fn(),
        getEffort: vi.fn().mockResolvedValue({ level: 'medium' }),
        setEffort: vi.fn(),
      },
    }))
    vi.doMock('../api/h5Access', () => ({
      h5AccessApi: {
        get: vi.fn().mockResolvedValue({
          settings: {
            enabled: false,
            tokenPreview: null,
            allowedOrigins: [],
            publicBaseUrl: null,
          },
        }),
        enable: vi.fn(),
        disable: vi.fn(),
        regenerate: vi.fn(),
        update: vi.fn(),
      },
    }))

    const { useSettingsStore } = await import('./settingsStore')

    await useSettingsStore.getState().fetchAll()

    expect(useSettingsStore.getState().updateProxy).toEqual({
      mode: 'system',
      url: '',
    })
  })

  it('persists manual update proxy settings trimmed', async () => {
    const updateUser = vi.fn().mockResolvedValue({})
    vi.doMock('../api/settings', () => ({
      settingsApi: {
        getUser: vi.fn(),
        updateUser,
        getPermissionMode: vi.fn(),
        setPermissionMode: vi.fn(),
        getCliLauncherStatus: vi.fn(),
      },
    }))
    vi.doMock('../api/models', () => ({
      modelsApi: {
        list: vi.fn(),
        getCurrent: vi.fn(),
        setCurrent: vi.fn(),
        getEffort: vi.fn(),
        setEffort: vi.fn(),
      },
    }))
    vi.doMock('../api/h5Access', () => ({
      h5AccessApi: {
        get: vi.fn(),
        enable: vi.fn(),
        disable: vi.fn(),
        regenerate: vi.fn(),
        update: vi.fn(),
      },
    }))

    const { useSettingsStore } = await import('./settingsStore')

    await useSettingsStore.getState().setUpdateProxy({
      mode: 'manual',
      url: '  http://127.0.0.1:7890  ',
    })

    expect(useSettingsStore.getState().updateProxy).toEqual({
      mode: 'manual',
      url: 'http://127.0.0.1:7890',
    })
    expect(updateUser).toHaveBeenCalledWith({
      updateProxy: {
        mode: 'manual',
        url: 'http://127.0.0.1:7890',
      },
    })
  })
})

describe('settingsStore network persistence', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    window.localStorage.clear()
  })

  it('defaults old user settings to 120s system network settings', async () => {
    vi.doMock('../api/settings', () => ({
      settingsApi: {
        getUser: vi.fn().mockResolvedValue({}),
        updateUser: vi.fn(),
        getPermissionMode: vi.fn().mockResolvedValue({ mode: 'default' }),
        setPermissionMode: vi.fn(),
        getCliLauncherStatus: vi.fn(),
      },
    }))
    vi.doMock('../api/models', () => ({
      modelsApi: {
        list: vi.fn().mockResolvedValue({ models: [] }),
        getCurrent: vi.fn().mockResolvedValue({ model: null }),
        setCurrent: vi.fn(),
        getEffort: vi.fn().mockResolvedValue({ level: 'medium' }),
        setEffort: vi.fn(),
      },
    }))
    vi.doMock('../api/h5Access', () => ({
      h5AccessApi: {
        get: vi.fn().mockResolvedValue({
          settings: {
            enabled: false,
            tokenPreview: null,
            allowedOrigins: [],
            publicBaseUrl: null,
          },
        }),
        enable: vi.fn(),
        disable: vi.fn(),
        regenerate: vi.fn(),
        update: vi.fn(),
      },
    }))

    const { useSettingsStore } = await import('./settingsStore')

    await useSettingsStore.getState().fetchAll()

    expect(useSettingsStore.getState().network).toEqual({
      aiRequestTimeoutMs: 120_000,
      proxy: {
        mode: 'system',
        url: '',
      },
    })
  })

  it('persists trimmed manual network proxy and clamps timeout', async () => {
    const updateUser = vi.fn().mockResolvedValue({})
    vi.doMock('../api/settings', () => ({
      settingsApi: {
        getUser: vi.fn(),
        updateUser,
        getPermissionMode: vi.fn(),
        setPermissionMode: vi.fn(),
        getCliLauncherStatus: vi.fn(),
      },
    }))
    vi.doMock('../api/models', () => ({
      modelsApi: {
        list: vi.fn(),
        getCurrent: vi.fn(),
        setCurrent: vi.fn(),
        getEffort: vi.fn(),
        setEffort: vi.fn(),
      },
    }))
    vi.doMock('../api/h5Access', () => ({
      h5AccessApi: {
        get: vi.fn(),
        enable: vi.fn(),
        disable: vi.fn(),
        regenerate: vi.fn(),
        update: vi.fn(),
      },
    }))

    const { useSettingsStore } = await import('./settingsStore')

    await useSettingsStore.getState().setNetwork({
      aiRequestTimeoutMs: 999_999,
      proxy: {
        mode: 'manual',
        url: '  http://127.0.0.1:7890  ',
      },
    })

    expect(useSettingsStore.getState().network).toEqual({
      aiRequestTimeoutMs: 600_000,
      proxy: {
        mode: 'manual',
        url: 'http://127.0.0.1:7890',
      },
    })
    expect(updateUser).toHaveBeenCalledWith({
      network: {
        aiRequestTimeoutMs: 600_000,
        proxy: {
          mode: 'manual',
          url: 'http://127.0.0.1:7890',
        },
      },
    })
  })

  it('persists the chat send behavior preference and normalizes invalid values', async () => {
    const updateUser = vi.fn().mockResolvedValue({})
    vi.doMock('../api/settings', () => ({
      settingsApi: {
        getUser: vi.fn().mockResolvedValue({
          chatSendBehavior: 'unexpected',
        }),
        updateUser,
        getPermissionMode: vi.fn().mockResolvedValue({ mode: 'default' }),
        setPermissionMode: vi.fn(),
        getCliLauncherStatus: vi.fn(),
      },
    }))
    vi.doMock('../api/models', () => ({
      modelsApi: {
        list: vi.fn().mockResolvedValue({ models: [] }),
        getCurrent: vi.fn().mockResolvedValue({ model: null }),
        setCurrent: vi.fn(),
        getEffort: vi.fn().mockResolvedValue({ level: 'medium' }),
        setEffort: vi.fn(),
      },
    }))
    vi.doMock('../api/h5Access', () => ({
      h5AccessApi: {
        get: vi.fn().mockResolvedValue({
          settings: {
            enabled: false,
            tokenPreview: null,
            allowedOrigins: [],
            publicBaseUrl: null,
          },
        }),
        enable: vi.fn(),
        disable: vi.fn(),
        regenerate: vi.fn(),
        update: vi.fn(),
      },
    }))

    const { useSettingsStore } = await import('./settingsStore')

    await useSettingsStore.getState().fetchAll()
    expect(useSettingsStore.getState().chatSendBehavior).toBe('enter')

    await useSettingsStore.getState().setChatSendBehavior('modifierEnter')

    expect(useSettingsStore.getState().chatSendBehavior).toBe('modifierEnter')
    expect(updateUser).toHaveBeenCalledWith({ chatSendBehavior: 'modifierEnter' })
  })
})

describe('settingsStore workspace LSP persistence', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    window.localStorage.clear()
  })

  it('hydrates custom workspace LSP settings from user settings', async () => {
    vi.doMock('../api/settings', () => ({
      settingsApi: {
        getUser: vi.fn().mockResolvedValue({
          workspaceLsp: {
            server: {
              name: 'custom:typescript',
              path: '  C:\\Program Files\\Example LSP\\server.exe  ',
              args: ['--stdio', 123],
              extensionToLanguage: { ts: ' typescript ', bad: '' },
            },
          },
        }),
        updateUser: vi.fn(),
        getPermissionMode: vi.fn().mockResolvedValue({ mode: 'default' }),
        setPermissionMode: vi.fn(),
        getCliLauncherStatus: vi.fn(),
      },
    }))
    vi.doMock('../api/models', () => ({
      modelsApi: {
        list: vi.fn().mockResolvedValue({ models: [] }),
        getCurrent: vi.fn().mockResolvedValue({ model: null }),
        setCurrent: vi.fn(),
        getEffort: vi.fn().mockResolvedValue({ level: 'medium' }),
        setEffort: vi.fn(),
      },
    }))
    vi.doMock('../api/h5Access', () => ({
      h5AccessApi: {
        get: vi.fn().mockResolvedValue({
          settings: {
            enabled: false,
            tokenPreview: null,
            allowedOrigins: [],
            publicBaseUrl: null,
          },
        }),
        enable: vi.fn(),
        disable: vi.fn(),
        regenerate: vi.fn(),
        update: vi.fn(),
      },
    }))

    const { useSettingsStore } = await import('./settingsStore')

    await useSettingsStore.getState().fetchAll()

    expect(useSettingsStore.getState().workspaceLsp).toEqual({
      server: {
        name: 'custom:typescript',
        path: 'C:\\Program Files\\Example LSP\\server.exe',
        args: ['--stdio'],
        extensionToLanguage: { '.ts': 'typescript' },
      },
    })
  })

  it('persists custom workspace LSP path or bare command with args array', async () => {
    const updateUser = vi.fn().mockResolvedValue({})
    vi.doMock('../api/settings', () => ({
      settingsApi: {
        getUser: vi.fn(),
        updateUser,
        getPermissionMode: vi.fn(),
        setPermissionMode: vi.fn(),
        getCliLauncherStatus: vi.fn(),
      },
    }))
    vi.doMock('../api/models', () => ({
      modelsApi: {
        list: vi.fn(),
        getCurrent: vi.fn(),
        setCurrent: vi.fn(),
        getEffort: vi.fn(),
        setEffort: vi.fn(),
      },
    }))
    vi.doMock('../api/h5Access', () => ({
      h5AccessApi: {
        get: vi.fn(),
        enable: vi.fn(),
        disable: vi.fn(),
        regenerate: vi.fn(),
        update: vi.fn(),
      },
    }))

    const { useSettingsStore } = await import('./settingsStore')

    await useSettingsStore.getState().setWorkspaceLsp({
      server: {
        path: ' C:\\Program Files\\Example LSP\\server.exe ',
        command: 'ignored-when-path-is-set',
        args: ['--stdio'],
        extensionToLanguage: { '.TS': 'typescript' },
      },
    })

    expect(useSettingsStore.getState().workspaceLsp).toEqual({
      server: {
        path: 'C:\\Program Files\\Example LSP\\server.exe',
        args: ['--stdio'],
        extensionToLanguage: { '.ts': 'typescript' },
      },
    })
    expect(updateUser).toHaveBeenCalledWith({
      workspaceLsp: {
        server: {
          path: 'C:\\Program Files\\Example LSP\\server.exe',
          args: ['--stdio'],
          extensionToLanguage: { '.ts': 'typescript' },
        },
      },
    })
  })
})
describe('settingsStore app mode', () => {
  const installElectronAppModeHost = (appMode: Partial<typeof browserHost.appMode>) => {
    window.desktopHost = {
      ...browserHost,
      kind: 'electron',
      isDesktop: true,
      capabilities: {
        ...browserHost.capabilities,
        appMode: true,
      },
      appMode: {
        ...browserHost.appMode,
        ...appMode,
      },
    }
  }

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__
    Reflect.deleteProperty(window, 'desktopHost')
    Reflect.deleteProperty(window, '__TAURI__')
  })

  it('hydrates app mode from the Electron desktop host', async () => {
    const getAppMode = vi.fn().mockResolvedValue({
      mode: 'portable',
      portableDir: 'C:\\cc-haha\\CLAUDE_CONFIG_DIR',
      defaultPortableDir: 'C:\\cc-haha\\CLAUDE_CONFIG_DIR',
    })
    installElectronAppModeHost({ get: getAppMode })

    const { useSettingsStore } = await import('./settingsStore')

    await useSettingsStore.getState().fetchAppMode()

    expect(getAppMode).toHaveBeenCalledTimes(1)
    expect(useSettingsStore.getState().appMode).toEqual({
      mode: 'portable',
      portableDir: 'C:\\cc-haha\\CLAUDE_CONFIG_DIR',
      defaultPortableDir: 'C:\\cc-haha\\CLAUDE_CONFIG_DIR',
    })
  })

  it('hydrates app mode from an injected desktop host', async () => {
    const getAppMode = vi.fn().mockResolvedValue({
      mode: 'portable',
      portableDir: 'D:\\cc-haha\\data',
      defaultPortableDir: 'D:\\cc-haha\\data',
    })
    installElectronAppModeHost({ get: getAppMode })

    const { useSettingsStore } = await import('./settingsStore')

    await useSettingsStore.getState().fetchAppMode()

    expect(getAppMode).toHaveBeenCalledTimes(1)
    expect(useSettingsStore.getState().appMode).toEqual({
      mode: 'portable',
      portableDir: 'D:\\cc-haha\\data',
      defaultPortableDir: 'D:\\cc-haha\\data',
    })
  })

  it('persists app mode through the Electron desktop host and marks restart required', async () => {
    const setAppMode = vi.fn().mockResolvedValue(undefined)
    installElectronAppModeHost({ set: setAppMode })

    const { useSettingsStore } = await import('./settingsStore')
    useSettingsStore.setState({
      appMode: {
        mode: 'default',
        portableDir: null,
        defaultPortableDir: 'C:\\cc-haha\\CLAUDE_CONFIG_DIR',
      },
      appModeRequiresRestart: false,
    })

    await useSettingsStore.getState().setAppMode('portable')

    expect(setAppMode).toHaveBeenCalledWith({
      mode: 'portable',
      portableDir: 'C:\\cc-haha\\CLAUDE_CONFIG_DIR',
    })
    expect(useSettingsStore.getState().appMode).toEqual({
      mode: 'portable',
      portableDir: 'C:\\cc-haha\\CLAUDE_CONFIG_DIR',
      defaultPortableDir: 'C:\\cc-haha\\CLAUDE_CONFIG_DIR',
      activeConfigDir: 'C:\\cc-haha\\CLAUDE_CONFIG_DIR',
      configDirSource: 'portable',
    })
    expect(useSettingsStore.getState().appModeRequiresRestart).toBe(true)
  })

  it('persists app mode through an injected desktop host', async () => {
    const setAppMode = vi.fn().mockResolvedValue(undefined)
    installElectronAppModeHost({ set: setAppMode })

    const { useSettingsStore } = await import('./settingsStore')
    useSettingsStore.setState({
      appMode: {
        mode: 'default',
        portableDir: null,
        defaultPortableDir: 'D:\\cc-haha\\data',
      },
      appModeRequiresRestart: false,
    })

    await useSettingsStore.getState().setAppMode('portable')

    expect(setAppMode).toHaveBeenCalledWith({
      mode: 'portable',
      portableDir: 'D:\\cc-haha\\data',
    })
    expect(useSettingsStore.getState().appModeRequiresRestart).toBe(true)
  })

  it('persists a user-selected portable directory', async () => {
    const setAppMode = vi.fn().mockResolvedValue(undefined)
    installElectronAppModeHost({ set: setAppMode })

    const { useSettingsStore } = await import('./settingsStore')
    useSettingsStore.setState({
      appMode: {
        mode: 'default',
        portableDir: null,
        defaultPortableDir: 'C:\\cc-haha\\CLAUDE_CONFIG_DIR',
      },
      appModeRequiresRestart: false,
    })

    await useSettingsStore.getState().setAppMode('portable', 'D:\\portable-data')

    expect(setAppMode).toHaveBeenCalledWith({
      mode: 'portable',
      portableDir: 'D:\\portable-data',
    })
    expect(useSettingsStore.getState().appMode).toMatchObject({
      mode: 'portable',
      portableDir: 'D:\\portable-data',
      activeConfigDir: 'D:\\portable-data',
      configDirSource: 'portable',
    })
  })

  it('switches app mode back to the system data source', async () => {
    const setAppMode = vi.fn().mockResolvedValue(undefined)
    installElectronAppModeHost({ set: setAppMode })

    const { useSettingsStore } = await import('./settingsStore')
    useSettingsStore.setState({
      appMode: {
        mode: 'portable',
        portableDir: 'D:\\portable-data',
        defaultPortableDir: 'C:\\cc-haha\\CLAUDE_CONFIG_DIR',
        activeConfigDir: 'D:\\portable-data',
        configDirSource: 'portable',
      },
      appModeRequiresRestart: false,
    })

    await useSettingsStore.getState().setAppMode('default', null)

    expect(setAppMode).toHaveBeenCalledWith({
      mode: 'default',
      portableDir: null,
    })
    expect(useSettingsStore.getState().appMode).toEqual({
      mode: 'default',
      portableDir: null,
      defaultPortableDir: 'C:\\cc-haha\\CLAUDE_CONFIG_DIR',
      activeConfigDir: null,
      configDirSource: 'system',
    })
    expect(useSettingsStore.getState().appModeRequiresRestart).toBe(true)
  })
})

describe('settingsStore desktop notification persistence', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    window.localStorage.clear()
  })

  it('defaults desktop notifications to explicit opt-in', async () => {
    vi.doMock('../api/settings', () => ({
      settingsApi: {
        getUser: vi.fn(),
        updateUser: vi.fn(),
        getPermissionMode: vi.fn(),
        setPermissionMode: vi.fn(),
        getCliLauncherStatus: vi.fn(),
      },
    }))
    vi.doMock('../api/models', () => ({
      modelsApi: {
        list: vi.fn(),
        getCurrent: vi.fn(),
        setCurrent: vi.fn(),
        getEffort: vi.fn(),
        setEffort: vi.fn(),
      },
    }))
    vi.doMock('../api/h5Access', () => ({
      h5AccessApi: {
        get: vi.fn().mockResolvedValue({
          settings: {
            enabled: false,
            tokenPreview: null,
            allowedOrigins: [],
            publicBaseUrl: null,
          },
        }),
        enable: vi.fn(),
        disable: vi.fn(),
        regenerate: vi.fn(),
        update: vi.fn(),
      },
    }))

    const { useSettingsStore } = await import('./settingsStore')

    expect(useSettingsStore.getState().desktopNotificationsEnabled).toBe(false)
  })

  it('keeps desktop notifications disabled when user settings do not opt in', async () => {
    vi.doMock('../api/settings', () => ({
      settingsApi: {
        getUser: vi.fn().mockResolvedValue({}),
        updateUser: vi.fn(),
        getPermissionMode: vi.fn().mockResolvedValue({ mode: 'default' }),
        setPermissionMode: vi.fn(),
        getCliLauncherStatus: vi.fn(),
      },
    }))
    vi.doMock('../api/models', () => ({
      modelsApi: {
        list: vi.fn().mockResolvedValue({ models: [] }),
        getCurrent: vi.fn().mockResolvedValue({ model: null }),
        setCurrent: vi.fn(),
        getEffort: vi.fn().mockResolvedValue({ level: 'medium' }),
        setEffort: vi.fn(),
      },
    }))
    vi.doMock('../api/h5Access', () => ({
      h5AccessApi: {
        get: vi.fn().mockResolvedValue({
          settings: {
            enabled: false,
            tokenPreview: null,
            allowedOrigins: [],
            publicBaseUrl: null,
          },
        }),
        enable: vi.fn(),
        disable: vi.fn(),
        regenerate: vi.fn(),
        update: vi.fn(),
      },
    }))

    const { useSettingsStore } = await import('./settingsStore')

    await useSettingsStore.getState().fetchAll()

    expect(useSettingsStore.getState().desktopNotificationsEnabled).toBe(false)
  })

  it('persists the latest desktop notification toggle when saves overlap', async () => {
    const pendingSaves: Array<() => void> = []
    const updateUser = vi.fn(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          pendingSaves.push(() => resolve({ ok: true }))
        }),
    )

    vi.doMock('../api/settings', () => ({
      settingsApi: {
        getUser: vi.fn(),
        updateUser,
        getPermissionMode: vi.fn(),
        setPermissionMode: vi.fn(),
        getCliLauncherStatus: vi.fn(),
      },
    }))
    vi.doMock('../api/models', () => ({
      modelsApi: {
        list: vi.fn(),
        getCurrent: vi.fn(),
        setCurrent: vi.fn(),
        getEffort: vi.fn(),
        setEffort: vi.fn(),
      },
    }))
    vi.doMock('../api/h5Access', () => ({
      h5AccessApi: {
        get: vi.fn().mockResolvedValue({
          settings: {
            enabled: false,
            tokenPreview: null,
            allowedOrigins: [],
            publicBaseUrl: null,
          },
        }),
        enable: vi.fn(),
        disable: vi.fn(),
        regenerate: vi.fn(),
        update: vi.fn(),
      },
    }))

    const { useSettingsStore } = await import('./settingsStore')

    const firstSave = useSettingsStore.getState().setDesktopNotificationsEnabled(false)
    await vi.waitFor(() => {
      expect(updateUser).toHaveBeenCalledWith({ desktopNotificationsEnabled: false })
    })

    const secondSave = useSettingsStore.getState().setDesktopNotificationsEnabled(true)
    expect(useSettingsStore.getState().desktopNotificationsEnabled).toBe(true)

    pendingSaves.shift()?.()
    await vi.waitFor(() => {
      expect(updateUser).toHaveBeenCalledWith({ desktopNotificationsEnabled: true })
    })
    pendingSaves.shift()?.()
    await Promise.all([firstSave, secondSave])

    expect(updateUser).toHaveBeenLastCalledWith({ desktopNotificationsEnabled: true })
    expect(useSettingsStore.getState().desktopNotificationsEnabled).toBe(true)
  })
})

describe('settingsStore thinking persistence', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    window.localStorage.clear()
  })

  it('persists both enabled and disabled thinking states explicitly', async () => {
    const updateUser = vi.fn().mockResolvedValue({})

    vi.doMock('../api/settings', () => ({
      settingsApi: {
        getUser: vi.fn(),
        updateUser,
        getPermissionMode: vi.fn(),
        setPermissionMode: vi.fn(),
        getCliLauncherStatus: vi.fn(),
      },
    }))
    vi.doMock('../api/models', () => ({
      modelsApi: {
        list: vi.fn(),
        getCurrent: vi.fn(),
        setCurrent: vi.fn(),
        getEffort: vi.fn(),
        setEffort: vi.fn(),
      },
    }))
    vi.doMock('../api/h5Access', () => ({
      h5AccessApi: {
        get: vi.fn(),
        enable: vi.fn(),
        disable: vi.fn(),
        regenerate: vi.fn(),
        update: vi.fn(),
      },
    }))

    const { useSettingsStore } = await import('./settingsStore')

    await useSettingsStore.getState().setThinkingEnabled(false)
    await useSettingsStore.getState().setThinkingEnabled(true)

    expect(updateUser).toHaveBeenNthCalledWith(1, { alwaysThinkingEnabled: false })
    expect(updateUser).toHaveBeenNthCalledWith(2, { alwaysThinkingEnabled: true })
    expect(useSettingsStore.getState().thinkingEnabled).toBe(true)
  })

  it('rolls back the thinking toggle when persistence fails', async () => {
    vi.doMock('../api/settings', () => ({
      settingsApi: {
        getUser: vi.fn(),
        updateUser: vi.fn().mockRejectedValue(new Error('save failed')),
        getPermissionMode: vi.fn(),
        setPermissionMode: vi.fn(),
        getCliLauncherStatus: vi.fn(),
      },
    }))
    vi.doMock('../api/models', () => ({
      modelsApi: {
        list: vi.fn(),
        getCurrent: vi.fn(),
        setCurrent: vi.fn(),
        getEffort: vi.fn(),
        setEffort: vi.fn(),
      },
    }))
    vi.doMock('../api/h5Access', () => ({
      h5AccessApi: {
        get: vi.fn(),
        enable: vi.fn(),
        disable: vi.fn(),
        regenerate: vi.fn(),
        update: vi.fn(),
      },
    }))

    const { useSettingsStore } = await import('./settingsStore')

    await useSettingsStore.getState().setThinkingEnabled(false)

    expect(useSettingsStore.getState().thinkingEnabled).toBe(true)
  })
})

describe('settingsStore desktop terminal shell persistence', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    window.localStorage.clear()
  })

  it('hydrates desktop terminal settings from user settings and falls back to system defaults', async () => {
    vi.doMock('../api/settings', () => ({
      settingsApi: {
        getUser: vi.fn().mockResolvedValue({
          desktopTerminal: {
            startupShell: 'pwsh',
            customShellPath: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
          },
        }),
        updateUser: vi.fn(),
        getPermissionMode: vi.fn().mockResolvedValue({ mode: 'default' }),
        setPermissionMode: vi.fn(),
        getCliLauncherStatus: vi.fn(),
      },
    }))
    vi.doMock('../api/models', () => ({
      modelsApi: {
        list: vi.fn().mockResolvedValue({ models: [] }),
        getCurrent: vi.fn().mockResolvedValue({ model: null }),
        setCurrent: vi.fn(),
        getEffort: vi.fn().mockResolvedValue({ level: 'medium' }),
        setEffort: vi.fn(),
      },
    }))
    vi.doMock('../api/h5Access', () => ({
      h5AccessApi: {
        get: vi.fn().mockResolvedValue({
          settings: {
            enabled: false,
            tokenPreview: null,
            allowedOrigins: [],
            publicBaseUrl: null,
          },
        }),
        enable: vi.fn(),
        disable: vi.fn(),
        regenerate: vi.fn(),
        update: vi.fn(),
      },
    }))

    const { useSettingsStore } = await import('./settingsStore')

    expect(useSettingsStore.getState().desktopTerminal).toEqual({
      startupShell: 'system',
      customShellPath: '',
    })

    await useSettingsStore.getState().fetchAll()

    expect(useSettingsStore.getState().desktopTerminal).toEqual({
      startupShell: 'pwsh',
      customShellPath: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    })
  })

  it('persists desktop terminal settings explicitly', async () => {
    const updateUser = vi.fn().mockResolvedValue({ ok: true })

    vi.doMock('../api/settings', () => ({
      settingsApi: {
        getUser: vi.fn(),
        updateUser,
        getPermissionMode: vi.fn(),
        setPermissionMode: vi.fn(),
        getCliLauncherStatus: vi.fn(),
      },
    }))
    vi.doMock('../api/models', () => ({
      modelsApi: {
        list: vi.fn(),
        getCurrent: vi.fn(),
        setCurrent: vi.fn(),
        getEffort: vi.fn(),
        setEffort: vi.fn(),
      },
    }))
    vi.doMock('../api/h5Access', () => ({
      h5AccessApi: {
        get: vi.fn().mockResolvedValue({
          settings: {
            enabled: false,
            tokenPreview: null,
            allowedOrigins: [],
            publicBaseUrl: null,
          },
        }),
        enable: vi.fn(),
        disable: vi.fn(),
        regenerate: vi.fn(),
        update: vi.fn(),
      },
    }))

    const { useSettingsStore } = await import('./settingsStore')

    await useSettingsStore.getState().setDesktopTerminal({
      startupShell: 'custom',
      customShellPath: 'C:\\tools\\pwsh.exe',
    })

    expect(updateUser).toHaveBeenCalledWith({
      desktopTerminal: {
        startupShell: 'custom',
        customShellPath: 'C:\\tools\\pwsh.exe',
      },
    })
    expect(useSettingsStore.getState().desktopTerminal).toEqual({
      startupShell: 'custom',
      customShellPath: 'C:\\tools\\pwsh.exe',
    })
  })
})

describe('settingsStore theme persistence', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    window.localStorage.clear()
    document.documentElement.removeAttribute('data-theme')
    document.documentElement.style.colorScheme = ''
  })

  it('falls back to the pure white theme when user settings have no theme', async () => {
    vi.doMock('../api/settings', () => ({
      settingsApi: {
        getUser: vi.fn().mockResolvedValue({}),
        updateUser: vi.fn(),
        getPermissionMode: vi.fn().mockResolvedValue({ mode: 'default' }),
        setPermissionMode: vi.fn(),
        getCliLauncherStatus: vi.fn(),
      },
    }))
    vi.doMock('../api/models', () => ({
      modelsApi: {
        list: vi.fn().mockResolvedValue({ models: [] }),
        getCurrent: vi.fn().mockResolvedValue({ model: null }),
        setCurrent: vi.fn(),
        getEffort: vi.fn().mockResolvedValue({ level: 'medium' }),
        setEffort: vi.fn(),
      },
    }))
    vi.doMock('../api/h5Access', () => ({
      h5AccessApi: {
        get: vi.fn().mockResolvedValue({
          settings: {
            enabled: false,
            tokenPreview: null,
            allowedOrigins: [],
            publicBaseUrl: null,
          },
        }),
        enable: vi.fn(),
        disable: vi.fn(),
        regenerate: vi.fn(),
        update: vi.fn(),
      },
    }))

    const { useSettingsStore } = await import('./settingsStore')
    const { useUIStore } = await import('./uiStore')

    await useSettingsStore.getState().fetchAll()

    expect(useSettingsStore.getState().theme).toBe('white')
    expect(useUIStore.getState().theme).toBe('white')
    expect(document.documentElement.getAttribute('data-theme')).toBe('white')
    expect(document.documentElement.style.colorScheme).toBe('light')
  })

  it('hydrates the pure white theme from user settings', async () => {
    vi.doMock('../api/settings', () => ({
      settingsApi: {
        getUser: vi.fn().mockResolvedValue({ theme: 'white' }),
        updateUser: vi.fn(),
        getPermissionMode: vi.fn().mockResolvedValue({ mode: 'default' }),
        setPermissionMode: vi.fn(),
        getCliLauncherStatus: vi.fn(),
      },
    }))
    vi.doMock('../api/models', () => ({
      modelsApi: {
        list: vi.fn().mockResolvedValue({ models: [] }),
        getCurrent: vi.fn().mockResolvedValue({ model: null }),
        setCurrent: vi.fn(),
        getEffort: vi.fn().mockResolvedValue({ level: 'medium' }),
        setEffort: vi.fn(),
      },
    }))
    vi.doMock('../api/h5Access', () => ({
      h5AccessApi: {
        get: vi.fn().mockResolvedValue({
          settings: {
            enabled: false,
            tokenPreview: null,
            allowedOrigins: [],
            publicBaseUrl: null,
          },
        }),
        enable: vi.fn(),
        disable: vi.fn(),
        regenerate: vi.fn(),
        update: vi.fn(),
      },
    }))

    const { useSettingsStore } = await import('./settingsStore')
    const { useUIStore } = await import('./uiStore')

    await useSettingsStore.getState().fetchAll()

    expect(useSettingsStore.getState().theme).toBe('white')
    expect(useUIStore.getState().theme).toBe('white')
    expect(document.documentElement.getAttribute('data-theme')).toBe('white')
    expect(document.documentElement.style.colorScheme).toBe('light')
  })
})

describe('settingsStore H5 access behavior', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    window.localStorage.clear()
  })

  it.each([404, 405])('falls back to disabled defaults only for legacy H5 endpoint status %s', async (status) => {
    vi.doMock('../api/settings', () => ({
      settingsApi: {
        getUser: vi.fn().mockResolvedValue({}),
        updateUser: vi.fn(),
        getPermissionMode: vi.fn().mockResolvedValue({ mode: 'default' }),
        setPermissionMode: vi.fn(),
        getCliLauncherStatus: vi.fn(),
      },
    }))
    vi.doMock('../api/models', () => ({
      modelsApi: {
        list: vi.fn().mockResolvedValue({ models: [] }),
        getCurrent: vi.fn().mockResolvedValue({ model: null }),
        setCurrent: vi.fn(),
        getEffort: vi.fn().mockResolvedValue({ level: 'medium' }),
        setEffort: vi.fn(),
      },
    }))
    vi.doMock('../api/h5Access', () => ({
      h5AccessApi: {
        get: vi.fn().mockRejectedValue(new ApiError(status, { message: 'legacy' })),
        enable: vi.fn(),
        disable: vi.fn(),
        regenerate: vi.fn(),
        update: vi.fn(),
      },
    }))

    const { useSettingsStore } = await import('./settingsStore')
    useSettingsStore.setState({
      h5Access: {
        enabled: true,
        tokenPreview: 'h5_prev',
        allowedOrigins: ['https://prev.example'],
        publicBaseUrl: 'https://prev.example/app',
      },
    })

    await useSettingsStore.getState().fetchAll()

    expect(useSettingsStore.getState().h5Access).toEqual({
      enabled: false,
      tokenPreview: null,
      allowedOrigins: [],
      publicBaseUrl: null,
    })
    expect(useSettingsStore.getState().h5AccessError).toBeNull()
  })

  it('preserves the last known H5 state and surfaces an H5 error on non-legacy load failures', async () => {
    vi.doMock('../api/settings', () => ({
      settingsApi: {
        getUser: vi.fn().mockResolvedValue({}),
        updateUser: vi.fn(),
        getPermissionMode: vi.fn().mockResolvedValue({ mode: 'default' }),
        setPermissionMode: vi.fn(),
        getCliLauncherStatus: vi.fn(),
      },
    }))
    vi.doMock('../api/models', () => ({
      modelsApi: {
        list: vi.fn().mockResolvedValue({ models: [] }),
        getCurrent: vi.fn().mockResolvedValue({ model: null }),
        setCurrent: vi.fn(),
        getEffort: vi.fn().mockResolvedValue({ level: 'medium' }),
        setEffort: vi.fn(),
      },
    }))
    vi.doMock('../api/h5Access', () => ({
      h5AccessApi: {
        get: vi.fn().mockRejectedValue(new ApiError(500, { message: 'H5 unavailable' })),
        enable: vi.fn(),
        disable: vi.fn(),
        regenerate: vi.fn(),
        update: vi.fn(),
      },
    }))

    const { useSettingsStore } = await import('./settingsStore')
    useSettingsStore.setState({
      h5Access: {
        enabled: true,
        tokenPreview: 'h5_prev',
        allowedOrigins: ['https://prev.example'],
        publicBaseUrl: 'https://prev.example/app',
      },
    })

    await useSettingsStore.getState().fetchAll()

    expect(useSettingsStore.getState().h5Access).toEqual({
      enabled: true,
      tokenPreview: 'h5_prev',
      allowedOrigins: ['https://prev.example'],
      publicBaseUrl: 'https://prev.example/app',
    })
    expect(useSettingsStore.getState().h5AccessError).toBe('H5 unavailable')
  })

  it('handles H5 enable, regenerate, and disable transitions without persisting a raw token in store state', async () => {
    vi.doMock('../api/settings', () => ({
      settingsApi: {
        getUser: vi.fn(),
        updateUser: vi.fn(),
        getPermissionMode: vi.fn(),
        setPermissionMode: vi.fn(),
        getCliLauncherStatus: vi.fn(),
      },
    }))
    vi.doMock('../api/models', () => ({
      modelsApi: {
        list: vi.fn(),
        getCurrent: vi.fn(),
        setCurrent: vi.fn(),
        getEffort: vi.fn(),
        setEffort: vi.fn(),
      },
    }))
    vi.doMock('../api/h5Access', () => ({
      h5AccessApi: {
        get: vi.fn(),
        enable: vi.fn().mockResolvedValue({
          settings: {
            enabled: true,
            tokenPreview: 'h5_first',
            allowedOrigins: [],
            publicBaseUrl: null,
          },
          token: 'raw-enable-token',
        }),
        disable: vi.fn().mockResolvedValue({
          settings: {
            enabled: false,
            tokenPreview: null,
            allowedOrigins: [],
            publicBaseUrl: null,
          },
        }),
        regenerate: vi.fn().mockResolvedValue({
          settings: {
            enabled: true,
            tokenPreview: 'h5_second',
            allowedOrigins: ['https://phone.example'],
            publicBaseUrl: 'https://phone.example/app',
          },
          token: 'raw-regenerated-token',
        }),
        update: vi.fn(),
      },
    }))

    const { useSettingsStore } = await import('./settingsStore')

    await expect(useSettingsStore.getState().enableH5Access()).resolves.toBe('raw-enable-token')
    expect(useSettingsStore.getState().h5Access).toEqual({
      enabled: true,
      tokenPreview: 'h5_first',
      allowedOrigins: [],
      publicBaseUrl: null,
    })

    await expect(useSettingsStore.getState().regenerateH5AccessToken()).resolves.toBe('raw-regenerated-token')
    expect(useSettingsStore.getState().h5Access).toEqual({
      enabled: true,
      tokenPreview: 'h5_second',
      allowedOrigins: ['https://phone.example'],
      publicBaseUrl: 'https://phone.example/app',
    })

    await expect(useSettingsStore.getState().disableH5Access()).resolves.toBeUndefined()
    expect(useSettingsStore.getState().h5Access).toEqual({
      enabled: false,
      tokenPreview: null,
      allowedOrigins: [],
      publicBaseUrl: null,
    })
    expect(useSettingsStore.getState().h5AccessError).toBeNull()
    expect('h5AccessGeneratedToken' in useSettingsStore.getState()).toBe(false)
  })
})
