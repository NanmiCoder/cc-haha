/**
 * Telegram typing indicator controller.
 *
 * Telegram's "typing…" bubble expires after ~5 seconds, so it must be
 * re-sent while the desktop session is actively thinking/streaming. We send
 * one immediately on start and keep a keepalive timer until the turn ends.
 */

type SendChatAction = (chatId: number | string, action: 'typing') => Promise<unknown>

export class TelegramTypingController {
  private readonly active = new Map<string, ReturnType<typeof setInterval>>()

  constructor(
    private readonly sendChatAction: SendChatAction,
    private readonly keepaliveIntervalMs = 4000,
  ) {}

  start(chatId: string): void {
    if (this.active.has(chatId)) return
    const numericChatId = Number(chatId)
    void this.sendChatAction(numericChatId, 'typing').catch(() => {})
    const timer = setInterval(() => {
      void this.sendChatAction(numericChatId, 'typing').catch(() => {})
    }, this.keepaliveIntervalMs)
    this.active.set(chatId, timer)
  }

  stop(chatId: string): void {
    const timer = this.active.get(chatId)
    if (timer) {
      clearInterval(timer)
      this.active.delete(chatId)
    }
  }

  destroy(): void {
    for (const timer of this.active.values()) {
      clearInterval(timer)
    }
    this.active.clear()
  }
}
