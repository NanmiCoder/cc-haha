import type { Command } from '../../commands.js'

const goal = {
  type: 'local-jsx',
  supportsNonInteractive: true,
  name: 'goal',
  description: 'Set a completion goal',
  argumentHint: '[<condition> | clear]',
  load: () => import('./goal.js'),
} satisfies Command

export default goal
