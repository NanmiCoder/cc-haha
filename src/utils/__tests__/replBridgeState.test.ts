import { afterEach, describe, expect, test } from 'bun:test'
import {
  isReplBridgeActive,
  resetStateForTests,
  setReplBridgeActive,
} from '../../bootstrap/state.js'

afterEach(() => {
  resetStateForTests()
})

describe('REPL bridge bootstrap state', () => {
  test('tracks inbound-control bridge activity explicitly', () => {
    expect(isReplBridgeActive()).toBe(false)

    setReplBridgeActive(true)

    expect(isReplBridgeActive()).toBe(true)
  })
})
