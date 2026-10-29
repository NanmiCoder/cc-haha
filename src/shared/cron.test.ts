import { expect, test } from 'bun:test'
import { parseCronExpression } from './cron.js'
import { parseCronExpression as parseRuntimeCron } from '../utils/cron.js'

test('the runtime uses the shared grammar without changing supported schedules', () => {
  expect(parseRuntimeCron).toBe(parseCronExpression)
  expect(parseCronExpression('0-30/10 9,18 * * 5-7')).toMatchObject({
    minute: [0, 10, 20, 30],
    hour: [9, 18],
    dayOfWeek: [0, 5, 6],
  })
  expect(parseCronExpression('  */15\t* * * 7 ')).toMatchObject({
    minute: [0, 15, 30, 45],
    dayOfWeek: [0],
  })
})

test('rejects invalid bounds and unsupported field syntax before scheduling', () => {
  for (const cron of [
    '', '0 9 *', '0 9 * * * *', '*/0 * * * *', '0 24 * * *',
    '60 9 * * *', '0 9 0 * *', '0 9 * 13 *', '0 9 * * 8',
    '0 9 * * 5-1', '0-30/0 9 * * *', '0/2 9 * * *', '0 9 * * MON',
    '0 9 * * 1,',
  ]) expect(parseCronExpression(cron), cron).toBeNull()
})
