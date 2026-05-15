// Web SaaS single-user mode: authentication is intentionally disabled.
// The deployment is expected to be reachable only by its operator.

export async function requireAuth(): Promise<Response | null> {
  return null
}

export async function requireH5Token(): Promise<Response | null> {
  return null
}

export async function validateRequestAuth(): Promise<{ valid: boolean }> {
  return { valid: true }
}

export function validateAuth(): { valid: boolean } {
  return { valid: true }
}
