---
title: Connect the campus opinion monitor
nav_title: Campus monitor
description: Open the existing campus event list in cc-haha and connect its trusted management MCP.
order: 10
---

# Connect SJTU-agent

The campus opinion monitor keeps using the existing Yujian Agent event list and data sources. cc-haha supplies the entry point and conversational MCP calls; it does not duplicate the dashboard.

## Start the campus monitor

Start the backend and frontend from the campus-monitor repository:

```bash
python -m trendradar serve --config config/campus.yaml --host 127.0.0.1 --port 8010

cd 前端
npm run dev
```

The frontend defaults to `http://127.0.0.1:3000/`; the backend health endpoint is `http://127.0.0.1:8010/api/health`.

Back in cc-haha, open a conversation and choose **SJTU-agent** in the left sidebar. The entry sends the event list to that conversation's native Workbench browser. If no conversation exists yet, cc-haha creates one through its native session flow first. The address bar, screenshots, element picker, and sending selections back to chat are all provided by CC-HAHA's native BrowserSurface.

## Connect the management MCP

In **Settings → MCP**, add a service with these values:

| Field | Value |
|---|---|
| Name | `campus-management` |
| Scope | User |
| Transport | Streamable HTTP |
| URL | `http://127.0.0.1:8010/mcp/management` |

This endpoint is the management surface for a trusted local client. It exposes core event queries and an allowlisted set of event-maintenance writes. Agent tool calls take effect immediately in the campus monitor and appear after the event list refreshes.

If the campus service has authentication enabled, add this request header to the MCP service:

| Key | Value |
|---|---|
| `Cookie` | `campus_monitor_session=<session value issued by login>` |

Use a local operator account to obtain the session value. The command below stores the `Set-Cookie` response in `campus.cookies`; copy `campus_monitor_session=...` from it into cc-haha's `Cookie` request header:

```bash
curl --cookie-jar campus.cookies \
  --header 'Content-Type: application/json' \
  --data '{"password":"<operator password>"}' \
  http://127.0.0.1:8010/api/auth/login
```

`campus.cookies` and the MCP Cookie header are high-privilege credentials. Do not commit or share them. No request header is needed when campus-service authentication is disabled.

## Use it

Open or create a cc-haha chat, then state the task directly, for example:

```text
Find high-risk campus events from the past seven days and show the evidence for each one.
Update the risk level of the “canteen complaint” event to high and add the reason for this change.
```

cc-haha discovers and calls the `campus-management` MCP tools. Confirm that it is connected in **Settings → MCP**; use **Reconnect** there after restarting the campus service.

`/mcp` is the campus service's public read-only surface and cannot modify events. An Agent that needs read/write access must use `/mcp/management`.
