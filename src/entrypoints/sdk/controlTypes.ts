export type SDKControlRequest = unknown
export type SDKResultSuccess = { ok: true }
export type SDKResultFailure = { ok: false; error: string }
export type SDKResult = SDKResultSuccess | SDKResultFailure