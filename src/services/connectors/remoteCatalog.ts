import type { ConnectorCategory, ConnectorDefinition } from './types.js'
import type { RemoteConnectorRecipe } from './types.js'
import { DOMESTIC_ENTRIES } from './domesticCatalog.js'
import { GLOBAL_ENTRIES } from './globalCatalog.js'

export type RemoteCatalogEntry = {
  region?: 'china' | 'global',
  id: string, name: string, category: ConnectorCategory, description: string, example: string,
  requirements: string, source: string, endpoint: string, auth: RemoteConnectorRecipe['auth'],
}
const keyQuery = (name: string): RemoteConnectorRecipe['auth'] => ({ type: 'api-key', in: 'query', name })
const bearer: RemoteConnectorRecipe['auth'] = { type: 'api-key', in: 'header', name: 'Authorization', prefix: 'Bearer ' }
const oauth: RemoteConnectorRecipe['auth'] = { type: 'oauth' }
const anonymous: RemoteConnectorRecipe['auth'] = { type: 'none' }

// Only official endpoints documented in research.md. No third-party gateway,
// guessed addresses, credentials, or background business calls belong here.
const entries: RemoteCatalogEntry[] = [
  { id: 'tencent-docs', name: '腾讯文档', category: 'office', description: '读取和整理在线文档、表格与协作资料。', example: '查找腾讯文档中与项目计划相关的资料。', requirements: '需要腾讯文档 MCP 访问令牌；仅可访问账号已有权限的文档。', source: 'https://developer.cloud.tencent.com.cn/mcp/server/11803', endpoint: 'https://docs.qq.com/openapi/mcp', auth: { type: 'api-key', in: 'header', name: 'Authorization' } },
  { id: 'jinshuju', name: '金数据', category: 'productivity', description: '查询表单与收集的数据，辅助统计和整理。', example: '查看金数据中最近收集的问卷结果并整理摘要。', requirements: '需要金数据账号，通过浏览器授权表单与数据访问权限。', source: 'https://open.jinshuju.net/mcp/oauth/', endpoint: 'https://jinshuju.net/mcp', auth: oauth },
  { id: 'pkulaw', name: '北大法宝', category: 'legal', description: '检索法律法规，追溯法律条文和原始出处。', example: '检索与劳动合同试用期相关的法律条文并注明出处。', requirements: '需要北大法宝 MCP access token 及相应资料权限；检索结果需核对现行有效性。', source: 'https://mcp.pkulaw.com/docs', endpoint: 'https://apim-gateway.pkulaw.com/mcp-law-search-service', auth: bearer },
  { id: 'datayes', name: '通联数据', category: 'finance', description: '查询股票行情与金融市场数据，辅助研究。', example: '查询我指定股票的历史行情并整理数据来源。', requirements: '需要通联数据 MCP Token；数据范围受账号权限和额度限制，企业账户需按服务商要求核验。', source: 'https://mcp.datayes.com/#/manual', endpoint: 'https://dataapi-mcp-server.datayes.com/stock-mkt/mcp', auth: bearer },
  { id: 'tencent-search', name: '腾讯云智能搜索', category: 'search', description: '检索网络资料，为研究提供可追溯信息。', example: '搜索国内低空经济产业发展资料，并整理官方来源。', requirements: '需要开通腾讯云 WSA 服务并获取 API Key，调用按账号额度与计费规则执行。', source: 'https://developer.cloud.tencent.com/mcp/server/11764', endpoint: 'https://api.wsa.cloud.tencent.com/Mcp', auth: bearer },
  { id: 'amap', name: '高德地图', category: 'maps', description: '搜索地点、规划路线，查询天气与出行信息。', example: '帮我规划从杭州东站到西湖的公共交通路线。', requirements: '需要高德开放平台 Web 服务 API Key；地图服务按账号权限和配额提供。', source: 'https://developer.amap.com/api/mcp-server/gettingstarted', endpoint: 'https://mcp.amap.com/mcp', auth: keyQuery('key') },
  { id: 'baidu-maps', name: '百度地图', category: 'maps', description: '地址解析、周边检索与路线规划。', example: '查询上海虹桥站附近的酒店和交通方式。', requirements: '需要百度地图开放平台服务器端 AK 及对应服务权限。', source: 'https://lbsyun.baidu.com/docs/ai?title=mcpserver%2Fquickstart', endpoint: 'https://mcp.map.baidu.com/mcp', auth: keyQuery('ak') },
  { id: 'tencent-maps', name: '腾讯地图', category: 'maps', description: '查询位置、距离和路线，辅助出行安排。', example: '比较广州南站到广州塔的公共交通与驾车路线。', requirements: '需要腾讯位置服务 Key，并开通 WebServiceAPI 权限与配额。', source: 'https://lbs.qq.com/service/MCPServer/MCPServerGuide/userGuide', endpoint: 'https://mcp.map.qq.com/mcp?format=0', auth: keyQuery('key') },
  { id: 'zhipu-search', name: '智谱联网搜索', category: 'search', description: '检索中文网页、新闻与实时信息，保留来源。', example: '搜索近期国内新能源汽车政策，并列出原始来源。', requirements: '需要 GLM Coding Plan 套餐 API Key；团队套餐密钥与平台通用密钥不通用。', source: 'https://docs.bigmodel.cn/cn/coding-plan/mcp/search-mcp-server', endpoint: 'https://open.bigmodel.cn/api/mcp/web_search_prime/mcp', auth: bearer },
  { id: 'notion', name: 'Notion', category: 'office', description: '搜索工作区资料，整理页面与项目知识。', example: '查找 Notion 中最近的项目周报并总结进展。', requirements: '需要 Notion 账号，浏览器授权后仅能访问该账号允许的工作区内容。', source: 'https://developers.notion.com/guides/mcp/get-started-with-mcp', endpoint: 'https://mcp.notion.com/mcp', auth: oauth },
  { id: 'linear', name: 'Linear', category: 'productivity', description: '查询问题、项目与迭代，跟进团队任务。', example: '列出 Linear 中分配给我的未完成问题。', requirements: '需要 Linear 工作区账号及相应项目访问权限，通过浏览器授权。', source: 'https://linear.app/docs/mcp', endpoint: 'https://mcp.linear.app/mcp', auth: oauth },
  { id: 'github', name: 'GitHub', category: 'development', description: '检索仓库代码、Issue 和 Pull Request。', example: '查看我的 GitHub 仓库中等待评审的 Pull Request。', requirements: '需要 GitHub Personal Access Token；按所需仓库与操作授予权限，组织策略仍然适用。', source: 'https://github.com/github/github-mcp-server/blob/main/docs/host-integration.md', endpoint: 'https://api.githubcopilot.com/mcp/', auth: bearer },
  { id: 'context7', name: 'Context7', category: 'development', description: '查阅软件库的最新文档与用法示例。', example: '查找 React useEffect 的官方文档和清理函数示例。', requirements: '使用官方匿名访问额度；不保证无限调用，额度不足时服务会返回限制。', source: 'https://github.com/upstash/context7/blob/master/server.json', endpoint: 'https://mcp.context7.com/mcp', auth: anonymous },
  { id: 'sentry', name: 'Sentry', category: 'development', description: '查看异常、追踪问题与应用运行信息。', example: '总结 Sentry 中最近一天新出现的错误。', requirements: '需要 Sentry 账号及组织、项目权限，通过浏览器授权。', source: 'https://mcp.sentry.dev/', endpoint: 'https://mcp.sentry.dev/mcp', auth: oauth },
  { id: 'tavily', name: 'Tavily', category: 'search', description: '搜索网页、提取内容，支持资料研究。', example: '研究开源向量数据库的主要差异，并给出来源。', requirements: '需要 Tavily API Key，调用按该账号订阅与额度计费。', source: 'https://docs.tavily.com/documentation/mcp', endpoint: 'https://mcp.tavily.com/mcp/', auth: keyQuery('tavilyApiKey') },
  { id: 'exa', name: 'Exa', category: 'search', description: '搜索网页与代码资料，发现相关信息。', example: '寻找关于分布式系统可观测性的技术文章。', requirements: '使用官方基础匿名访问额度；可用工具和次数由服务商决定。', source: 'https://exa.ai/docs/reference/exa-mcp', endpoint: 'https://mcp.exa.ai/mcp', auth: anonymous },
  { id: 'supabase', name: 'Supabase', category: 'data', description: '查看项目、数据库结构和开发资料。', example: '查看 Supabase 项目的数据表结构，不修改数据。', requirements: '需要 Supabase 账号及目标组织、项目权限；数据库写操作仍需明确任务授权。', source: 'https://supabase.com/docs/guides/ai-tools/mcp', endpoint: 'https://mcp.supabase.com/mcp', auth: oauth },
  { id: 'huggingface', name: 'Hugging Face', category: 'data', description: '发现模型、数据集与机器学习研究资源。', example: '寻找适合中文文本分类的公开模型与数据集。', requirements: '需要 Hugging Face 访问令牌；检索建议仅授予 read 权限，计算任务可能另行收费。', source: 'https://github.com/huggingface/hf-mcp-server', endpoint: 'https://huggingface.co/mcp', auth: bearer },
  { id: 'canva', name: 'Canva', category: 'design', description: '搜索和整理设计素材，协作处理设计内容。', example: '查找 Canva 中最近的品牌设计素材。', requirements: '每位用户使用自己的 Canva 账号授权；部分能力受订阅和团队权限限制。', source: 'https://www.canva.dev/docs/mcp/', endpoint: 'https://mcp.canva.com/mcp', auth: oauth },
  { id: 'figma', name: 'Figma', category: 'design', description: '读取设计上下文，理解组件与界面结构。', example: '分析我提供的 Figma 设计链接中的组件结构。', requirements: '需要 Figma 账号授权；设计访问权限、席位和套餐决定可用工具及次数。', source: 'https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/', endpoint: 'https://mcp.figma.com/mcp', auth: oauth },
  { id: 'stripe', name: 'Stripe', category: 'finance', description: '查询客户、账单和支付业务资料。', example: '查看 Stripe 中最近的账单概况，不创建支付或退款。', requirements: '需要 Stripe 账号授权。该官方服务为预览版；付款、退款等写操作需要明确任务授权。', source: 'https://docs.stripe.com/mcp', endpoint: 'https://mcp.stripe.com', auth: oauth },
]

const allEntries = [...entries, ...DOMESTIC_ENTRIES, ...GLOBAL_ENTRIES]
const domesticIds = new Set(['tencent-docs', 'jinshuju', 'pkulaw', 'datayes', 'tencent-search', 'amap', 'baidu-maps', 'tencent-maps', 'zhipu-search'])

export const REMOTE_RECIPES: RemoteConnectorRecipe[] = allEntries.map(entry => ({ id: entry.id, pluginId: `office-${entry.id}@haha-connectors`, version: '1.0.0', endpoint: entry.endpoint, transport: 'http', auth: entry.auth }))
export const REMOTE_CONNECTORS: ConnectorDefinition[] = allEntries.map(entry => ({
  id: entry.id, pluginId: `office-${entry.id}@haha-connectors`, version: '1.0.0', packageName: entry.name,
  collection: 'services', region: entry.region ?? (domesticIds.has(entry.id) ? 'china' : 'global'),
  homepage: entry.source, credentialMode: 'isolated', transport: 'mcp',
  platforms: ['darwin-arm64', 'darwin-x64', 'win32-x64', 'win32-arm64'],
  displayName: entry.name, description: entry.description, category: entry.category,
  capabilities: [entry.description], example: entry.example, requirements: entry.requirements,
  ...(entry.auth.type === 'api-key' ? { setupFields: [{ key: 'apiKey', label: 'API Key / Token', secret: true }] } : {}),
}))
export function getRemoteRecipe(id: string): RemoteConnectorRecipe | undefined { return REMOTE_RECIPES.find(recipe => recipe.id === id) }
