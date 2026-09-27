import type { CuPermissionRequest, CuPermissionResponse } from '../../vendor/computer-use-mcp/types.js'
import { getSessionTurnState, sendToSession } from '../ws/handler.js'
import { emitSessionTurnEvent } from './sessionTurnEvents.js'

type PendingApproval = {
  sessionId: string
  request: CuPermissionRequest
  resolve: (response: CuPermissionResponse) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

const REQUEST_TIMEOUT_MS = 5 * 60 * 1000

export class ComputerUseApprovalService {
  private pending = new Map<string, PendingApproval>()

  constructor(private readonly timeoutMs = REQUEST_TIMEOUT_MS) {}

  private resolved(sessionId: string, requestId: string): void {
    emitSessionTurnEvent({ type: 'output', sessionId, message: { type: 'control_response', request_id: requestId } })
  }

  async requestApproval(
    sessionId: string,
    request: CuPermissionRequest,
  ): Promise<CuPermissionResponse> {
    const existing = this.pending.get(request.requestId)
    if (existing) {
      clearTimeout(existing.timeout)
      existing.reject(new Error('Computer Use approval request superseded'))
      this.pending.delete(request.requestId)
    }

    // Check before inserting into pending: our own request must not make an
    // otherwise nonexistent session appear blocked and eligible for approval.
    const canWaitWithoutRenderer = getSessionTurnState(sessionId) !== 'idle'

    return await new Promise<CuPermissionResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(request.requestId)
        this.resolved(sessionId, request.requestId)
        reject(new Error('Computer Use approval timed out'))
      }, this.timeoutMs)

      this.pending.set(request.requestId, {
        sessionId,
        request,
        resolve,
        reject,
        timeout,
      })

      const sent = sendToSession(sessionId, {
        type: 'computer_use_permission_request',
        requestId: request.requestId,
        request,
      })

      if (!sent && !canWaitWithoutRenderer) {
        clearTimeout(timeout)
        this.pending.delete(request.requestId)
        reject(new Error('Desktop session is not connected'))
        return
      }
      emitSessionTurnEvent({ type: 'output', sessionId, message: {
        type: 'control_request', request_id: request.requestId,
        request: { subtype: 'can_use_tool', tool_name: 'ComputerUse', description: request.reason },
      } })
    })
  }

  resolveApproval(requestId: string, response: CuPermissionResponse): boolean {
    const pending = this.pending.get(requestId)
    if (!pending) return false
    clearTimeout(pending.timeout)
    this.pending.delete(requestId)
    this.resolved(pending.sessionId, requestId)
    pending.resolve(response)
    return true
  }

  getPendingRequests(sessionId: string): CuPermissionRequest[] {
    return Array.from(this.pending.values())
      .filter((pending) => pending.sessionId === sessionId)
      .map((pending) => pending.request)
  }

  cancelSession(sessionId: string): void {
    for (const [requestId, pending] of this.pending.entries()) {
      if (pending.sessionId !== sessionId) continue
      clearTimeout(pending.timeout)
      this.pending.delete(requestId)
      this.resolved(sessionId, requestId)
      pending.reject(new Error('Desktop session disconnected during Computer Use approval'))
    }
  }
}

export const computerUseApprovalService = new ComputerUseApprovalService()
