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

// The server lists a lean session's commands after applying the runtime rule
// (`.claude/commands/*.md` arrive as sourceless `kind: 'command'` rows), so a
// listed name is available; the desktop only judges the rows it adds itself.
it('trusts the commands the lean session list offers', () => {
  const listed = new Set(['foo', 'review', 'help'])
  const legacy = { name: 'foo', description: '', kind: 'command' as const }
  expect(isLeanSlashCommand(legacy)).toBe(false)
  expect(isLeanSlashCommand(legacy, listed)).toBe(true)
  // A project command that shadows a desktop built-in is what the CLI runs.
  expect(isLeanSlashCommand({ name: 'review', description: '', kind: 'command' }, listed)).toBe(true)
  expect(isLeanSlashCommand({ name: 'review', description: '', kind: 'command' }, new Set(['foo']))).toBe(false)
  expect(isLeanSlashCommand({ name: 'help', description: '', source: 'project' }, listed)).toBe(true)
  // Agent shortcuts reach the Agent tool, which lean omits, whatever a list says.
  expect(isLeanSlashCommand({ name: 'agent reviewer', description: '', kind: 'agent' }, new Set(['agent reviewer']))).toBe(false)
  // The desktop's own lean built-ins stay available while the list is empty.
  expect(isLeanSlashCommand({ name: 'compact', description: '', kind: 'command' }, new Set())).toBe(true)
})

it('sends a listed custom command and still rejects what lean cannot run', () => {
  const listed = new Set(['foo', 'plan'])
  const commands = [{ name: 'foo', description: '', kind: 'command' as const }, { name: 'agent', description: '', kind: 'command' as const }]
  expect(isUnsupportedLeanSlashInput('/foo bar', commands)).toBe(true)
  expect(isUnsupportedLeanSlashInput('/foo bar', commands, listed)).toBe(false)
  // Listed without a row (the caller filtered it): the list still speaks for it.
  expect(isUnsupportedLeanSlashInput('/plan', commands, listed)).toBe(false)
  expect(isUnsupportedLeanSlashInput('/plan', commands, new Set(['foo']))).toBe(true)
  expect(isUnsupportedLeanSlashInput('/agent debug', commands, listed)).toBe(true)
  for (const text of ['/team build', '/workflow run', '/btw why']) {
    expect(isUnsupportedLeanSlashInput(text, commands, listed)).toBe(true)
  }
  // Unknown to every list (still loading, or the request failed): the runtime decides.
  expect(isUnsupportedLeanSlashInput('/foo bar', [], new Set())).toBe(false)
})
