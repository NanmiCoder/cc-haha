import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'bun:test'

test('Android autolinking selects the patched image decoder for source compilation', () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  // This checks dependency/build wiring, not device decoding. Without the
  // source-build override Expo 58 silently uses the original precompiled AAR.
  const linking = JSON.parse(execFileSync(process.execPath, [
    'node_modules/expo-modules-autolinking/bin/expo-modules-autolinking.js',
    'resolve', '--platform', 'android', '--json',
  ], { cwd: root, encoding: 'utf8' }))
  expect(linking.configuration?.buildFromSource).toContain('expo-camera')
  const camera = linking.modules.find((module: { packageName: string }) => module.packageName === 'expo-camera')
  expect(camera.packageVersion).toBe('58.0.12')
  const source = readFileSync(`${camera.projects[0].sourceDir}/src/main/java/expo/modules/camera/CameraViewModule.kt`, 'utf8')
  const imageScan = source.slice(source.indexOf('AsyncFunction("scanFromURLAsync")'), source.indexOf('AsyncFunction("launchScanner")'))
  expect(imageScan).toContain('if (!CameraUtils.isMLKitBarcodeScannerAvailable())')
  expect(imageScan).not.toContain('isMLKitAvailable(appContext.reactContext)')
  // The separate Google Code Scanner still requires Google services.
  expect(imageScan).toContain('promise.reject(CameraExceptions.MLKitUnavailableException())')
  const googleScan = source.slice(source.indexOf('AsyncFunction("launchScanner")'), source.indexOf('AsyncFunction("dismissScanner")'))
  expect(googleScan).toContain('CameraUtils.hasGooglePlayServices(appContext.reactContext)')
})
