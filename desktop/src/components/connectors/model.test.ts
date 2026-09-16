import { describe, expect, it } from 'vitest'
import { hasStoredCredentials, primaryAction, safeConnectorUrl } from './model'
import type { ConnectorDto } from '@/types/connector'
const connector = { supported: true, installed: true, runtime: 'ready', status: 'needs-auth', connection: 'needs-auth' } as ConnectorDto

describe('connector actions', () => {
  it('requires authentication instead of claiming an installed connector is ready', () => {
    expect(primaryAction(connector)).toBe('authenticate')
    expect(primaryAction({ ...connector, installed: false })).toBe('prepare')
    expect(primaryAction({ ...connector, supported: false })).toBeNull()
    expect(primaryAction({ ...connector, operation: { id: 'x', kind: 'authenticate', phase: 'waiting', startedAt: '' } })).toBeNull()
  })
  it('does not mistake a negative remote check or stale account label for stored credentials', () => {
    expect(hasStoredCredentials(connector)).toBe(false)
    expect(hasStoredCredentials({ ...connector, status: 'error', connection: 'needs-auth' })).toBe(false)
    expect(hasStoredCredentials({ ...connector, connection: 'connected' })).toBe(true)
    expect(hasStoredCredentials({ ...connector, status: 'ready' })).toBe(true)
    expect(hasStoredCredentials({ ...connector, status: 'configured' })).toBe(true)
    expect(hasStoredCredentials({ ...connector, verification: 'remote' })).toBe(false)
    expect(hasStoredCredentials({ ...connector, accountLabel: 'Existing account' })).toBe(false)
  })
  it('rejects executable and malformed authorization links', () => {
    expect(safeConnectorUrl('javascript:alert(1)')).toBeNull()
    expect(safeConnectorUrl('file:///private/file')).toBeNull()
    expect(safeConnectorUrl('bad')).toBeNull()
    expect(safeConnectorUrl('https://example.test/auth')).toBe('https://example.test/auth')
  })
})

it('follows prepared and deactivated service DTOs even while runtime registration is missing', () => {
  // prepare installs files before runtime registration; runtime=missing does not mean uninstalled.
  const prepared = { ...connector, installed: true, runtime: 'missing', status: 'needs-auth', connection: 'needs-auth' } as ConnectorDto
  expect(primaryAction(prepared)).toBe('authenticate')
  expect(primaryAction({ ...prepared, status: 'configured', connection: 'connected' })).toBeNull()
  expect(primaryAction({ ...prepared, status: 'ready', connection: 'connected' })).toBeNull()
  expect(primaryAction({ ...prepared, status: 'disabled', enabled: false })).toBe('check')
  expect(primaryAction({ ...prepared, status: 'error', failedPhase: 'downloading' })).toBe('prepare')
  expect(primaryAction({ ...prepared, status: 'error', failedPhase: 'awaiting-authorization' })).toBe('authenticate')
  expect(primaryAction({ ...prepared, status: 'error', failedPhase: 'check' })).toBe('check')
})

it('offers an update for an installed older connector without hiding active operations', () => {
  const outdated = { ...connector, status: 'ready', connection: 'connected', installedVersion: '1', version: '2', updateAvailable: true } as ConnectorDto
  expect(primaryAction(outdated)).toBe('prepare')
  expect(primaryAction({ ...outdated, operation: { id: 'update', kind: 'prepare', phase: 'downloading', startedAt: '' } })).toBeNull()
})

it('loads tool skills without requesting service authentication, including stale authorization errors', () => {
  const tool = { ...connector, collection: 'tools', transport: 'skills' } as ConnectorDto
  expect(primaryAction(tool)).toBe('check')
  expect(primaryAction({ ...tool, status: 'error', failedPhase: 'awaiting-authorization' })).toBe('check')
  expect(primaryAction({ ...tool, status: 'error', failedPhase: 'downloading' })).toBe('prepare')
  expect(primaryAction({ ...tool, status: 'configured', enabled: true })).toBeNull()
  expect(primaryAction({ ...tool, status: 'disabled', enabled: false })).toBe('check')
})
