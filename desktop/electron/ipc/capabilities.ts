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

const isSafeUiLabel = (value: unknown) =>
  typeof value === 'string'
  && value.trim().length > 0
  && value.length <= 120
  && !/[\u0000-\u001f\u007f-\u009f]/.test(value)

const petCreateFromAtlas: Validator = value => {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'slug',
    'displayName',
    'description',
    'dialogTitle',
    'dialogFilterName',
  ])) return false
  if (
    typeof value.slug !== 'string'
    || value.slug.length === 0
    || value.slug.length > 73
    || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.slug)
  ) return false
  return typeof value.displayName === 'string'
    && value.displayName.trim().length > 0
    && value.displayName.length <= 80
    && typeof value.description === 'string'
    && value.description.trim().length > 0
    && value.description.length <= 500
    && (value.dialogTitle === undefined || isSafeUiLabel(value.dialogTitle))
    && (value.dialogFilterName === undefined || isSafeUiLabel(value.dialogFilterName))
}

const petContextMenu: Validator = value => {
  if (!isRecord(value) || !hasOnlyKeys(value, ['closeLabel'])) return false
  if (typeof value.closeLabel !== 'string' || value.closeLabel.length > 80) return false
  const closeLabel = value.closeLabel.trim()
  return closeLabel.length > 0
    && closeLabel.length <= 80
    && !/[\u0000-\u001f\u007f-\u009f]/.test(value.closeLabel)
}

const petWindowDrag: Validator = value => {
  if (!isRecord(value) || !hasOnlyKeys(value, ['phase', 'x', 'y'])) return false
  if (value.phase !== 'start' && value.phase !== 'move' && value.phase !== 'end') return false
  return ['x', 'y'].every((key) =>
    typeof value[key] === 'number'
    && Number.isFinite(value[key])
    && Math.abs(value[key]) <= 1_000_000)
}

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

const petInteractiveRegions: Validator = value =>
  Array.isArray(value)
  && value.length > 0
  && value.length <= 8
  && value.every((region) =>
    isRecord(region)
    && hasOnlyKeys(region, ['x', 'y', 'width', 'height'])
    && ['x', 'y', 'width', 'height'].every((key) =>
      typeof region[key] === 'number'
      && Number.isInteger(region[key])
      && region[key] >= (key === 'width' || key === 'height' ? 1 : 0)
      && region[key] <= 2_000))

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
  [ELECTRON_IPC_CHANNELS.runtimeGetLocalAccessToken]: noPayload,
  [ELECTRON_IPC_CHANNELS.runtimeGetPetAccessToken]: noPayload,
  [ELECTRON_IPC_CHANNELS.commandInvoke]: commandInvoke,
  [ELECTRON_IPC_CHANNELS.clipboardReadText]: noPayload,
  [ELECTRON_IPC_CHANNELS.clipboardWriteText]: stringPayload,
  [ELECTRON_IPC_CHANNELS.shellOpen]: stringPayload,
  [ELECTRON_IPC_CHANNELS.shellOpenPath]: stringPayload,
  [ELECTRON_IPC_CHANNELS.traceOpenWindow]: sessionIdPayload,
  [ELECTRON_IPC_CHANNELS.petsList]: noPayload,
  [ELECTRON_IPC_CHANNELS.petsCreateFromImage]: petCreateFromAtlas,
  [ELECTRON_IPC_CHANNELS.petsCreateFromAtlas]: petCreateFromAtlas,
  [ELECTRON_IPC_CHANNELS.petsOpenFolder]: noPayload,
  [ELECTRON_IPC_CHANNELS.petsShow]: noPayload,
  [ELECTRON_IPC_CHANNELS.petsHide]: noPayload,
  [ELECTRON_IPC_CHANNELS.petsShowContextMenu]: petContextMenu,
  [ELECTRON_IPC_CHANNELS.petsDragWindow]: petWindowDrag,
  [ELECTRON_IPC_CHANNELS.petsSetIgnoreMouseEvents]: booleanPayload,
  [ELECTRON_IPC_CHANNELS.petsSetInteractiveRegions]: petInteractiveRegions,
  [ELECTRON_IPC_CHANNELS.petsFocusSession]: sessionIdPayload,
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
  [ELECTRON_IPC_CHANNELS.windowStartDragging]: noPayload,
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
  [ELECTRON_IPC_CHANNELS.previewSetZoom]: zoomPayload,
  [ELECTRON_IPC_CHANNELS.previewClose]: noPayload,
  [ELECTRON_IPC_CHANNELS.previewMessage]: () => true,
  [ELECTRON_IPC_CHANNELS.appModeGet]: noPayload,
  [ELECTRON_IPC_CHANNELS.appModeSet]: optionalRecord,
  [ELECTRON_IPC_CHANNELS.appModePrepareRestart]: noPayload,
  [ELECTRON_IPC_CHANNELS.appModeRestart]: noPayload,
  [ELECTRON_IPC_CHANNELS.adaptersRestartSidecar]: noPayload,
  [ELECTRON_IPC_CHANNELS.zoomSet]: zoomPayload,
} satisfies Record<ElectronIpcChannel, Validator>

const allowedChannels = new Set<ElectronIpcChannel>(
  Object.values(ELECTRON_IPC_CHANNELS),
)

const petWindowChannels = new Set<ElectronIpcChannel>([
  ELECTRON_IPC_CHANNELS.runtimeGetServerUrl,
  ELECTRON_IPC_CHANNELS.runtimeGetPetAccessToken,
  ELECTRON_IPC_CHANNELS.petsList,
  ELECTRON_IPC_CHANNELS.petsHide,
  ELECTRON_IPC_CHANNELS.petsShowContextMenu,
  ELECTRON_IPC_CHANNELS.petsDragWindow,
  ELECTRON_IPC_CHANNELS.petsSetIgnoreMouseEvents,
  ELECTRON_IPC_CHANNELS.petsSetInteractiveRegions,
  ELECTRON_IPC_CHANNELS.petsFocusSession,
])

export function isElectronIpcChannel(channel: string): channel is ElectronIpcChannel {
  return allowedChannels.has(channel as ElectronIpcChannel)
}

export function validateElectronIpcPayload(channel: ElectronIpcChannel, payload: unknown): boolean {
  return ELECTRON_IPC_VALIDATORS[channel](payload)
}

export function isElectronIpcChannelAllowedForPetWindow(channel: ElectronIpcChannel): boolean {
  return petWindowChannels.has(channel)
}
