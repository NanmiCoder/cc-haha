import { expect, test } from 'bun:test'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
// The function expo-router's web build uses to turn a URL into a route.
import { stripBaseUrl } from 'expo-router/build/fork/getStateFromPath-forks'
import { H5_BASE_PATH } from '../../app.config'

test('the H5 base path is removed only as a whole path segment', () => {
  // Unpatched expo-router turned /member into "ember" and /models into "odels"
  // (patches/expo-router@58.0.25.patch). Drop the patch only once this passes without it.
  expect(stripBaseUrl('/member?host=h5', H5_BASE_PATH)).toBe('/member?host=h5')
  expect(stripBaseUrl('/models', H5_BASE_PATH)).toBe('/models')
  expect(stripBaseUrl('/m/chat/abc?host=h5', H5_BASE_PATH)).toBe('/chat/abc?host=h5')
  expect(stripBaseUrl('/m/member', H5_BASE_PATH)).toBe('/member')
  expect(stripBaseUrl('/m', H5_BASE_PATH)).toBe('')
  expect(stripBaseUrl('/m?x=1', H5_BASE_PATH)).toBe('?x=1')
})

test('every app route keeps its name under the H5 base path', () => {
  const routes = readdirSync(join(import.meta.dir, '..', 'app'))
    .map((name) => name.replace(/\.tsx$/, ''))
    .filter((name) => !name.startsWith('_') && !name.includes('.'))
  expect(routes).toContain('member')
  for (const route of routes) {
    expect(stripBaseUrl(`/${route}`, H5_BASE_PATH)).toBe(`/${route}`)
    expect(stripBaseUrl(`${H5_BASE_PATH}/${route}`, H5_BASE_PATH)).toBe(`/${route}`)
  }
})
