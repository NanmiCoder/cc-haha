function isAllowedApiPath(method: string, pathname: string): boolean {
  if (method === 'GET' && pathname === '/api/usage-summary') return true
  if (method === 'GET' && pathname === '/api/desktop-ui/preferences/usage-widget') return true
  if (method === 'PUT' && pathname === '/api/desktop-ui/preferences/usage-widget') return true
  return false
}

/**
 * The floating usage-widget token is intentionally narrower than the desktop
 * local-access token. It can only read the aggregated usage summary and
 * read/update usage-widget preferences. Every other endpoint fails closed.
 */
export function isUsageWidgetHttpRequestAllowed(request: Request, url: URL): boolean {
  if (request.method === 'GET' && url.pathname === '/health') return true
  if (request.method === 'OPTIONS') {
    const requestedMethod = request.headers.get('Access-Control-Request-Method')?.toUpperCase()
    return requestedMethod ? isAllowedApiPath(requestedMethod, url.pathname) : false
  }
  return isAllowedApiPath(request.method, url.pathname)
}
