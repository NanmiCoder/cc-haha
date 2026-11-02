import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withGoogleServicesFile } from '../app.config'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})
const config = {
  name: 'cc-haha',
  slug: 'cc-haha-mobile',
  android: { package: 'app.cchaha.mobile', permissions: ['CAMERA'] },
}
function fixture(value: unknown) {
  const directory = mkdtempSync(join(tmpdir(), 'cc-haha-fcm-config-'))
  directories.push(directory)
  const file = join(directory, 'google-services.json')
  writeFileSync(file, JSON.stringify(value))
  return file
}
test('FCM is optional and retains the base native configuration', () => {
  expect(withGoogleServicesFile(config, '')).toBe(config)
  const file = fixture({
    client: [
      {
        client_info: {
          android_client_info: { package_name: config.android.package },
        },
      },
    ],
  })
  expect(withGoogleServicesFile(config, file).android).toEqual({
    ...config.android,
    googleServicesFile: file,
  })
})
test('a service-account key or mismatched client never silently produces an unusable push build', () => {
  for (const value of [
    { private_key: 'fixture-only' },
    {
      client: [
        { client_info: { android_client_info: { package_name: 'wrong.app' } } },
      ],
    },
  ]) {
    expect(() => withGoogleServicesFile(config, fixture(value))).toThrow(
      'Firebase 客户端'
    )
  }
  expect(() =>
    withGoogleServicesFile(config, '/fixture-missing-services.json')
  ).toThrow('可读取')
})
