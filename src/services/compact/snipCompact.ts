import type { Message } from '../../types/message.js'

export function isSnipRuntimeEnabled(): boolean {
  return false
}

export function shouldNudgeForSnips(messages: Message[]): boolean {
  return false
}