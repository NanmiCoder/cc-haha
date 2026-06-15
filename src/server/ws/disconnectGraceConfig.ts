/**
 * Cached disconnect grace period (issue #764).
 *
 * The WebSocket `close` handler runs synchronously, but the configured grace
 * period lives in managed settings (async disk read). We cache the resolved
 * value here so the hot path stays synchronous, and refresh the cache at
 * server startup and whenever the H5 access settings are updated.
 */
import { H5AccessService, DEFAULT_DISCONNECT_GRACE_MS } from '../services/h5AccessService.js'

let cachedGraceMs = DEFAULT_DISCONNECT_GRACE_MS
const h5AccessService = new H5AccessService()

/** Synchronous accessor for the disconnect cleanup grace period, in ms. */
export function getDisconnectGraceMs(): number {
  return cachedGraceMs
}

/** Reload the cached grace period from managed settings. Best-effort. */
export async function refreshDisconnectGraceMs(): Promise<number> {
  try {
    cachedGraceMs = await h5AccessService.getDisconnectGraceMs()
  } catch {
    // Keep the previous (or default) value on read failure.
  }
  return cachedGraceMs
}

/** Test hook: override the cached value directly. */
export function __setDisconnectGraceMsForTests(value: number): void {
  cachedGraceMs = value
}

/** Test hook: reset to the built-in default. */
export function __resetDisconnectGraceMsForTests(): void {
  cachedGraceMs = DEFAULT_DISCONNECT_GRACE_MS
}
