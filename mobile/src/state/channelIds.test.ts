import { expect, test } from 'bun:test'
import { CHANNEL_IDS, channelTriggerFor } from './channelIds'

test('local fallback notifications land in the channel matching their event on Android', () => {
  expect(channelTriggerFor('android', 'decision')).toEqual({ channelId: CHANNEL_IDS.decisions })
  expect(channelTriggerFor('android', 'completed')).toEqual({ channelId: CHANNEL_IDS.completed })
  expect(channelTriggerFor('android', 'error')).toEqual({ channelId: CHANNEL_IDS.errors })
})

test('iOS has no channels: immediate trigger stays null', () => {
  expect(channelTriggerFor('ios', 'decision')).toBeNull()
})
