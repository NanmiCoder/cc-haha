/** A model is identified by its provider and model together. null is Claude official. */
export type SessionRuntimeSelection = {
  providerId: string | null
  modelId: string
  effortLevel?: string
  openAIFastMode?: boolean
}

export type SessionModelChoice = {
  providerId: string | null
  providerName: string
  modelId: string
  modelName: string
  aliases?: string[]
  supportedEfforts: string[]
  defaultEffort?: string
  isDefault: boolean
  isProviderDefault?: boolean
}
export type SessionModelOption = SessionModelChoice
export type SessionUserInstruction = { messageId: string; quote: string }
export type SessionDelegationInput = {
  requestId: string
  sessions: Array<{
    id?: string
    title?: string
    prompt: string
    workDir?: string
    runtime?: SessionRuntimeSelection
    model?: string
    providerId?: string | null
    userInstruction?: SessionUserInstruction
  }>
}
export type SessionDelegationEntry = {
  id: string
  title?: string
  prompt: string
  workDir?: string
  runtime?: SessionRuntimeSelection
  error?: string
  sessionId?: string
  messageId?: string
  launched?: boolean
}
export type SessionDelegationBatch = {
  id: string
  callerSessionId: string
  requestId: string
  revision: number
  state: 'review' | 'launching' | 'launched' | 'cancelled' | 'failed'
  sessions: SessionDelegationEntry[]
  error?: string
}
export type SessionModelChangeInput = {
  requestId: string
  mode?: 'after_turn' | 'immediate'
  resume?: boolean
  selections: Array<{ sessionId: string; runtime: SessionRuntimeSelection }>
}
export type SessionModelChange = {
  id: string
  callerSessionId: string
  requestId: string
  mode: 'after_turn' | 'immediate'
  resume: boolean
  revision: number
  state: 'pending' | 'applying' | 'applied' | 'failed' | 'cancelled'
  selections: Array<{ sessionId: string; runtime: SessionRuntimeSelection }>
  error?: string
}
