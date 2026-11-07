const { withAndroidManifest } = require('expo/config-plugins')

/**
 * The app uses react-native-webrtc only for data channels to the paired
 * computer. Its library manifest also declares a screen-capture foreground
 * service we never start; drop it so the merged manifest asks for nothing new.
 * (The library's own Expo plugin is deliberately not used: it adds camera,
 * microphone, Bluetooth and overlay permissions meant for video calls.)
 */
const SERVICE = 'com.oney.WebRTCModule.MediaProjectionService'

function withWebRtcDataChannels(config) {
  return withAndroidManifest(config, (next) => {
    const manifest = next.modResults.manifest
    manifest.$ = { ...manifest.$, 'xmlns:tools': 'http://schemas.android.com/tools' }
    const application = manifest.application?.[0]
    if (!application) throw new Error('withWebRtcDataChannels: AndroidManifest has no <application>')
    const services = (application.service ?? []).filter((service) => service.$['android:name'] !== SERVICE)
    services.push({ $: { 'android:name': SERVICE, 'tools:node': 'remove' } })
    application.service = services
    return next
  })
}

module.exports = withWebRtcDataChannels
