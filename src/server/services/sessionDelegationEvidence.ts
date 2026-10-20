import type { SessionUserInstruction } from '../../shared/sessionDelegation.js'

type EvidenceMessage = { id: string; type: string; content: unknown; collaboration?: unknown }

/** Validate provenance only. Understanding an explicit assignment remains the agent's responsibility. */
export function matchesDelegationUserInstruction(messages: EvidenceMessage[], evidence: SessionUserInstruction): boolean {
  if (!evidence.quote.trim()) return false
  const latest = [...messages].reverse().find(message => message.type === 'user' && !message.collaboration)
  if (!latest || latest.id !== evidence.messageId) return false
  const text = typeof latest.content === 'string' ? latest.content : Array.isArray(latest.content)
    ? latest.content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n') : ''
  return text.includes(evidence.quote)
}
