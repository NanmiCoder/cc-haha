import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./print.ts', import.meta.url), 'utf8')

test('model metadata advertises Auto by feature instead of provider or model', () => {
  expect(source).not.toContain('modelSupportsAutoMode(resolvedModel)')
  expect(source).toContain(
    "const autoModeSupported = feature('TRANSCRIPT_CLASSIFIER') ? true : false",
  )
  expect(source).toContain('const hasAutoMode = autoModeSupported')
})

test('print mode routes teammate permission mailbox messages to the host instead of the model', () => {
  expect(source).toContain('partitionLeadMailboxMessages')
  expect(source).toContain('resolveTeammatePermissionRequests')
  expect(source).toContain('hostPermissionPromptAvailable')
  expect(source).not.toMatch(
    /formatted = unread\s*\.map/,
  )
})
