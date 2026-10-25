import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { sessionsApi } from '@/api/sessions'
import { useSessionUltracode } from './useSessionUltracode'

afterEach(() => vi.restoreAllMocks())
const off = { enabled: false, active: false, available: true, running: true, effort: 'low', model: 'claude-haiku-5-5' }
it('reads live mode across remounts and resets to off when the process restarts', async () => {
  const get = vi.spyOn(sessionsApi, 'getUltracode').mockResolvedValue({ ...off, enabled: true, active: true })
  const { result, rerender } = renderHook(({ refresh }) => useSessionUltracode('chat', refresh, true), { initialProps: { refresh: 'running' } })
  await waitFor(() => expect(result.current.state?.enabled).toBe(true))
  get.mockResolvedValue({ ...off, running: false })
  rerender({ refresh: 'restarted' })
  await waitFor(() => expect(result.current.state?.enabled).toBe(false))
})
it('updates only after native acknowledgement and preserves the last good state on failure', async () => {
  vi.spyOn(sessionsApi, 'getUltracode').mockResolvedValue(off)
  const put = vi.spyOn(sessionsApi, 'setUltracode').mockRejectedValue(new Error('Not supported'))
  const { result } = renderHook(() => useSessionUltracode('chat', 'idle', true))
  await waitFor(() => expect(result.current.state).toEqual(off))
  await act(() => result.current.setEnabled(true))
  expect(put).toHaveBeenCalledWith('chat', true)
  expect(result.current.state?.enabled).toBe(false)
  expect(result.current.error).toBe('Not supported')
})
it('discards an old session toggle response after switching chats', async () => {
  vi.spyOn(sessionsApi, 'getUltracode').mockResolvedValue(off)
  let finish!: (value: typeof off) => void
  vi.spyOn(sessionsApi, 'setUltracode').mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const { result, rerender } = renderHook(({ id }) => useSessionUltracode(id, 'idle', true), { initialProps: { id: 'first' } })
  await waitFor(() => expect(result.current.state).toEqual(off))
  let update!: Promise<void>
  act(() => { update = result.current.setEnabled(true) })
  rerender({ id: 'second' })
  await waitFor(() => expect(result.current.state).toEqual(off))
  await act(async () => { finish({ ...off, enabled: true, active: true }); await update })
  expect(result.current.state?.enabled).toBe(false)
})
it('discards a toggle from an earlier visit when returning to the same chat', async () => {
  const get = vi.spyOn(sessionsApi, 'getUltracode').mockResolvedValue(off)
  let finish!: (value: typeof off) => void
  vi.spyOn(sessionsApi, 'setUltracode').mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const { result, rerender } = renderHook(({ id }) => useSessionUltracode(id, 'idle', true), { initialProps: { id: 'first' } })
  await waitFor(() => expect(result.current.state).toEqual(off))
  let update!: Promise<void>
  act(() => { update = result.current.setEnabled(true) })
  rerender({ id: 'second' })
  await waitFor(() => expect(result.current.state).toEqual(off))
  rerender({ id: 'first' })
  await waitFor(() => expect(get).toHaveBeenCalledTimes(3))
  await waitFor(() => expect(result.current.state).toEqual(off))

  // The native process may have restarted while this chat was hidden. The
  // fresh read must win over the acknowledgement from the previous visit.
  await act(async () => { finish({ ...off, enabled: true, active: true }); await update })
  expect(result.current.state).toEqual(off)
})
it('never queries draft, non SDK, or missing session controls', () => {
  const get = vi.spyOn(sessionsApi, 'getUltracode')
  renderHook(() => useSessionUltracode(undefined, 'idle', true))
  expect(get).not.toHaveBeenCalled()
})
