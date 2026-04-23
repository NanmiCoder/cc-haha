import type { CuPermissionRequest, CuPermissionResponse } from '../../vendor/computer-use-mcp/types.js'
import { sendToSession } from '../ws/handler.js'

type PendingApproval = {
  sessionId: string
  resolve: (response: CuPermissionResponse) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

const REQUEST_TIMEOUT_MS = 5 * 60 * 1000

class ComputerUseApprovalService {
  private pending = new Map<string, PendingApproval>()

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

    return await new Promise<CuPermissionResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(request.requestId)
        reject(new Error('Computer Use approval timed out'))
      }, REQUEST_TIMEOUT_MS)

      this.pending.set(request.requestId, {
        sessionId,
        resolve,
        reject,
        timeout,
      })

      const sent = sendToSession(sessionId, {
        type: 'computer_use_permission_request',
        requestId: request.requestId,
        request,
      })

      if (!sent) {
        clearTimeout(timeout)
        this.pending.delete(request.requestId)
        reject(new Error('Desktop session is not connected'))
      }
    })
  }

  resolveApproval(requestId: string, response: CuPermissionResponse): boolean {
    const pending = this.pending.get(requestId)
    if (!pending) return false
    clearTimeout(pending.timeout)
    this.pending.delete(requestId)
    pending.resolve(response)
    return true
  }

  cancelSession(sessionId: string): void {
    for (const [requestId, pending] of this.pending.entries()) {
      if (pending.sessionId !== sessionId) continue
      clearTimeout(pending.timeout)
      this.pending.delete(requestId)
      pending.reject(new Error('Desktop session disconnected during Computer Use approval'))
    }
  }
}

export const computerUseApprovalService = new ComputerUseApprovalService()
