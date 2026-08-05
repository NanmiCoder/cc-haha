---
title: 接入校园舆情工作台
nav_title: 校园舆情
description: 在 cc-haha 中打开校园事件列表，并连接受信任的校园管理 MCP。
order: 10
---

# 接入校园舆情工作台

校园舆情工作台沿用现有「舆见 Agent」的事件列表和数据源；cc-haha 只提供入口与对话式 MCP 调用，不再复制一套看板。

## 启动校园工作台

在校园舆情仓库中启动后端和前端：

```bash
python -m trendradar serve --config config/campus.yaml --host 127.0.0.1 --port 8010

cd 前端
npm run dev
```

前端默认地址是 `http://127.0.0.1:3000/`，后端健康检查是 `http://127.0.0.1:8010/api/health`。

回到 cc-haha，点左侧边栏的「校园舆情」。它会在原生浏览器面板中打开现有的事件列表；地址栏仍可用于排查或切换到同一服务的其他页面。

## 连接管理 MCP

在「设置 → MCP」中添加一个服务：

| 字段 | 值 |
|---|---|
| 名称 | `campus-management` |
| 配置范围 | 全局用户 |
| 传输方式 | Streamable HTTP |
| URL | `http://127.0.0.1:8010/mcp/management` |

这个端点是受信任本机客户端使用的管理面：它提供核心事件查询以及已验证的事件维护写工具。Agent 的工具调用会立即写入校园工作台，事件列表刷新后即可看到结果。

如果校园服务启用了认证，在该 MCP 服务的「请求头」中增加：

| 键 | 值 |
|---|---|
| `Cookie` | `campus_monitor_session=<登录接口签发的会话值>` |

可用本机的运营员账号取得该会话值。下面的命令会将响应中的 `Set-Cookie` 保存到 `campus.cookies`；把其中的 `campus_monitor_session=...` 填入 cc-haha 的 `Cookie` 请求头即可：

```bash
curl --cookie-jar campus.cookies \
  --header 'Content-Type: application/json' \
  --data '{"password":"<运营员密码>"}' \
  http://127.0.0.1:8010/api/auth/login
```

`campus.cookies` 与 MCP 的 Cookie 请求头都是高权限凭据，不能提交到 Git，也不要发到聊天或工单里。未启用校园服务认证时不需要添加该请求头。

## 使用方式

新建或打开一个 cc-haha 会话后，直接说明要做什么，例如：

```text
查询最近 7 天的高风险校园事件，给出每项的证据来源；
将“食堂投诉”事件的风险等级更新为 high，并补充这次更新的原因。
```

cc-haha 会发现 `campus-management` 的 MCP 工具并调用。先检查「设置 → MCP」中它是否已连接；若服务重启过，可在该页点「重连」。

`/mcp` 是校园服务的公开只读面，不能用于修改事件；需要读写一体的 Agent 必须配置 `/mcp/management`。
