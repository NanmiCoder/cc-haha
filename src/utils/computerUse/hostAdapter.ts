import type {
  ComputerUseHostAdapter,
  Logger,
} from '../../vendor/computer-use-mcp/types.js'
import { format } from 'util'
import { logForDebugging } from '../debug.js'
import { COMPUTER_USE_MCP_SERVER_NAME } from './common.js'
import { createCliExecutor } from './executor.js'
import { getChicagoEnabled, getChicagoSubGates } from './gates.js'
import { normalizeOsPermissions } from './permissions.js'
// Platform-routed helper: macOS → native cu-helper, Windows → Python helper.
import { callHelper } from './helperBridge.js'
import { maybeShowNativePermissionCard } from './nativePermissionCard.js'
import { ComputerUseRepl } from './replRuntime.js'

class DebugLogger implements Logger {
  silly(message: string, ...args: unknown[]): void {
    logForDebugging(format(message, ...args), { level: 'debug' })
  }
  debug(message: string, ...args: unknown[]): void {
    logForDebugging(format(message, ...args), { level: 'debug' })
  }
  info(message: string, ...args: unknown[]): void {
    logForDebugging(format(message, ...args), { level: 'info' })
  }
  warn(message: string, ...args: unknown[]): void {
    logForDebugging(format(message, ...args), { level: 'warn' })
  }
  error(message: string, ...args: unknown[]): void {
    logForDebugging(format(message, ...args), { level: 'error' })
  }
}

let cached: ComputerUseHostAdapter | undefined

export function getComputerUseHostAdapter(): ComputerUseHostAdapter {
  if (cached) return cached
  cached = {
    serverName: COMPUTER_USE_MCP_SERVER_NAME,
    logger: new DebugLogger(),
    createReplRuntime: () => new ComputerUseRepl(),
    executor: createCliExecutor({
      getMouseAnimationEnabled: () => getChicagoSubGates().mouseAnimation,
      getHideBeforeActionEnabled: () => getChicagoSubGates().hideBeforeAction,
    }),
    ensureOsPermissions: async () => {
      const rawPerms = await callHelper<{ accessibility: boolean; screenRecording: boolean | null }>('check_permissions', {})
      const perms = normalizeOsPermissions(rawPerms)
      if (perms.granted) return { granted: true as const }
      // Missing a TCC grant → pop the native, guided permission card (macOS).
      // Fire-and-forget + debounced; spawned from this same CLI process so it
      // grants the very cu-helper binary that runs injection/capture.
      maybeShowNativePermissionCard({
        accessibility: perms.accessibility,
        screenRecording: perms.screenRecording,
      })
      return { granted: false as const, accessibility: perms.accessibility, screenRecording: perms.screenRecording }
    },
    isDisabled: () => !getChicagoEnabled(),
    getSubGates: getChicagoSubGates,
    getAutoUnhideEnabled: () => true,
    cropRawPatch: () => null,
  }
  return cached
}
