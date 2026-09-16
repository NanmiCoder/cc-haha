import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { ALL_CONNECTORS, CONNECTORS, getConnectorDefinition } from './catalog.js'
import { REMOTE_CONNECTORS, REMOTE_RECIPES } from './remoteCatalog.js'
import { buildRemotePlugin } from './remoteConnector.js'

// These hosts and path quirks were independently checked against vendor docs.
const officialEndpoints: Record<string, string> = {
  qingflow: 'https://mcp.qingflow.com/mcp',
  qcc: 'https://agent.qcc.com/mcp/company/stream',
  xmind: 'https://app.xmind.cn/api/mcp',
  kuaicha: 'https://bizveris.kuaicha365.com/mcp',
  qveris: 'https://mcp.qveris.cn/mcp',
  listinggood: 'https://listinggood.cn/mcp',
  bazhuayu: 'https://mcp.bazhuayu.com',
  variflight: 'https://c-gw.variflight.com/chat_message/mcp/api',
  jufa: 'https://www.jufaai.com/mcp/case',
  sorftime: 'https://mcp.sorftime.com/',
  intercom: 'https://mcp.intercom.com/mcp',
  neon: 'https://mcp.neon.tech/mcp',
  cloudflare: 'https://mcp.cloudflare.com/mcp',
  firecrawl: 'https://mcp.firecrawl.dev/v2/mcp',
  clickup: 'https://mcp.clickup.com/mcp',
  miro: 'https://mcp.miro.com',
  postman: 'https://mcp.postman.com/minimal',
  render: 'https://mcp.render.com/mcp',
  airtable: 'https://mcp.airtable.com/mcp',
  atlassian: 'https://mcp.atlassian.com/v2/mcp',
  webflow: 'https://mcp.webflow.com/mcp',
  todoist: 'https://ai.todoist.net/mcp',
  'tencent-docs': 'https://docs.qq.com/openapi/mcp',
  jinshuju: 'https://jinshuju.net/mcp',
  pkulaw: 'https://apim-gateway.pkulaw.com/mcp-law-search-service',
  datayes: 'https://dataapi-mcp-server.datayes.com/stock-mkt/mcp',
  'tencent-search': 'https://api.wsa.cloud.tencent.com/Mcp',
  amap: 'https://mcp.amap.com/mcp',
  'baidu-maps': 'https://mcp.map.baidu.com/mcp',
  'tencent-maps': 'https://mcp.map.qq.com/mcp?format=0',
  'zhipu-search': 'https://open.bigmodel.cn/api/mcp/web_search_prime/mcp',
  notion: 'https://mcp.notion.com/mcp', linear: 'https://mcp.linear.app/mcp',
  github: 'https://api.githubcopilot.com/mcp/', context7: 'https://mcp.context7.com/mcp',
  sentry: 'https://mcp.sentry.dev/mcp', tavily: 'https://mcp.tavily.com/mcp/',
  exa: 'https://mcp.exa.ai/mcp', supabase: 'https://mcp.supabase.com/mcp',
  huggingface: 'https://huggingface.co/mcp', canva: 'https://mcp.canva.com/mcp',
  figma: 'https://mcp.figma.com/mcp', stripe: 'https://mcp.stripe.com',
}

test('all 54 services and tool packages have unique plugin identities and packaged icons', () => {
  expect(CONNECTORS).toHaveLength(3)
  expect(REMOTE_CONNECTORS).toHaveLength(43)
  expect(ALL_CONNECTORS).toHaveLength(54)
  expect(new Set(ALL_CONNECTORS.map(item => item.id)).size).toBe(54)
  expect(new Set(ALL_CONNECTORS.map(item => item.pluginId)).size).toBe(54)
  for (const def of ALL_CONNECTORS) {
    expect(getConnectorDefinition(def.id)).toEqual(def)
    expect(def.pluginId).toBe(`office-${def.id}@haha-connectors`)
    const icon = readFileSync(new URL(`../../../desktop/public/connectors/${def.id}.svg`, import.meta.url), 'utf8')
    expect(icon).toContain('<svg')
    expect(icon).not.toMatch(/<script|\bonload\s*=|\bonerror\s*=/i)
  }
})

test('remote recipes preserve official endpoints and generate only credential placeholders', () => {
  expect(REMOTE_RECIPES.map(item => item.id).sort()).toEqual(Object.keys(officialEndpoints).sort())
  for (const recipe of REMOTE_RECIPES) {
    expect(recipe.endpoint).toBe(officialEndpoints[recipe.id])
    expect(recipe.transport).toBe('http')
    const def = getConnectorDefinition(recipe.id)!
    expect(def.homepage).toStartWith('https://')
    expect(def.credentialMode).toBe('isolated')
    const plugin = buildRemotePlugin(recipe)
    const config = plugin.mcpConfig.mcpServers.service
    if (recipe.auth.type === 'api-key') {
      expect(def.setupFields).toEqual([{ key: 'apiKey', label: 'API Key / Token', secret: true }])
      expect(plugin.manifest.userConfig?.apiKey.sensitive).toBe(true)
      if (recipe.auth.in === 'header') {
        expect(config.url).toBe(recipe.endpoint)
        expect(config.headers).toEqual({ [recipe.auth.name]: `${recipe.auth.prefix ?? ''}\${user_config.apiKey}` })
      } else {
        expect(config.url).toContain(`${recipe.auth.name}=\${user_config.apiKey}`)
        expect(config.headers).toBeUndefined()
      }
    } else {
      expect(def.setupFields).toBeUndefined()
      expect(config.url).toBe(recipe.endpoint)
      expect(config.headers).toBeUndefined()
    }
  }
  expect(REMOTE_RECIPES.find(item => item.id === 'tencent-docs')?.auth).toEqual({ type: 'api-key', in: 'header', name: 'Authorization' })
  expect(REMOTE_RECIPES.find(item => item.id === 'github')?.auth).toMatchObject({ type: 'api-key', prefix: 'Bearer ' })
})
