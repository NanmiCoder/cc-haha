import { describe, it, expect, mock } from 'bun:test'
import {
  TELEGRAM_BOT_COMMANDS,
  buildTelegramSelectionPage,
  parseTelegramSelectionCallback,
  syncTelegramBotCommands,
} from '../menu.js'

describe('Telegram menu helpers', () => {
  it('keeps bot commands valid for Telegram setMyCommands', () => {
    expect(TELEGRAM_BOT_COMMANDS.length).toBeGreaterThan(0)
    for (const command of TELEGRAM_BOT_COMMANDS) {
      expect(command.command).toMatch(/^[a-z0-9_]{1,32}$/)
      expect(command.description.trim().length).toBeGreaterThan(0)
      expect(command.description.length).toBeLessThanOrEqual(256)
    }
  })

  it('deletes stale bot commands before setting the current menu', async () => {
    const calls: string[] = []
    const api = {
      deleteMyCommands: mock(async () => {
        calls.push('delete')
      }),
      setMyCommands: mock(async () => {
        calls.push('set')
      }),
    }

    await syncTelegramBotCommands(api)

    expect(calls).toEqual(['delete', 'set'])
    expect(api.setMyCommands).toHaveBeenCalledWith(TELEGRAM_BOT_COMMANDS)
  })

  it('builds paginated selection callbacks after eight options', () => {
    const page = buildTelegramSelectionPage({
      kind: 'model',
      items: Array.from({ length: 9 }, (_, index) => ({
        label: `Model ${index + 1}`,
        value: `model-${index + 1}`,
      })),
      page: 0,
    })

    expect(page.totalPages).toBe(2)
    expect(page.visibleItems).toHaveLength(8)
    expect(page.rows.at(-1)).toEqual([
      { text: '1/2', callbackData: 'tgsel:model:noop:0' },
      { text: 'Next', callbackData: 'tgsel:model:page:1' },
    ])
  })

  it('parses selection callbacks and rejects unrelated callback data', () => {
    expect(parseTelegramSelectionCallback('tgsel:resume_session:pick:7')).toEqual({
      kind: 'resume_session',
      action: 'pick',
      index: 7,
    })
    expect(parseTelegramSelectionCallback('permit:req:yes')).toBeNull()
    expect(parseTelegramSelectionCallback('tgsel:model:page:-1')).toBeNull()
  })
})
