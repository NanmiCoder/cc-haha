/**
 * PushNotificationService — JPush (极光推送) integration
 *
 * Sends push notifications to registered mobile devices via JPush REST API v3.
 * Device registration_ids are persisted to ~/.claude/mobile_devices.json.
 *
 * Configuration:
 *   JPUSH_APP_KEY       — from 极光控制台 → 应用设置 → AppKey
 *   JPUSH_MASTER_SECRET — from 极光控制台 → 应用设置 → Master Secret
 *   JPUSH_PRODUCTION    — set to '1' for production APNs (default: false/sandbox)
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MobileDevice {
  deviceToken: string   // JPush registration_id
  platform: 'ios' | 'android'
  registeredAt: string
}

export interface PushNotificationPayload {
  title: string
  body: string
  data?: Record<string, string>
}

// ─── Device storage ───────────────────────────────────────────────────────────

function devicesFilePath(): string {
  const configDir =
    process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  return path.join(configDir, 'mobile_devices.json')
}

function loadDevices(): MobileDevice[] {
  try {
    const raw = fs.readFileSync(devicesFilePath(), 'utf-8')
    return JSON.parse(raw) as MobileDevice[]
  } catch {
    return []
  }
}

function saveDevices(devices: MobileDevice[]): void {
  fs.mkdirSync(path.dirname(devicesFilePath()), { recursive: true })
  fs.writeFileSync(devicesFilePath(), JSON.stringify(devices, null, 2), 'utf-8')
}

// ─── JPush auth ───────────────────────────────────────────────────────────────

const JPUSH_API = 'https://api.jpush.cn/v3/push'

let _initialized = false
let _appKey = ''
let _masterSecret = ''

function getAuthHeader(): string {
  const encoded = btoa(`${_appKey}:${_masterSecret}`)
  return `Basic ${encoded}`
}

// ─── Public API ───────────────────────────────────────────────────────────────

class PushNotificationService {
  private devices: MobileDevice[] = []

  initialize(): void {
    if (_initialized) return

    _appKey = process.env.JPUSH_APP_KEY || ''
    _masterSecret = process.env.JPUSH_MASTER_SECRET || ''

    if (!_appKey || !_masterSecret) {
      // JPush not configured — service stays in no-op mode
      return
    }

    this.devices = loadDevices()
    _initialized = true
    const isProduction = process.env.JPUSH_PRODUCTION === '1'
    console.log(
      `[PushNotification] JPush initialized — ${this.devices.length} device(s), APNs: ${isProduction ? 'production' : 'sandbox'}`,
    )
  }

  isInitialized(): boolean {
    return _initialized
  }

  registerDevice(deviceToken: string, platform: 'ios' | 'android'): void {
    this.devices = this.devices.filter((d) => d.deviceToken !== deviceToken)
    this.devices.push({
      deviceToken,
      platform,
      registeredAt: new Date().toISOString(),
    })
    saveDevices(this.devices)

    if (_initialized) {
      console.log(
        `[PushNotification] Device registered: ${platform} (${this.devices.length} total)`,
      )
    }
  }

  unregisterDevice(deviceToken: string): void {
    const before = this.devices.length
    this.devices = this.devices.filter((d) => d.deviceToken !== deviceToken)
    if (this.devices.length < before) {
      saveDevices(this.devices)
    }
  }

  /**
   * Send push to all registered devices in a single JPush API call.
   * JPush supports up to 1000 registration_ids per request — we batch if needed.
   */
  async broadcastToAll(payload: PushNotificationPayload): Promise<void> {
    if (!_initialized || this.devices.length === 0) return
    if (!_appKey || !_masterSecret) return

    const isProduction = process.env.JPUSH_PRODUCTION === '1'
    const registrationIds = this.devices.map((d) => d.deviceToken)

    // Batch by 1000 (JPush limit)
    const BATCH_SIZE = 1000
    const batches: string[][] = []
    for (let i = 0; i < registrationIds.length; i += BATCH_SIZE) {
      batches.push(registrationIds.slice(i, i + BATCH_SIZE))
    }

    for (const batch of batches) {
      try {
        await this._sendBatch(batch, payload, isProduction)
      } catch (err) {
        console.error('[PushNotification] JPush batch send error:', err)
      }
    }
  }

  private async _sendBatch(
    registrationIds: string[],
    payload: PushNotificationPayload,
    isProduction: boolean,
  ): Promise<void> {
    const body = {
      platform: 'all' as const,
      audience: {
        registration_id: registrationIds,
      },
      notification: {
        android: {
          alert: payload.body,
          title: payload.title,
          channel_id: 'haha_tasks',
          extras: payload.data || {},
        },
        ios: {
          alert: {
            title: payload.title,
            body: payload.body,
          },
          sound: 'default',
          badge: '+1',
          extras: payload.data || {},
        },
      },
      options: {
        apns_production: isProduction,
        time_to_live: 86400, // 1 day
      },
    }

    const resp = await fetch(JPUSH_API, {
      method: 'POST',
      headers: {
        'Authorization': getAuthHeader(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      console.error(`[PushNotification] JPush send failed (${resp.status}):`, text)
      return
    }

    const result = (await resp.json()) as {
      sendno?: string
      msg_id?: string
      error?: { code?: number; message?: string }
    }

    if (result.error) {
      console.error(
        `[PushNotification] JPush error [${result.error.code}]: ${result.error.message}`,
      )
    }
  }

  getDevices(): ReadonlyArray<MobileDevice> {
    return this.devices
  }
}

export const pushNotificationService = new PushNotificationService()
