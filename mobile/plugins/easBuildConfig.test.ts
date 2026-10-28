import { expect, test } from 'bun:test'
import { withEasProject } from '../app.config'
import eas from '../eas.json'

test('existing app config remains valid before EAS association', () => {
  const legacy = { name: 'fixture', slug: 'fixture', extra: { feature: true } }
  expect(withEasProject(legacy, {})).toBe(legacy)
})

test('project association preserves widget declarations and other app configuration', () => {
  const projectId = '11111111-2222-4333-8444-555555555555'
  const extensions = [{ targetName: 'FixtureWidget', bundleIdentifier: 'test.fixture.widget' }]
  const old = {
    owner: 'fixture-owner',
    extra: { feature: true, eas: { projectId, build: { experimental: { ios: { appExtensions: extensions } } } } },
  }
  const updated = withEasProject(old, { EXPO_OWNER: 'ci-owner' })
  expect(updated.owner).toBe('ci-owner')
  expect(updated.extra).toEqual(old.extra)
  expect(old.owner).toBe('fixture-owner')
  expect(withEasProject(old, { EXPO_PROJECT_ID: ' ' }).extra?.eas.projectId).toBe(projectId)
  expect(() => withEasProject(old, { EXPO_PROJECT_ID: 'invalid' })).toThrow('UUID')
})

test('production builds use remote credentials, increasing build numbers, and installable APKs', () => {
  expect(eas.cli.appVersionSource).toBe('remote')
  expect(eas.build.production).toMatchObject({
    distribution: 'store', credentialsSource: 'remote', autoIncrement: true,
    android: { buildType: 'apk' },
  })
  expect(eas.build.production).not.toHaveProperty('developmentClient')
})
