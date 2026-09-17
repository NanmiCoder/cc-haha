# managed-resources — integration map

```yaml
feature: managed-resources
schemaVersion: 1
upstreamBaseHead: 6561a36238e2352f389f545f87b155bf39371447
verifiedAt: 2026-09-07
scope: Windows 10/11 desktop only; macOS / Swift / Linux desktop builds out of scope
```

This file is **upgrade metadata only**. Every U-row status is `not-wired` and every
no-feature regression contract status is `planned`. No factory has been created, no
host code has been modified, no functional claim is attached to this map. The
purpose is to lock the host seams and the planned contract set so the next
micro-batches (M0.5+ and feature wiring) can be tracked deterministically.

## U01–U17 host seams

| ID | Existing host path(s) | Existing symbol / stable anchor | Allowed thin connection | Forbidden content | Planned module owner | Planned contract test | Status |
|---|---|---|---|---|---|---|---|
| U01 | `desktop/src/components/layout/TabBar.tsx` | `TabBar` | Two icon / click calls — about 10–30 lines | Connection creation, tag management logic | `desktop/src/features/managed-resources/ui/tabIntegration.tsx` | `desktop/src/features/managed-resources/integration/tabIntegration.test.tsx` | wired |
| U02 | `desktop/src/components/layout/ContentRouter.tsx` | `ContentRouter` | New tab container + keep-alive visibility — about 10–25 lines | SSH runtime initialisation | `desktop/src/features/managed-resources/ui/routerIntegration.tsx` | `desktop/src/features/managed-resources/integration/routerIntegration.test.tsx` | wired |
| U03 | `desktop/src/stores/tabStore.ts`<br>`desktop/src/lib/persistenceMigrations.ts` | `useTabStore`<br>`runDesktopPersistenceMigrations` | New special type / ID / restore branch + delegate close hook | New library file reads / writes, transfer cancel implementation | `desktop/src/features/managed-resources/integration/tabStoreBranch.ts` | `desktop/src/features/managed-resources/integration/tabStoreBranch.test.ts` | wired |
| U04 | `desktop/src/pages/Settings.tsx`<br>`desktop/src/stores/uiStore.ts` | `Settings`<br>`useUIStore` | Concept navigation / enum / dedicated panel | Concept CRUD and graph algorithms | `desktop/src/features/managed-resources/integration/settingsEntry.tsx` | `desktop/src/features/managed-resources/integration/settingsEntry.test.ts` | wired |
| U05 | `desktop/src/components/chat/ChatInput.tsx`<br>`desktop/src/pages/EmptySession.tsx` | `ChatInput`<br>`EmptySession` | Same button component, trigger delegation, scope migration, snapshot arg | Password assembly, closure algorithms, network staging | `desktop/src/features/managed-resources/integration/composerIntegration.tsx` | `desktop/src/pages/EmptySession.test.tsx` | wired |
| U06 | `desktop/src/components/chat/composerUtils.ts` | `findSlashTrigger`<br>`resolveSlashUiAction` | Keep the four commands; call feature parser; do not replace original parser | New business command execution | `desktop/src/features/managed-resources/integration/parserBridge.ts` | `desktop/src/features/managed-resources/integration/parserBridge.test.ts` | wired |
| U07 | `desktop/src/stores/chatStore.ts` | `useChatStore`<br>`sendMessage`<br>`queueUserMessage`<br>`sendQueuedUserMessage` | Optional `managedContext` metadata, three-send-point delegation, UUID replay association | Brand-new queue, context serialisation | `desktop/src/features/managed-resources/integration/chatSubmission.ts` | `desktop/src/stores/chatStore.test.ts` | wired |
| U08 | `desktop/src/api/websocket.ts` | `WebSocketManager`<br>`onMessage`<br>`wsManager` | Only protocol handling for `accepted` / `rejected` / `runtimeRevision` etc. | Knowledge base and credential resolution | planned:`desktop/src/features/managed-resources/integration/wsProtocolBridge.ts` | planned:`desktop/src/features/managed-resources/integration/wsProtocolBridge.test.ts` | not-wired |
| U09 | `desktop/src/lib/desktopHost/types.ts`<br>`desktop/src/lib/desktopHost/electronHost.ts`<br>`desktop/src/lib/desktopHost/browserHost.ts`<br>`desktop/src/lib/desktopHost/index.ts`<br>`desktop/electron/preload.ts`<br>`desktop/electron/ipc/capabilities.ts`<br>`desktop/electron/main.ts` | `DesktopHost`<br>`createElectronHost`<br>`browserHost`<br>`createDesktopHost`<br>`validateElectronIpcPayload`<br>`registerIpcHandlers` | New capability / narrow API mapping; concrete validation delegates to module; preload + main IPC capability entry boundary | Arbitrary RPC / URL / file-path channels | `desktop/src/features/managed-resources/api/desktopHostCapabilities.ts` | `desktop/src/features/managed-resources/integration/desktopHostCapabilities.test.ts` | wired |
| U10 | `desktop/electron/main.ts`<br>`desktop/electron/services/keychain.ts` | `app.whenReady`<br>`installMacOsChromiumKeychainPromptGuard` | Factory create / register / teardown; mock-switch strategy fix | CRUD, SSH / SFTP, database operations | `desktop/electron/services/managedResources/index.ts` | `desktop/electron/services/managedResources/module.test.ts` | wired |
| U11 | `src/server/router.ts`<br>`src/server/index.ts` | `handleApiRequest`<br>`startServer`<br>`startBackgroundIndexesInPriorityOrder` | New route delegation + real-peer source passing | Ticket state machine | `src/server/features/managedContext/api.ts` | `src/server/features/managedContext/__tests__/contract.auth.test.ts` | wired |
| U12 | `src/server/ws/events.ts`<br>`src/server/ws/handler.ts` | `ClientMessage`<br>`ServerMessage`<br>`RUNTIME_CONFIG_APPLIED_EVENT`<br>`getSessionChatActivityState`<br>`markSessionChatQueued`<br>`clearLegacySessionChatState` | Optional new fields, admit / commit / replay delegation, `runtimeRevision` | Resource category switch, plaintext history projection implementation | `src/server/features/managedContext/wsBridge.ts` | `src/server/features/managedContext/__tests__/contract.sessionMatch.test.ts` | wired |
| U13 | `src/server/services/conversationService.ts` | `ConversationService`<br>`sendMessage`<br>`buildUserContent` | Late `compose` / `canSend` binding; pass stable UUID | Reading host JSON, vault, extra provider logic | `src/server/features/managedContext/composer.ts` | `src/server/features/managedContext/__tests__/contract.compose.test.ts` | wired |
| U14 | `src/server/services/sessionService.ts`<br>`src/server/services/localIndex/transcriptReducer.ts`<br>`src/server/services/localIndex/searchContentProjector.ts` | `sessionService`<br>`reduceTranscript`<br>`reduceTranscriptWithLocators`<br>`createSearchContentProjector` | Single project / policy delegation | Multiple password regex filters | planned:`src/server/features/managedContext/project.ts` | planned:`src/server/features/managedContext/project.test.ts` | not-wired |
| U15 | `src/server/ws/handler.ts`<br>`src/services/api/traceCapture.ts`<br>`src/services/api/dumpPrompts.ts` | `bindTitleSessionOutput`<br>`sessionTitleState`<br>`traceCaptureService`<br>`createDumpPromptsFetch`<br>`getDumpPromptsPath` | Query feature policy then skip body capture for that session | Rewriting every normal session diagnostic format | `src/services/managedContext/sensitivityPolicy.ts` | `src/server/features/managedContext/__tests__/contract.traceMarker.test.ts` | wired |
| U16 | `desktop/src/components/controls/ModelSelector.tsx` | `ModelSelector` | Sensitive provider switch hint delegation, only when already sensitive | Rebuilding the model selector | planned:`desktop/src/features/managed-resources/integration/sensitiveSwitchHint.tsx` | planned:`desktop/src/features/managed-resources/integration/sensitiveSwitchHint.test.tsx` | not-wired |
| U17 | `desktop/src/i18n/locales/en.ts`<br>`desktop/src/i18n/locales/zh.ts`<br>`desktop/src/i18n/locales/jp.ts`<br>`desktop/src/i18n/locales/kr.ts`<br>`desktop/src/i18n/locales/zh-TW.ts`<br>`desktop/package.json`<br>`desktop/bun.lock`<br>`scripts/quality-gate/modes.ts` | `en`<br>`zh`<br>`jp`<br>`kr` | New keys, approved dep collection, registering new tests | Reformatting the entire locale tree or reinstalling every dependency | `desktop/src/features/managed-resources/i18n/keys.ts` | `desktop/src/features/managed-resources/integration/i18nKeyBindings.test.ts` | wired |

> Host paths and anchors above are verified by `fs.existsSync` and substring
> search in each file at `upstreamBaseHead 6561a36238e2352f389f545f87b155bf39371447`.
> Every `planned:`repo/relative/path`` resolves inside the repository but does not yet exist
> on disk (to be created by its future micro-batch). No existing host path is
> marked `planned:`.

## No-feature regression contracts (06 §5)

| Contract | Planned test path | Status | Future passing evidence |
|---|---|---|---|
| Empty selection walks the original message chain | `desktop/src/features/managed-resources/integration/contract.emptySelection.test.tsx` | wired | Real `chatStore.sendMessage` round-trip without any new module branch firing |
| Both composer surfaces reach the same controller | `desktop/src/features/managed-resources/integration/contract.dualComposer.test.tsx` | wired | Drive `ChatInput` and `EmptySession`; both reach the same integration entrypoint |
| Three send points share one ticket preparation | `desktop/src/features/managed-resources/integration/contract.ticketShare.test.tsx` | wired | Stub all three send points; assert identical prepared ticket |
| `sessionId` / `runtimeRevision` match ticket | planned:`desktop/src/features/managed-resources/integration/contract.sessionMatch.test.tsx` | planned | Assert server route binds ticket before user message lands |
| SDK UUID → replay / history / project is one identity | planned:`desktop/src/features/managed-resources/integration/contract.uuidIdentity.test.tsx` | planned | Drive replay; assert single history entry + single project row |
| Host tab lifecycle stays independent of the main session | planned:`desktop/src/features/managed-resources/integration/contract.tabLifecycle.test.tsx` | planned | Toggle host tab; assert session unaffected |
| Server auth rejects non-loopback / non-local bearer | planned:`src/server/features/managedContext/contract.auth.test.ts` | planned | Issue request with non-loopback peer; assert rejection |
| Trace / prompt-dump sees secret-turn marker | planned:`src/server/features/managedContext/contract.traceMarker.test.ts` | planned | Drive a sensitive turn; assert dump preamble contains the marker |
| New resource store keeps unknown fields with old fixture | planned:`desktop/src/features/managed-resources/integration/contract.unknownFields.test.ts` | planned | Round-trip the M0.3 fixture; assert unknown keys preserved |
| Removing a tag re-computes all dependents / credentials | planned:`desktop/src/features/managed-resources/integration/contract.tagRecompute.test.ts` | planned | Remove a tag; assert dependents and credentials drop |

## Dependency direction (locks for the next micro-batches)

```
host  →  module interfaces / factories (one-way)
renderer  ⇏  Node drivers (mysql2 / pg / pg-cursor / @redis/client / ssh2)
Electron module  ⇏  main.ts
sensitivity policy  ⇏  src/server
plain no-feature path  →  unchanged (no decorator / wrapping on the no-feature branch)
```

Any attempt to invert one of these arrows is a `stopConditions` violation in the current micro-batch.

## Scope and limits

- **Scope:** Windows 10 / Windows 11 desktop client. Linux is only a remotely
  managed host (SSH / SFTP / database / Redis). macOS / Swift / Linux desktop
  builds are explicitly out of scope for this feature; their checks are skipped
  or marked `skipped: Windows 10/11 only`.
- **No live network:** no real SSH, MySQL, PostgreSQL, Redis, browser, model,
  host, port, credential, or profile is contacted by anything declared in
  this map.
- **Upgrade metadata only:** this file does not claim the feature is wired,
  the contracts have passed, or the host is ready for production traffic.
  Every row reads `not-wired` / `planned` until the corresponding wiring
  micro-batch publishes an update acceptance (review verdict `ACCEPTED`).