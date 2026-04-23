import * as React from 'react'
import { Box, Text } from '../../ink.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import {
  getCompanion,
  roll,
  rollWithSeed,
  companionUserId,
} from '../../buddy/companion.js'
import { renderSprite } from '../../buddy/sprites.js'
import {
  RARITY_COLORS,
  RARITY_STARS,
  STAT_NAMES,
  type StoredCompanion,
} from '../../buddy/types.js'
import { saveGlobalConfig } from '../../utils/config.js'

function CompanionCard({
  onDone,
  args,
  setAppState,
}: {
  onDone: (result?: string, options?: { display?: string }) => void
  args: string
  setAppState: (updater: (prev: any) => any) => void
}) {
  const trimmed = args.trim().toLowerCase()
  const companion = getCompanion()

  // Handle keyboard input to dismiss
  const handleKeyDown = (e: any) => {
    if (e.key === 'q' || e.key === 'Enter') {
      e.preventDefault()
      onDone()
    }
  }

  // Handle subcommands
  React.useEffect(() => {
    if (trimmed === 'mute') {
      saveGlobalConfig(c => ({ ...c, companionMuted: true }))
      onDone(`${companion?.name ?? 'Companion'} is now muted.`, {
        display: 'system',
      })
      return
    }

    if (trimmed === 'unmute') {
      saveGlobalConfig(c => ({ ...c, companionMuted: false }))
      onDone(`${companion?.name ?? 'Companion'} says hello!`, {
        display: 'system',
      })
      return
    }

    if (trimmed === 'pet') {
      if (!companion) {
        onDone('You need to hatch a companion first! Use /buddy hatch', {
          display: 'system',
        })
        return
      }
      setAppState((prev: any) => ({ ...prev, companionPetAt: Date.now() }))
      onDone(`You pet ${companion.name}! ♥`, { display: 'system' })
      return
    }

    if (trimmed === 'hatch') {
      if (companion) {
        onDone(
          `You already have ${companion.name}! Use /buddy info to see them.`,
          { display: 'system' },
        )
        return
      }
      // Hatch a new companion with a generated name and random seed
      const appearanceSeed = `hatch:${Date.now()}:${Math.random().toString(36).slice(2)}`
      const { bones } = rollWithSeed(appearanceSeed)
      const adjectives = [
        'Bright', 'Cozy', 'Swift', 'Calm', 'Wise', 'Bold',
        'Fuzzy', 'Lucky', 'Snappy', 'Quirky',
      ]
      const nouns = [
        'Spark', 'Pixel', 'Ember', 'Glitch', 'Byte',
        'Flux', 'Drift', 'Blip', 'Quip', 'Zap',
      ]
      const adj = adjectives[Math.floor(Math.random() * adjectives.length)]!
      const noun = nouns[Math.floor(Math.random() * nouns.length)]!
      const name = `${adj} ${noun}`
      const soul: StoredCompanion = {
        name,
        personality: `A ${bones.rarity} ${bones.species} who loves debugging and hanging out.`,
        hatchedAt: Date.now(),
        appearanceSeed,
      }
      saveGlobalConfig(c => ({ ...c, companion: soul }))
      onDone(
        `✨ You hatched ${name} the ${bones.rarity} ${bones.species}! Say hello!`,
        { display: 'system' },
      )
      return
    }

    if (trimmed === 'release') {
      if (!companion) {
        onDone('No companion to release.', { display: 'system' })
        return
      }
      const name = companion.name
      saveGlobalConfig(c => {
        const next = { ...c }
        delete next.companion
        return next
      })
      onDone(`Goodbye, ${name}! You'll be missed.`, { display: 'system' })
      return
    }
  }, [])

  // Render companion info
  if (!companion) {
    const { bones } = roll(companionUserId())
    const preview = renderSprite(bones, 0)
    const color = RARITY_COLORS[bones.rarity]
    return (
      <Box flexDirection="column" paddingX={1} paddingY={1} autoFocus={true} onKeyDown={handleKeyDown} tabIndex={0}>
        <Text bold>You haven't hatched a companion yet!</Text>
        <Text dimColor>Here's a preview of yours:</Text>
        <Box flexDirection="column" marginY={1}>
          {preview.map((line, i) => (
            <Text key={i} color={color}>
              {line}
            </Text>
          ))}
          <Text italic dimColor>
            A {bones.rarity} {bones.species} {RARITY_STARS[bones.rarity]}
          </Text>
        </Box>
        <Text>Run <Text bold>/buddy hatch</Text> to bring them to life!</Text>
        <Text dimColor>Or type <Text bold>q</Text> to dismiss.</Text>
      </Box>
    )
  }

  const sprite = renderSprite(companion, 0)
  const color = RARITY_COLORS[companion.rarity]

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1} autoFocus={true} onKeyDown={handleKeyDown} tabIndex={0}>
      <Box flexDirection="row" gap={2}>
        <Box flexDirection="column">
          {sprite.map((line, i) => (
            <Text key={i} color={color}>
              {line}
            </Text>
          ))}
          <Text italic bold color={color}>
            {companion.name}
          </Text>
        </Box>
        <Box flexDirection="column" justifyContent="center">
          <Text>
            <Text bold>Species:</Text>{' '}
            <Text color={color}>{companion.species}</Text>
          </Text>
          <Text>
            <Text bold>Rarity:</Text>{' '}
            <Text color={color}>
              {companion.rarity} {RARITY_STARS[companion.rarity]}
            </Text>
          </Text>
          {companion.shiny && <Text color="warning">✦ Shiny!</Text>}
          <Text dimColor>{'─'.repeat(20)}</Text>
          <Text bold>Stats:</Text>
          {STAT_NAMES.map(stat => (
            <Text key={stat}>
              <Text dimColor>{stat}:</Text>{' '}
              <Text color={color}>{companion.stats[stat]}</Text>
            </Text>
          ))}
        </Box>
      </Box>
      <Text dimColor>{'─'.repeat(40)}</Text>
      <Text dimColor>
        /buddy pet · /buddy mute · /buddy unmute · /buddy release
      </Text>
      <Text dimColor>Press q or Enter to dismiss</Text>
    </Box>
  )
}

export const call: LocalJSXCommandCall = async (onDone, context, args = '') => {
  return (
    <CompanionCard
      onDone={onDone}
      args={args}
      setAppState={context.setAppState}
    />
  )
}
