/**
 * Providers REST API
 *
 * GET    /api/providers              — list all saved providers + activeId
 * GET    /api/providers/presets       — list available presets
 * GET    /api/providers/auth-status   — check whether any usable auth exists
 * GET    /api/providers/settings      — read cc-haha managed settings.json
 * POST   /api/providers              — add a provider
 * PUT    /api/providers/settings      — update cc-haha managed settings.json
 * PUT    /api/providers/:id          — update a provider
 * DELETE /api/providers/:id          — delete a provider
 * POST   /api/providers/:id/activate — activate a saved provider
 * POST   /api/providers/official     — activate official (clear env)
 * POST   /api/providers/:id/test     — test a saved provider
 * POST   /api/providers/test         — test unsaved config
 * POST   /api/providers/fetch-models — server-side fetch upstream /v1/models (bypasses CORS / mixed-content)
 */

import { z } from 'zod'
import { ProviderService } from '../services/providerService.js'
import { PROVIDER_PRESETS } from '../config/providerPresets.js'
import {
  CreateProviderSchema,
  UpdateProviderSchema,
  TestProviderSchema,
  FetchModelsSchema,
  ReorderProvidersSchema,
} from '../types/provider.js'
import { ApiError, errorResponse } from '../middleware/errorHandler.js'
import { diagnosticsService } from '../services/diagnosticsService.js'

const providerService = new ProviderService()

export async function handleProvidersApi(
  req: Request,
  _url: URL,
  segments: string[],
): Promise<Response> {
  try {
    const id = segments[2]
    const action = segments[3]

    // POST /api/providers/test
    if (id === 'test' && req.method === 'POST') {
      return await handleTestUnsaved(req)
    }

    // POST /api/providers/fetch-models
    if (id === 'fetch-models' && req.method === 'POST') {
      return await handleFetchModels(req)
    }

    // GET /api/providers/presets
    if (id === 'presets' && req.method === 'GET') {
      return Response.json({ presets: PROVIDER_PRESETS })
    }

    // GET /api/providers/auth-status
    if (id === 'auth-status' && req.method === 'GET') {
      const status = await providerService.checkAuthStatus()
      return Response.json(status)
    }

    // /api/providers/settings
    if (id === 'settings') {
      if (req.method === 'GET') {
        return Response.json(await providerService.getManagedSettings())
      }
      if (req.method === 'PUT') {
        const body = await parseJsonBody(req)
        await providerService.updateManagedSettings(body)
        return Response.json({ ok: true })
      }
      throw methodNotAllowed(req.method)
    }

    // POST /api/providers/official
    if (id === 'official' && req.method === 'POST') {
      await providerService.activateOfficial()
      return Response.json({ ok: true })
    }

    // PUT /api/providers/reorder
    if (id === 'reorder') {
      if (req.method !== 'PUT') throw methodNotAllowed(req.method)
      return await handleReorder(req)
    }

    // /api/providers (no ID)
    if (!id) {
      if (req.method === 'GET') {
        const { providers, activeId } = await providerService.listProviders()
        return Response.json({ providers, activeId })
      }
      if (req.method === 'POST') {
        return await handleCreate(req)
      }
      throw methodNotAllowed(req.method)
    }

    // /api/providers/:id/activate
    if (action === 'activate') {
      if (req.method !== 'POST') throw methodNotAllowed(req.method)
      await providerService.activateProvider(id)
      return Response.json({ ok: true })
    }

    // /api/providers/:id/test
    if (action === 'test') {
      if (req.method !== 'POST') throw methodNotAllowed(req.method)
      let overrides: { baseUrl?: string; modelId?: string; apiFormat?: string; authStrategy?: string } | undefined
      try {
        const body = await req.json()
        if (body && typeof body === 'object') overrides = body as typeof overrides
      } catch { /* no body is fine — uses saved values */ }
      const result = await providerService.testProvider(id, overrides)
      if (!result.connectivity.success || result.proxy?.success === false) {
        void diagnosticsService.recordEvent({
          type: 'provider_test_failed',
          severity: 'warn',
          summary: result.connectivity.error || result.proxy?.error || 'Provider test failed',
          details: {
            providerId: id,
            httpStatus: result.connectivity.httpStatus ?? result.proxy?.httpStatus,
            apiFormat: overrides?.apiFormat,
            modelId: overrides?.modelId,
            connectivity: result.connectivity,
            proxy: result.proxy,
          },
        })
      }
      return Response.json({ result })
    }

    // /api/providers/:id
    if (req.method === 'GET') {
      const provider = await providerService.getProvider(id)
      return Response.json({ provider })
    }
    if (req.method === 'PUT') {
      return await handleUpdate(req, id)
    }
    if (req.method === 'DELETE') {
      await providerService.deleteProvider(id)
      return Response.json({ ok: true })
    }

    throw methodNotAllowed(req.method)
  } catch (error) {
    return errorResponse(error)
  }
}

async function handleCreate(req: Request): Promise<Response> {
  const body = await parseJsonBody(req)
  try {
    const input = CreateProviderSchema.parse(body)
    const provider = await providerService.addProvider(input)
    return Response.json({ provider }, { status: 201 })
  } catch (err) {
    if (err instanceof z.ZodError) throw ApiError.badRequest(err.issues.map((i) => i.message).join('; '))
    throw err
  }
}

async function handleUpdate(req: Request, id: string): Promise<Response> {
  const body = await parseJsonBody(req)
  try {
    const input = UpdateProviderSchema.parse(body)
    const provider = await providerService.updateProvider(id, input)
    return Response.json({ provider })
  } catch (err) {
    if (err instanceof z.ZodError) throw ApiError.badRequest(err.issues.map((i) => i.message).join('; '))
    throw err
  }
}

async function handleReorder(req: Request): Promise<Response> {
  const body = await parseJsonBody(req)
  try {
    const input = ReorderProvidersSchema.parse(body)
    const { providers, providerOrder } = await providerService.reorderProviders(input.orderedIds)
    return Response.json({ providers, providerOrder })
  } catch (err) {
    if (err instanceof z.ZodError) throw ApiError.badRequest(err.issues.map((i) => i.message).join('; '))
    throw err
  }
}

async function handleTestUnsaved(req: Request): Promise<Response> {
  const body = await parseJsonBody(req)
  try {
    const input = TestProviderSchema.parse(body)
    const result = await providerService.testProviderConfig(input)
    if (!result.connectivity.success || result.proxy?.success === false) {
      void diagnosticsService.recordEvent({
        type: 'provider_test_failed',
        severity: 'warn',
        summary: result.connectivity.error || result.proxy?.error || 'Provider test failed',
        details: {
          providerId: null,
          baseUrl: input.baseUrl,
          apiFormat: input.apiFormat,
          modelId: input.modelId,
          connectivity: result.connectivity,
          proxy: result.proxy,
        },
      })
    }
    return Response.json({ result })
  } catch (err) {
    if (!(err instanceof z.ZodError)) {
      void diagnosticsService.recordEvent({
        type: 'provider_test_failed',
        severity: 'warn',
        summary: err instanceof Error ? err.message : String(err),
        details: { providerId: null, error: err },
      })
    }
    if (err instanceof z.ZodError) throw ApiError.badRequest(err.issues.map((i) => i.message).join('; '))
    throw err
  }
}

/**
 * POST /api/providers/fetch-models
 *
 * Server-side proxy for the desktop "Fetch Models" button. The renderer
 * cannot reliably call upstream `/v1/models` directly: HTTP-only relay
 * URLs are mixed-content-blocked from the secure-context webview, and
 * many self-hosted relays do not return permissive CORS headers.
 * Routing through the server bypasses both.
 */
async function handleFetchModels(req: Request): Promise<Response> {
  const body = await parseJsonBody(req)
  try {
    const input = FetchModelsSchema.parse(body)
    const { status, data } = await providerService.fetchUpstreamModels(input)
    return Response.json({ status, data })
  } catch (err) {
    if (err instanceof z.ZodError) {
      throw ApiError.badRequest(err.issues.map((i) => i.message).join('; '))
    }
    if (!(err instanceof ApiError)) {
      void diagnosticsService.recordEvent({
        type: 'provider_fetch_models_failed',
        severity: 'warn',
        summary: err instanceof Error ? err.message : String(err),
        details: { error: err },
      })
    }
    throw err
  }
}

async function parseJsonBody(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>
  } catch {
    throw ApiError.badRequest('Invalid JSON body')
  }
}

function methodNotAllowed(method: string): ApiError {
  return new ApiError(405, `Method ${method} not allowed`, 'METHOD_NOT_ALLOWED')
}
