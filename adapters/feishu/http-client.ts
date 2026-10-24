import { defaultHttpInstance, type HttpInstance, type HttpRequestOptions } from '@larksuiteoapi/node-sdk'
import { FeishuProxyAgent } from './proxy-agent.js'

/** Keep the SDK's serializers, streams and response interceptors, while making
 * HTTPS proxy requests use CONNECT. Axios otherwise sends an absolute HTTPS
 * URL as an ordinary HTTP request, which the desktop proxy bridge rejects. */
export function createFeishuHttpClient(): HttpInstance {
  // Resolve proxy/NO_PROXY for every request, including each redirect target.
  const request: HttpInstance['request'] = <T, R = T, D = unknown>(options: HttpRequestOptions<D>) => {
    const controller = new AbortController()
    const agent = new FeishuProxyAgent(options, controller)
    // These Axios cancellation options are accepted by the SDK at runtime even
    // though its narrower HttpRequestOptions type does not expose them.
    const { signal, cancelToken } = options as typeof options & {
      signal?: AbortSignal
      cancelToken?: {
        reason?: unknown
        subscribe: (listener: () => void) => void
        unsubscribe: (listener: () => void) => void
      }
    }
    const cancel = () => controller.abort()
    signal?.addEventListener('abort', cancel, { once: true })
    cancelToken?.subscribe(cancel)
    if (signal?.aborted || cancelToken?.reason) cancel()
    return defaultHttpInstance.request<T, R, D>({
      ...options, proxy: false, httpAgent: agent, httpsAgent: agent,
    }).catch(error => {
      if (agent.timeoutError) {
        // The underlying socket reports AbortError after its signal is aborted;
        // retain Axios's public timeout code and message for callers/retries.
        error.code = agent.timeoutError.code
        error.message = agent.timeoutError.message
      }
      throw error
    }).finally(() => {
      signal?.removeEventListener('abort', cancel)
      cancelToken?.unsubscribe(cancel)
    })
  }

  return {
    request,
    get: (url, options) => request({ ...options, method: 'GET', url }),
    delete: (url, options) => request({ ...options, method: 'DELETE', url }),
    head: (url, options) => request({ ...options, method: 'HEAD', url }),
    options: (url, options) => request({ ...options, method: 'OPTIONS', url }),
    post: (url, data, options) => request({ ...options, method: 'POST', url, data }),
    put: (url, data, options) => request({ ...options, method: 'PUT', url, data }),
    patch: (url, data, options) => request({ ...options, method: 'PATCH', url, data }),
  }
}
