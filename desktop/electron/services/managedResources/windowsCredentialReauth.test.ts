import { describe, expect, it } from 'vitest'
import {
  createWindowsCredentialRevealAuthorizer,
  WINDOWS_PASSWORD_REAUTH_SCRIPT,
} from './windowsCredentialReauth.js'

describe('Windows credential reveal re-authentication', () => {
  it('fails closed outside Windows without launching a prompt', async () => {
    let called = false
    const authorizer = createWindowsCredentialRevealAuthorizer({
      platform: 'linux',
      runPrompt: async () => {
        called = true
        return 'AUTHORIZED'
      },
    })

    await expect(authorizer.authorize()).resolves.toEqual({ status: 'unavailable' })
    expect(called).toBe(false)
  })

  it.each([
    ['AUTHORIZED', 'authorized'],
    ['CANCELLED', 'cancelled'],
    ['DENIED', 'denied'],
    ['UNAVAILABLE', 'unavailable'],
    ['unexpected-output', 'unavailable'],
  ] as const)('maps native helper result %s without exposing a password', async (nativeResult, status) => {
    let capturedScript = ''
    const authorizer = createWindowsCredentialRevealAuthorizer({
      platform: 'win32',
      runPrompt: async script => {
        capturedScript = script
        return nativeResult
      },
    })

    await expect(authorizer.authorize()).resolves.toEqual({ status })
    expect(capturedScript).toBe(WINDOWS_PASSWORD_REAUTH_SCRIPT)
  })

  it('pins the system dialog to the current user, forbids persistence, and validates through LogonUser network logon', () => {
    expect(WINDOWS_PASSWORD_REAUTH_SCRIPT).toContain('CREDUI_FLAGS_KEEP_USERNAME')
    expect(WINDOWS_PASSWORD_REAUTH_SCRIPT).toContain('CREDUI_FLAGS_PASSWORD_ONLY_OK')
    expect(WINDOWS_PASSWORD_REAUTH_SCRIPT).toContain('CREDUI_FLAGS_DO_NOT_PERSIST')
    expect(WINDOWS_PASSWORD_REAUTH_SCRIPT).toContain('LogonUserW')
    expect(WINDOWS_PASSWORD_REAUTH_SCRIPT).toContain('LOGON32_LOGON_NETWORK = 3')
    expect(WINDOWS_PASSWORD_REAUTH_SCRIPT).toContain("password[i] = '\\0'")
    expect(WINDOWS_PASSWORD_REAUTH_SCRIPT).not.toContain('Write-Host $password')
  })
})
