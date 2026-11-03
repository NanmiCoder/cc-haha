import { describe, expect, test } from 'bun:test'
import { parseMemberCommand, unsupportedMemberCommandReason } from './memberCommand.js'

describe('member commands', () => {
  test('a slash command is recognized by its name, whatever follows it', () => {
    expect(parseMemberCommand('/compact')).toEqual({ name: 'compact' })
    expect(parseMemberCommand('  /Compact keep the test results  ')).toEqual({ name: 'compact' })
    expect(parseMemberCommand('/review-pr 123')).toEqual({ name: 'review-pr' })
    expect(parseMemberCommand('/plugin:skill args')).toEqual({ name: 'plugin:skill' })
  })

  test('a message that only starts with a slash stays a message', () => {
    expect(parseMemberCommand('/tmp/out.log is empty, why?')).toBeNull()
    expect(parseMemberCommand('please run /compact')).toBeNull()
    expect(parseMemberCommand('/')).toBeNull()
    expect(parseMemberCommand('// TODO here')).toBeNull()
  })

  test('only commands that would undo the member are refused', () => {
    for (const name of ['clear', 'reset', 'new', 'model']) {
      expect(unsupportedMemberCommandReason({ name })).toBeString()
    }
    for (const name of ['compact', 'context', 'review-pr']) {
      expect(unsupportedMemberCommandReason({ name })).toBeUndefined()
    }
  })
})
