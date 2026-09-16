import type {
  DesktopHost,
  DesktopHostUnlisten,
  DesktopUpdate,
  DesktopUpdateDownloadEvent,
} from './types'
import {
  ELECTRON_EVENT_CHANNELS,
  ELECTRON_IPC_CHANNELS,
  type ElectronEventChannel,
  type ElectronIpcChannel,
} from '../../../electron/ipc/channels'
import { validateElectronIpcPayload } from '../../../electron/ipc/capabilities'
import type { HostManagementEvent } from '../../features/managed-resources/types/resourceTypes'
import type {
  HostManagementResult,
  ManagedLocalPathToken,
  ManagedRemoteEditSnapshot,
  ManagedTransferJob,
  ManagedContextTicketRef,
} from '../../features/managed-resources/api/hostManagementApi'
import type { DataConnectionsHostApi } from '../../features/managed-resources/api/dataConnectionsApi'

export type ElectronHostBridge = {
  invoke<T>(channel: ElectronIpcChannel, payload?: unknown): Promise<T>
  getPathForFile?(file: File): string
  subscribe<T>(
    channel: ElectronEventChannel,
    handler: (payload: T) => void,
  ): Promise<DesktopHostUnlisten>
}

type ElectronUpdateMetadata = {
  version: string
  body?: string | null
}

// ---------------------------------------------------------------------------
// M4 renderer-facing projection
//
// The main process answers with the full service record. The renderer publishes
// the narrower DTOs from the managed-resources API module, and this projection
// is what actually keeps the internal `ownerId` and the local filesystem paths
// (a transfer job's `localPath`, a token's owner) out of the renderer — a
// narrower *type* alone would still let the runtime object carry them across.
// ---------------------------------------------------------------------------

type LocalPathTokenWire = ManagedLocalPathToken & { ownerId: string }

type TransferJobWire = ManagedTransferJob & { ownerId: string; localPath: string }

type RemoteEditSnapshotWire = {
  edit: ManagedRemoteEditSnapshot['edit'] & { ownerId: string }
  metadata: ManagedRemoteEditSnapshot['metadata']
}

function projectResult<TWire, TPublished>(
  result: HostManagementResult<TWire>,
  publish: (wire: TWire) => TPublished,
): HostManagementResult<TPublished> {
  return result.ok ? { ok: true, data: publish(result.data) } : result
}

function publishLocalPathToken(wire: LocalPathTokenWire): ManagedLocalPathToken {
  return {
    token: wire.token,
    absolutePath: wire.absolutePath,
    expiresAt: wire.expiresAt,
    purpose: wire.purpose,
  }
}

function publishTransferJob(wire: TransferJobWire): ManagedTransferJob {
  return {
    ...(wire.folder !== undefined ? { folder: wire.folder, entriesTotal: wire.entriesTotal, entriesCompleted: wire.entriesCompleted } : {}),
    id: wire.id,
    connectionId: wire.connectionId,
    generation: wire.generation,
    direction: wire.direction,
    remotePath: wire.remotePath,
    size: wire.size,
    transferred: wire.transferred,
    state: wire.state,
    error: wire.error,
    checksum: wire.checksum,
    startedAt: wire.startedAt,
    finishedAt: wire.finishedAt,
  }
}

function publishRemoteEditSnapshot(wire: RemoteEditSnapshotWire): ManagedRemoteEditSnapshot {
  return {
    edit: {
      id: wire.edit.id,
      connectionId: wire.edit.connectionId,
      generation: wire.edit.generation,
      absolutePath: wire.edit.absolutePath,
      baseRevision: wire.edit.baseRevision,
      baseSha256: wire.edit.baseSha256,
      baseSize: wire.edit.baseSize,
      baseMtimeMs: wire.edit.baseMtimeMs,
      text: wire.edit.text,
      hasBom: wire.edit.hasBom,
      dirty: wire.edit.dirty,
      openedAt: wire.edit.openedAt,
    },
    metadata: {
      size: wire.metadata.size,
      mtimeMs: wire.metadata.mtimeMs,
      mode: wire.metadata.mode,
      lineEnding: wire.metadata.lineEnding,
      hasBom: wire.metadata.hasBom,
    },
  }
}

function safeInvoke<T>(
  bridge: ElectronHostBridge,
  channel: ElectronIpcChannel,
  payload?: unknown,
): Promise<T> {
  if (!validateElectronIpcPayload(channel, payload)) {
    return Promise.reject(new Error(`Invalid Electron IPC payload for ${channel}`))
  }
  return bridge.invoke<T>(channel, payload)
}

export function createElectronHost(bridge: ElectronHostBridge): DesktopHost {
  const invoke = <T>(channel: ElectronIpcChannel, payload?: unknown) =>
    safeInvoke<T>(bridge, channel, payload)
  const invokeProjected = <TWire, TPublished>(
    channel: ElectronIpcChannel,
    payload: unknown,
    publish: (wire: TWire) => TPublished,
  ) =>
    safeInvoke<HostManagementResult<TWire>>(bridge, channel, payload)
      .then(result => projectResult(result, publish))
  const subscribe = <T>(channel: ElectronEventChannel, handler: (payload: T) => void) =>
    bridge.subscribe(channel, handler)
  const createUpdate = (metadata: ElectronUpdateMetadata): DesktopUpdate => ({
    version: metadata.version,
    body: metadata.body ?? null,
    async download(onEvent) {
      const unlisten = onEvent
        ? await subscribe<DesktopUpdateDownloadEvent>(ELECTRON_EVENT_CHANNELS.updateDownloadEvent, onEvent)
        : null
      try {
        await invoke(ELECTRON_IPC_CHANNELS.updateDownload)
      } finally {
        unlisten?.()
      }
    },
    install: () => invoke(ELECTRON_IPC_CHANNELS.updateInstall),
    close: () => invoke(ELECTRON_IPC_CHANNELS.updateCancelInstall),
  })

  return {
    publicAccess: {
      getStatus: () => invoke(ELECTRON_IPC_CHANNELS.publicAccessGetStatus),
      saveCredential: token => invoke(ELECTRON_IPC_CHANNELS.publicAccessSaveCredential, token),
      deleteCredential: () => invoke(ELECTRON_IPC_CHANNELS.publicAccessDeleteCredential),
      start: consentVersion => invoke(ELECTRON_IPC_CHANNELS.publicAccessStart, consentVersion),
      stop: () => invoke(ELECTRON_IPC_CHANNELS.publicAccessStop),
      setAutoStart: enabled => invoke(ELECTRON_IPC_CHANNELS.publicAccessSetAutoStart, enabled),
    },
    kind: 'electron',
    isDesktop: true,
    capabilities: {
      appMode: true,
      clipboard: true,
      dialogs: true,
      notifications: true,
      previewWebview: true,
      workspaceBrowser: true,
      shell: true,
      terminal: true,
      updates: true,
      windowControls: true,
      zoom: true,
      hostManagement: true,
      conceptKnowledge: true,
      conversationContext: true,
      dataConnections: true,
    },
    runtime: {
      getServerUrl: () => invoke(ELECTRON_IPC_CHANNELS.runtimeGetServerUrl),
      getLocalAccessToken: () => invoke(ELECTRON_IPC_CHANNELS.runtimeGetLocalAccessToken),
    },
    app: {
      getVersion: () => invoke(ELECTRON_IPC_CHANNELS.appGetVersion),
      getLocalePreference: () => invoke(ELECTRON_IPC_CHANNELS.appGetLocalePreference),
      setLocalePreference: locale => invoke(ELECTRON_IPC_CHANNELS.appSetLocalePreference, locale),
      getPreferredSystemLanguages: () => invoke(ELECTRON_IPC_CHANNELS.appGetPreferredSystemLanguages),
      onLocaleChanged: handler => subscribe(ELECTRON_EVENT_CHANNELS.appLocaleChanged, handler),
    },
    commands: {
      invoke: (command, args) => invoke(ELECTRON_IPC_CHANNELS.commandInvoke, { command, args }),
    },
    clipboard: {
      readText: () => invoke(ELECTRON_IPC_CHANNELS.clipboardReadText),
      writeText: text => invoke(ELECTRON_IPC_CHANNELS.clipboardWriteText, text),
    },
    files: {
      getPathForFile(file) {
        const nativePath = bridge.getPathForFile?.(file)
        if (nativePath) return nativePath
        const legacyPath = (file as File & { path?: unknown }).path
        return typeof legacyPath === 'string' ? legacyPath : ''
      },
    },
    events: {
      listen: (_eventName, handler) => subscribe(ELECTRON_EVENT_CHANNELS.event, handler),
    },
    webview: {
      onDragDropEvent: handler => subscribe(ELECTRON_EVENT_CHANNELS.webviewDragDrop, handler),
    },
    shell: {
      open: target => invoke(ELECTRON_IPC_CHANNELS.shellOpen, target),
      openPath: path => invoke(ELECTRON_IPC_CHANNELS.shellOpenPath, path),
    },
    trace: {
      openWindow: sessionId => invoke(ELECTRON_IPC_CHANNELS.traceOpenWindow, sessionId),
    },
    pets: {
      list: () => invoke(ELECTRON_IPC_CHANNELS.petsList),
      createFromImage: input => invoke(ELECTRON_IPC_CHANNELS.petsCreateFromImage, input),
      createFromAtlas: input => invoke(ELECTRON_IPC_CHANNELS.petsCreateFromAtlas, input),
      pickSourceSheet: input => invoke(ELECTRON_IPC_CHANNELS.petsPickSourceSheet, input),
      createFromAtlasBytes: input => invoke(ELECTRON_IPC_CHANNELS.petsCreateFromAtlasBytes, input),
      openFolder: () => invoke(ELECTRON_IPC_CHANNELS.petsOpenFolder),
      show: () => invoke(ELECTRON_IPC_CHANNELS.petsShow),
      hide: () => invoke(ELECTRON_IPC_CHANNELS.petsHide),
      showContextMenu: closeLabel => invoke(
        ELECTRON_IPC_CHANNELS.petsShowContextMenu,
        { closeLabel },
      ),
      dragWindow: payload => invoke(ELECTRON_IPC_CHANNELS.petsDragWindow, payload),
      setIgnoreMouseEvents: ignore => invoke(ELECTRON_IPC_CHANNELS.petsSetIgnoreMouseEvents, ignore),
      setInteractiveRegions: regions => invoke(ELECTRON_IPC_CHANNELS.petsSetInteractiveRegions, regions),
      focusMainWindow: () => invoke(ELECTRON_IPC_CHANNELS.petsFocusMainWindow),
      focusSession: sessionId => invoke(ELECTRON_IPC_CHANNELS.petsFocusSession, sessionId),
      onNavigateSession: handler => subscribe(ELECTRON_EVENT_CHANNELS.petNavigateSession, handler),
      onVisibilityChanged: handler => subscribe(ELECTRON_EVENT_CHANNELS.petVisibilityChanged, handler),
      onPanelPlacementChanged: handler =>
        subscribe(ELECTRON_EVENT_CHANNELS.petPanelPlacementChanged, handler),
    },
    dialogs: {
      open: options => invoke(ELECTRON_IPC_CHANNELS.dialogOpen, options),
      save: options => invoke(ELECTRON_IPC_CHANNELS.dialogSave, options),
    },
    updates: {
      check: async (options) => {
        const update = await invoke<ElectronUpdateMetadata | null>(ELECTRON_IPC_CHANNELS.updateCheck, options)
        return update ? createUpdate(update) : null
      },
      prepareInstall: () => invoke(ELECTRON_IPC_CHANNELS.updatePrepareInstall),
      cancelInstall: () => invoke(ELECTRON_IPC_CHANNELS.updateCancelInstall),
      relaunch: () => invoke(ELECTRON_IPC_CHANNELS.updateRelaunch),
    },
    notifications: {
      permissionState: () => invoke(ELECTRON_IPC_CHANNELS.notificationPermissionState),
      requestPermission: () => invoke(ELECTRON_IPC_CHANNELS.notificationRequestPermission),
      send: options => invoke(ELECTRON_IPC_CHANNELS.notificationSend, options),
      onAction: handler => subscribe(ELECTRON_EVENT_CHANNELS.notificationAction, handler),
      ackAction: payload => invoke(ELECTRON_IPC_CHANNELS.notificationActionAck, payload),
    },
    window: {
      minimize: () => invoke(ELECTRON_IPC_CHANNELS.windowMinimize),
      toggleMaximize: () => invoke(ELECTRON_IPC_CHANNELS.windowToggleMaximize),
      close: () => invoke(ELECTRON_IPC_CHANNELS.windowClose),
      startDragging: () => invoke(ELECTRON_IPC_CHANNELS.windowStartDragging),
      requestAttention: () => invoke(ELECTRON_IPC_CHANNELS.windowRequestAttention),
      focus: () => invoke(ELECTRON_IPC_CHANNELS.windowFocus),
      isMaximized: () => invoke(ELECTRON_IPC_CHANNELS.windowIsMaximized),
      onResized: handler => subscribe(ELECTRON_EVENT_CHANNELS.windowResized, handler),
      onNativeMenuNavigate: handler => subscribe(ELECTRON_EVENT_CHANNELS.nativeMenuNavigate, handler),
    },
    terminal: {
      supportsStartupCorrelation: true,
      spawn: options => invoke(ELECTRON_IPC_CHANNELS.terminalSpawn, options),
      write: (sessionId, data) => invoke(ELECTRON_IPC_CHANNELS.terminalWrite, { sessionId, data }),
      resize: (sessionId, cols, rows) => invoke(ELECTRON_IPC_CHANNELS.terminalResize, { sessionId, cols, rows }),
      kill: sessionId => invoke(ELECTRON_IPC_CHANNELS.terminalKill, { sessionId }),
      onOutput: handler => subscribe(ELECTRON_EVENT_CHANNELS.terminalOutput, handler),
      onExit: handler => subscribe(ELECTRON_EVENT_CHANNELS.terminalExit, handler),
      getBashPath: () => invoke(ELECTRON_IPC_CHANNELS.terminalGetBashPath),
      setBashPath: path => invoke(ELECTRON_IPC_CHANNELS.terminalSetBashPath, path),
    },
    preview: {
      open: (url, bounds) => invoke(ELECTRON_IPC_CHANNELS.previewOpen, { url, bounds }),
      navigate: url => invoke(ELECTRON_IPC_CHANNELS.previewNavigate, url),
      setBounds: bounds => invoke(ELECTRON_IPC_CHANNELS.previewSetBounds, bounds),
      setVisible: visible => invoke(ELECTRON_IPC_CHANNELS.previewSetVisible, visible),
      setZoom: level => invoke(ELECTRON_IPC_CHANNELS.previewSetZoom, level),
      close: () => invoke(ELECTRON_IPC_CHANNELS.previewClose),
      message: payload => invoke(ELECTRON_IPC_CHANNELS.previewMessage, payload),
      onEvent: handler => subscribe(ELECTRON_EVENT_CHANNELS.previewEvent, handler),
    },
    browser: {
      showMenu: (tabId, options) => invoke(ELECTRON_IPC_CHANNELS.workspaceBrowserShowMenu, { ...options, tabId }),
      create: (tabId, options) => invoke(ELECTRON_IPC_CHANNELS.workspaceBrowserCreate, {
        tabId,
        storageId: options.storageId,
        ...(options.url === undefined ? {} : { url: options.url }),
        ...(options.bounds === undefined ? {} : { bounds: options.bounds }),
        ...(options.visible === undefined ? {} : { visible: options.visible }),
      }),
      navigate: (tabId, url) => invoke(ELECTRON_IPC_CHANNELS.workspaceBrowserNavigate, { tabId, url }),
      goBack: tabId => invoke(ELECTRON_IPC_CHANNELS.workspaceBrowserGoBack, { tabId }),
      goForward: tabId => invoke(ELECTRON_IPC_CHANNELS.workspaceBrowserGoForward, { tabId }),
      reload: (tabId, options) => invoke(ELECTRON_IPC_CHANNELS.workspaceBrowserReload, {
        tabId,
        ...(options?.ignoreCache === undefined ? {} : { ignoreCache: options.ignoreCache }),
      }),
      stop: tabId => invoke(ELECTRON_IPC_CHANNELS.workspaceBrowserStop, { tabId }),
      setBounds: (tabId, bounds) => invoke(ELECTRON_IPC_CHANNELS.workspaceBrowserSetBounds, { tabId, bounds }),
      setVisible: (tabId, visible) => invoke(ELECTRON_IPC_CHANNELS.workspaceBrowserSetVisible, { tabId, visible }),
      setZoom: (tabId, factor) => invoke(ELECTRON_IPC_CHANNELS.workspaceBrowserSetZoom, { tabId, factor }),
      find: (tabId, text, options) => invoke(ELECTRON_IPC_CHANNELS.workspaceBrowserFind, {
        tabId,
        text,
        ...(options === undefined ? {} : { options }),
      }),
      stopFind: tabId => invoke(ELECTRON_IPC_CHANNELS.workspaceBrowserStopFind, { tabId }),
      capture: (tabId, kind) => invoke(ELECTRON_IPC_CHANNELS.workspaceBrowserCapture, { tabId, kind }),
      snapshot: (tabId) => invoke(ELECTRON_IPC_CHANNELS.workspaceBrowserSnapshot, { tabId }),
      message: (tabId, payload) => invoke(ELECTRON_IPC_CHANNELS.workspaceBrowserMessage, { tabId, payload }),
      printToPdf: tabId => invoke(ELECTRON_IPC_CHANNELS.workspaceBrowserPrintToPdf, { tabId }),
      close: tabId => invoke(ELECTRON_IPC_CHANNELS.workspaceBrowserClose, { tabId }),
      onEvent: handler => subscribe(ELECTRON_EVENT_CHANNELS.workspaceBrowserEvent, handler),
    },
    appMode: {
      get: () => invoke(ELECTRON_IPC_CHANNELS.appModeGet),
      set: config => invoke(ELECTRON_IPC_CHANNELS.appModeSet, config),
      prepareRestart: () => invoke(ELECTRON_IPC_CHANNELS.appModePrepareRestart),
      restart: () => invoke(ELECTRON_IPC_CHANNELS.appModeRestart),
    },
    adapters: {
      restartSidecar: () => invoke(ELECTRON_IPC_CHANNELS.adaptersRestartSidecar),
    },
    zoom: {
      set: level => invoke(ELECTRON_IPC_CHANNELS.zoomSet, level),
    },
    appearance: {
      setApplied: state => invoke(ELECTRON_IPC_CHANNELS.appearanceSetApplied, state),
    },
    hostManagement: {
      getCapabilities: () => invoke(ELECTRON_IPC_CHANNELS.mrGetCapabilities),
      listHosts: params => invoke(ELECTRON_IPC_CHANNELS.mrListHosts, params),
      getHost: id => invoke(ELECTRON_IPC_CHANNELS.mrGetHost, { id }),
      saveHost: input => invoke(ELECTRON_IPC_CHANNELS.mrSaveHost, input),
      deleteHost: (id, expectedRevision) => invoke(ELECTRON_IPC_CHANNELS.mrDeleteHost, { id, expectedRevision }),
      listTags: namespace => invoke(ELECTRON_IPC_CHANNELS.mrListTags, { namespace }),
      saveTag: input => invoke(ELECTRON_IPC_CHANNELS.mrSaveTag, input),
      deleteTag: (id, expectedRevision) => invoke(ELECTRON_IPC_CHANNELS.mrDeleteTag, { id, expectedRevision }),
      saveApplication: input => {
        if ('id' in input.application) {
          const { id, ...changes } = input.application
          return invoke(ELECTRON_IPC_CHANNELS.mrSaveApplication, {
            mode: 'update', hostId: input.hostId, expectedHostRevision: input.expectedHostRevision,
            applicationId: id, changes,
          })
        }
        return invoke(ELECTRON_IPC_CHANNELS.mrSaveApplication, { mode: 'create', ...input })
      },
      deleteApplication: input => invoke(ELECTRON_IPC_CHANNELS.mrDeleteApplication, input),
      saveCredential: input => invoke(ELECTRON_IPC_CHANNELS.mrSaveCredential, input),
      deleteCredential: (id, expectedRevision) => invoke(ELECTRON_IPC_CHANNELS.mrDeleteCredential, { id, expectedRevision }),
      revealCredential: id => invoke(ELECTRON_IPC_CHANNELS.mrRevealCredential, { id }),
      provideTemporaryCredential: (hostId, secret) => invoke(ELECTRON_IPC_CHANNELS.mrProvideTemporaryCredential, { hostId, secret }),
      exportMetadata: () => invokeProjected(
        ELECTRON_IPC_CHANNELS.mrExportMetadata, undefined,
        (wire: { exportedCount: number; filePath: string }) => ({ count: wire.exportedCount, filePath: wire.filePath }),
      ),
      importMetadata: () => invokeProjected(
        ELECTRON_IPC_CHANNELS.mrImportMetadata, undefined,
        (wire: { importedCount: number }) => ({ imported: true, count: wire.importedCount }),
      ),
      createConnection: input => invoke(ELECTRON_IPC_CHANNELS.mrCreateConnection, input),
      startConnection: input => invoke(ELECTRON_IPC_CHANNELS.mrStartConnection, input),
      answerHostKey: input => invoke(ELECTRON_IPC_CHANNELS.mrAnswerHostKey, input),
      writeConnection: input => invoke(ELECTRON_IPC_CHANNELS.mrWriteConnection, input),
      resizeConnection: input => invoke(ELECTRON_IPC_CHANNELS.mrResizeConnection, input),
      ackOutput: input => invoke(ELECTRON_IPC_CHANNELS.mrAckOutput, input),
      disconnect: input => invoke(ELECTRON_IPC_CHANNELS.mrDisconnect, input),
      onEvent: handler => bridge.subscribe<HostManagementEvent>(ELECTRON_EVENT_CHANNELS.mrEvent, handler),
      // SFTP browsing, transfers and remote editing (M4). One channel each, and
      // never an `ownerId`: the main process binds the canonical owner, and the
      // preload validator rejects the field set if anything else is added. The
      // methods that answer with a service record project it down to the
      // published DTO first.
      mintUploadToken: fileName =>
        invokeProjected(ELECTRON_IPC_CHANNELS.mrMintUploadToken, { fileName }, publishLocalPathToken),
      mintDownloadToken: fileName =>
        invokeProjected(ELECTRON_IPC_CHANNELS.mrMintDownloadToken, { fileName }, publishLocalPathToken),
      resolveLocalToken: token => invoke(ELECTRON_IPC_CHANNELS.mrResolveLocalToken, { token }),
      revokeLocalToken: token => invoke(ELECTRON_IPC_CHANNELS.mrRevokeLocalToken, { token }),
      sftpList: (connectionId, generation, absolutePath) =>
        invoke(ELECTRON_IPC_CHANNELS.mrSftpList, { connectionId, generation, absolutePath }),
      sftpStat: (connectionId, generation, absolutePath) =>
        invoke(ELECTRON_IPC_CHANNELS.mrSftpStat, { connectionId, generation, absolutePath }),
      transferStartDownload: (jobId, connectionId, generation, remotePath, localToken) =>
        invokeProjected(
          ELECTRON_IPC_CHANNELS.mrTransferStartDownload,
          { jobId, connectionId, generation, remotePath, localToken },
          publishTransferJob,
        ),
      transferStartUpload: (jobId, connectionId, generation, remotePath, localToken) =>
        invokeProjected(
          ELECTRON_IPC_CHANNELS.mrTransferStartUpload,
          { jobId, connectionId, generation, remotePath, localToken },
          publishTransferJob,
        ),
      transferUploadFolder: input => invokeProjected(ELECTRON_IPC_CHANNELS.mrTransferUploadFolder, input, publishTransferJob),
      transferDownloadFolder: input => invokeProjected(ELECTRON_IPC_CHANNELS.mrTransferDownloadFolder, input, publishTransferJob),      transferCancel: jobId => invoke(ELECTRON_IPC_CHANNELS.mrTransferCancel, { jobId }),
      transferGet: jobId =>
        invokeProjected(ELECTRON_IPC_CHANNELS.mrTransferGet, { jobId }, publishTransferJob),
      remoteEditOpen: (connectionId, generation, absolutePath) =>
        invokeProjected(
          ELECTRON_IPC_CHANNELS.mrRemoteEditOpen,
          { connectionId, generation, absolutePath },
          publishRemoteEditSnapshot,
        ),
      remoteEditSave: (editId, baseRevision, text) =>
        invokeProjected(
          ELECTRON_IPC_CHANNELS.mrRemoteEditSave,
          { editId, baseRevision, text },
          publishRemoteEditSnapshot,
        ),
      remoteEditClose: editId => invoke(ELECTRON_IPC_CHANNELS.mrRemoteEditClose, { editId }),
      hostTools: input => invoke(ELECTRON_IPC_CHANNELS.mrHostTools, input),
      applicationOperation: input => invoke(ELECTRON_IPC_CHANNELS.mrApplicationOperation, input),
    },
    dataConnections: {
      list: params => invoke(ELECTRON_IPC_CHANNELS.mrListDataConnections, params),
      get: id => invoke(ELECTRON_IPC_CHANNELS.mrGetDataConnection, { id }),
      save: input => invoke(ELECTRON_IPC_CHANNELS.mrSaveDataConnection, input),
      delete: (id, expectedRevision) => invoke(ELECTRON_IPC_CHANNELS.mrDeleteDataConnection, { id, expectedRevision }),
      testConnection: input => invoke(ELECTRON_IPC_CHANNELS.mrTestDataConnection, input),
      openConnection: (connectionId, expectedRevision) => invoke(ELECTRON_IPC_CHANNELS.mrOpenDataSession, { connectionId, expectedRevision }),
      closeConnection: (dataSessionId, generation) => invoke(ELECTRON_IPC_CHANNELS.mrCloseDataSession, { dataSessionId, generation }),
      listDatabases: (dataSessionId, generation) => invoke(ELECTRON_IPC_CHANNELS.mrListDatabases, { dataSessionId, generation }),
      listSchemas: (dataSessionId, generation) => invoke(ELECTRON_IPC_CHANNELS.mrListSchemas, { dataSessionId, generation }),
      listTables: (dataSessionId, generation, schema) => invoke(ELECTRON_IPC_CHANNELS.mrListTables, { dataSessionId, generation, schema }),
      describeTable: (dataSessionId, generation, schema, table) => invoke(ELECTRON_IPC_CHANNELS.mrDescribeTable, { dataSessionId, generation, schema, table }),
      previewTable: input => invoke(ELECTRON_IPC_CHANNELS.mrPreviewTable, input),
      executeQuery: input => invoke(ELECTRON_IPC_CHANNELS.mrExecuteQuery, input),
      cancelQuery: (dataSessionId, generation, queryId) => invoke(ELECTRON_IPC_CHANNELS.mrCancelQuery, { dataSessionId, generation, queryId }),
      scanKeys: input => invoke(ELECTRON_IPC_CHANNELS.mrScanRedisKeys, input),
      readKey: input => invoke(ELECTRON_IPC_CHANNELS.mrReadRedisKey, input),
    } satisfies DataConnectionsHostApi,
    conceptKnowledge: {
      listConcepts: () => invoke(ELECTRON_IPC_CHANNELS.mrListConcepts),
      getConcept: id => invoke(ELECTRON_IPC_CHANNELS.mrGetConcept, { id }),
      saveConcept: input => invoke(ELECTRON_IPC_CHANNELS.mrSaveConcept, input),
      deleteConcept: (id, expectedRevision, removeReferenceEdges) =>
        invoke(ELECTRON_IPC_CHANNELS.mrDeleteConcept, { id, expectedRevision, removeReferenceEdges }),
    },
    conversationContext: {
      getSelection: sessionId => invoke(ELECTRON_IPC_CHANNELS.mrGetSelection, { sessionId }),
      saveSelection: (sessionId, selection) => invoke(ELECTRON_IPC_CHANNELS.mrSaveSelection, { sessionId, selection }),
      deleteSelection: sessionId => invoke(ELECTRON_IPC_CHANNELS.mrDeleteSelection, { sessionId }),
      prepareSubmission: input => invoke<HostManagementResult<ManagedContextTicketRef>>(
        ELECTRON_IPC_CHANNELS.mrPrepareContext,
        input,
      ),
    },
  }
}
