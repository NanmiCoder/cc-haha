import { renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  isMobileH5Available,
  MOBILE_H5_MARKER_PATH,
  phoneAppCanAuthenticate,
  servesItsOwnServer,
  useMobileH5Handoff,
} from './mobileH5Handoff'

function marker(body: unknown, { ok = true, type = 'application/json; charset=utf-8' } = {}) {
  return vi.fn(async () => ({
    ok,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? type : null) },
    json: async () => body,
  }))
}

describe('isMobileH5Available', () => {
  it('trusts only the marker the phone build writes', async () => {
    const fetchMarker = marker({ app: 'cc-haha-mobile', version: '0.1.2' })
    expect(await isMobileH5Available(fetchMarker)).toBe(true)
    expect(fetchMarker).toHaveBeenCalledWith(MOBILE_H5_MARKER_PATH, { cache: 'no-store', credentials: 'same-origin' })
  })

  it('treats a dev server index page, a 404 or another JSON as no phone build', async () => {
    expect(await isMobileH5Available(marker('<!doctype html>', { type: 'text/html' }))).toBe(false)
    expect(await isMobileH5Available(marker({ app: 'cc-haha-mobile' }, { ok: false }))).toBe(false)
    expect(await isMobileH5Available(marker({ app: 'something-else' }))).toBe(false)
    expect(await isMobileH5Available(vi.fn(async () => { throw new TypeError('offline') }))).toBe(false)
  })
})

describe('servesItsOwnServer', () => {
  it('hands off only when the page and its API are the same computer', () => {
    expect(servesItsOwnServer('http://192.168.1.8:3456', 'http://192.168.1.8:3456')).toBe(true)
    expect(servesItsOwnServer('http://192.168.1.8:3456/', 'http://192.168.1.8:3456')).toBe(true)
    expect(servesItsOwnServer('http://192.168.1.9:3456', 'http://192.168.1.8:3456')).toBe(false)
    expect(servesItsOwnServer('not a url', 'http://192.168.1.8:3456')).toBe(false)
  })
})

describe('phoneAppCanAuthenticate', () => {
  const pageOrigin = 'http://192.168.1.8:3456'

  it('requires the LAN token to be readable from this origin\'s storage', () => {
    expect(phoneAppCanAuthenticate({
      storagePersistent: true,
      authToken: 'h5_token',
      stored: { serverUrl: 'http://192.168.1.8:3456', token: 'h5_token' },
      pageOrigin,
    })).toBe(true)
    // Storage blocked or full: the token only lives in this page's memory.
    expect(phoneAppCanAuthenticate({ storagePersistent: true, authToken: 'h5_token', stored: { serverUrl: null, token: null }, pageOrigin })).toBe(false)
    // An older token, or one paired with another server.
    expect(phoneAppCanAuthenticate({
      storagePersistent: true,
      authToken: 'h5_token',
      stored: { serverUrl: 'http://192.168.1.8:3456', token: 'h5_old' },
      pageOrigin,
    })).toBe(false)
    expect(phoneAppCanAuthenticate({
      storagePersistent: true,
      authToken: 'h5_token',
      stored: { serverUrl: 'http://192.168.1.9:3456', token: 'h5_token' },
      pageOrigin,
    })).toBe(false)
  })

  it('needs nothing stored for the remote device cookie or a loopback page', () => {
    expect(phoneAppCanAuthenticate({ storagePersistent: true, authToken: null, stored: { serverUrl: null, token: null }, pageOrigin })).toBe(true)
  })

  it('never hands over from a browser that denied web storage, whatever this page holds in memory', () => {
    // index.html swapped in an in-memory storage: the token reads back here, but the phone app is a new page.
    const stored = { serverUrl: 'http://192.168.1.8:3456', token: 'h5_token' }
    expect(phoneAppCanAuthenticate({ storagePersistent: false, authToken: 'h5_token', stored, pageOrigin })).toBe(false)
    expect(phoneAppCanAuthenticate({ storagePersistent: false, authToken: null, stored, pageOrigin })).toBe(false)
  })
})

describe('useMobileH5Handoff', () => {
  const origin = window.location.origin
  const serverUrl = () => origin

  it('leaves for the phone app once the connection is ready and the build is there', async () => {
    const leave = vi.fn()
    const available = vi.fn(async () => true)
    const { result, rerender } = renderHook(
      ({ ready }) => useMobileH5Handoff({ ready, eligible: () => true, serverUrl, available, leave }),
      { initialProps: { ready: false } },
    )
    // Not before the H5 token page or remote pairing has finished.
    expect(available).not.toHaveBeenCalled()
    rerender({ ready: true })
    await waitFor(() => expect(result.current).toBe('leaving'))
    expect(leave).toHaveBeenCalledTimes(1)
  })

  it('decides once: a desktop window narrowed later stays in this app', async () => {
    const leave = vi.fn()
    const available = vi.fn(async () => true)
    let phoneLayout = false
    // Fresh callbacks on every render, as AppShell passes them.
    const { result, rerender } = renderHook(() =>
      useMobileH5Handoff({
        ready: true,
        eligible: () => phoneLayout,
        serverUrl: () => origin,
        available: () => available(),
        leave: () => leave(),
      }),
    )
    await waitFor(() => expect(result.current).toBe('unavailable'))
    // The window is dragged below the phone breakpoint mid-use.
    phoneLayout = true
    rerender()
    rerender()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(result.current).toBe('unavailable')
    expect(available).not.toHaveBeenCalled()
    expect(leave).not.toHaveBeenCalled()
  })

  it('keeps the built-in phone shell when the phone app is not served', async () => {
    const leave = vi.fn()
    const { result } = renderHook(() =>
      useMobileH5Handoff({ ready: true, eligible: () => true, serverUrl, available: async () => false, leave }),
    )
    await waitFor(() => expect(result.current).toBe('unavailable'))
    expect(leave).not.toHaveBeenCalled()
  })

  it('never leaves a page that talks to a different server', async () => {
    const leave = vi.fn()
    const available = vi.fn(async () => true)
    const { result } = renderHook(() =>
      useMobileH5Handoff({ ready: true, eligible: () => true, serverUrl: () => 'http://10.0.0.2:3456', available, leave }),
    )
    await waitFor(() => expect(result.current).toBe('unavailable'))
    expect(available).not.toHaveBeenCalled()
    expect(leave).not.toHaveBeenCalled()
  })
})
