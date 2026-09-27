const actions = new Set(['list', 'read', 'create', 'send', 'wait'])

export function collaborationToolAction(pathname: string): string | null {
  const match = /^\/api\/session-collaboration\/([^/]+)$/.exec(pathname)
  return match && actions.has(match[1]!) ? match[1]! : null
}

export function authenticateCollaborationCaller(
  request: Request,
  authorize: (sessionId: string, token: string) => boolean,
): string | null {
  if (request.method !== 'POST' || request.headers.has('origin')) return null
  const sessionId = request.headers.get('x-session-id')
  const authorization = request.headers.get('authorization')
  if (!sessionId || !authorization?.startsWith('Bearer ')) return null
  return authorize(sessionId, authorization.slice(7)) ? sessionId : null
}
