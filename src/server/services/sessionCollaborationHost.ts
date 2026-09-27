import { join } from 'node:path'
import { homedir } from 'node:os'
import { sessionService } from './sessionService.js'
import { SearchService } from './searchService.js'
import { conversationService } from './conversationService.js'
import { getRepositoryContext } from './repositoryLaunchService.js'
import { SessionCollaborationService } from './sessionCollaborationService.js'
import { registerSessionTurnAdmissionGuard, observeSessionTurns, type SessionTurnEvent } from './sessionTurnEvents.js'
import { getRuntimeSettings, getSessionTurnState, isSessionTurnStopped, stopSessionTurn, submitSessionTurn, sendToSession } from '../ws/handler.js'
import { ApiError } from '../middleware/errorHandler.js'

const searchService = new SearchService()

let endpoint = { serverHost: '127.0.0.1', serverPort: 0 }
let current: { path: string; service: SessionCollaborationService; ready: Promise<void> } | undefined
let unsubscribe: (() => void) | undefined

export function configureSessionCollaborationHost(serverHost: string, serverPort: number): () => void {
  endpoint = { serverHost, serverPort }
  unsubscribe?.()
  let eventTail: Promise<void> = Promise.resolve()
  const removeGuard = registerSessionTurnAdmissionGuard(async (sessionId, canAdmit) => {
    // Previously emitted lifecycle events belong before this new reservation.
    await eventTail
    return (await getSessionCollaborationService()).admitUserTurn(sessionId, canAdmit)
  })
  let disposed = false
  unsubscribe = observeSessionTurns(event => {
    eventTail = eventTail.then(async () => {
      if (disposed) return
      await handleSessionCollaborationEvent(await getSessionCollaborationService(), event)
    }).catch(error => console.error('[SessionCollaboration] Event failed', error))
  })
  return () => { disposed = true; removeGuard(); unsubscribe?.(); unsubscribe = undefined; current = undefined }
}

export async function getSessionCollaborationService(): Promise<SessionCollaborationService> {
  const path = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'cc-haha', 'session-collaboration', 'state.json')
  if (!current || current.path !== path) {
    const service = new SessionCollaborationService({
      statePath: path,
      sessions: {
        async list({ query, limit, offset, signal }) {
          const needle = query?.trim() ?? ''
          // Metadata ranking and the body lookup are both synchronous SQLite.
          // Whichever is still pending once this elapses is skipped so the
          // picker cannot hold the process while other requests wait.
          const deadlineMs = Date.now() + 300
          const metadata = await sessionService.searchSessionMetadata(needle, { limit, offset, signal, deadlineMs })
          signal?.throwIfAborted()
          // A full metadata page already answers the picker. Do not wait for
          // full-text matches (or canonical transcript validation) to display it.
          if (!needle) return metadata
          if (metadata.truncated || metadata.sessions.length === limit || Date.now() > deadlineMs) {
            return { ...metadata, truncated: true, totalIsLowerBound: true }
          }
          const content = await searchService.searchSessionSuggestions(needle, { limit: 100, signal, deadlineMs })
          signal?.throwIfAborted()
          const details = new Map(sessionService.getSessionSuggestionMetadata(content.sessions.map(item => item.sessionId)).map(item => [item.id, item]))
          const normalized = needle.toLowerCase()
          const seen = new Set<string>()
          const bodyOnly = content.sessions.flatMap(item => {
            const detail = details.get(item.sessionId)
            // The metadata page is authoritative for title/project matches;
            // filter these from content pages too so pagination cannot repeat them.
            if (seen.has(item.sessionId)) return []
            seen.add(item.sessionId)
            if (detail && [detail.id, detail.title, detail.workDir ?? '', detail.projectPath].some(value => value.toLowerCase().includes(normalized))) return []
            return [detail ?? { id: item.sessionId, title: item.sessionId, projectPath: item.projectPath, modifiedAt: item.modifiedAt }]
          })
          const bodyOffset = Math.max(0, offset - metadata.total)
          return {
            sessions: [...metadata.sessions, ...bodyOnly.slice(bodyOffset, bodyOffset + limit - metadata.sessions.length)],
            total: metadata.total + bodyOnly.length,
            truncated: content.truncated,
            totalIsLowerBound: content.truncated || content.indexUnavailable,
            indexUnavailable: content.indexUnavailable,
          }
        },
        read: (sessionId, options) => sessionService.getSessionHistoryPage(sessionId, { ...options, projectContext: false }),
        exists: async sessionId => Boolean(await sessionService.getSessionSummary(sessionId)),
        titles: sessionIds => {
          const titles: Record<string, string> = {}
          // The index can briefly contain both the source placeholder and the
          // worktree transcript. Rows are newest-first; keep the first useful
          // title instead of letting an older duplicate or Untitled overwrite it.
          for (const item of sessionService.getSessionSuggestionMetadata(sessionIds)) {
            const title = item.title.trim()
            if (!title) continue
            if (!(item.id in titles) || titles[item.id] === 'Untitled Session') {
              titles[item.id] = title
            }
          }
          return titles
        },
        async create(callerSessionId, input) {
          const workDir = input.workDir ?? await sessionService.getSessionWorkDir(callerSessionId)
          if (!workDir) throw new ApiError(409, 'The source session working directory is unavailable', 'SESSION_WORKSPACE_UNAVAILABLE')
          const [repository, runtime] = await Promise.all([getRepositoryContext(workDir), getRuntimeSettings(callerSessionId)])
          if (repository.state !== 'ok' && repository.state !== 'not_git_repo') throw new ApiError(400, `Cannot resolve the target repository (${repository.state}); no session was created`, 'SESSION_REPOSITORY_UNAVAILABLE')
          const created = await sessionService.createSession(workDir, repository.state === 'ok' ? { worktree: true } : undefined, runtime.permissionMode)
          await sessionService.appendSessionMetadata(created.sessionId, {
            workDir: created.workDir, customTitle: input.title ?? input.prompt.slice(0, 80),
            permissionMode: runtime.permissionMode, runtimeProviderId: input.providerId !== undefined ? input.providerId : runtime.providerId,
            runtimeModelId: input.model ?? runtime.model, effortLevel: runtime.effort,
          })
          return created
        },
      },
      runtime: {
        getState: getSessionTurnState,
        async start(sessionId, message) {
          if (!endpoint.serverPort) throw new Error('Desktop session host is not running')
          const ack = await submitSessionTurn(sessionId, message.content, { ...endpoint, messageId: message.id, sourceSessionId: message.sourceSessionId, canSend: () => service.canDeliver(message.id) })
          if (ack.status === 'consumed') {
            await service.onMessageConsumed(message.id, sessionId)
            await service.onSessionState(sessionId, 'idle')
          }
        },
        async enqueue(sessionId, message) {
          const result = await conversationService.requestControl(sessionId, {
            subtype: 'enqueue_session_message', message_id: message.id,
            sender_session_id: message.sourceSessionId, text: message.content,
          }, 10_000, undefined, () => !isSessionTurnStopped(sessionId) && service.canDeliver(message.id))
          if (result.status !== 'queued' && result.status !== 'consumed') throw new Error('CLI did not acknowledge the session message')
          if (result.status === 'consumed') await service.onMessageConsumed(message.id, sessionId)
          else if (getSessionTurnState(sessionId) === 'idle' && service.canDeliver(message.id)) {
            const ack = await submitSessionTurn(sessionId, message.content, { ...endpoint, messageId: message.id, sourceSessionId: message.sourceSessionId, canSend: () => service.canDeliver(message.id) })
            if (ack.status === 'consumed') {
              await service.onMessageConsumed(message.id, sessionId)
              await service.onSessionState(sessionId, 'idle')
            }
          }
        },
        async stop(sessionId) { stopSessionTurn(sessionId) },
      },
    })
    current = { path, service, ready: service.recover() }
  }
  await current.ready
  return current.service
}

export async function handleSessionCollaborationEvent(service: SessionCollaborationService, event: SessionTurnEvent): Promise<boolean> {
  // A renderer input arrives before the CLI is started. Only reopen its fence
  // here; the shared admission's committed event proves the SDK can accept the
  // pending collaboration inbox without racing process startup.
  if (event.type === 'user-input') { await service.onUserInput(event.sessionId, { dispatch: false }); return false }
  if (event.type === 'input-committed') { await service.onSessionState(event.sessionId, 'running'); return false }
  if (event.type === 'stopped') { await service.onStopped(event.sessionId); return false }
  const message = event.message
  let collaborationStateChanged = false
  if (message.type === 'system' && message.subtype === 'session_message_receipt' && message.status === 'consumed') {
    await service.onMessageConsumed(message.message_id, event.sessionId)
    collaborationStateChanged = true
  } else if (message.type === 'result') {
    await service.onSessionState(event.sessionId, message.is_error ? 'failed' : 'completed',
      String(message.result ?? message.errors?.join('\n') ?? '').slice(0, 8000), message.uuid)
    collaborationStateChanged = true
  } else if (message.type === 'control_request' && message.request?.subtype === 'can_use_tool') {
    await service.onSessionState(event.sessionId, 'blocked', `Waiting for permission: ${message.request.tool_name ?? 'tool'}`, message.request_id)
    collaborationStateChanged = true
  } else if (message.type === 'control_response' || message.type === 'control_cancel_request') {
    if (getSessionTurnState(event.sessionId) === 'running') {
      await service.onSessionState(event.sessionId, 'running')
      collaborationStateChanged = true
    }
  }
  // The SDK emits every streaming assistant fragment through this observer.
  // Broadcasting a collaboration update for fragments that do not mutate the
  // collaboration state made every renderer refetch the full session list,
  // creating thousands of concurrent requests during multi-agent turns.
  if (!collaborationStateChanged) return false
  sendToSession(event.sessionId, { type: 'system_notification', subtype: 'session_collaboration_updated', data: { sessionId: event.sessionId } })
  return true
}
