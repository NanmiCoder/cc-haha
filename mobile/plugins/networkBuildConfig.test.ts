import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { BlockList } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { createSandboxedTestEnvironment, removeTestSandbox } from '../../scripts/pr/test-environment'

const root = resolve(import.meta.dir, '..')
const read = (path: string) => readFileSync(join(root, path), 'utf8')
const moduleDir = 'modules/cchaha-network/android'
const edgeSource = read(`${moduleDir}/src/main/java/app/cchaha/network/CloudflareEdge.kt`)
const raceSource = read(`${moduleDir}/src/main/java/app/cchaha/network/CloudflareEdgeRace.kt`)

function autolinkedProjects(platform: 'android' | 'apple') {
  const sandbox = mkdtempSync(join(tmpdir(), 'mobile-network-build-config-'))
  try {
    const output = execFileSync(process.execPath, [
      '--no-env-file', join(root, 'node_modules/expo-modules-autolinking/bin/expo-modules-autolinking.js'),
      'resolve', '--platform', platform, '--json',
    ], {
      cwd: root,
      env: { ...createSandboxedTestEnvironment(sandbox, { CI: '1', EXPO_NO_DOTENV: '1', NO_COLOR: '1' }), NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15000,
    })
    const modules = JSON.parse(output.toString()).modules as { packageName: string, projects?: { name: string, sourceDir: string }[] }[]
    return modules.flatMap(module => (module.projects ?? []).map(project => ({
      packageName: module.packageName,
      name: project.name,
      sourceDir: project.sourceDir,
    })))
  } finally {
    removeTestSandbox(sandbox, 'mobile network config')
  }
}

/** The string literals of `val <name> = listOf(...)` in the Kotlin source. */
function kotlinList(source: string, name: string) {
  const body = source.match(new RegExp(`val ${name} = listOf\\(([^)]*)\\)`))?.[1]
  if (!body) throw new Error(`listOf ${name} not found`)
  return [...body.matchAll(/"([^"]+)"/g)].map(match => match[1]!)
}

describe('Cloudflare edge fallback native wiring', () => {
  test('the module that MainApplication imports is linked into Android builds only', () => {
    expect(autolinkedProjects('android')).toContainEqual({
      packageName: 'cchaha-network',
      name: 'cchaha-network',
      sourceDir: join(root, moduleDir),
    })
    expect(autolinkedProjects('apple').map(project => project.packageName)).not.toContain('cchaha-network')
  }, 40000)

  test('the module still exposes what the generated MainApplication calls', () => {
    expect(edgeSource).toMatch(/@JvmStatic\s+fun install\(context: Context\)/)
    expect(edgeSource).toMatch(/@JvmStatic\s+fun configureWebSocket\(builder: OkHttpClient\.Builder\): OkHttpClient\.Builder/)
    // Fetch, XHR and images share one factory: React Native's default builder plus the DNS and a finite connect timeout.
    expect(edgeSource).toContain('OkHttpClientProvider.setOkHttpClientFactory {')
    expect(edgeSource).toContain('configure(OkHttpClientProvider.createClientBuilder().cache(cache)).build()')
    expect(edgeSource).toContain('configure(builder).cache(null)')
    expect(edgeSource).toMatch(/\.dns\(dns\)\s+\.socketFactory\(sockets\)\s+\.connectTimeout\(CONNECT_TIMEOUT_SECONDS, TimeUnit\.SECONDS\)/)
    expect(edgeSource).toContain('private const val CONNECT_TIMEOUT_SECONDS = 5L')
  })

  test('expo/fetch and React Native networking still build their clients through the replaceable factory', () => {
    const provider = read('node_modules/react-native/ReactAndroid/src/main/java/com/facebook/react/modules/network/OkHttpClientProvider.kt')
    expect(provider).toContain('return factory?.createNewNetworkModuleClient() ?: createClientBuilder(context).build()')
    expect(provider).toContain('return client ?: createClient().also { client = it }')
    // ExpoFetchModule casts the jar; the factory must keep React Native's container.
    expect(provider).toMatch(/fun createClientBuilder\(\): OkHttpClient\.Builder \{[^}]*\.cookieJar\(ReactCookieJarContainer\(\)\)/)
    const fetch = read('node_modules/expo/android/src/main/java/expo/modules/fetch/ExpoFetchModule.kt')
    expect(fetch).toContain('OkHttpClientProvider.createClient(reactContext)')
    expect(fetch).toContain('client.cookieJar as CookieJarContainer')
    const webSocket = read('node_modules/react-native/ReactAndroid/src/main/java/com/facebook/react/modules/websocket/WebSocketModule.kt')
    expect(webSocket).toMatch(/OkHttpClientProvider\.getOkHttpClient\(\)\s+\.newBuilder\(\)/)
  })

  test('release shrinking keeps the fallback', () => {
    expect(read(`${moduleDir}/build.gradle`)).toContain("consumerProguardFiles 'proguard-rules.pro'")
    expect(read(`${moduleDir}/proguard-rules.pro`)).toContain('-keep class app.cchaha.network.** { *; }')
  })

  test('every built-in alternate is a Cloudflare address, in both families', () => {
    const ranges = new BlockList()
    for (const cidr of kotlinList(raceSource, 'ranges')) {
      const [network, prefix] = cidr.split('/')
      ranges.addSubnet(network!, Number(prefix), network!.includes(':') ? 'ipv6' : 'ipv4')
    }
    const alternates = kotlinList(raceSource, 'alternateLiterals')
    expect(new Set(alternates).size).toBe(alternates.length)
    for (const address of alternates)
      expect([address, ranges.check(address, address.includes(':') ? 'ipv6' : 'ipv4')]).toEqual([address, true])
    expect(alternates.some(address => address.includes(':'))).toBe(true)
    expect(alternates.some(address => !address.includes(':'))).toBe(true)
    expect(ranges.check('1.1.1.1', 'ipv4')).toBe(false)
    expect(ranges.check('192.168.1.20', 'ipv4')).toBe(false)
  })
})
