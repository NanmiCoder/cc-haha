import { expect, test } from 'bun:test'
import {
  effortName,
  modeName,
  modes,
  planExecutionModes,
  profileName,
} from './modes'

test('every permission mode has exactly one user-facing name', () => {
  expect(modes.map((mode) => [mode.id, mode.title])).toEqual([
    ['default', '询问'],
    ['acceptEdits', '自动接受编辑'],
    ['auto', '自动'],
    ['plan', '计划'],
    ['bypassPermissions', '全权限'],
  ])
  expect(modeName('default')).toBe('询问')
  expect(modeName('dontAsk')).toBe('不询问')
  expect(modeName(undefined)).toBe('询问')
  expect(modeName('futureMode')).toBe('futureMode')
})

test('plan execution reuses the same names instead of a second vocabulary', () => {
  expect(planExecutionModes.map((mode) => mode.title)).toEqual([
    '询问',
    '自动接受编辑',
    '全权限',
  ])
})

test('effort and profile labels are localized once with safe fallbacks', () => {
  expect(effortName('high')).toBe('高')
  expect(effortName('xhigh')).toBe('超高')
  expect(effortName('max')).toBe('最高')
  expect(effortName(undefined)).toBe('默认')
  expect(effortName('turbo')).toBe('turbo')
  expect(profileName('lean')).toBe('轻量')
  expect(profileName('standard')).toBe('完整工具')
  expect(profileName(undefined)).toBe('完整工具')
})
