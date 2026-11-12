import { describe, expect, it } from 'bun:test'
import {
  formatPermissionDecisionStatus,
  formatPermissionInstructions,
  parsePermissionCommand,
  parsePermitCallbackData,
} from '../permission.js'

describe('permission helpers', () => {
  it('parses text permission commands', () => {
    expect(parsePermissionCommand('/allow req-1')).toEqual({ requestId: 'req-1', allowed: true })
    expect(parsePermissionCommand('/always req-2')).toEqual({ requestId: 'req-2', allowed: true, rule: 'always' })
    expect(parsePermissionCommand('/allow-always req-3')).toEqual({ requestId: 'req-3', allowed: true, rule: 'always' })
    expect(parsePermissionCommand('/deny req-4')).toEqual({ requestId: 'req-4', allowed: false })
  })

  it('parses short replies when one permission is pending', () => {
    const pending = new Set(['req-1'])
    expect(parsePermissionCommand('1', pending)).toEqual({ requestId: 'req-1', allowed: true })
    expect(parsePermissionCommand('2', pending)).toEqual({ requestId: 'req-1', allowed: true, rule: 'always' })
    expect(parsePermissionCommand('3', pending)).toEqual({ requestId: 'req-1', allowed: false })
    expect(parsePermissionCommand('/always', pending)).toEqual({ requestId: 'req-1', allowed: true, rule: 'always' })
    expect(parsePermissionCommand('永久允许', pending)).toEqual({ requestId: 'req-1', allowed: true, rule: 'always' })
  })

  it('does not parse short replies when multiple permissions are pending', () => {
    expect(parsePermissionCommand('1', new Set(['req-1', 'req-2']))).toBeNull()
  })

  it('parses callback permission actions', () => {
    expect(parsePermitCallbackData('permit:req-1:yes')).toEqual({ requestId: 'req-1', allowed: true })
    expect(parsePermitCallbackData('permit:req-2:always')).toEqual({ requestId: 'req-2', allowed: true, rule: 'always' })
    expect(parsePermitCallbackData('permit:req-3:no')).toEqual({ requestId: 'req-3', allowed: false })
    expect(parsePermitCallbackData('permit:req-4:unknown')).toBeNull()
  })

  it('formats text fallback and status labels', () => {
    expect(formatPermissionInstructions('req-1')).toContain('Reply 1')
    expect(formatPermissionInstructions('req-1')).toContain('/always req-1')
    expect(formatPermissionDecisionStatus({ allowed: true, rule: 'always' })).toContain('Always allowed')
    expect(formatPermissionDecisionStatus({ allowed: false })).toContain('Denied')
  })
  it('uses only numeric instructions for one pending request and explicit commands for multiple', () => {
    expect(formatPermissionInstructions('req-1', { pendingCount: 1 })).toBe('Reply 1 to allow once, 2 to always allow, 3 to deny.')
    const multiple = formatPermissionInstructions('req-2', { pendingCount: 2 })
    expect(multiple).toContain('Multiple approval requests')
    expect(multiple).not.toContain('Reply 1')
    for (const action of ['allow', 'always', 'deny']) expect(multiple).toContain(`/${action} req-2`)
  })
})
