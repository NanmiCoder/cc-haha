import { afterAll, beforeAll, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const compiler = Bun.which('clang++') ?? Bun.which('g++')
const root = dirname(fileURLToPath(import.meta.resolve('react-native-audio-api/package.json')))
let scratch: string | undefined
let binary: string

/** Extract a pinned C++ method body while respecting comments and string braces. */
function method(source: string, signature: string): string {
  const start = source.indexOf(signature)
  if (start < 0) throw new Error(`Native method missing: ${signature}`)
  let depth = 0
  let opened = false
  let mode: 'code' | 'line' | 'block' | 'string' = 'code'
  for (let index = start; index < source.length; index++) {
    const current = source[index]
    const next = source[index + 1]
    if (mode === 'line') {
      if (current === '\n') mode = 'code'
    } else if (mode === 'block') {
      if (current === '*' && next === '/') { mode = 'code'; index++ }
    } else if (mode === 'string') {
      if (current === '\\') index++
      else if (current === '"') mode = 'code'
    } else if (current === '/' && next === '/') { mode = 'line'; index++ }
    else if (current === '/' && next === '*') { mode = 'block'; index++ }
    else if (current === '"') mode = 'string'
    else if (current === '{') { depth++; opened = true }
    else if (current === '}' && --depth === 0 && opened) return source.slice(start, index + 1)
  }
  throw new Error(`Incomplete native method: ${signature}`)
}

// Give cold CI compilation its 30-second process budget plus setup overhead.
beforeAll(() => {
  if (!compiler) return
  scratch = mkdtempSync(join(tmpdir(), 'mobile-audio-native-patch-'))
  const recorder = readFileSync(join(root, 'android/src/main/cpp/audioapi/android/core/AndroidAudioRecorder.cpp'), 'utf8')
  const writer = readFileSync(join(root, 'android/src/main/cpp/audioapi/android/core/utils/miniaudioBackend/MiniAudioFileWriter.cpp'), 'utf8')
  const backend = readFileSync(join(root, 'android/src/main/cpp/audioapi/android/core/utils/AndroidFileWriterBackend.cpp'), 'utf8')
  let harness = readFileSync(new URL('./__fixtures__/voiceCaptureNative.cpp', import.meta.url), 'utf8')
  const methods = {
    RECORDER_START: method(recorder, 'Result<NoneType, std::string> AndroidAudioRecorder::start('),
    RECORDER_STOP: method(recorder, 'AudioRecorder::StopResult AndroidAudioRecorder::stop()'),
    RECORDER_ERROR: method(recorder, 'void AndroidAudioRecorder::onErrorAfterClose('),
    WRITER_SUBMIT: method(backend, 'void AndroidFileWriterBackend::writeAudioData('),
    WRITER_TASK: method(backend, 'void AndroidFileWriterBackend::runWriterTask('),
    WRITER_PROCESS: method(writer, 'void MiniAudioFileWriter::processWriterData('),
    WRITER_CLOSE: method(writer, 'CloseFileResult MiniAudioFileWriter::closeFile()'),
  }
  for (const [name, body] of Object.entries(methods)) harness = harness.replace(`/*__${name}__*/`, body)
  const file = join(scratch, 'capture.cpp')
  binary = join(scratch, process.platform === 'win32' ? 'capture.exe' : 'capture')
  writeFileSync(file, harness)
  execFileSync(compiler, ['-std=c++20', '-pthread', '-I', join(root, 'common/cpp'), file, '-o', binary], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 })
}, 35000)

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true })
})

test('the pinned patch is installed and Android compiles the patched recorder sources', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  expect(packageJson.dependencies['react-native-audio-api']).toBe('0.13.6')
  expect(packageJson.patchedDependencies['react-native-audio-api@0.13.6']).toBe('patches/react-native-audio-api@0.13.6.patch')
  const patch = readFileSync(new URL('../patches/react-native-audio-api@0.13.6.patch', import.meta.url), 'utf8')
  for (const file of ['AndroidAudioRecorder.cpp', 'MiniAudioFileWriter.cpp']) expect(patch).toContain(file)
  const recorder = readFileSync(join(root, 'android/src/main/cpp/audioapi/android/core/AndroidAudioRecorder.cpp'), 'utf8')
  expect(method(recorder, 'AudioRecorder::StopResult AndroidAudioRecorder::stop()')).toContain('isIdle() && mStream_ == nullptr')
  const gradle = readFileSync(join(root, 'android/build.gradle'), 'utf8')
  expect(gradle).toMatch(/externalNativeBuild\s*\{\s*cmake\s*\{\s*path "CMakeLists\.txt"/)
  const entry = readFileSync(join(root, 'android/CMakeLists.txt'), 'utf8')
  expect(entry).toContain('add_subdirectory("${ANDROID_CPP_DIR}/audioapi")')
  const cmake = readFileSync(join(root, 'android/src/main/cpp/audioapi/CMakeLists.txt'), 'utf8')
  expect(cmake).toContain('file(GLOB_RECURSE ANDROID_CPP_SOURCES_ABS CONFIGURE_DEPENDS "${ANDROID_CPP_DIR}/audioapi/*.cpp")')
  expect(cmake).toContain('add_library(react-native-audio-api SHARED ${ANDROID_CPP_SOURCES} ${COMMON_CPP_SOURCES})')
  expect(cmake).not.toContain('REMOVE_ITEM ANDROID_CPP_SOURCES')
})

test('the audio worklets runner only calls WorkletRuntime methods the installed react-native-worklets exposes', () => {
  const runner = readFileSync(join(root, 'common/cpp/audioapi/core/utils/worklets/WorkletsRunner.cpp'), 'utf8')
  const calls = [...new Set([...runner.matchAll(/strongRuntime->(\w+)\(/g)].map(match => match[1]))]
  expect(calls.length).toBeGreaterThan(0)
  const worklets = dirname(fileURLToPath(import.meta.resolve('react-native-worklets/package.json')))
  const runtime = readFileSync(join(worklets, 'Common/cpp/worklets/WorkletRuntime/WorkletRuntime.h'), 'utf8')
  for (const name of calls) expect({ name, declared: new RegExp(`\\b${name}\\s*\\(`).test(runtime) }).toEqual({ name, declared: true })
})

for (const boundary of ['partial-start', 'tail-flush', 'disconnect']) {
  test.skipIf(!compiler)(`the installed Android native recorder handles ${boundary}`, () => {
    const result = Bun.spawnSync([binary, boundary])
    expect({ exitCode: result.exitCode, detail: result.stderr.toString() }).toEqual({ exitCode: 0, detail: '' })
  })
}
