/**
 * U06 parser contract: the caret-aware context trigger finder and the bridge
 * that routes only `/hh` `/ce` `/db` `/rd`, leaving every other input to the
 * original slash parser.
 */
import { describe, expect, it } from 'vitest'
import { findContextSlashTrigger, parseSlash } from '../composer/contextPicker'
import { classifyContextSlash, contextPickerKindFor, resolveContextSlash } from './parserBridge'
import { findContextSlash, findSlashTrigger, resolveSlashUiAction } from '../../../components/chat/composerUtils'

describe('findContextSlashTrigger', () => {
  it('finds /hh at the very start', () => {
    expect(findContextSlashTrigger('/hh', 3)).toEqual({ command: 'hh', slashPos: 0, filter: '' })
  })

  it('finds a trigger at a real position, not only at offset 0', () => {
    // `parseSlash` only matches at the start; this finder honours the caret.
    expect(parseSlash('deploy /hh')).toEqual({ kind: 'none' })
    expect(parseSlash('/hh')).toEqual({ kind: 'command', command: 'hh' })
    expect(findContextSlashTrigger('deploy /hh', 10)).toEqual({ command: 'hh', slashPos: 7, filter: '' })
  })

  it('ignores text after the caret', () => {
    expect(findContextSlashTrigger('/hh 生产', 3)).toEqual({ command: 'hh', slashPos: 0, filter: '' })
    expect(findContextSlashTrigger('/hh 生产', 6)).toEqual({ command: 'hh', slashPos: 0, filter: '生产' })
  })

  it('accepts a Chinese query with and without a separator space', () => {
    expect(findContextSlashTrigger('/hh生产', 5)?.filter).toBe('生产')
    expect(findContextSlashTrigger('/hh 生产', 6)?.filter).toBe('生产')
    expect(findContextSlashTrigger('/ce 架构', 6)).toEqual({ command: 'ce', slashPos: 0, filter: '架构' })
  })

  it('requires a word boundary before the slash', () => {
    expect(findContextSlashTrigger('a/b', 3)).toBeNull()
    expect(findContextSlashTrigger('/hh', 3)).not.toBeNull()
    expect(findContextSlashTrigger('x /hh', 5)).not.toBeNull()
  })

  it('requires the command name to be delimited', () => {
    // `/hhx` is an ordinary word, so the legacy parser keeps it.
    expect(findContextSlashTrigger('/hhx', 4)).toBeNull()
    expect(findSlashTrigger('/hhx', 4)).toEqual({ slashPos: 0, filter: 'hhx' })
    expect(findContextSlashTrigger('/hh生产', 5)).not.toBeNull()
  })

  it('does not span a newline', () => {
    expect(findContextSlashTrigger('/hh\nfoo', 7)).toBeNull()
  })

  it('skips a slash that sits inside an excluded range (mention pill)', () => {
    expect(findContextSlashTrigger('note /hh', 8, { excludedRanges: [{ start: 5, end: 8 }] })).toBeNull()
    // Outside the range it is a trigger again.
    expect(findContextSlashTrigger('note /hh', 8, { excludedRanges: [{ start: 0, end: 4 }] })?.command).toBe('hh')
    expect(findContextSlashTrigger('note /hh', 8)?.command).toBe('hh')
  })
})

describe('classifyContextSlash', () => {
  it('routes /hh and /ce to the picker with their kind', () => {
    expect(classifyContextSlash('/hh', 3)).toEqual({
      type: 'context-picker',
      command: 'hh',
      kind: 'host',
      filter: '',
      slashPos: 0,
    })
    expect(classifyContextSlash('/ce 架构', 6)).toMatchObject({
      type: 'context-picker',
      command: 'ce',
      kind: 'concept',
      filter: '架构',
    })
  })

  it('routes /db and /rd to their real M9 picker kinds', () => {
    expect(classifyContextSlash('/db orders', 10)).toMatchObject({
      type: 'context-picker',
      command: 'db',
      kind: 'database',
      filter: 'orders',
    })
    expect(classifyContextSlash('/rd cache', 9)).toMatchObject({
      type: 'context-picker',
      command: 'rd',
      kind: 'redis',
      filter: 'cache',
    })
  })

  it('answers none for everything it does not own', () => {
    expect(classifyContextSlash('plain prompt', 12)).toEqual({ type: 'none' })
    expect(classifyContextSlash('/clear', 6)).toEqual({ type: 'none' })
    expect(classifyContextSlash('/', 1)).toEqual({ type: 'none' })
    expect(resolveContextSlash('/clear', 6)).toBeNull()
  })

  it('maps commands to kinds', () => {
    expect(contextPickerKindFor('hh')).toBe('host')
    expect(contextPickerKindFor('ce')).toBe('concept')
    expect(contextPickerKindFor('db')).toBe('database')
    expect(contextPickerKindFor('rd')).toBe('redis')
  })
})

describe('the composer seam keeps the original parser', () => {
  it('delegates to the same classification', () => {
    expect(findContextSlash('/hh 生产', 6)).toEqual(classifyContextSlash('/hh 生产', 6))
    expect(findContextSlash('hello', 5)).toEqual({ type: 'none' })
    expect(findContextSlash('deploy /hh', 10, { excludedRanges: [{ start: 7, end: 10 }] })).toEqual({ type: 'none' })
  })

  it('leaves the four existing commands and the command menu untouched', () => {
    // The original parser never changed shape for non-context input.
    expect(findSlashTrigger('/cle', 4)).toEqual({ slashPos: 0, filter: 'cle' })
    expect(resolveSlashUiAction('help')).toEqual({ type: 'panel', command: 'help' })
    expect(resolveSlashUiAction('model')).toEqual({ type: 'model' })
    expect(resolveSlashUiAction('hh')).toBeNull()
  })
})
