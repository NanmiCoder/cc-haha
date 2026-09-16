export type SlashCommandKind = 'command' | 'skill' | 'agent' | 'plugin'

export type SlashCommandSource = 'user' | 'project' | 'plugin'

export type SlashCommandOption = {
  name: string
  description: string
  argumentHint?: string
  kind?: SlashCommandKind
  source?: SlashCommandSource
}
