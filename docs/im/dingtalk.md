---
title: 钉钉接入
nav_title: 钉钉
description: 用钉钉扫码授权机器人，走 DingTalk Stream 长连接，不需要公网回调地址。
order: 4
---

# 钉钉接入

适合把钉钉当主力办公工具的国内团队：扫一次码就能授权出一个机器人，走 DingTalk Stream 长连接，不需要公网回调地址和内网穿透。回复默认用 AI Card 流式输出。限制是只处理单聊，不处理群聊；想要可点的权限卡片还得额外配一个模板 ID，否则只能回复文本命令。

## 扫码绑定机器人

1. 打开「设置」→「IM 接入」，切到「钉钉」Tab。
2. 在「扫码绑定钉钉机器人」里点「扫码绑定」。
3. 用钉钉手机 App 扫码，并在钉钉里确认创建和授权。
4. 等页面显示「钉钉机器人已绑定」。

![扫码绑定与手动填写凭据](../images/im/dingding/dingding01.png)

授权成功后 `Client ID` 和 `Client Secret` 会自动填好并写入本机配置，adapter 随即用新凭据重连。

## 手动填写凭据

扫码走不通时，也可以自己填。这几个字段就在扫码区域下面：

- **Client ID** — 钉钉应用的 `appKey`
- **Client Secret** — 钉钉应用的 `appSecret`
- **Stream Endpoint** — 可选，默认 `https://api.dingtalk.com`
- **权限卡片模板 ID** — 可选，填了之后权限请求优先发钉钉互动卡片
- **允许的用户** — 可选，直接放行指定的钉钉用户 ID

填完点「保存」，adapter 会用新凭据重新建立 Stream 长连接。

## 授权具体用户

机器人绑定完成后，还要让具体的人通过配对码获得授权。

1. 回到页面顶部的「配对管理」，点「生成配对码」。
2. 在钉钉里私聊机器人，把这枚 6 位码发过去。
3. 看到配对成功提示后就能开始聊。

![在钉钉里发送配对码并开始对话](../images/im/dingding/dingding02.png)

配对码 60 分钟内有效、只能用一次。配对成功的人会出现在「已配对用户」列表里，随时可以解绑；被解绑的人要重新发一枚新码。

## 选项目并开始对话

配了「默认项目」的话，第一条消息就直接在那个目录下开会话。没配的话，机器人会先列出最近用过的项目，回复编号、项目名或绝对路径即可。

之后同一个聊天窗口的消息会复用同一条会话。发 `/new` 重新选项目，发 `/clear` 清空上下文但保留项目绑定。

## 支持的命令

钉钉没有像飞书那样的机器人菜单，命令入口就是单聊输入框。配对成功后机器人会提示发 `/help`。

- `/help` 或 `帮助` — 显示可用命令
- `/status` 或 `状态` — 当前项目、分支、模型、运行状态和任务摘要
- `/projects` 或 `项目列表` — 重新列出最近项目
- `/new` 或 `新会话` — 清空当前绑定并重新选择项目
- `/new <编号、项目名或绝对路径>` — 直接在指定项目下开新会话
- `/clear` 或 `清空` — 清空上下文，保留项目绑定
- `/stop` 或 `停止` — 停止本轮生成

## 权限审批与消息表现

默认情况下，权限请求以文本消息发出，回复其中一条：

- `/allow <requestId>` — 允许这一次
- `/always <requestId>` — 永久允许同类请求
- `/deny <requestId>` — 拒绝

如果在设置页填了已发布的「权限卡片模板 ID」，adapter 会优先发互动卡片，按钮回调走 DingTalk Stream 回传。卡片发不出去或看不见时，文本命令始终可用。

普通回复优先用 AI Card 做流式输出，图片附件会下载后以内联图片进入模型输入，附件超出大小限制时机器人会在钉钉里提示。

## 解除绑定

两种粒度：

- 「解除机器人绑定」清掉钉钉凭据、权限卡片模板 ID 和这个平台的授权名单，之后要重新扫码或手动填凭据。
- 在「已配对用户」列表里点某个用户右侧的「解绑」，只撤销那一个人。

## 本地开发启动

发布版桌面端会自动把 adapter 作为 sidecar 拉起。只有从源码运行或单独调试时才需要手动启动：

```bash
cd adapters
bun install
bun run dingtalk
```

可选的环境变量覆盖：

```bash
export DINGTALK_CLIENT_ID="..."
export DINGTALK_CLIENT_SECRET="..."
export DINGTALK_STREAM_ENDPOINT="https://api.dingtalk.com"
export DINGTALK_PERMISSION_CARD_TEMPLATE_ID="..."
export ADAPTER_SERVER_URL="ws://127.0.0.1:3456"
```

正常使用桌面端不需要手动设置这些，扫码绑定或手动填写会写好本机配置。

## 常见问题

**扫码成功后发消息仍提示未授权**：这是正常流程。扫码只写入机器人凭据，具体用户还要发配对码，或被写进「允许的用户」。

**扫码失败或一直等待确认**：重新点「扫码绑定」生成新二维码；仍然不行就手动填 `Client ID` 和 `Client Secret`。

**adapter 启动时报缺少 clientId/clientSecret**：环境变量和 `~/.claude/adapters.json` 里的 `dingtalk.clientId`/`dingtalk.clientSecret` 都没生效，先在设置页完成扫码或手动填写。

**权限卡片没出现**：确认模板 ID 填的是已发布的模板、模板支持 adapter 用的回调路由、机器人已发布新版本。卡片不可见时用 `/allow`、`/always`、`/deny` 照样能批。

**收不到回复**：依次确认桌面端在运行、Tab 里显示已绑定、当前用户已配对或在「允许的用户」里、`~/.claude/adapters.json` 能正常写入；源码运行时还要确认 `ADAPTER_SERVER_URL` 指向正在跑的桌面服务。

**重启后会话没接回来**：检查 `~/.claude/adapter-sessions.json` 能否正常写入，以及桌面端里那条会话是否还在。

## 源码入口

`adapters/dingtalk/` 下的 `index.ts`、`helpers.ts`、`ai-card.ts`、`permission-card.ts`、`media.ts`，以及 `adapters/common/` 下的 `pairing.ts`、`session-store.ts`、`ws-bridge.ts`、`http-client.ts`。
