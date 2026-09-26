import { afterEach, describe, expect, test } from 'bun:test'
import {
  addToTotalGenerationDuration,
  getTotalDecodeDuration,
  getTotalTimedOutputTokens,
  resetTotalDurationStateAndCost_FOR_TESTS_ONLY,
} from './state.js'

afterEach(() => {
  resetTotalDurationStateAndCost_FOR_TESTS_ONLY()
})

describe('session generation timing pairs its span with the tokens it covered', () => {
  test('counts a call that reported a span', () => {
    addToTotalGenerationDuration(2_000, 300, 250)

    expect(getTotalDecodeDuration()).toBe(2_000)
    expect(getTotalTimedOutputTokens()).toBe(250)
  })

  test('a call with no span contributes time to neither side', () => {
    // A non-streamed fallback reports its usage but never opened a decode span. Its tokens still
    // reach the session totals, so recording them as "timed" would restore exactly the pairing
    // bug the counter exists to prevent: 6044 tok/s for an engine running ~120.
    addToTotalGenerationDuration(0, 0, 9_000)

    expect(getTotalDecodeDuration()).toBe(0)
    expect(getTotalTimedOutputTokens()).toBe(0)
  })

  test('accumulates across calls', () => {
    addToTotalGenerationDuration(1_000, 100, 100)
    addToTotalGenerationDuration(3_000, 200, 300)
    addToTotalGenerationDuration(0, 0, 5_000)

    expect(getTotalDecodeDuration()).toBe(4_000)
    expect(getTotalTimedOutputTokens()).toBe(400)
  })
})
