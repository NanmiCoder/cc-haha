import type { RemoteCatalogEntry } from './remoteCatalog.js'

// Vendor-owned endpoints verified in research.md; credentials are never catalog data.
export const GLOBAL_ENTRIES: RemoteCatalogEntry[] = [
  {
    "id": "intercom",
    "name": "Intercom",
    "category": "office",
    "description": "检索客户对话、联系人和帮助中心资料。",
    "example": "查找最近客户反馈中的常见问题并汇总。",
    "requirements": "目前仅支持美国托管工作区；需要具有联系人、对话和文章权限的访问令牌。",
    "source": "https://developers.intercom.com/docs/guides/mcp",
    "endpoint": "https://mcp.intercom.com/mcp",
    "auth": {
      "type": "api-key",
      "in": "header",
      "name": "Authorization",
      "prefix": "Bearer "
    },
    "region": "global"
  },
  {
    "id": "neon",
    "name": "Neon",
    "category": "data",
    "description": "查看数据库项目、分支与开发数据结构。",
    "example": "查看 Neon 开发项目的数据库结构，不修改数据。",
    "requirements": "需要 Neon API Key 和项目权限；官方建议优先用于开发和测试数据库。",
    "source": "https://neon.com/docs/ai/neon-mcp-server",
    "endpoint": "https://mcp.neon.tech/mcp",
    "auth": {
      "type": "api-key",
      "in": "header",
      "name": "Authorization",
      "prefix": "Bearer "
    },
    "region": "global"
  },
  {
    "id": "cloudflare",
    "name": "Cloudflare",
    "category": "development",
    "description": "查询和管理网站、网络及云开发资源。",
    "example": "查看我的 Cloudflare 资源并汇总当前配置。",
    "requirements": "需要用户或账户 API Token；按所需资源授予权限，部署和配置变更需明确任务授权。",
    "source": "https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/",
    "endpoint": "https://mcp.cloudflare.com/mcp",
    "auth": {
      "type": "api-key",
      "in": "header",
      "name": "Authorization",
      "prefix": "Bearer "
    },
    "region": "global"
  },
  {
    "id": "firecrawl",
    "name": "Firecrawl",
    "category": "search",
    "description": "搜索网页、提取页面并整理研究资料。",
    "example": "搜索关于浏览器自动化的技术资料并保留来源。",
    "requirements": "需要 Firecrawl API Key；调用按账户额度计费，密钥通过安全请求头发送。",
    "source": "https://github.com/firecrawl/firecrawl-mcp-server",
    "endpoint": "https://mcp.firecrawl.dev/v2/mcp",
    "auth": {
      "type": "api-key",
      "in": "header",
      "name": "Authorization",
      "prefix": "Bearer "
    },
    "region": "global"
  },
  {
    "id": "clickup",
    "name": "ClickUp",
    "category": "productivity",
    "description": "查找项目、任务和团队工作资料。",
    "example": "列出 ClickUp 中分配给我的未完成任务。",
    "requirements": "需要 ClickUp 账号及工作区权限，通过浏览器授权；服务仍为公开测试版。",
    "source": "https://developer.clickup.com/docs/connect-an-ai-assistant-to-clickups-mcp-server-1",
    "endpoint": "https://mcp.clickup.com/mcp",
    "auth": {
      "type": "oauth"
    },
    "region": "global"
  },
  {
    "id": "miro",
    "name": "Miro",
    "category": "design",
    "description": "查阅协作白板，整理设计与讨论内容。",
    "example": "总结我指定 Miro 白板中的主要想法和待办。",
    "requirements": "需要 Miro 账号和白板访问权限，组织管理员可能需要启用 MCP。",
    "source": "https://developers.miro.com/docs/miro-mcp-server-frequently-asked-questions",
    "endpoint": "https://mcp.miro.com",
    "auth": {
      "type": "oauth"
    },
    "region": "global"
  },
  {
    "id": "postman",
    "name": "Postman",
    "category": "development",
    "description": "查询 API 工作区、集合与开发资料。",
    "example": "查找 Postman 工作区中与用户登录相关的 API。",
    "requirements": "使用美国区域 Postman 账号浏览器授权；此条目采用精简工具集，欧盟区域需单独 API Key 配置。",
    "source": "https://learning.postman.com/docs/reference/postman-api/postman-mcp-server/postman-mcp-remote-server",
    "endpoint": "https://mcp.postman.com/minimal",
    "auth": {
      "type": "oauth"
    },
    "region": "global"
  },
  {
    "id": "render",
    "name": "Render",
    "category": "development",
    "description": "查看部署服务、数据库、运行日志与指标。",
    "example": "查看 Render 服务最近的运行日志并总结异常。",
    "requirements": "需要 Render API Key；先指定工作区。密钥可访问本人所属工作区，部署等写操作需明确任务授权。",
    "source": "https://render.com/docs/mcp-server",
    "endpoint": "https://mcp.render.com/mcp",
    "auth": {
      "type": "api-key",
      "in": "header",
      "name": "Authorization",
      "prefix": "Bearer "
    },
    "region": "global"
  },
  {
    "id": "airtable",
    "name": "Airtable",
    "category": "data",
    "description": "查询数据表、记录与团队协作资料。",
    "example": "查看 Airtable 中最近更新的项目记录。",
    "requirements": "通过浏览器授权目标工作区或数据表；企业管理员可能限制客户端访问。",
    "source": "https://support.airtable.com/articles/9897799762-using-the-airtable-mcp-server",
    "endpoint": "https://mcp.airtable.com/mcp",
    "auth": {
      "type": "oauth"
    },
    "region": "global"
  },
  {
    "id": "atlassian",
    "name": "Atlassian",
    "category": "productivity",
    "description": "检索 Jira、Confluence 与项目协作资料。",
    "example": "汇总 Jira 中分配给我的问题并关联 Confluence 资料。",
    "requirements": "需要 Atlassian Cloud 账号及产品权限，通过浏览器授权；部分产品和操作需要管理员启用。",
    "source": "https://atlassian.github.io/atlassian-mcp-server/",
    "endpoint": "https://mcp.atlassian.com/v2/mcp",
    "auth": {
      "type": "oauth"
    },
    "region": "global"
  },
  {
    "id": "webflow",
    "name": "Webflow",
    "category": "design",
    "description": "读取网站结构、CMS 内容与设计资料。",
    "example": "查看我的 Webflow 网站中的 CMS 集合和字段。",
    "requirements": "需要至少一个可访问站点的 Webflow 账号；浏览器授权自动安装 MCP Bridge App，设计器操作需桥接应用连接。",
    "source": "https://developers.webflow.com/mcp/reference/getting-started",
    "endpoint": "https://mcp.webflow.com/mcp",
    "auth": {
      "type": "oauth"
    },
    "region": "global"
  },
  {
    "id": "todoist",
    "name": "Todoist",
    "category": "productivity",
    "description": "查看待办、项目和个人任务安排。",
    "example": "列出 Todoist 中今天到期和已经逾期的任务。",
    "requirements": "需要 Todoist 账号，通过浏览器授权任务和项目访问权限。",
    "source": "https://developer.todoist.com/api/v1/",
    "endpoint": "https://ai.todoist.net/mcp",
    "auth": {
      "type": "oauth"
    },
    "region": "global"
  }
]
