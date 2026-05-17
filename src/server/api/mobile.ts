/**
 * Mobile API handler — device registration, auth status, server info
 *
 * Provides endpoints for Flutter mobile app to:
 * - Register/unregister FCM device tokens for push notifications
 * - Validate API key
 * - Get server metadata
 */

import { pushNotificationService } from '../services/pushNotificationService.js'

type MobileRegisterRequest = {
  deviceToken: string
  platform: 'ios' | 'android'
}

export async function handleMobileApi(
  req: Request,
  url: URL,
  segments: string[],
): Promise<Response> {
  const subResource = segments[2]

  switch (req.method) {
    case 'POST': {
      if (subResource === 'register-device') {
        return handleRegisterDevice(req)
      }
      if (subResource === 'unregister-device') {
        return handleUnregisterDevice(req)
      }
      return Response.json(
        { error: 'Not Found' },
        { status: 404 },
      )
    }

    case 'GET': {
      if (subResource === 'auth-status') {
        return handleAuthStatus()
      }
      if (subResource === 'server-info') {
        return handleServerInfo()
      }
      return Response.json(
        { error: 'Not Found' },
        { status: 404 },
      )
    }

    default:
      return Response.json(
        { error: 'Method Not Allowed' },
        { status: 405 },
      )
  }
}

async function handleRegisterDevice(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as MobileRegisterRequest

    if (!body.deviceToken || typeof body.deviceToken !== 'string') {
      return Response.json(
        { error: 'Invalid request', message: 'deviceToken is required' },
        { status: 400 },
      )
    }

    if (body.platform !== 'ios' && body.platform !== 'android') {
      return Response.json(
        { error: 'Invalid request', message: 'platform must be "ios" or "android"' },
        { status: 400 },
      )
    }

    pushNotificationService.registerDevice(body.deviceToken, body.platform)

    return Response.json({ ok: true, message: 'Device registered' })
  } catch (err) {
    console.error('[Mobile] Failed to register device:', err)
    return Response.json(
      { error: 'Internal server error' },
      { status: 500 },
    )
  }
}

async function handleUnregisterDevice(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as { deviceToken: string }

    if (!body.deviceToken || typeof body.deviceToken !== 'string') {
      return Response.json(
        { error: 'Invalid request', message: 'deviceToken is required' },
        { status: 400 },
      )
    }

    pushNotificationService.unregisterDevice(body.deviceToken)

    return Response.json({ ok: true, message: 'Device unregistered' })
  } catch (err) {
    console.error('[Mobile] Failed to unregister device:', err)
    return Response.json(
      { error: 'Internal server error' },
      { status: 500 },
    )
  }
}

function handleAuthStatus(): Response {
  return Response.json({
    ok: true,
    authenticated: true,
    message: 'API key is valid',
  })
}

function handleServerInfo(): Response {
  const version = process.env.CLAUDE_CODE_VERSION || 'unknown'
  return Response.json({
    version,
    features: {
      pushNotifications: pushNotificationService.isInitialized(),
      scheduledTasks: true,
      sessions: true,
    },
    timestamp: new Date().toISOString(),
  })
}
