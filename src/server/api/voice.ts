/**
 * Voice input REST API
 *
 * GET    /api/voice/catalog                     — providers, preferences, limits, correction targets
 * PUT    /api/voice/preferences                 — partial update of { enabled, providerId, language, downloadSource,
 *                                                  correctionEnabled, correctionProviderId + correctionModelId }
 * POST   /api/voice/providers/:id/prepare       — start (or join) the background download
 * POST   /api/voice/providers/:id/cancel        — cancel a running download
 * GET    /api/voice/providers/:id/status        — provider info + preparation state
 * DELETE /api/voice/providers/:id/assets        — delete downloaded runtime and models
 * POST   /api/voice/transcribe?provider=&language= — raw 16 kHz mono PCM16 WAV body
 * POST   /api/voice/correct                     — { text } → corrected text + changes (AI correction)
 * GET    /api/voice/vocabulary                  — personal vocabulary, suggestions, history run
 * POST   /api/voice/vocabulary/terms            — { entries, source?, dismiss? } add / merge
 * PUT    /api/voice/vocabulary/terms            — { from, term, aliases } replace one entry
 * DELETE /api/voice/vocabulary/terms?term=      — remove one entry (and stop suggesting it)
 * POST   /api/voice/vocabulary/suggestions/dismiss — { term } stop suggesting a term
 * GET    /api/voice/vocabulary/history/sources  — which chat histories exist locally
 * POST   /api/voice/vocabulary/history/suggest  — { sources, providerId, modelId } local count + one model pick
 *
 * Voice errors use `{ error: 'voice/...', message, reason? }` with 400/404/409/500/502.
 * Everything except catalog, provider status and transcribe is desktop-only
 * (see publicAccess.ts).
 */

import { ApiError, errorResponse } from '../middleware/errorHandler.js'
import { getVoiceService } from '../services/voice/defaultRegistry.js'
import { VoiceServiceError } from '../services/voice/errors.js'
import { isVoiceLanguage } from '../services/voice/preferences.js'
import { VOICE_LIMITS, type VoiceVocabularyInput } from '../services/voice/types.js'
import { isVoiceVocabularySource } from '../services/voice/vocabulary/store.js'
import type { VoiceService } from '../services/voice/voiceService.js'

export async function handleVoiceApi(
  req: Request,
  url: URL,
  segments: string[],
  service: VoiceService = getVoiceService(),
): Promise<Response> {
  try {
    const sub = segments[2]

    if (sub === 'catalog') {
      requireMethod(req, 'GET')
      return Response.json(await service.catalog())
    }

    if (sub === 'preferences') {
      requireMethod(req, 'PUT')
      const preferences = await service.updatePreferences(await parseJsonBody(req))
      return Response.json({ preferences })
    }

    if (sub === 'providers') {
      const providerId = segments[3] ? decodeProviderId(segments[3]) : undefined
      const action = segments[4]
      if (!providerId || !action) throw ApiError.notFound('Unknown voice provider endpoint')

      if (action === 'status') {
        requireMethod(req, 'GET')
        return Response.json(await service.status(providerId))
      }
      if (action === 'prepare') {
        requireMethod(req, 'POST')
        return Response.json(await service.prepare(providerId))
      }
      if (action === 'cancel') {
        requireMethod(req, 'POST')
        return Response.json(await service.cancel(providerId))
      }
      if (action === 'assets') {
        requireMethod(req, 'DELETE')
        return Response.json(await service.removeAssets(providerId))
      }
      throw ApiError.notFound(`Unknown voice provider endpoint: ${action}`)
    }

    if (sub === 'transcribe') {
      requireMethod(req, 'POST')
      const language = url.searchParams.get('language') ?? undefined
      if (language !== undefined && !isVoiceLanguage(language)) {
        throw ApiError.badRequest(`Unsupported language: ${language}`)
      }
      const wav = await readAudioBody(req)
      const transcript = await service.transcribe(
        url.searchParams.get('provider') ?? undefined,
        wav,
        language,
        req.signal,
      )
      return Response.json(transcript)
    }

    if (sub === 'correct' && segments.length === 3) {
      requireMethod(req, 'POST')
      const body = requireObject(await parseJsonBody(req))
      return Response.json(await service.correct(body.text, req.signal))
    }

    if (sub === 'vocabulary') {
      return await handleVocabulary(req, url, segments.slice(3), service)
    }

    throw ApiError.notFound(`Unknown voice endpoint: ${sub}`)
  } catch (error) {
    if (error instanceof VoiceServiceError) {
      return Response.json(error.toBody(), { status: error.status })
    }
    return errorResponse(error)
  }
}

async function handleVocabulary(
  req: Request,
  url: URL,
  rest: string[],
  service: VoiceService,
): Promise<Response> {
  const route = rest.join('/')
  const vocabulary = service.vocabulary

  if (route === '') {
    requireMethod(req, 'GET')
    return Response.json(await vocabulary.read())
  }

  if (route === 'terms') {
    if (req.method === 'POST') {
      const body = requireObject(await parseJsonBody(req))
      if (!Array.isArray(body.entries)) throw ApiError.badRequest('entries must be an array')
      if (body.source !== undefined && !isVoiceVocabularySource(body.source)) {
        throw ApiError.badRequest(`Unsupported source: ${String(body.source)}`)
      }
      if (body.dismiss !== undefined && !isStringArray(body.dismiss)) {
        throw ApiError.badRequest('dismiss must be an array of strings')
      }
      return Response.json(await vocabulary.add(body.entries.map(readEntry), {
        source: body.source,
        dismiss: body.dismiss,
      }))
    }
    if (req.method === 'PUT') {
      const body = requireObject(await parseJsonBody(req))
      if (typeof body.from !== 'string' || typeof body.term !== 'string') {
        throw ApiError.badRequest('from and term must be strings')
      }
      if (!isStringArray(body.aliases)) throw ApiError.badRequest('aliases must be an array of strings')
      return Response.json({
        vocabulary: await vocabulary.update(body.from, { term: body.term, aliases: body.aliases }),
      })
    }
    if (req.method === 'DELETE') {
      const term = url.searchParams.get('term')
      if (!term) throw ApiError.badRequest('term is required')
      return Response.json({ vocabulary: await vocabulary.remove(term) })
    }
    throw methodNotAllowed(req)
  }

  if (route === 'suggestions/dismiss') {
    requireMethod(req, 'POST')
    const body = requireObject(await parseJsonBody(req))
    if (typeof body.term !== 'string') throw ApiError.badRequest('term must be a string')
    return Response.json({ vocabulary: await vocabulary.dismissSuggestion(body.term) })
  }

  if (route === 'history/sources') {
    requireMethod(req, 'GET')
    return Response.json({ sources: await service.historySources() })
  }

  if (route === 'history/suggest') {
    requireMethod(req, 'POST')
    return Response.json(await service.suggestFromHistory(await parseJsonBody(req), req.signal))
  }

  throw ApiError.notFound(`Unknown voice vocabulary endpoint: ${route}`)
}

/** Entries that are not `{ term, aliases? }` still count, as skipped, in the add result. */
function readEntry(value: unknown): VoiceVocabularyInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { term: '' }
  const record = value as Record<string, unknown>
  return {
    term: typeof record.term === 'string' ? record.term : '',
    aliases: isStringArray(record.aliases) ? record.aliases : [],
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function requireObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw ApiError.badRequest('Request body must be a JSON object')
  }
  return value as Record<string, unknown>
}

/** A malformed `%` escape can never name a registered provider; answer 404 rather than throwing a URIError. */
function decodeProviderId(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    throw new VoiceServiceError('voice/unknown-provider', 'Unknown voice provider')
  }
}

/**
 * Reads the upload without buffering past the audio limit. The main server
 * accepts bodies far larger than a dictation clip, so the cap lives here.
 */
async function readAudioBody(req: Request): Promise<Uint8Array> {
  const max = VOICE_LIMITS.maxAudioBytes
  const tooLarge = () =>
    new VoiceServiceError('voice/invalid-audio', `Audio is too large (limit ${max} bytes)`)

  const declared = Number(req.headers.get('Content-Length'))
  if (Number.isFinite(declared) && declared > max) throw tooLarge()
  if (!req.body) throw new VoiceServiceError('voice/invalid-audio', 'Audio body is empty')

  const chunks: Uint8Array[] = []
  let total = 0
  const reader = req.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => {})
      throw tooLarge()
    }
    chunks.push(value)
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

async function parseJsonBody(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    throw ApiError.badRequest('Invalid JSON body')
  }
}

function methodNotAllowed(req: Request): ApiError {
  return new ApiError(405, `Method ${req.method} not allowed`, 'METHOD_NOT_ALLOWED')
}

function requireMethod(req: Request, method: string): void {
  if (req.method !== method) throw methodNotAllowed(req)
}
