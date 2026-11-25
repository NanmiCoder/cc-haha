import { serveFileWithRange } from './previewFs.js'
import {
  getMobileUpdateService,
  MOBILE_UPDATE_HEADER,
  MobileUpdateService,
  MobileUpdateServiceError,
} from '../services/mobileUpdateService.js'

const SHA256_RE = /^[a-f0-9]{64}$/

function jsonWithMarker(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      [MOBILE_UPDATE_HEADER]: '1',
      'Cache-Control': 'no-store',
    },
  })
}

function stripRangeIfEtagMismatch(headers: Headers, expectedEtag: string): Headers {
  const ifRange = headers.get('if-range')?.trim()
  if (!ifRange || ifRange === expectedEtag) return headers
  const next = new Headers(headers)
  next.delete('range')
  return next
}

function parseOptionalSha256(url: URL): { ok: true; value: string | undefined } | { ok: false; response: Response } {
  const keys = [...url.searchParams.keys()]
  if (keys.some(key => key !== 'sha256')) {
    return { ok: false, response: jsonWithMarker({ error: 'Unexpected query parameter', code: 'INVALID_QUERY' }, 400) }
  }
  const shaValues = url.searchParams.getAll('sha256')
  if (shaValues.length > 1) {
    return { ok: false, response: jsonWithMarker({ error: 'Duplicate sha256 parameter', code: 'INVALID_QUERY' }, 400) }
  }
  const expectedSha256 = shaValues[0]
  if (expectedSha256 !== undefined && !SHA256_RE.test(expectedSha256)) {
    return { ok: false, response: jsonWithMarker({ error: 'Invalid sha256 parameter', code: 'INVALID_QUERY' }, 400) }
  }
  return { ok: true, value: expectedSha256 }
}

export async function handleMobileUpdateApi(
  req: Request,
  url: URL,
  segments: string[],
  service: MobileUpdateService = getMobileUpdateService(),
): Promise<Response> {
  if (segments.length !== 4 || segments[1] !== 'mobile-update' || segments[2] !== 'android') {
    return jsonWithMarker({ error: 'Not Found', code: 'NOT_FOUND' }, 404)
  }
  const action = segments[3]
  if (action !== 'latest' && action !== 'prepare' && action !== 'apk') {
    return jsonWithMarker({ error: 'Not Found', code: 'NOT_FOUND' }, 404)
  }

  if (action === 'prepare') {
    if (req.method !== 'GET' && req.method !== 'POST') {
      return jsonWithMarker({ error: 'Method Not Allowed', code: 'METHOD_NOT_ALLOWED' }, 405)
    }
  } else if (req.method !== 'GET') {
    return jsonWithMarker({ error: 'Method Not Allowed', code: 'METHOD_NOT_ALLOWED' }, 405)
  }

  try {
    if (action === 'latest') {
      const keys = [...url.searchParams.keys()]
      if (keys.some(key => key !== 'refresh')) {
        return jsonWithMarker({ error: 'Unexpected query parameter', code: 'INVALID_QUERY' }, 400)
      }
      const refreshValues = url.searchParams.getAll('refresh')
      if (refreshValues.length > 1 || (refreshValues.length === 1 && refreshValues[0] !== '1')) {
        return jsonWithMarker({ error: 'Invalid refresh parameter', code: 'INVALID_QUERY' }, 400)
      }
      const result = await service.getLatestManifest({
        refresh: refreshValues[0] === '1',
        signal: req.signal,
      })
      return jsonWithMarker(result, 200)
    }

    const shaParam = parseOptionalSha256(url)
    if (!shaParam.ok) return shaParam.response

    if (action === 'prepare') {
      const result = await service.prepareApk({
        expectedSha256: shaParam.value,
        start: req.method === 'POST',
        signal: req.signal,
      })
      return jsonWithMarker(result, 200)
    }

    const resolved = await service.ensureApkFile({
      expectedSha256: shaParam.value,
      signal: req.signal,
    })
    const etag = `"${resolved.manifest.sha256}"`
    const effectiveHeaders = stripRangeIfEtagMismatch(req.headers, etag)

    const response = await serveFileWithRange(resolved.filePath, effectiveHeaders, {
      'Content-Type': 'application/vnd.android.package-archive',
      'ETag': etag,
      'X-Android-Update-Sha256': resolved.manifest.sha256,
      'Content-Disposition': `attachment; filename="${resolved.manifest.asset}"`,
      [MOBILE_UPDATE_HEADER]: '1',
    })
    if (response.status === 404) {
      // Cache file could be pruned between ensureApkFile and statSync; always
      // carry the relay marker so the phone never misclassifies it as an old desktop.
      return jsonWithMarker({ error: 'Cached APK disappeared, please retry', code: 'UPSTREAM_UNREACHABLE' }, 502)
    }
    return response
  } catch (error) {
    if (error instanceof MobileUpdateServiceError) {
      return jsonWithMarker(
        {
          error: error.message,
          code: error.code,
          ...(error.manifest ? { manifest: error.manifest } : {}),
        },
        error.status,
      )
    }
    return jsonWithMarker({ error: 'Mobile update request failed', code: 'UPSTREAM_UNREACHABLE' }, 502)
  }
}
