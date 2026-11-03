import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { AGENT_DESKTOP_COMMANDS } from './agentDesktopProtocol.js'

export function buildAgentDesktopTools(): Tool[] {
  return [{
    name: 'desktop',
    description: 'Operate native Windows or Linux desktop apps with agent-desktop. '
      + 'Before first use run command="skills", args=["get","desktop"], then ["get","platform"]. '
      + 'All 60 upstream commands are available; args is an argv array, never a shell command. '
      + 'Use args=["--help"] for a command. Observe with snapshot, act on the full snapshot-qualified ref, then verify. '
      + 'Example: {"command":"snapshot","args":["--app","APP","-i"]}. '
      + 'Ref actions default to semantic accessibility calls without moving the real pointer. '
      + 'headed=true permits shared physical input and focus changes; use only when required by the user task. '
      + 'Bare press, focus-window and clipboard commands can affect the user even without headed. '
      + 'Windows type needs headed; set-value is the background text path. '
      + 'Linux Wayland has no ordinary-app physical pointer path. '
      + 'Sessions, refs and the virtual cursor are managed by the host; they do not create isolated desktops. '
      + 'The virtual cursor is presentation only. Read delivery/retry dispositions; never blindly replay uncertain actions.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        command: { type: 'string', enum: [...AGENT_DESKTOP_COMMANDS] },
        args: { type: 'array', items: { type: 'string' }, maxItems: 256 },
        headed: { type: 'boolean', description: 'Allow physical input for this command. Defaults to false.' },
      },
      required: ['command'],
    },
  }]
}
