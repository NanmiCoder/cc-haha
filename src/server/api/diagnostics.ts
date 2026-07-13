/**
 * Diagnostics REST API
 *
 * GET    /api/diagnostics/status       — log directory, retention and counters
 * GET    /api/diagnostics/events       — recent sanitized diagnostic events
 * GET    /api/diagnostics/issue-report — share-safe GitHub issue report Markdown
 * POST   /api/diagnostics/events       — append a sanitized client diagnostic event
 * POST   /api/diagnostics/export       — write a sanitized tar.gz bundle
 * POST   /api/diagnostics/open-log-dir — open the diagnostics directory
 * DELETE /api/diagnostics              — clear diagnostics files
 */

import { diagnosticsService } from '../services/diagnosticsService.js'
import { ApiError, errorResponse } from '../middleware/errorHandler.js'

export async function handleDiagnosticsApi(
  req: Request,
  url: URL,
  segments: string[],
): Promise<Response> {
  try {
    const action = segments[2]

    if (!action && req.method === 'DELETE') {
      await diagnosticsService.clear()
      return Response.json({ ok: true })
    }

    if (action === 'status' && req.method === 'GET') {
      return Response.json(await diagnosticsService.getStatus())
    }

    if (action === 'events' && req.method === 'GET') {
      const limit = Number.parseInt(url.searchParams.get('limit') || '100', 10)
      const events = await diagnosticsService.readRecentEvents(Number.isFinite(limit) ? limit : 100)
      return Response.json({ events })
    }

    if (action === 'issue-report' && req.method === 'GET') {
      return Response.json({ report: await diagnosticsService.buildIssueReport() })
    }

    if (action === 'events' && req.method === 'POST') {
      const body = await parseJsonBody(req)
      const type = typeof body.type === 'string' && body.type.trim()
        ? body.type.trim().slice(0, 128)
        : 'client_diagnostic_event'
      // A client event that omits/garbles severity is not, by default, an error.
      const severity = isDiagnosticSeverity(body.severity) ? body.severity : 'info'
      const summary = typeof body.summary === 'string' && body.summary.trim()
        ? body.summary
        : type
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : undefined
      const result = await diagnosticsService.recordEvent({
        type,
        severity,
        summary,
        sessionId,
        details: body.details,
      })
      if (!result.ok) throw ApiError.internal(result.error)
      return Response.json({ ok: true, eventId: result.event.id })
    }

    if (action === 'export' && req.method === 'POST') {
      return Response.json({ bundle: await diagnosticsService.exportBundle() })
    }

    if (action === 'open-log-dir' && req.method === 'POST') {
      await diagnosticsService.openLogDir()
      return Response.json({ ok: true })
    }

    throw new ApiError(404, `Unknown diagnostics endpoint: ${action ?? '(root)'}`, 'NOT_FOUND')
  } catch (error) {
    return errorResponse(error)
  }
}

async function parseJsonBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json()
    return body && typeof body === 'object' ? body as Record<string, unknown> : {}
  } catch {
    throw ApiError.badRequest('Invalid JSON body')
  }
}

function isDiagnosticSeverity(value: unknown): value is 'debug' | 'info' | 'warn' | 'error' {
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error'
}
