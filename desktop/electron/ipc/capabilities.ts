import { ELECTRON_IPC_CHANNELS, type ElectronIpcChannel } from './channels'

type Validator = (payload: unknown) => boolean

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const noPayload: Validator = value => value === undefined
const optionalRecord: Validator = value => value === undefined || isRecord(value)
const stringPayload: Validator = value => typeof value === 'string'
const booleanPayload: Validator = value => typeof value === 'boolean'
const hasOnlyKeys = (value: Record<string, unknown>, allowedKeys: string[]) =>
  Object.keys(value).every(key => allowedKeys.includes(key))

const sessionIdPayload: Validator = value =>
  typeof value === 'string'
  && value.length > 0
  && value.length <= 200
  && /^[A-Za-z0-9._:-]+$/.test(value)

const commandInvoke: Validator = value =>
  isRecord(value)
  && typeof value.command === 'string'
  && value.command.length > 0
  && (value.args === undefined || isRecord(value.args))

const terminalWrite: Validator = value =>
  isRecord(value)
  && typeof value.sessionId === 'number'
  && typeof value.data === 'string'

const terminalSpawn: Validator = value =>
  value === undefined
  || (
    isRecord(value)
    && (value.cols === undefined || typeof value.cols === 'number')
    && (value.rows === undefined || typeof value.rows === 'number')
    && (value.cwd === undefined || typeof value.cwd === 'string')
    && (value.shell === undefined || typeof value.shell === 'string')
  )

const terminalResize: Validator = value =>
  isRecord(value)
  && typeof value.sessionId === 'number'
  && typeof value.cols === 'number'
  && typeof value.rows === 'number'

const terminalSessionId: Validator = value =>
  isRecord(value)
  && typeof value.sessionId === 'number'

const boundsPayload: Validator = value =>
  isRecord(value)
  && typeof value.x === 'number'
  && typeof value.y === 'number'
  && typeof value.width === 'number'
  && typeof value.height === 'number'

const windowDragMovePayload: Validator = value =>
  value === undefined
  || (
    isRecord(value)
    && hasOnlyKeys(value, ['deltaX', 'deltaY'])
    && typeof value.deltaX === 'number'
    && Number.isFinite(value.deltaX)
    && typeof value.deltaY === 'number'
    && Number.isFinite(value.deltaY)
  )

const urlWithOptionalBounds: Validator = value =>
  isRecord(value)
  && typeof value.url === 'string'
  && (value.bounds === undefined || boundsPayload(value.bounds))

const zoomPayload: Validator = value => typeof value === 'number' && Number.isFinite(value)

const updateCheckOptions: Validator = value => {
  if (value === undefined) return true
  if (!isRecord(value) || !hasOnlyKeys(value, ['proxy'])) return false
  return value.proxy === undefined || (typeof value.proxy === 'string' && value.proxy.trim().length > 0)
}

export const ELECTRON_IPC_VALIDATORS = {
  [ELECTRON_IPC_CHANNELS.appGetVersion]: noPayload,
  [ELECTRON_IPC_CHANNELS.runtimeGetServerUrl]: noPayload,
  [ELECTRON_IPC_CHANNELS.commandInvoke]: commandInvoke,
  [ELECTRON_IPC_CHANNELS.shellOpen]: stringPayload,
  [ELECTRON_IPC_CHANNELS.shellOpenPath]: stringPayload,
  [ELECTRON_IPC_CHANNELS.traceOpenWindow]: sessionIdPayload,
  [ELECTRON_IPC_CHANNELS.dialogOpen]: optionalRecord,
  [ELECTRON_IPC_CHANNELS.dialogSave]: optionalRecord,
  [ELECTRON_IPC_CHANNELS.updateCheck]: updateCheckOptions,
  [ELECTRON_IPC_CHANNELS.updateDownload]: noPayload,
  [ELECTRON_IPC_CHANNELS.updateInstall]: noPayload,
  [ELECTRON_IPC_CHANNELS.updatePrepareInstall]: noPayload,
  [ELECTRON_IPC_CHANNELS.updateCancelInstall]: noPayload,
  [ELECTRON_IPC_CHANNELS.updateRelaunch]: noPayload,
  [ELECTRON_IPC_CHANNELS.notificationPermissionState]: noPayload,
  [ELECTRON_IPC_CHANNELS.notificationRequestPermission]: noPayload,
  [ELECTRON_IPC_CHANNELS.notificationSend]: optionalRecord,
  [ELECTRON_IPC_CHANNELS.notificationActionAck]: optionalRecord,
  [ELECTRON_IPC_CHANNELS.windowMinimize]: noPayload,
  [ELECTRON_IPC_CHANNELS.windowToggleMaximize]: noPayload,
  [ELECTRON_IPC_CHANNELS.windowClose]: noPayload,
  [ELECTRON_IPC_CHANNELS.windowStartDragging]: windowDragMovePayload,
  [ELECTRON_IPC_CHANNELS.windowRequestAttention]: noPayload,
  [ELECTRON_IPC_CHANNELS.windowFocus]: noPayload,
  [ELECTRON_IPC_CHANNELS.windowIsMaximized]: noPayload,
  [ELECTRON_IPC_CHANNELS.terminalSpawn]: terminalSpawn,
  [ELECTRON_IPC_CHANNELS.terminalWrite]: terminalWrite,
  [ELECTRON_IPC_CHANNELS.terminalResize]: terminalResize,
  [ELECTRON_IPC_CHANNELS.terminalKill]: terminalSessionId,
  [ELECTRON_IPC_CHANNELS.terminalGetBashPath]: noPayload,
  [ELECTRON_IPC_CHANNELS.terminalSetBashPath]: value => value === null || stringPayload(value),
  [ELECTRON_IPC_CHANNELS.previewOpen]: urlWithOptionalBounds,
  [ELECTRON_IPC_CHANNELS.previewNavigate]: stringPayload,
  [ELECTRON_IPC_CHANNELS.previewSetBounds]: boundsPayload,
  [ELECTRON_IPC_CHANNELS.previewSetVisible]: booleanPayload,
  [ELECTRON_IPC_CHANNELS.previewClose]: noPayload,
  [ELECTRON_IPC_CHANNELS.previewMessage]: () => true,
  [ELECTRON_IPC_CHANNELS.appModeGet]: noPayload,
  [ELECTRON_IPC_CHANNELS.appModeSet]: optionalRecord,
  [ELECTRON_IPC_CHANNELS.appModeDetectPortableDir]: noPayload,
  [ELECTRON_IPC_CHANNELS.appModePrepareRestart]: noPayload,
  [ELECTRON_IPC_CHANNELS.appModeRestart]: noPayload,
  [ELECTRON_IPC_CHANNELS.adaptersRestartSidecar]: noPayload,
  [ELECTRON_IPC_CHANNELS.zoomSet]: zoomPayload,
} satisfies Record<ElectronIpcChannel, Validator>

const allowedChannels = new Set<ElectronIpcChannel>(
  Object.values(ELECTRON_IPC_CHANNELS),
)

export function isElectronIpcChannel(channel: string): channel is ElectronIpcChannel {
  return allowedChannels.has(channel as ElectronIpcChannel)
}

export function validateElectronIpcPayload(channel: ElectronIpcChannel, payload: unknown): boolean {
  return ELECTRON_IPC_VALIDATORS[channel](payload)
}
