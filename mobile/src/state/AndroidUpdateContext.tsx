import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { AppState, Platform } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import Constants from 'expo-constants'
import * as Network from 'expo-network'
import CCHahaUpdater from '../../modules/cchaha-updater'
import { isH5 } from './h5'
import {
  buildAndroidUpdateViewModel,
  type AndroidUpdateSnapshot,
  type AndroidUpdateViewModel,
  type UpdateSource,
} from '../core/androidUpdateModel'
import { useConnection } from './AppContext'
import {
  AndroidUpdateController,
  type ActiveDesktopConnection,
  type DesktopLatestResponse,
  type DesktopPrepareResponse,
} from './androidUpdateController'
import { AndroidUpdateStore } from './androidUpdateStorage'
import { isAndroidOtaSupported } from './androidUpdateSupport'

export type AndroidUpdateContextValue = {
  supported: boolean
  snapshot: AndroidUpdateSnapshot | null
  viewModel: AndroidUpdateViewModel | null
  checkForUpdates(options?: { preferDesktop?: boolean; directOnly?: boolean }): Promise<void>
  shouldWarnCellular(): Promise<boolean>
  download(source: UpdateSource): Promise<void>
  cancelDownload(): Promise<void>
  install(): Promise<void>
  openUnknownSourcesSettings(): Promise<void>
  retryInstallAfterPermission(): Promise<void>
  deleteDownloadedApk(): Promise<void>
  dismissAvailableVersion(): Promise<void>
  setSettingsFocused(focused: boolean): void
}

const NOOP_CONTEXT: AndroidUpdateContextValue = {
  supported: false,
  snapshot: null,
  viewModel: null,
  checkForUpdates: async () => {},
  shouldWarnCellular: async () => false,
  download: async () => {},
  cancelDownload: async () => {},
  install: async () => {},
  openUnknownSourcesSettings: async () => {},
  retryInstallAfterPermission: async () => {},
  deleteDownloadedApk: async () => {},
  dismissAvailableVersion: async () => {},
  setSettingsFocused: () => {},
}

const AndroidUpdateContext = createContext<AndroidUpdateContextValue>(NOOP_CONTEXT)

/**
 * 仅依赖 isConnected 判断离线，不检查 isInternetReachable：
 * Android 上 isInternetReachable 依赖 Google 连通性探测（NET_CAPABILITY_VALIDATED）
 * 以及 VPN 带宽字段，国内原生 ROM、纯局域网（靠配对电脑代理更新）和部分 TUN VPN 会误判为 false。
 */
async function probeNetworkState() {
  const state = await Network.getNetworkStateAsync()
  const online = state.isConnected !== false
  const cellular = state.type === Network.NetworkStateType.CELLULAR
  return { online, cellular }
}

export function AndroidUpdateProvider({ children }: React.PropsWithChildren) {
  const supported = isAndroidOtaSupported({
    platform: Platform.OS,
    isH5,
    executionEnvironment: Constants.executionEnvironment,
    hasNativeModule: Boolean(CCHahaUpdater),
  })
  const { host, client, credential } = useConnection()

  const [controller] = useState<AndroidUpdateController | null>(() => {
    if (!supported || !CCHahaUpdater) return null
    return new AndroidUpdateController({
      nativeUpdater: CCHahaUpdater,
      store: new AndroidUpdateStore(AsyncStorage),
      getNetworkState: probeNetworkState,
    })
  })

  const [snapshot, setSnapshot] = useState<AndroidUpdateSnapshot | null>(() =>
    controller ? controller.getSnapshot() : null
  )

  useEffect(() => {
    if (!controller) return
    const nextConnection: ActiveDesktopConnection | null =
      host && client && credential !== undefined
        ? {
            host,
            credential,
            fetchLatest: (refresh: boolean) =>
              client.get<DesktopLatestResponse>(
                refresh ? '/api/mobile-update/android/latest?refresh=1' : '/api/mobile-update/android/latest',
                { timeoutMs: 20_000 }
              ),
            prepareApk: (sha256: string, start: boolean) =>
              client.request<DesktopPrepareResponse>(
                `/api/mobile-update/android/prepare?sha256=${encodeURIComponent(sha256)}`,
                { method: start ? 'POST' : 'GET', timeoutMs: 15_000 }
              ),
          }
        : null
    controller.setConnection(nextConnection)
  }, [controller, host, client, credential])

  useEffect(() => {
    if (!controller) return
    const unsubscribe = controller.subscribe(setSnapshot)
    void controller.start()
    const appStateSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void controller.handleAppForeground()
      } else {
        controller.handleAppBackground()
      }
    })
    return () => {
      unsubscribe()
      appStateSub.remove()
      controller.stop()
    }
  }, [controller])

  const setSettingsFocused = useCallback(
    (focused: boolean) => {
      controller?.setSettingsFocused(focused)
    },
    [controller]
  )

  const value = useMemo<AndroidUpdateContextValue>(() => {
    if (!supported || !controller || !snapshot) return NOOP_CONTEXT
    const viewModel = buildAndroidUpdateViewModel(snapshot)
    return {
      supported: true,
      snapshot,
      viewModel,
      checkForUpdates: (options) =>
        controller.checkForUpdates({
          manual: true,
          preferDesktop: options?.preferDesktop,
          directOnly: options?.directOnly,
        }),
      shouldWarnCellular: () => controller.shouldWarnCellular(),
      download: (source) => controller.download(source),
      cancelDownload: () => controller.cancelDownload(),
      install: () => controller.install(),
      openUnknownSourcesSettings: () => controller.openUnknownSourcesSettings(),
      retryInstallAfterPermission: () => controller.retryInstallAfterPermission(),
      deleteDownloadedApk: () => controller.deleteDownloadedApk(),
      dismissAvailableVersion: () => controller.dismissAvailableVersion(),
      setSettingsFocused,
    }
  }, [supported, controller, snapshot, setSettingsFocused])

  return <AndroidUpdateContext.Provider value={value}>{children}</AndroidUpdateContext.Provider>
}

export function useAndroidUpdate(): AndroidUpdateContextValue {
  return useContext(AndroidUpdateContext)
}
