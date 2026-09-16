import { beforeEach, describe, expect, it } from 'vitest'
import { useOverlayStore } from './overlayStore'

const reset = () => {
  useOverlayStore.setState(useOverlayStore.getInitialState(), true)
}

describe('overlayStore', () => {
  beforeEach(reset)

  it('starts at count 0', () => {
    expect(useOverlayStore.getState().count).toBe(0)
  })

  it('tracks snapshot overlays separately so ordinary modals keep immediate hiding', () => {
    const { push, pop } = useOverlayStore.getState()
    push(true)
    push()
    expect(useOverlayStore.getState()).toMatchObject({ count: 2, snapshotCount: 1 })
    pop()
    expect(useOverlayStore.getState()).toMatchObject({ count: 1, snapshotCount: 1 })
    pop(true)
    expect(useOverlayStore.getState()).toMatchObject({ count: 0, snapshotCount: 0 })
  })

  it('push increments by 1', () => {
    useOverlayStore.getState().push()
    expect(useOverlayStore.getState().count).toBe(1)
    useOverlayStore.getState().push()
    expect(useOverlayStore.getState().count).toBe(2)
  })

  it('pop decrements by 1', () => {
    const { push, pop } = useOverlayStore.getState()
    push()
    push()
    pop()
    expect(useOverlayStore.getState().count).toBe(1)
  })

  it('pop at 0 stays clamped at 0', () => {
    useOverlayStore.getState().pop()
    expect(useOverlayStore.getState().count).toBe(0)
    useOverlayStore.getState().pop()
    expect(useOverlayStore.getState().count).toBe(0)
  })

  it('balances pushes and pops back to 0', () => {
    const { push, pop } = useOverlayStore.getState()
    push(); push(); push()
    expect(useOverlayStore.getState().count).toBe(3)
    pop(); pop(); pop()
    expect(useOverlayStore.getState().count).toBe(0)
    // extra pop is still clamped
    pop()
    expect(useOverlayStore.getState().count).toBe(0)
  })
})
