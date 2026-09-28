import { buildTool, type ToolDef } from '../../Tool.js'
import { executeNetworkConfig, NetworkConfigInputSchema } from './networkConfigAccess.js'

const description = 'Find and diagnose cc-haha’s built-in Windows network configuration tool (网络配置、家庭网络、工作网络、固定 VPN 路由、IP 网段绑定、SakuraCat、主机连通性). List saved home/work profiles or managed hosts, inspect the actual route and configuration plan, and verify specified targets without changing network settings.'

export const NetworkConfigTool = buildTool({
  name: 'NetworkConfig',
  searchHint: '网络配置 家庭网络 工作网络 固定 VPN 路由 IP 网段绑定 SakuraCat 主机连通性 network configuration home office VPN route binding routing connectivity',
  alwaysLoad: true,
  maxResultSizeChars: 40000,
  inputSchema: NetworkConfigInputSchema,
  userFacingName: () => 'NetworkConfig',
  isEnabled: () => true,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async description() { return description },
  async prompt() {
    return `${description}\nUse action=locate to identify the desktop entry next to Host management. The desktop VPN stage also has a fixed Windows VPN destination binding workflow for an IP or CIDR: choose an existing VPN, preview route conflicts, apply the reviewed binding, then verify actual route selection. SakuraCat DIRECT rules do not create Windows routes. Use list_profiles before inspect_profile or verify_profile; use list_hosts before probe_host. Verification makes bounded outbound TCP/HTTPS probes only to saved profile targets or managed hosts. Never infer VPN connectivity from a saved profile or TCP success from configuration alone. Configuration changes, login and rollback use the desktop tool's reviewed plan workflow. Do not invent credentials or replace this tool with broad shell-based route changes.`
  },
  renderToolUseMessage: () => null,
  async call(input) { return { data: await executeNetworkConfig(input) } },
  mapToolResultToToolResultBlockParam(data, toolUseID) {
    return { tool_use_id: toolUseID, type: 'tool_result', content: JSON.stringify(data) }
  },
} satisfies ToolDef<typeof NetworkConfigInputSchema, Record<string, unknown>>)
