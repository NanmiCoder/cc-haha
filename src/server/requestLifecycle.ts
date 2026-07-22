const CLIENT_CLOSED_REQUEST_STATUS = 499

function clientClosedResponse(): Response {
  return new Response(null, { status: CLIENT_CLOSED_REQUEST_STATUS })
}

export async function settleResponseOnRequestAbort(
  request: Request,
  operation: Promise<Response>,
): Promise<Response> {
  if (request.signal.aborted) return clientClosedResponse()

  let resolveAborted!: (response: Response) => void
  const aborted = new Promise<Response>(resolve => {
    resolveAborted = resolve
  })
  const onAbort = () => resolveAborted(clientClosedResponse())
  request.signal.addEventListener('abort', onAbort, { once: true })

  try {
    return await Promise.race([operation, aborted])
  } finally {
    request.signal.removeEventListener('abort', onAbort)
  }
}
