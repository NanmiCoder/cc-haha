import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { ERROR_MESSAGE_USER_ABORT } from '../../services/compact/compact.js'
import type { Message } from '../../types/message.js'
import {
  createAssistantAPIErrorMessage,
  createAssistantMessage,
  createUserMessage,
  INTERRUPT_MESSAGE,
} from '../messages.js'
import { jsonStringify } from '../slowOperations.js'
import { readMailbox, writeToMailbox } from '../teammateMailbox.js'
import {
  classifyTeammateTurnFailure,
  getTeammateTurnResult,
  takeTeammateMailbox,
} from './inProcessRunner.js'

function sendMessageCall(id: string, to: string, text = 'Report'): Message {
  return createAssistantMessage({
    content: [
      { type: 'text', text },
      {
        type: 'tool_use',
        id,
        name: 'SendMessage',
        input: { to, summary: 'report', message: 'All done' },
      },
    ] as never,
  })
}

function toolResult(id: string, body: unknown, isError = false): Message {
  return createUserMessage({
    content: [
      {
        type: 'tool_result',
        tool_use_id: id,
        is_error: isError,
        content: [{ type: 'text', text: jsonStringify(body) }],
      },
    ] as never,
  })
}

describe('teammate turn result', () => {
  test('is the newest assistant text since the turn prompt', () => {
    expect(getTeammateTurnResult([
      createUserMessage({ content: 'Earlier prompt' }),
      createAssistantMessage({ content: 'Earlier answer' }),
      createUserMessage({ content: 'Current prompt' }),
      createAssistantMessage({ content: 'Looking at it' }),
      toolResult('read-1', { ok: true }),
      createAssistantMessage({ content: 'Fixed and verified.' }),
    ])).toBe('Fixed and verified.')
  })

  test('is absent when the turn produced no text of its own', () => {
    expect(getTeammateTurnResult([
      createUserMessage({ content: 'Earlier prompt' }),
      createAssistantMessage({ content: 'Earlier answer' }),
      createUserMessage({ content: 'Current prompt' }),
      createAssistantAPIErrorMessage({ content: 'API Error: 529 Overloaded' }),
    ])).toBeUndefined()
  })

  test('is suppressed when the turn already reported to the lead', () => {
    expect(getTeammateTurnResult([
      createUserMessage({ content: 'Prompt' }),
      sendMessageCall('send-1', 'team-lead', 'Reporting now'),
      toolResult('send-1', { success: true, message: 'sent' }),
    ])).toBeUndefined()
  })

  test('keeps the text when the report to the lead did not go through', () => {
    expect(getTeammateTurnResult([
      createUserMessage({ content: 'Prompt' }),
      sendMessageCall('send-1', 'team-lead', 'Reporting now'),
      toolResult('send-1', { success: false, message: 'Failed to write' }),
    ])).toBe('Reporting now')
  })

  test('keeps text written after the report, and ignores peer messages', () => {
    expect(getTeammateTurnResult([
      createUserMessage({ content: 'Prompt' }),
      sendMessageCall('send-1', 'team-lead'),
      toolResult('send-1', { success: true }),
      createAssistantMessage({ content: 'One more finding.' }),
    ])).toBe('One more finding.')
    expect(getTeammateTurnResult([
      createUserMessage({ content: 'Prompt' }),
      sendMessageCall('send-2', 'reviewer', 'Asked the reviewer'),
      toolResult('send-2', { success: true }),
    ])).toBe('Asked the reviewer')
  })
})

describe('teammate turn failure', () => {
  test('classifies the API error that ended a turn', () => {
    expect(classifyTeammateTurnFailure([
      createAssistantMessage({ content: 'Working' }),
      createAssistantAPIErrorMessage({ content: 'API Error: 529 Overloaded\nretry later' }),
    ])).toEqual({ reason: 'API Error: 529 Overloaded', isTransient: true })
    expect(classifyTeammateTurnFailure([
      createAssistantAPIErrorMessage({ content: 'API Error: 401 Invalid API key' }),
    ])).toEqual({ reason: 'API Error: 401 Invalid API key', isTransient: false })
  })

  test('ignores turns that ended normally or were cancelled', () => {
    expect(classifyTeammateTurnFailure([
      createAssistantAPIErrorMessage({ content: 'API Error: 529 Overloaded' }),
      createAssistantMessage({ content: 'Recovered' }),
    ])).toBeUndefined()
    expect(classifyTeammateTurnFailure([
      createAssistantAPIErrorMessage({ content: INTERRUPT_MESSAGE }),
    ])).toBeUndefined()
    expect(classifyTeammateTurnFailure([
      createAssistantAPIErrorMessage({ content: ERROR_MESSAGE_USER_ABORT }),
    ])).toBeUndefined()
  })
})

describe('teammate mailbox drain', () => {
  const TEAM = 'drain-team'
  let configDir: string
  let originalConfigDir: string | undefined

  beforeEach(async () => {
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR
    configDir = await mkdtemp(join(tmpdir(), 'cc-haha-runner-drain-'))
    process.env.CLAUDE_CONFIG_DIR = configDir
  })

  afterEach(async () => {
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    await rm(configDir, { recursive: true, force: true })
  })

  async function mail(from: string, text: string): Promise<void> {
    expect(await writeToMailbox('worker', { from, text, timestamp: new Date().toISOString() }, TEAM)).toBe(true)
  }

  test('hands over a shutdown request alone and first', async () => {
    await mail('reviewer', 'Peer chatter')
    await mail('team-lead', jsonStringify({
      type: 'shutdown_request',
      requestId: 'shutdown-1',
      from: 'team-lead',
      timestamp: new Date().toISOString(),
    }))

    const first = await takeTeammateMailbox({ agentName: 'worker', teamName: TEAM })
    expect(first).toMatchObject({ type: 'shutdown_request', from: 'team-lead' })
    // The rest waits for the model's decision
    const second = await takeTeammateMailbox({ agentName: 'worker', teamName: TEAM })
    expect(second).toEqual({
      type: 'new_messages',
      messages: [expect.objectContaining({ from: 'reviewer', text: 'Peer chatter' })],
    })
    expect(await takeTeammateMailbox({ agentName: 'worker', teamName: TEAM })).toBeNull()
  })

  test('delivers nothing twice and leaves an empty inbox empty', async () => {
    expect(await takeTeammateMailbox({ agentName: 'worker', teamName: TEAM })).toBeNull()
    await mail('team-lead', 'One')
    await mail('reviewer', 'Two')

    const delivery = await takeTeammateMailbox({ agentName: 'worker', teamName: TEAM })
    expect(delivery).toEqual({
      type: 'new_messages',
      messages: [
        expect.objectContaining({ text: 'One' }),
        expect.objectContaining({ text: 'Two' }),
      ],
    })
    expect(await takeTeammateMailbox({ agentName: 'worker', teamName: TEAM })).toBeNull()
    expect((await readMailbox('worker', TEAM)).filter(message => !message.read)).toEqual([])
  })
})
