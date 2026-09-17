import { PUBLIC_ACCESS_CONSENT_VERSION } from '../../src/lib/desktopHost/types'
import { HostToolsInputSchema } from '../../src/features/managed-resources/api/hostToolsApi'
import { ApplicationOperationInputSchema } from '../../src/features/managed-resources/api/applicationOperationsApi'
import { ELECTRON_IPC_CHANNELS, type ElectronIpcChannel } from './channels'
import { FolderTransferInputSchema, RevealCredentialInputSchema, SaveHostInputSchema, SaveApplicationInputSchema } from '../../src/features/managed-resources/api/hostManagementApi'
import {
  CloseDataSessionInputSchema,
  DeleteDataConnectionInputSchema,
  GetDataConnectionInputSchema,
  ListDataConnectionsInputSchema,
  OpenDataSessionInputSchema,
  RedisReadInputSchema,
  RedisScanInputSchema,
  SaveDataConnectionInputSchema,
  SqlCancelInputSchema,
  SqlDescribeTableInputSchema,
  SqlExecuteInputSchema,
  SqlListDatabasesInputSchema,
  SqlListSchemasInputSchema,
  SqlListTablesInputSchema,
  SqlPreviewInputSchema,
  TestDataConnectionInputSchema,
} from '../../src/features/managed-resources/api/dataConnectionsApi'
import {
  M4_PATH_MAX_CHARS,
  M4_PAYLOAD_FIELDS,
  isM4AbsolutePosixPath,
  isM4BaseRevision,
  isM4EditText,
  isM4FileName,
  isM4Generation,
  isM4OwnerId,
  isM4Uuid,
} from '../../src/features/managed-resources/api/m4IpcContract'

type Validator = (payload: unknown) => boolean

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const noPayload: Validator = value => value === undefined
const optionalRecord: Validator = value => value === undefined || isRecord(value)
const stringPayload: Validator = value => typeof value === 'string'
const booleanPayload: Validator = value => typeof value === 'boolean'
const hasOnlyKeys = (value: Record<string, unknown>, allowedKeys: readonly string[]) =>
  Object.keys(value).every(key => allowedKeys.includes(key))

const MAX_TERMINAL_DIMENSION = 1_000
const MAX_TERMINAL_CWD_LENGTH = 4_096
const MAX_TERMINAL_WRITE_LENGTH = 1_048_576

const isTerminalSessionId = (value: unknown) =>
  typeof value === 'number'
  && Number.isSafeInteger(value)
  && value > 0

const isTerminalDimension = (value: unknown) =>
  typeof value === 'number'
  && Number.isInteger(value)
  && value > 0
  && value <= MAX_TERMINAL_DIMENSION

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

const hasValidPetIdentity = (value: Record<string, unknown>): boolean => {
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
}

const petCreateFromAtlas: Validator = value => {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'slug',
    'displayName',
    'description',
    'dialogTitle',
    'dialogFilterName',
  ])) return false
  return hasValidPetIdentity(value)
    && (value.dialogTitle === undefined || isSafeUiLabel(value.dialogTitle))
    && (value.dialogFilterName === undefined || isSafeUiLabel(value.dialogFilterName))
}

const petPickSourceSheet: Validator = value => {
  if (value === undefined) return true
  if (!isRecord(value) || !hasOnlyKeys(value, ['dialogTitle', 'dialogFilterName'])) return false
  return (value.dialogTitle === undefined || isSafeUiLabel(value.dialogTitle))
    && (value.dialogFilterName === undefined || isSafeUiLabel(value.dialogFilterName))
}

/** Matches DEFAULT_CUSTOM_PET_MAX_IMAGE_BYTES so oversized atlases are dropped at the boundary. */
const MAX_PET_ATLAS_PAYLOAD_BYTES = 8 * 1024 * 1024

const petCreateFromAtlasBytes: Validator = value => {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'slug',
    'displayName',
    'description',
    'atlasData',
    'mimeType',
  ])) return false
  if (
    !(value.atlasData instanceof Uint8Array)
    || value.atlasData.byteLength === 0
    || value.atlasData.byteLength > MAX_PET_ATLAS_PAYLOAD_BYTES
  ) return false
  if (value.mimeType !== 'image/png' && value.mimeType !== 'image/webp') return false
  return hasValidPetIdentity(value)
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
  && hasOnlyKeys(value, ['sessionId', 'data'])
  && isTerminalSessionId(value.sessionId)
  && typeof value.data === 'string'
  && value.data.length <= MAX_TERMINAL_WRITE_LENGTH

const terminalSpawn: Validator = value =>
  value === undefined
  || (
    isRecord(value)
    && hasOnlyKeys(value, ['cols', 'rows', 'cwd', 'requestId'])
    && (value.requestId === undefined || (typeof value.requestId === 'string' && value.requestId.length > 0 && value.requestId.length <= 128))
    && (value.cols === undefined || isTerminalDimension(value.cols))
    && (value.rows === undefined || isTerminalDimension(value.rows))
    && (
      value.cwd === undefined
      || (
        typeof value.cwd === 'string'
        && value.cwd.length <= MAX_TERMINAL_CWD_LENGTH
        && !value.cwd.includes('\0')
      )
    )
  )

const terminalResize: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['sessionId', 'cols', 'rows'])
  && isTerminalSessionId(value.sessionId)
  && isTerminalDimension(value.cols)
  && isTerminalDimension(value.rows)

const terminalSessionId: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['sessionId'])
  && isTerminalSessionId(value.sessionId)

// `Number.isFinite`, not `typeof === 'number'`: `NaN` and `Infinity` are
// numbers, and they reach `normalizePreviewBounds`, which throws — turning a
// malformed message into an unhandled rejection in the renderer.
const boundsPayload: Validator = value =>
  isRecord(value)
  && Number.isFinite(value.x)
  && Number.isFinite(value.y)
  && Number.isFinite(value.width)
  && Number.isFinite(value.height)

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

const MAX_WORKSPACE_BROWSER_FIND_LENGTH = 2_048

const isWorkspaceBrowserId = (value: unknown) =>
  typeof value === 'string'
  && value.length > 0
  && value.length <= 200
  && /^[A-Za-z0-9._:-]+$/.test(value)

const workspaceBrowserTab: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['tabId'])
  && isWorkspaceBrowserId(value.tabId)

const workspaceBrowserCreate: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['tabId', 'storageId', 'url', 'bounds', 'visible'])
  && isWorkspaceBrowserId(value.tabId)
  && isWorkspaceBrowserId(value.storageId)
  && (value.url === undefined || (typeof value.url === 'string' && value.url.length <= 8_192))
  && (value.bounds === undefined || boundsPayload(value.bounds))
  && (value.visible === undefined || typeof value.visible === 'boolean')

const workspaceBrowserMenuLabelKeys = ['find', 'print', 'zoom', 'zoomIn', 'zoomOut', 'zoomReset', 'capture', 'pickElement', 'downloads', 'history', 'openExternal']

const workspaceBrowserShowMenu: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['tabId', 'x', 'y', 'labels', 'zoomFactor', 'hasPage', 'canOpenExternal'])
  && isWorkspaceBrowserId(value.tabId)
  && Number.isFinite(value.x)
  && Number.isFinite(value.y)
  && typeof value.zoomFactor === 'number' && Number.isFinite(value.zoomFactor) && value.zoomFactor > 0
  && typeof value.hasPage === 'boolean'
  && typeof value.canOpenExternal === 'boolean'
  && isRecord(value.labels)
  && hasOnlyKeys(value.labels, workspaceBrowserMenuLabelKeys)
  && workspaceBrowserMenuLabelKeys.every((key) => {
    const label = (value.labels as Record<string, unknown>)[key]
    return typeof label === 'string' && label.length > 0 && label.length <= 200 && !/[\r\n\0]/.test(label)
  })

const workspaceBrowserNavigate: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['tabId', 'url'])
  && isWorkspaceBrowserId(value.tabId)
  && typeof value.url === 'string'
  && value.url.length > 0
  && value.url.length <= 8_192

const workspaceBrowserReload: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['tabId', 'ignoreCache'])
  && isWorkspaceBrowserId(value.tabId)
  && (value.ignoreCache === undefined || typeof value.ignoreCache === 'boolean')

const workspaceBrowserSetBounds: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['tabId', 'bounds'])
  && isWorkspaceBrowserId(value.tabId)
  && boundsPayload(value.bounds)

const workspaceBrowserSetVisible: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['tabId', 'visible'])
  && isWorkspaceBrowserId(value.tabId)
  && typeof value.visible === 'boolean'

const workspaceBrowserSetZoom: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['tabId', 'factor'])
  && isWorkspaceBrowserId(value.tabId)
  && zoomPayload(value.factor)

const workspaceBrowserFind: Validator = value => {
  if (!isRecord(value) || !hasOnlyKeys(value, ['tabId', 'text', 'options'])) return false
  if (!isWorkspaceBrowserId(value.tabId)) return false
  if (typeof value.text !== 'string' || value.text.length > MAX_WORKSPACE_BROWSER_FIND_LENGTH) return false
  const options = value.options
  if (options === undefined) return true
  if (!isRecord(options) || !hasOnlyKeys(options, ['forward', 'findNext', 'matchCase'])) return false
  return ['forward', 'findNext', 'matchCase'].every(key =>
    options[key] === undefined || typeof options[key] === 'boolean')
}

const workspaceBrowserCapture: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['tabId', 'kind'])
  && isWorkspaceBrowserId(value.tabId)
  && (value.kind === 'full' || value.kind === 'viewport')

// The payload itself is the preview-agent protocol, re-validated in the main
// process before it reaches a page; only the addressing is checked here.
const workspaceBrowserMessage: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['tabId', 'payload'])
  && isWorkspaceBrowserId(value.tabId)

// The colors reach BrowserWindow.setBackgroundColor, so they are pinned to a
// literal 6-digit #RRGGBB. This is load-bearing, not tidiness: that API also
// accepts #AARRGGBB, so an 8-digit value would let a compromised renderer make
// a window translucent or fully transparent — click-through and overlay
// spoofing. Do not relax this into "any CSS color".
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/
const appliedAppearance: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['isDark', 'background', 'lightBackground', 'followSystem'])
  && typeof value.isDark === 'boolean'
  && typeof value.followSystem === 'boolean'
  && typeof value.background === 'string'
  && HEX_COLOR.test(value.background)
  && typeof value.lightBackground === 'string'
  && HEX_COLOR.test(value.lightBackground)

const updateCheckOptions: Validator = value => {
  if (value === undefined) return true
  if (!isRecord(value) || !hasOnlyKeys(value, ['proxy'])) return false
  return value.proxy === undefined || (typeof value.proxy === 'string' && value.proxy.trim().length > 0)
}

// ==========================================
// SSH Connection & Terminal (M3) validators
// ==========================================
//
// The renderer is the source of truth for the user's intent, but it is also
// the side that talks to a hostile network. Each channel rejects unknown
// fields, oversized strings, and impossible dimensions before the payload
// reaches main. The detailed shape check happens inside the service layer
// (Zod); here we only enforce wire-format invariants.

const MAX_SSH_WRITE_BYTES = 64 * 1024
const MAX_SSH_RESERVED_FIELDS = 16

// Every value-level rule below comes from `m4IpcContract.ts`, the same module
// the main-process strict Zod schemas import. The preload gate used to keep
// its own copies, which is how it ended up rejecting a legal download payload
// (missing `localToken`) and letting ~1 MiB of CJK text through that the
// handler then rejected on UTF-8 byte length. One rule, one place.
const isPositiveInt = (value: unknown): boolean =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0

const sshCommonFields = (value: Record<string, unknown>): boolean =>
  isM4OwnerId(value.ownerId)

type SshPayloadKind =
  | 'create' | 'start' | 'answer' | 'write' | 'resize' | 'ack' | 'disconnect'
  | 'list' | 'stat' | 'download' | 'upload' | 'cancelTransfer' | 'getTransfer'
  | 'editOpen' | 'editSave' | 'editClose' | 'mintUpload' | 'mintDownload'
  | 'resolveToken' | 'revokeToken'

// Shared allowed-field table, keyed by validator kind. Only the M4 kinds are
// listed: the M3 SSH connect/write/resize payloads have their own shape and
// are checked inline below.
const M4_FIELDS_BY_KIND: Partial<Record<SshPayloadKind, readonly string[]>> = {
  list: M4_PAYLOAD_FIELDS.sftpList,
  stat: M4_PAYLOAD_FIELDS.sftpStat,
  download: M4_PAYLOAD_FIELDS.transferStartDownload,
  upload: M4_PAYLOAD_FIELDS.transferStartUpload,
  cancelTransfer: M4_PAYLOAD_FIELDS.transferCancel,
  getTransfer: M4_PAYLOAD_FIELDS.transferGet,
  editOpen: M4_PAYLOAD_FIELDS.remoteEditOpen,
  editSave: M4_PAYLOAD_FIELDS.remoteEditSave,
  editClose: M4_PAYLOAD_FIELDS.remoteEditClose,
  mintUpload: M4_PAYLOAD_FIELDS.mintToken,
  mintDownload: M4_PAYLOAD_FIELDS.mintToken,
  resolveToken: M4_PAYLOAD_FIELDS.resolveToken,
  revokeToken: M4_PAYLOAD_FIELDS.revokeToken,
}

const sshConnectionInput = (kind: SshPayloadKind): Validator =>
  value => {
    if (!isRecord(value)) return false
    if (Object.keys(value).length > MAX_SSH_RESERVED_FIELDS) return false
    if (!sshCommonFields(value)) return false
    // M4 field sets are checked against the shared table so the preload gate
    // and the handler schema advertise exactly the same keys.
    const sharedFields = M4_FIELDS_BY_KIND[kind]
    if (sharedFields && !hasOnlyKeys(value, sharedFields)) return false
    switch (kind) {
      case 'create': {
        if (!hasOnlyKeys(value, ['ownerId', 'hostId', 'expectedRevision', 'cols', 'rows'])) return false
        if (typeof value.hostId !== 'string' || value.hostId.length === 0 || value.hostId.length > 256) return false
        if (value.expectedRevision !== undefined && !isPositiveInt(value.expectedRevision)) return false
        if (value.cols !== undefined && (typeof value.cols !== 'number' || !Number.isInteger(value.cols) || value.cols < 2 || value.cols > 500)) return false
        if (value.rows !== undefined && (typeof value.rows !== 'number' || !Number.isInteger(value.rows) || value.rows < 1 || value.rows > 300)) return false
        return true
      }
      case 'start':
      case 'disconnect': {
        if (!hasOnlyKeys(value, ['ownerId', 'connectionId'])) return false
        return isM4Uuid(value.connectionId)
      }
      case 'answer': {
        if (!hasOnlyKeys(value, ['ownerId', 'connectionId', 'challengeId', 'decision'])) return false
        if (!isM4Uuid(value.connectionId)) return false
        if (!isM4Uuid(value.challengeId)) return false
        return value.decision === 'trust' || value.decision === 'reject'
      }
      case 'write': {
        if (!hasOnlyKeys(value, ['ownerId', 'connectionId', 'generation', 'data', 'isBase64'])) return false
        if (!isM4Uuid(value.connectionId)) return false
        if (typeof value.generation !== 'number' || !Number.isInteger(value.generation) || value.generation < 1) return false
        if (typeof value.data !== 'string' || value.data.length === 0 || value.data.length > MAX_SSH_WRITE_BYTES * 4) return false
        if (value.isBase64 !== undefined && typeof value.isBase64 !== 'boolean') return false
        return true
      }
      case 'resize': {
        if (!hasOnlyKeys(value, ['ownerId', 'connectionId', 'generation', 'cols', 'rows'])) return false
        if (!isM4Uuid(value.connectionId)) return false
        if (typeof value.generation !== 'number' || !Number.isInteger(value.generation) || value.generation < 1) return false
        if (typeof value.cols !== 'number' || !Number.isInteger(value.cols) || value.cols < 2 || value.cols > 500) return false
        if (typeof value.rows !== 'number' || !Number.isInteger(value.rows) || value.rows < 1 || value.rows > 300) return false
        return true
      }
      case 'ack': {
        if (!hasOnlyKeys(value, ['ownerId', 'connectionId', 'generation', 'bytesAcked'])) return false
        if (!isM4Uuid(value.connectionId)) return false
        if (typeof value.generation !== 'number' || !Number.isInteger(value.generation) || value.generation < 1) return false
        if (!isPositiveInt(value.bytesAcked)) return false
        return true
      }
      case 'list':
      case 'stat':
      case 'editOpen': {
        if (!isM4Uuid(value.connectionId)) return false
        if (!isM4Generation(value.generation)) return false
        return isM4AbsolutePosixPath(value.absolutePath, M4_PATH_MAX_CHARS)
      }
      case 'download':
      case 'upload': {
        if (!isM4Uuid(value.connectionId)) return false
        if (!isM4Generation(value.generation)) return false
        if (!isM4Uuid(value.jobId)) return false
        if (!isM4AbsolutePosixPath(value.remotePath, M4_PATH_MAX_CHARS)) return false
        return isM4Uuid(value.localToken)
      }
      case 'cancelTransfer':
      case 'getTransfer': {
        return isM4Uuid(value.jobId)
      }
      case 'editSave': {
        if (!isM4Uuid(value.editId)) return false
        if (!isM4BaseRevision(value.baseRevision)) return false
        return isM4EditText(value.text)
      }
      case 'editClose': {
        return isM4Uuid(value.editId)
      }
      case 'mintUpload':
      case 'mintDownload': {
        return isM4FileName(value.fileName)
      }
      case 'resolveToken':
      case 'revokeToken': {
        return isM4Uuid(value.token)
      }
    }
  }

const localePreference: Validator = value =>
  value === 'en'
  || value === 'zh'
  || value === 'zh-TW'
  || value === 'jp'
  || value === 'kr'

export const ELECTRON_IPC_VALIDATORS = {
  [ELECTRON_IPC_CHANNELS.appGetVersion]: noPayload,
  [ELECTRON_IPC_CHANNELS.appGetLocalePreference]: noPayload,
  [ELECTRON_IPC_CHANNELS.appSetLocalePreference]: localePreference,
  [ELECTRON_IPC_CHANNELS.appGetPreferredSystemLanguages]: noPayload,
  [ELECTRON_IPC_CHANNELS.publicAccessGetStatus]: noPayload,
  [ELECTRON_IPC_CHANNELS.publicAccessSaveCredential]: value => typeof value === 'string' && value.trim().length > 0 && value.length <= 4096 && !/\s/.test(value.trim()),
  [ELECTRON_IPC_CHANNELS.publicAccessDeleteCredential]: noPayload,
  // Tracks the shared consent constant so a version bump cannot silently
  // invalidate the payload the renderer actually sends.
  [ELECTRON_IPC_CHANNELS.publicAccessStart]: value => value === PUBLIC_ACCESS_CONSENT_VERSION,
  [ELECTRON_IPC_CHANNELS.publicAccessStop]: noPayload,
  [ELECTRON_IPC_CHANNELS.publicAccessSetAutoStart]: booleanPayload,
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
  [ELECTRON_IPC_CHANNELS.petsPickSourceSheet]: petPickSourceSheet,
  [ELECTRON_IPC_CHANNELS.petsCreateFromAtlasBytes]: petCreateFromAtlasBytes,
  [ELECTRON_IPC_CHANNELS.petsOpenFolder]: noPayload,
  [ELECTRON_IPC_CHANNELS.petsShow]: noPayload,
  [ELECTRON_IPC_CHANNELS.petsHide]: noPayload,
  [ELECTRON_IPC_CHANNELS.petsShowContextMenu]: petContextMenu,
  [ELECTRON_IPC_CHANNELS.petsDragWindow]: petWindowDrag,
  [ELECTRON_IPC_CHANNELS.petsSetIgnoreMouseEvents]: booleanPayload,
  [ELECTRON_IPC_CHANNELS.petsSetInteractiveRegions]: petInteractiveRegions,
  [ELECTRON_IPC_CHANNELS.petsFocusMainWindow]: noPayload,
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
  [ELECTRON_IPC_CHANNELS.workspaceBrowserCreate]: workspaceBrowserCreate,
  [ELECTRON_IPC_CHANNELS.workspaceBrowserShowMenu]: workspaceBrowserShowMenu,
  [ELECTRON_IPC_CHANNELS.workspaceBrowserNavigate]: workspaceBrowserNavigate,
  [ELECTRON_IPC_CHANNELS.workspaceBrowserGoBack]: workspaceBrowserTab,
  [ELECTRON_IPC_CHANNELS.workspaceBrowserGoForward]: workspaceBrowserTab,
  [ELECTRON_IPC_CHANNELS.workspaceBrowserReload]: workspaceBrowserReload,
  [ELECTRON_IPC_CHANNELS.workspaceBrowserStop]: workspaceBrowserTab,
  [ELECTRON_IPC_CHANNELS.workspaceBrowserSetBounds]: workspaceBrowserSetBounds,
  [ELECTRON_IPC_CHANNELS.workspaceBrowserSetVisible]: workspaceBrowserSetVisible,
  [ELECTRON_IPC_CHANNELS.workspaceBrowserSetZoom]: workspaceBrowserSetZoom,
  [ELECTRON_IPC_CHANNELS.workspaceBrowserFind]: workspaceBrowserFind,
  [ELECTRON_IPC_CHANNELS.workspaceBrowserStopFind]: workspaceBrowserTab,
  [ELECTRON_IPC_CHANNELS.workspaceBrowserCapture]: workspaceBrowserCapture,
  [ELECTRON_IPC_CHANNELS.workspaceBrowserSnapshot]: workspaceBrowserTab,
  [ELECTRON_IPC_CHANNELS.workspaceBrowserMessage]: workspaceBrowserMessage,
  [ELECTRON_IPC_CHANNELS.workspaceBrowserPrintToPdf]: workspaceBrowserTab,
  [ELECTRON_IPC_CHANNELS.workspaceBrowserClose]: workspaceBrowserTab,
  [ELECTRON_IPC_CHANNELS.appModeGet]: noPayload,
  [ELECTRON_IPC_CHANNELS.appModeSet]: optionalRecord,
  [ELECTRON_IPC_CHANNELS.appModePrepareRestart]: noPayload,
  [ELECTRON_IPC_CHANNELS.appModeRestart]: noPayload,
  [ELECTRON_IPC_CHANNELS.adaptersRestartSidecar]: noPayload,
  [ELECTRON_IPC_CHANNELS.zoomSet]: zoomPayload,
  [ELECTRON_IPC_CHANNELS.appearanceSetApplied]: appliedAppearance,
  [ELECTRON_IPC_CHANNELS.mrGetCapabilities]: noPayload,
  [ELECTRON_IPC_CHANNELS.mrListHosts]: optionalRecord,
  [ELECTRON_IPC_CHANNELS.mrGetHost]: optionalRecord,
  [ELECTRON_IPC_CHANNELS.mrSaveHost]: value => SaveHostInputSchema.safeParse(value).success,
  [ELECTRON_IPC_CHANNELS.mrDeleteHost]: optionalRecord,
  [ELECTRON_IPC_CHANNELS.mrSaveApplication]: value => SaveApplicationInputSchema.safeParse(value).success,
  [ELECTRON_IPC_CHANNELS.mrDeleteApplication]: optionalRecord,
  [ELECTRON_IPC_CHANNELS.mrListTags]: optionalRecord,
  [ELECTRON_IPC_CHANNELS.mrSaveTag]: optionalRecord,
  [ELECTRON_IPC_CHANNELS.mrDeleteTag]: optionalRecord,
  [ELECTRON_IPC_CHANNELS.mrSaveCredential]: optionalRecord,
  [ELECTRON_IPC_CHANNELS.mrDeleteCredential]: optionalRecord,
  [ELECTRON_IPC_CHANNELS.mrRevealCredential]: value => RevealCredentialInputSchema.safeParse(value).success,
  [ELECTRON_IPC_CHANNELS.mrProvideTemporaryCredential]: optionalRecord,
  [ELECTRON_IPC_CHANNELS.mrListConcepts]: optionalRecord,
  [ELECTRON_IPC_CHANNELS.mrGetConcept]: optionalRecord,
  [ELECTRON_IPC_CHANNELS.mrSaveConcept]: optionalRecord,
  [ELECTRON_IPC_CHANNELS.mrDeleteConcept]: optionalRecord,
  [ELECTRON_IPC_CHANNELS.mrListDataConnections]: value => ListDataConnectionsInputSchema.safeParse(value ?? {}).success,
  [ELECTRON_IPC_CHANNELS.mrGetDataConnection]: value => GetDataConnectionInputSchema.safeParse(value).success,
  [ELECTRON_IPC_CHANNELS.mrSaveDataConnection]: value => SaveDataConnectionInputSchema.safeParse(value).success,
  [ELECTRON_IPC_CHANNELS.mrDeleteDataConnection]: value => DeleteDataConnectionInputSchema.safeParse(value).success,
  [ELECTRON_IPC_CHANNELS.mrTestDataConnection]: value => TestDataConnectionInputSchema.safeParse(value).success,
  [ELECTRON_IPC_CHANNELS.mrOpenDataSession]: value => OpenDataSessionInputSchema.safeParse(value).success,
  [ELECTRON_IPC_CHANNELS.mrCloseDataSession]: value => CloseDataSessionInputSchema.safeParse(value).success,
  [ELECTRON_IPC_CHANNELS.mrListDatabases]: value => SqlListDatabasesInputSchema.safeParse(value).success,
  [ELECTRON_IPC_CHANNELS.mrListSchemas]: value => SqlListSchemasInputSchema.safeParse(value).success,
  [ELECTRON_IPC_CHANNELS.mrListTables]: value => SqlListTablesInputSchema.safeParse(value).success,
  [ELECTRON_IPC_CHANNELS.mrDescribeTable]: value => SqlDescribeTableInputSchema.safeParse(value).success,
  [ELECTRON_IPC_CHANNELS.mrPreviewTable]: value => SqlPreviewInputSchema.safeParse(value).success,
  [ELECTRON_IPC_CHANNELS.mrExecuteQuery]: value => SqlExecuteInputSchema.safeParse(value).success,
  [ELECTRON_IPC_CHANNELS.mrCancelQuery]: value => SqlCancelInputSchema.safeParse(value).success,
  [ELECTRON_IPC_CHANNELS.mrScanRedisKeys]: value => RedisScanInputSchema.safeParse(value).success,
  [ELECTRON_IPC_CHANNELS.mrReadRedisKey]: value => RedisReadInputSchema.safeParse(value).success,
  [ELECTRON_IPC_CHANNELS.mrGetSelection]: optionalRecord,
  [ELECTRON_IPC_CHANNELS.mrSaveSelection]: optionalRecord,
  [ELECTRON_IPC_CHANNELS.mrDeleteSelection]: optionalRecord,
  [ELECTRON_IPC_CHANNELS.mrPrepareContext]: optionalRecord,
  [ELECTRON_IPC_CHANNELS.mrExportMetadata]: optionalRecord,
  [ELECTRON_IPC_CHANNELS.mrImportMetadata]: optionalRecord,
  [ELECTRON_IPC_CHANNELS.mrCreateConnection]: sshConnectionInput('create'),
  [ELECTRON_IPC_CHANNELS.mrSftpList]: sshConnectionInput('list'),
  [ELECTRON_IPC_CHANNELS.mrMintUploadToken]: sshConnectionInput('mintUpload'),
  [ELECTRON_IPC_CHANNELS.mrMintDownloadToken]: sshConnectionInput('mintDownload'),
  [ELECTRON_IPC_CHANNELS.mrResolveLocalToken]: sshConnectionInput('resolveToken'),
  [ELECTRON_IPC_CHANNELS.mrRevokeLocalToken]: sshConnectionInput('revokeToken'),
  [ELECTRON_IPC_CHANNELS.mrSftpStat]: sshConnectionInput('stat'),
  [ELECTRON_IPC_CHANNELS.mrTransferStartDownload]: sshConnectionInput('download'),
  [ELECTRON_IPC_CHANNELS.mrTransferStartUpload]: sshConnectionInput('upload'),
  [ELECTRON_IPC_CHANNELS.mrTransferUploadFolder]: value => FolderTransferInputSchema.safeParse(value).success,
  [ELECTRON_IPC_CHANNELS.mrTransferDownloadFolder]: value => FolderTransferInputSchema.safeParse(value).success,
  [ELECTRON_IPC_CHANNELS.mrTransferCancel]: sshConnectionInput('cancelTransfer'),
  [ELECTRON_IPC_CHANNELS.mrTransferGet]: sshConnectionInput('getTransfer'),
  [ELECTRON_IPC_CHANNELS.mrRemoteEditOpen]: sshConnectionInput('editOpen'),
  [ELECTRON_IPC_CHANNELS.mrRemoteEditSave]: sshConnectionInput('editSave'),
  [ELECTRON_IPC_CHANNELS.mrRemoteEditClose]: sshConnectionInput('editClose'),
  [ELECTRON_IPC_CHANNELS.mrHostTools]: value => HostToolsInputSchema.safeParse(value).success,
  [ELECTRON_IPC_CHANNELS.mrApplicationOperation]: value => ApplicationOperationInputSchema.safeParse(value).success && !(value && typeof value === 'object' && 'ownerId' in value),
  [ELECTRON_IPC_CHANNELS.mrStartConnection]: sshConnectionInput('start'),
  [ELECTRON_IPC_CHANNELS.mrAnswerHostKey]: sshConnectionInput('answer'),
  [ELECTRON_IPC_CHANNELS.mrWriteConnection]: sshConnectionInput('write'),
  [ELECTRON_IPC_CHANNELS.mrResizeConnection]: sshConnectionInput('resize'),
  [ELECTRON_IPC_CHANNELS.mrAckOutput]: sshConnectionInput('ack'),
  [ELECTRON_IPC_CHANNELS.mrDisconnect]: sshConnectionInput('disconnect'),
} satisfies Record<ElectronIpcChannel, Validator>

const allowedChannels = new Set<ElectronIpcChannel>(
  Object.values(ELECTRON_IPC_CHANNELS),
)

const petWindowChannels = new Set<ElectronIpcChannel>([
  ELECTRON_IPC_CHANNELS.appGetLocalePreference,
  ELECTRON_IPC_CHANNELS.appGetPreferredSystemLanguages,
  ELECTRON_IPC_CHANNELS.runtimeGetServerUrl,
  ELECTRON_IPC_CHANNELS.runtimeGetPetAccessToken,
  ELECTRON_IPC_CHANNELS.petsList,
  ELECTRON_IPC_CHANNELS.petsHide,
  ELECTRON_IPC_CHANNELS.petsShowContextMenu,
  ELECTRON_IPC_CHANNELS.petsDragWindow,
  ELECTRON_IPC_CHANNELS.petsSetIgnoreMouseEvents,
  ELECTRON_IPC_CHANNELS.petsSetInteractiveRegions,
  ELECTRON_IPC_CHANNELS.petsFocusMainWindow,
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
