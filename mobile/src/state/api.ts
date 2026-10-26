import { fetch as expoFetch } from 'expo/fetch'
import { ApiClient } from '../core/client'
import type { Host } from '../core/types'

// Explicitly use Expo's native transport: RN's legacy fetch may follow redirects.
export function createApiClient(host: Host, credential: string) {
  return new ApiClient(host, credential, {
    fetch: (input, options) => expoFetch(input, options),
  })
}
