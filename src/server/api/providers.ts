/**
 * Providers REST API
 *
 * GET    /api/providers                  — list all saved providers + activeId
 * GET    /api/providers/presets           — list available presets
 * GET    /api/providers/auth-status       — check whether any usable auth exists
 * GET    /api/providers/settings          — read cc-haha managed settings.json
 * GET    /api/providers/cc-switch/scan    — scan a local cc-switch install
 * POST   /api/providers                  — add a provider
 * POST   /api/providers/cc-switch/import  — import scanned cc-switch providers
 * POST   /api/providers/models            — list upstream models for a config
 * PUT    /api/providers/settings          — update cc-haha managed settings.json
 * PUT    /api/providers/:id              — update a provider
 * DELETE /api/providers/:id              — delete a provider
 * POST   /api/providers/:id/activate     — activate a saved provider
 * GET    /api/providers/:id/models       — read built-in OAuth model mapping
 * PUT    /api/providers/:id/models       — update built-in OAuth model mapping
 * POST   /api/providers/official         — activate official (clear env)
 * POST   /api/providers/:id/test         — test a saved provider
 * POST   /api/providers/test             — test unsaved config
 */

import { z } from 'zod'
import { ProviderService } from '../services/providerService.js'
import { PROVIDER_PRESETS } from '../config/providerPresets.js'
import {
  CreateProviderSchema,
  ModelMappingSchema,
  UpdateProviderSchema,
  TestProviderSchema,
  ReorderProvidersSchema,
} from '../types/provider.js'
import { ApiError, errorResponse } from '../middleware/errorHandler.js'
import { diagnosticsService } from '../services/diagnosticsService.js'
import {
  readCcSwitchProviders,
  resolveCcSwitchImports,
  toCcSwitchScanResult,
} from '../services/ccSwitchImport.js'
import { fetchProviderModels } from '../services/providerModelCatalog.js'

const providerService = new ProviderService()

const CcSwitchImportSchema = z.object({
  sourceIds: z.array(z.string().min(1)).min(1),
})

const FetchProviderModelsSchema = z.object({
  baseUrl: z.string().min(1),
  apiKey: z.string().min(1),
  isFullUrl: z.boolean().optional(),
  // `modelsUrl` is deliberately NOT accepted over HTTP. The service still
  // supports the override for internal callers, but exposing a free-form
  // endpoint on an authenticated route only widens the request surface — no
  // client sends it.
})

const OfficialProviderModelsUpdateSchema = z.object({
  models: ModelMappingSchema.extend({
    main: z.string().trim().min(1),
  }),
})

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

    // POST /api/providers/models
    if (id === 'models' && req.method === 'POST') {
      return await handleFetchModels(req)
    }

    // /api/providers/cc-switch/* — registered before the generic :id handlers
    if (id === 'cc-switch') {
      if (action === 'scan') {
        if (req.method !== 'GET') throw methodNotAllowed(req.method)
        return await handleCcSwitchScan()
      }
      if (action === 'import') {
        if (req.method !== 'POST') throw methodNotAllowed(req.method)
        return await handleCcSwitchImport(req)
      }
      throw ApiError.notFound(`Unknown cc-switch route: ${action ?? ''}`)
    }

    // GET /api/providers/presets
    // Carries retired presets too (flagged `deprecated`), so a consumer resolving a saved
    // provider's presetId still finds it. Filter on `deprecated` to build add-provider choices.
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

    // /api/providers/:id/models — built-in OAuth provider model aliases
    if (action === 'models') {
      if (req.method === 'GET') {
        const models = await providerService.getOfficialProviderModels(id)
        return Response.json({ models })
      }
      if (req.method === 'PUT') {
        const parsed = OfficialProviderModelsUpdateSchema.safeParse(await parseJsonBody(req))
        if (!parsed.success) {
          throw ApiError.badRequest(parsed.error.issues.map((issue) => issue.message).join('; '))
        }
        const models = await providerService.updateOfficialProviderModels(id, parsed.data.models)
        return Response.json({ models })
      }
      throw methodNotAllowed(req.method)
    }

    // /api/providers/:id/test
    if (action === 'test') {
      if (req.method !== 'POST') throw methodNotAllowed(req.method)
      let body: unknown
      try {
        body = await req.json()
      } catch { /* no body is fine — uses saved values */ }
      let overrides: { modelId?: string } | undefined
      if (body && typeof body === 'object') {
        const candidate = body as Record<string, unknown>
        for (const field of ['baseUrl', 'apiFormat', 'authStrategy']) {
          if (Object.prototype.hasOwnProperty.call(candidate, field)) {
            throw ApiError.badRequest(
              `${field} cannot be overridden when testing with a saved provider key`,
            )
          }
        }
        if (candidate.modelId !== undefined && typeof candidate.modelId !== 'string') {
          throw ApiError.badRequest('modelId must be a string')
        }
        overrides = candidate.modelId === undefined
          ? undefined
          : { modelId: candidate.modelId as string }
      }
      const result = await providerService.testProvider(id, overrides)
      if (!result.connectivity.success || result.proxy?.success === false) {
        void diagnosticsService.recordEvent({
          type: 'provider_test_failed',
          severity: 'warn',
          summary: result.connectivity.error || result.proxy?.error || 'Provider test failed',
          details: {
            providerId: id,
            httpStatus: result.connectivity.httpStatus ?? result.proxy?.httpStatus,
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

async function handleCcSwitchScan(): Promise<Response> {
  const { providers } = await providerService.listProviders()
  const scan = await readCcSwitchProviders({ existingProviders: providers })
  // Full API keys stay server-side; the client only ever sees masked previews.
  return Response.json(toCcSwitchScanResult(scan))
}

async function handleCcSwitchImport(req: Request): Promise<Response> {
  const body = await parseJsonBody(req)
  try {
    const input = CcSwitchImportSchema.parse(body)
    const { providers } = await providerService.listProviders()
    const scan = await readCcSwitchProviders({ existingProviders: providers })
    const { inputs, skipped } = resolveCcSwitchImports(scan, input.sourceIds)
    const imported = await providerService.importProviders(inputs)
    return Response.json({ imported, skipped })
  } catch (err) {
    if (err instanceof z.ZodError) throw ApiError.badRequest(err.issues.map((i) => i.message).join('; '))
    throw err
  }
}

async function handleFetchModels(req: Request): Promise<Response> {
  const body = await parseJsonBody(req)
  try {
    const input = FetchProviderModelsSchema.parse(body)
    // Upstream failures are reported as 200 + { ok: false }, like testProvider.
    return Response.json(await fetchProviderModels(input))
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
