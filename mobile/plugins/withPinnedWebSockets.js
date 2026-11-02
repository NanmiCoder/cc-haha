const { withMainApplication } = require('expo/config-plugins')

const moduleImport =
  'import com.facebook.react.modules.websocket.WebSocketModule'
const startMarker = '// cc-haha: pinned WebSocket origin (begin)'
const endMarker = '// cc-haha: pinned WebSocket origin (end)'
const failure = (detail) =>
  new Error(
    `withPinnedWebSockets: ${detail}. Refusing to generate Android with redirectable WebSockets.`
  )

/** Pin Android's native WebSocket to its requested endpoint, before React starts. */
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
  const block = [
    `${indent}${startMarker}`,
    `${indent}WebSocketModule.setCustomClientBuilder { builder ->`,
    `${indent}  builder.followRedirects(false)`,
    `${indent}  builder.followSslRedirects(false)`,
    `${indent}}`,
    `${indent}${endMarker}`,
  ].join(eol)
  const importLines =
    source.match(
      /^import com\.facebook\.react\.modules\.websocket\.WebSocketModule[^\r\n]*/gm
    ) ?? []
  if (
    importLines.length > 1 ||
    (importLines.length === 1 && importLines[0] !== moduleImport)
  )
    throw failure('Conflicting WebSocketModule import')
  const setters = source.match(/\bsetCustomClientBuilder\b/g) ?? []
  if (source.includes(startMarker) || source.includes(endMarker)) {
    const startCount = source.split(startMarker).length - 1
    const endCount = source.split(endMarker).length - 1
    const expected = `${anchor[0]}${eol}${block}`
    if (
      startCount !== 1 ||
      endCount !== 1 ||
      setters.length !== 1 ||
      importLines.length !== 1 ||
      !source.includes(expected)
    )
      throw failure('Existing WebSocket policy was modified or moved')
    return source
  }
  if (setters.length)
    throw failure('Another custom WebSocket client builder already exists')
  const packages = [
    ...source.matchAll(
      /^package [A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*[ \t]*(?=\r?$)/gm
    ),
  ]
  if (packages.length !== 1)
    throw failure('Unrecognized Kotlin package declaration')
  let result =
    source.slice(0, anchor.index) +
    anchor[0] +
    eol +
    block +
    source.slice(anchor.index + anchor[0].length)
  if (!importLines.length)
    result = result.replace(
      packages[0][0],
      `${packages[0][0]}${eol}${eol}${moduleImport}`
    )
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
