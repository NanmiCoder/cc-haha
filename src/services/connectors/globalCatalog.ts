import type { RemoteCatalogEntry } from './remoteCatalog.js'

// Vendor-owned endpoints verified in research.md; credentials are never catalog data.
export const GLOBAL_ENTRIES: RemoteCatalogEntry[] = [
  {
    "id": "intercom",
    "name": "Intercom",
    "category": "office",
    "description": "Search customer conversations, contacts and help content.",
    "example": "Summarize common questions in recent customer feedback.",
    "requirements": "US-hosted workspaces only. Requires an access token with contact, conversation and article permissions.",
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
    "description": "Inspect database projects, branches and development schemas.",
    "example": "Inspect my Neon development database schema without changing data.",
    "requirements": "Requires a Neon API Key and project access. The provider recommends development and test databases.",
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
    "description": "Inspect and manage websites, networking and cloud resources.",
    "example": "Review my Cloudflare resources and summarize their configuration.",
    "requirements": "Requires a user or account API Token with the necessary resource permissions. Deployments and configuration changes require an explicit task.",
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
    "description": "Search the web and extract pages for research.",
    "example": "Find technical resources on browser automation and keep source links.",
    "requirements": "Requires a Firecrawl API Key. Usage is billed against the account quota; the key is sent in a secure request header.",
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
    "description": "Find projects, tasks and team work materials.",
    "example": "List unfinished ClickUp tasks assigned to me.",
    "requirements": "Requires a ClickUp account and workspace access, authorized in the browser. The service is in public beta.",
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
    "description": "Review collaborative boards and organize design discussions.",
    "example": "Summarize the ideas and action items on a Miro board I choose.",
    "requirements": "Requires a Miro account and board access. Organization administrators may need to enable MCP.",
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
    "description": "Find API workspaces, collections and development resources.",
    "example": "Find login-related APIs in my Postman workspace.",
    "requirements": "Authorize a US-region Postman account in the browser. This connector uses the minimal tool set; EU accounts need a separate API-key configuration.",
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
    "description": "Review deployed services, databases, logs and metrics.",
    "example": "Review recent Render service logs and summarize errors.",
    "requirements": "Requires a Render API Key. Select a workspace first. The key accesses workspaces you belong to; deployments require an explicit task.",
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
    "description": "Query tables, records and team information.",
    "example": "Review recently updated project records in Airtable.",
    "requirements": "Authorize workspaces or bases in the browser. Enterprise administrators may restrict client access.",
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
    "description": "Search Jira, Confluence and project collaboration content.",
    "example": "Summarize my Jira issues and link relevant Confluence pages.",
    "requirements": "Requires an Atlassian Cloud account and product access through browser authorization. Some products and operations need administrator enablement.",
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
    "description": "Read website structure, CMS content and design context.",
    "example": "Inspect CMS collections and fields on my Webflow site.",
    "requirements": "Requires a Webflow account with site access. OAuth installs the MCP Bridge App; Designer operations require the bridge connection.",
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
    "description": "Review tasks, projects and personal schedules.",
    "example": "List my overdue Todoist tasks and tasks due today.",
    "requirements": "Requires a Todoist account with browser authorization for tasks and projects.",
    "source": "https://developer.todoist.com/api/v1/",
    "endpoint": "https://ai.todoist.net/mcp",
    "auth": {
      "type": "oauth"
    },
    "region": "global"
  }
]
