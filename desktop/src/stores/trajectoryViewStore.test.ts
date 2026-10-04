import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  TRAJECTORY_DETAIL_WIDTH_DEFAULT,
  TRAJECTORY_DETAIL_WIDTH_KEY,
  TRAJECTORY_DETAIL_WIDTH_MAX,
  TRAJECTORY_DETAIL_WIDTH_MIN,
  clampDetailWidth,
  useTrajectoryViewStore,
} from './trajectoryViewStore'

describe('trajectoryViewStore', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    localStorage.removeItem(TRAJECTORY_DETAIL_WIDTH_KEY)
    useTrajectoryViewStore.setState({ modes: {}, opened: {}, nav: null })
  })

  it('clamps the detail width and falls back to the default for garbage', () => {
    expect(clampDetailWidth(10)).toBe(TRAJECTORY_DETAIL_WIDTH_MIN)
    expect(clampDetailWidth(10_000)).toBe(TRAJECTORY_DETAIL_WIDTH_MAX)
    expect(clampDetailWidth(Number.NaN)).toBe(TRAJECTORY_DETAIL_WIDTH_DEFAULT)
  })

  it('persists the width, and keeps working when storage throws', () => {
    useTrajectoryViewStore.getState().setDetailWidth(500)
    expect(localStorage.getItem(TRAJECTORY_DETAIL_WIDTH_KEY)).toBe('500')
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
    expect(() => useTrajectoryViewStore.getState().setDetailWidth(600)).not.toThrow()
    expect(useTrajectoryViewStore.getState().detailWidth).toBe(600)
  })

  it('records that a session opened its trajectory only once it is shown', () => {
    const store = useTrajectoryViewStore.getState()
    store.setMode('s1', 'chat')
    expect(useTrajectoryViewStore.getState().opened.s1).toBeUndefined()
    store.setMode('s1', 'trajectory')
    store.setMode('s1', 'chat')
    expect(useTrajectoryViewStore.getState().opened.s1).toBe(true)
    expect(useTrajectoryViewStore.getState().modes.s1).toBe('chat')
  })

  it('consumes a navigation request only by its own nonce', () => {
    const store = useTrajectoryViewStore.getState()
    store.revealInChat('s1', { toolUseId: 'toolu_1' })
    const first = useTrajectoryViewStore.getState().nav!
    store.revealInChat('s1', { toolUseId: 'toolu_2' })
    // A late consumer of the first request must not drop the second.
    store.consumeNav(first.nonce)
    expect(useTrajectoryViewStore.getState().nav).toMatchObject({ target: { toolUseId: 'toolu_2' } })
  })
})
