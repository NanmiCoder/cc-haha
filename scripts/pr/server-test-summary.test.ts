import { expect, test } from 'bun:test'
import { readServerTestSummary } from './server-test-summary'

test('recognizes a completed platform-skipped file without counting it as passing tests', () => {
  expect(readServerTestSummary(' 0 pass\n 2 skip\n 0 fail\nRan 2 tests across 1 file. [1s]', 0))
    .toEqual({ passedTests: 0, skippedTests: 2, failedTests: 0, evidenceComplete: true })
})

test('requires completed, nonempty discovery and a successful exit', () => {
  expect(readServerTestSummary('No tests found', 0).evidenceComplete).toBe(false)
  expect(readServerTestSummary(' 0 pass\n 0 fail\nRan 0 tests across 1 file.', 0).evidenceComplete).toBe(false)
  expect(readServerTestSummary(' 1 pass\n 0 fail\n', 0).evidenceComplete).toBe(false)
  expect(readServerTestSummary(' 1 pass\n 0 fail\nRan 1 test across 1 file.', 139).evidenceComplete).toBe(false)
  expect(readServerTestSummary(' 1 pass\n 1 fail\nRan 2 tests across 1 file.', 0).evidenceComplete).toBe(false)
  expect(readServerTestSummary(' 2 pass\n 0 fail\nRan 2 tests across 2 files.', 0).evidenceComplete).toBe(false)
})

test('retains independent pass and skip counts', () => {
  expect(readServerTestSummary(' 3 pass\n 1 skip\n 0 fail\nRan 4 tests across 1 file.', 0))
    .toEqual({ passedTests: 3, skippedTests: 1, failedTests: 0, evidenceComplete: true })
})
