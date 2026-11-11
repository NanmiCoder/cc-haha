const { withMainApplication } = require('expo/config-plugins')

// In order; missing ones go before the first one already present.
const imports = [
  'import app.cchaha.network.CloudflareEdge',
  'import com.facebook.react.modules.websocket.WebSocketModule',
]
const startMarker = '// cc-haha: native network policy (begin)'
const endMarker = '// cc-haha: native network policy (end)'
// The block generated before the Cloudflare edge fallback. `expo prebuild`
// without --clean edits the existing MainApplication, so it is upgraded in place.
const legacyStartMarker = '// cc-haha: pinned WebSocket origin (begin)'
const legacyEndMarker = '// cc-haha: pinned WebSocket origin (end)'
const failure = (detail) =>
  new Error(
    `withPinnedWebSockets: ${detail}. Refusing to generate Android with redirectable WebSockets or without the Cloudflare edge fallback.`
  )
const count = (source, text) => source.split(text).length - 1

/**
 * Before React starts: pin Android's native WebSocket to its requested
 * endpoint, and route React Native's HTTP and WebSocket clients through the
 * Cloudflare edge fallback in `modules/cchaha-network`.
 */
function pinWebSockets(source, language) {
  if (language !== 'kt')
    throw failure('Only the Expo Kotlin MainApplication template is supported')
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const anchors = [
    ...source.matchAll(
      /^([ \t]*)override fun onCreate\(\) \{[ \t]*\r?\n([ \t]*)super\.onCreate\(\)[ \t]*(?=\r?$)/gm
    ),
  ]
  if (
    anchors.length !== 1 ||
    !/^class MainApplication : Application\(\), ReactApplication \{/m.test(
      source
    )
  )
    throw failure('Unrecognized MainApplication.onCreate template')
  const anchor = anchors[0]
  const indent = anchor[2]
  const placed = (lines) =>
    [anchor[0], ...lines.map((line) => `${indent}${line}`)].join(eol)
  const block = placed([
    startMarker,
    'CloudflareEdge.install(this)',
    'WebSocketModule.setCustomClientBuilder { builder ->',
    '  builder.followRedirects(false)',
    '  builder.followSslRedirects(false)',
    '  CloudflareEdge.configureWebSocket(builder)',
    '}',
    endMarker,
  ])
  const legacyBlock = placed([
    legacyStartMarker,
    'WebSocketModule.setCustomClientBuilder { builder ->',
    '  builder.followRedirects(false)',
    '  builder.followSslRedirects(false)',
    '}',
    legacyEndMarker,
  ])
  const importLines = imports.map((line) => {
    const name = line.slice('import '.length).replace(/\./g, '\\.')
    const found =
      source.match(new RegExp(`^import ${name}\\b[^\\r\\n]*`, 'gm')) ?? []
    if (found.length > 1 || (found.length === 1 && found[0] !== line))
      throw failure(`Conflicting ${line.split('.').pop()} import`)
    return found.length === 1
  })
  if (/\bsetOkHttpClientFactory\b/.test(source))
    throw failure('Another OkHttp client factory already exists')

  let result = source
  if (
    result.includes(legacyStartMarker) ||
    result.includes(legacyEndMarker)
  ) {
    if (
      count(result, legacyStartMarker) !== 1 ||
      count(result, legacyEndMarker) !== 1 ||
      count(result, 'setCustomClientBuilder') !== 1 ||
      result.includes(startMarker) ||
      !result.includes(legacyBlock)
    )
      throw failure('Existing WebSocket policy was modified or moved')
    result = result.replace(legacyBlock, () => block)
  }
  const setters = count(result, 'setCustomClientBuilder')
  if (result.includes(startMarker) || result.includes(endMarker)) {
    if (
      count(result, startMarker) !== 1 ||
      count(result, endMarker) !== 1 ||
      setters !== 1 ||
      !result.includes(block)
    )
      throw failure('Existing network policy was modified or moved')
  } else {
    if (setters)
      throw failure('Another custom WebSocket client builder already exists')
    result = result.replace(anchor[0], () => block)
  }

  const missing = imports.filter((_, index) => !importLines[index])
  if (missing.length) {
    const present = imports.find((_, index) => importLines[index])
    if (present) {
      result = result.replace(present, () =>
        [...missing, present].join(eol)
      )
    } else {
      const packages = [
        ...result.matchAll(
          /^package [A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*[ \t]*(?=\r?$)/gm
        ),
      ]
      if (packages.length !== 1)
        throw failure('Unrecognized Kotlin package declaration')
      result = result.replace(packages[0][0], () =>
        [packages[0][0], '', ...missing].join(eol)
      )
    }
  }
  return result
}

function withPinnedWebSockets(config) {
  return withMainApplication(config, (config) => {
    config.modResults.contents = pinWebSockets(
      config.modResults.contents,
      config.modResults.language
    )
    return config
  })
}

module.exports = withPinnedWebSockets
module.exports.pinWebSockets = pinWebSockets
