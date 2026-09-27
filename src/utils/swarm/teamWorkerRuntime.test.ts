import { expect, test } from 'bun:test'
import { initialRuntimeEffort } from './teamWorkerRuntime.js'

test('worker model-default effort never reads a persisted high effort', () => {
  let reads = 0
  expect(initialRuntimeEffort(() => { reads++; return 'high' }, true)).toBeUndefined()
  expect(reads).toBe(0)
  expect(initialRuntimeEffort(() => 'high', false)).toBe('high')
})
