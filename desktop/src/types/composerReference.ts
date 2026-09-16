export type ComposerReferenceCandidate = {
  kind: 'skill' | 'plugin'
  id: string
  name: string
  displayName: string
  description: string
  source: string
  path?: string
  icon?: string
  modelText: string
  skillNames?: string[]
  mcpServerNames?: string[]
}
