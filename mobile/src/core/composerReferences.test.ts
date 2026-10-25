import { parseUserMessageSegments } from '../../../src/shared/userMessageCapabilities'
import { describe, expect, test } from 'bun:test'
import type { ApiClient } from './client'
import { composerTrigger, insertComposerCandidate, loadComposerCandidates, mergeComposerReferences, serializeComposer, type ComposerReference } from './composerReferences'
import { buildComposerMessage } from './chatComposer'
import { clearPendingTask, peekPendingTask, pendingTaskDraft, putPendingTask } from './pendingTask'

const skill: ComposerReference = { kind: 'skill', id: 'project:review', name: 'review', displayName: '代码审查', description: '检查代码', modelText: 'Use the Skill tool with skill: "review" for this request.' }

describe('native composer references', () => {
  test('triggers at the caret without treating email addresses, paths or ranges as commands', () => {
    expect(composerTrigger('请用 @rev 检查', 7)).toEqual({ start: 3, end: 7, kind: '@', query: 'rev' })
    expect(composerTrigger('hello /com rest', 10)).toEqual({ start: 6, end: 10, kind: '/', query: 'com' })
    expect(composerTrigger('a@b.test', 8)).toBeNull()
    expect(composerTrigger('/Users/name', 11)).toBeNull()
    expect(composerTrigger('/com', 0, 4)).toBeNull()
  })
  test('inserts a command at the active token and preserves the text after the caret', () => {
    const text = '请 /com 然后继续'
    const result = insertComposerCandidate(text, composerTrigger(text, 6), { name: 'compact', description: '', kind: 'command' })
    expect(result).toEqual({ text: '请 /compact  然后继续', cursor: 11 })
  })
  test('selected skills become server-authored instructions; ordinary typed @ stays literal', () => {
    const candidate = { name: skill.name, description: skill.description, kind: skill.kind, reference: skill }
    const inserted = insertComposerCandidate('用 @rev 做检查', composerTrigger('用 @rev 做检查', 6), candidate)
    expect(inserted.text).toBe('用  做检查')
    expect(serializeComposer('手写 @review', [])).toBe('手写 @review')
    expect(serializeComposer(inserted.text, [skill, skill])).toBe(`${skill.modelText}\n\n用  做检查`)
    expect(serializeComposer('再看看', [])).not.toContain('Skill tool')
    const team = buildComposerMessage(serializeComposer('检查', [skill]), [], true)
    expect(team.content.match(/<agent-team-request>/g)).toHaveLength(1)
    expect(team.content).toContain(skill.modelText)
  })
  test('same display name in a plugin does not erase a distinct selected reference', () => {
    expect(mergeComposerReferences([skill], [{ ...skill, kind: 'plugin' }], [skill])).toHaveLength(2)
  })
  test('new task handoff preserves the display draft and selected skills separately from model content', () => {
    const content = buildComposerMessage(serializeComposer('检查这个文件', [skill]), [], true).content
    putPendingTask('fixture', 'new', { content, displayText: '检查这个文件', references: [skill], attachments: [] })
    const task = peekPendingTask('fixture', 'new')!
    expect(task.content).toContain(skill.modelText)
    expect(pendingTaskDraft(task)).toEqual({ text: '检查这个文件', team: true })
    expect(task.references).toEqual([skill])
    clearPendingTask('fixture', 'new')
  })
  test('new-task catalog uses cwd, explicit Claude provider and lean without prematurely creating a session', async () => {
    const calls: string[] = []
    const client = { get: async (path: string) => { calls.push(path); return path.includes('/commands?') ? { commands: [{ name: 'draft-command', description: 'Project command' }] } : { skills: [skill], plugins: [] } } } as unknown as ApiClient
    const result = await loadComposerCandidates(client, { workDir: '/tmp/hello world', runtime: { providerId: null, modelId: 'model' }, lean: true }, new AbortController().signal)
    expect(calls).toHaveLength(2)
    const url = new URL(calls[0], 'http://fixture')
    expect(url.searchParams.get('cwd')).toBe('/tmp/hello world')
    expect(url.searchParams.get('providerId')).toBe('claude-official')
    expect(url.searchParams.get('agentProfile')).toBe('lean')
    expect(result.find((value) => value.name === 'review')?.reference?.modelText).toBe(skill.modelText)
    expect(result.some((value) => value.name === 'model')).toBe(true)
    expect(result.some((value) => value.name === 'permissions')).toBe(true)
    expect(result.some((value) => value.name === 'draft-command')).toBe(true)
  })
  test('session catalog merges commands without downgrading the authoritative skill reference', async () => {
    const signal = new AbortController().signal
    const calls: string[] = []
    const client = { get: async (path: string, options: { signal: AbortSignal }) => {
      expect(options.signal).toBe(signal)
      calls.push(path)
      return path.includes('slash-commands') ? { commands: [{ name: 'review', description: 'old' }, { name: 'compact', description: 'compact' }] } : { skills: [skill], plugins: [] }
    } } as unknown as ApiClient
    const result = await loadComposerCandidates(client, { sessionId: 's/a', lean: false }, signal)
    expect(calls).toContain('/api/sessions/s%2Fa/slash-commands')
    expect(new URL(calls[0], 'http://fixture').searchParams.has('providerId')).toBe(false)
    expect(result.filter((value) => value.name === 'review')).toHaveLength(1)
    expect(result[0].reference).toEqual(skill)
    expect(result.some((value) => value.name === 'compact')).toBe(true)
  })
})


test('sent native skill prompts use the desktop reader to recover visible reference chips after history reload', () => {
  const sent = serializeComposer('检查结果', [skill])
  expect(parseUserMessageSegments(sent)).toEqual([
    { type: 'skill', id: 'review', label: 'review', modelText: skill.modelText },
    { type: 'text', text: '\n\n检查结果' },
  ])
  expect(parseUserMessageSegments('普通手写 @review')).toEqual([{ type: 'text', text: '普通手写 @review' }])
})
