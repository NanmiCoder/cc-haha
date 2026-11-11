import { mergeConfig, type ViteDevServer } from 'vite'
import desktopConfig from '../../../vite.config'

// Public-runtime detection needs /remote. Keep that URL inside the fixture on
// history navigation/reload, so it can never load the application's bootstrap.
export default mergeConfig(desktopConfig, {
  server: { hmr: false },
  plugins: [{
    name: 'mobile-chat-fixture-route',
    configureServer(server: ViteDevServer) {
      server.middlewares.use((request, _response, next) => {
        if (request.url?.startsWith('/remote/mobile-chat-fixture')) {
          request.url = request.url.replace('/remote/mobile-chat-fixture', '/scripts/fixtures/mobile-chat/index.html')
        }
        next()
      })
    },
  }],
})
