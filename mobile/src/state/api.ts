import { fetch as expoFetch } from 'expo/fetch'
import { ApiClient } from '../core/client'
import type { Host } from '../core/types'
import { isH5 } from './h5'

/** The H5 page's requests carry the remote device cookie; nothing else sends cookies. */
export const fetchCredentials = isH5 ? 'same-origin' : 'omit'

// Explicitly use Expo's native transport: RN's legacy fetch may follow redirects.
export function createApiClient(host: Host, credential: string) {
  return new ApiClient(host, credential, {
    fetch: (input, options) => expoFetch(input, options),
    credentials: fetchCredentials,
  })
}
