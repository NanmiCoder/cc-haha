import { describe, expect, it } from 'bun:test'
import { normalizeOsPermissions } from './permissions.js'

describe('normalizeOsPermissions', () => {
  it('treats explicit grants as granted', () => {
    expect(
      normalizeOsPermissions({ accessibility: true, screenRecording: true }),
    ).toEqual({
      granted: true,
      accessibility: true,
      screenRecording: true,
    })
  })

  it('treats screen recording unknown as non-blocking when accessibility is granted', () => {
    expect(
      normalizeOsPermissions({ accessibility: true, screenRecording: null }),
    ).toEqual({
      granted: true,
      accessibility: true,
      screenRecording: true,
    })
  })

  it('still blocks when accessibility is missing', () => {
    expect(
      normalizeOsPermissions({ accessibility: false, screenRecording: null }),
    ).toEqual({
      granted: false,
      accessibility: false,
      screenRecording: true,
    })
  })

  it('blocks when screen recording is explicitly denied', () => {
    expect(
      normalizeOsPermissions({ accessibility: true, screenRecording: false }),
    ).toEqual({
      granted: false,
      accessibility: true,
      screenRecording: false,
    })
  })
})
