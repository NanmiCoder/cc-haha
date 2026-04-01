import type { Command } from '../../commands.js'

const connectSource = {
  type: 'local-jsx',
  name: 'connect-source',
  description: 'Manage API source configurations',
  aliases: ['connect-scource'],
  load: () => import('./connect-source.js'),
} satisfies Command

export default connectSource