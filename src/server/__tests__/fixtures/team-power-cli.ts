// Real subprocess/SDK protocol fixture. All provider requests stay on loopback.
const args = process.argv.slice(2)
const arg = (name: string) => args[args.indexOf(name) + 1]
const agent = args.includes('--agent-name') ? arg('--agent-name') : 'lead'
const sdk = new WebSocket(arg('--sdk-url'))
let permissionResolved: (() => void) | undefined

sdk.onmessage = async event => {
  for (const line of String(event.data).trim().split('\n')) {
    const message = JSON.parse(line)
    if (message.type === 'control_request') {
      sdk.send(JSON.stringify({
        type: 'control_response',
        response: { subtype: 'success', request_id: message.request_id, response: {} },
      }))
    } else if (message.type === 'control_response') {
      if (message.response?.request_id === 'fixture-permission') permissionResolved?.()
    } else if (message.type === 'user') {
      sdk.send(JSON.stringify({ type: 'system', subtype: 'session_state_changed', state: 'running' }))
      const url = new URL(process.env.ANTHROPIC_BASE_URL!)
      if (url.hostname !== '127.0.0.1') throw new Error('Fixture refuses non-loopback upstream')
      const response = await fetch(url, {
        method: 'POST',
        body: JSON.stringify({ agent, prompt: message.message?.content }),
      })
      const text = await response.text()
      if (sdk.readyState !== WebSocket.OPEN) continue
      if (text === 'FIXTURE_PERMISSION') {
        await new Promise<void>(resolve => {
          permissionResolved = resolve
          sdk.send(JSON.stringify({
            type: 'control_request', request_id: 'fixture-permission',
            request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'fixture' } },
          }))
        })
        if (sdk.readyState !== WebSocket.OPEN) continue
      }
      const failed = text.startsWith('FIXTURE_ERROR:')
      sdk.send(JSON.stringify({
        type: 'result',
        subtype: 'success',
        ...(failed ? { is_error: true } : {}),
        result: failed ? text.slice('FIXTURE_ERROR:'.length) : text,
      }))
      sdk.send(JSON.stringify({ type: 'system', subtype: 'session_state_changed', state: 'idle' }))
    }
  }
}
