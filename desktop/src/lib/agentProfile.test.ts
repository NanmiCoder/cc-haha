import { expect, it } from 'vitest'
import { isLeanSlashCommand, isUnsupportedLeanSlashInput } from '@/lib/agentProfile'
it('keeps local inspection commands and excludes capabilities unavailable in lean', () => {
  expect(isLeanSlashCommand({ name: 'context', description: '' })).toBe(true)
  for (const name of ['btw', 'team', 'agent', 'workflow', 'unknown']) {
    expect(isLeanSlashCommand({ name, description: '' })).toBe(false)
  }
  expect(isLeanSlashCommand({ name: 'help', description: '', kind: 'skill' })).toBe(true)
  expect(isLeanSlashCommand({ name: 'help', description: '', source: 'project' })).toBe(false)
})

it('allows explicit skills and absolute paths while rejecting known unavailable commands', () => {
  const commands = [{ name: 'review', kind: 'skill' as const, description: '' }, { name: 'agent', description: '' }]
  expect(isUnsupportedLeanSlashInput('/review file.ts', commands)).toBe(false)
  expect(isUnsupportedLeanSlashInput('/tmp/cart.js fix this', commands)).toBe(false)
  expect(isUnsupportedLeanSlashInput('/README.md read this', commands)).toBe(false)
  expect(isUnsupportedLeanSlashInput('/unknown-skill', commands)).toBe(false)
  expect(isUnsupportedLeanSlashInput('/agent debug', commands)).toBe(true)
  expect(isUnsupportedLeanSlashInput('/btw why', commands)).toBe(true)
})
