import type http from 'node:http'
import { ProxyAgent } from 'proxy-agent'

type RequestOptions = {
  timeout?: number
  timeoutErrorMessage?: string
  transitional?: { clarifyTimeoutError?: boolean }
}

/** Axios starts its socket timeout only after the agent finishes CONNECT.
 * Bound that pending handshake too, and give its socket a request-local signal. */
export class FeishuProxyAgent extends ProxyAgent {
  timeoutError?: Error & { code: string }

  constructor(private requestOptions: RequestOptions, private controller: AbortController) {
    super({ signal: controller.signal })
  }

  async connect(request: http.ClientRequest, options: Parameters<ProxyAgent['connect']>[1]): Promise<http.Agent> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const cleanup = () => {
      clearTimeout(timer)
      request.removeListener('socket', cleanup)
      request.removeListener('error', cleanup)
      request.removeListener('close', cancel)
    }
    const cancel = () => {
      cleanup()
      this.controller.abort()
    }
    request.once('socket', cleanup)
    request.once('error', cleanup)
    request.once('close', cancel)
    const timeout = Number(this.requestOptions.timeout)
    if (Number.isFinite(timeout) && timeout > 0) {
      timer = setTimeout(() => {
        this.timeoutError = Object.assign(new Error(
          this.requestOptions.timeoutErrorMessage ?? `timeout of ${timeout}ms exceeded`,
        ), {
          code: this.requestOptions.transitional?.clarifyTimeoutError ? 'ETIMEDOUT' : 'ECONNABORTED',
        })
        request.destroy(this.timeoutError)
        this.controller.abort(this.timeoutError)
        cleanup()
      }, timeout)
    }
    try {
      return await super.connect(request, options)
    } catch (error) {
      cleanup()
      throw error
    }
  }
}
