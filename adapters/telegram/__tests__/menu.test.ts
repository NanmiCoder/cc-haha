import { describe, it, expect, mock } from 'bun:test'
import { t } from '../../common/i18n.js'
import {
  telegramBotCommands,
  buildTelegramSelectionPage,
  parseTelegramSelectionCallback,
  syncTelegramBotCommands,
} from '../menu.js'

describe('Telegram menu helpers', () => {
  it('keeps bot commands valid for Telegram setMyCommands', () => {
    const commands = telegramBotCommands()
    expect(commands.length).toBeGreaterThan(0)
    for (const command of commands) {
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
    expect(api.setMyCommands).toHaveBeenCalledWith(telegramBotCommands())
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
      { text: t('telegram.next'), callbackData: 'tgsel:model:page:1' },
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
