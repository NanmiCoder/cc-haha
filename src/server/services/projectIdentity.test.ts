import { expect, test } from 'bun:test'
import * as path from 'node:path'
import { findExplicitProjectRoot } from './projectIdentity.js'

test('Windows project roots match separators and case by components, choosing the nearest root', () => {
  const parent = 'D:/Github/obsidian'
  const child = `${parent}/projects/Tools/输入法`
  expect(findExplicitProjectRoot('d:\\github\\OBSIDIAN\\projects\\Tools\\输入法\\src', [parent, child], path.win32)).toBe(child)
  expect(findExplicitProjectRoot('D:/Github/obsidian-other/src', [parent], path.win32)).toBeNull()
  expect(findExplicitProjectRoot('E:/Github/obsidian/src', [parent], path.win32)).toBeNull()
})
