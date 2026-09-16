/** Metadata for the composer. No secrets, execution config, or skill contents. */
export type CapabilityMentionCandidate = {
  kind: 'skill' | 'plugin'
  id: string
  name: string
  displayName: string
  description: string
  source: string
  path?: string
  icon?: string
  /** Fixed server-generated request using the runtime's exact identifiers. */
  modelText: string
  skillNames?: string[]
  mcpServerNames?: string[]
}

export type CapabilityMentionResponse = {
  skills: CapabilityMentionCandidate[]
  plugins: CapabilityMentionCandidate[]
}
