---
title: 手机 App、H5 与 IM 接力
nav_title: 手机与 IM
description: 从手机连接入口用浏览器扫码接力，了解手机 App 发布状态与外出连接方法。
order: 9
---

# 手机 App、H5 与 IM 接力

电脑上跑着的任务，想在手机上看进度、追加一句话，可以从桌面左侧 **手机连接** 进入，也可从 **设置 → 手机连接** 进入。目前可直接用手机浏览器扫码连接，无需等待手机 App 发布。

## cc-haha 手机 App 安装状态

| 手机上的打开方式 | 当前状态 | 如何使用 |
|---|---|---|
| cc-haha Android App | 正式签名 APK 待发布 | 下载入口将在发布后提供 |
| cc-haha iPhone / iPad App | TestFlight 邀请待开放 | 安装邀请将在开放后提供 |
| 手机浏览器（H5） | 现在可用 | 点击「先用浏览器连接」，按下方步骤开启连接并扫码 |

「先用浏览器连接」会切换到 **同一 Wi-Fi**，需要你阅读提示并主动开启连接。手机和电脑在同一个可信 Wi-Fi 时，无需安装 Tailscale；外出、使用蜂窝网络或其他 Wi-Fi 时，才需要下方的 **Tailscale 远程连接**。

这些方式都需要电脑开着、cc-haha 正在运行且未休眠。任务始终在电脑上执行。Tailscale 负责外出时的设备联网，cc-haha 手机 App 和浏览器负责查看任务与处理审批。

想直接在微信、钉钉、WhatsApp、Telegram 或飞书里对话，可使用本页最后的 **IM 接入**。

## H5 访问

### 开启

1. 点击桌面左侧 **手机连接**（也可从 **设置 → 手机连接** 进入）。
2. 点击「先用浏览器连接」，或选择 **同一 Wi-Fi**。
3. 打开「开启局域网连接」，读一遍风险提示后确认。
4. 用手机相机扫码，在常用的 Safari、Chrome 或系统浏览器中打开；也可复制扫码链接到自己的设备。

如果旧配置缺少已保存的令牌，点「生成令牌」后再扫码。

扫出来的链接里带着服务器地址和令牌。用手机相机扫码后，在你常用的 Safari、Chrome 或系统浏览器中打开，首次验证成功会把连接信息保存在该浏览器的 localStorage 中，并移除地址栏中的令牌。之后再次扫码或打开收藏可直接连接；短暂断网不会删除配对，连接失败时可点击「重试」使用已保存的凭据。令牌被撤销或重新生成后，需要用新二维码更新。

![手机端查看真实项目的会话内容](../images/app/zh-CN/h5-session.webp)

### 令牌是访问凭据

拿到这条链接的人就能访问你桌面上暴露出来的能力。所以：

- 不要把带令牌的链接贴进群聊、公开 Issue、日志截图或任何公开页面。
- 只在可信网络里开。离开局域网后，使用下方的「Tailscale 远程连接」，通过 HTTPS 和逐设备配对连接。
- 怀疑泄露了就点「重新生成令牌」。旧二维码和旧令牌会立刻失效——只是关掉再打开 H5 不会换令牌。

不用的时候关掉。关掉会立即拒绝远程访问，但令牌保留着，下次开还是同一个。

:::warning
H5 默认关闭，它也不是公开服务。开启前先确认你在自己信得过的网络里。
:::

### 访问主机与固定端口

「访问主机 / IP」填电脑当前的局域网 IP，比如 `192.168.1.20`，端口用当前服务端口。换了 Wi-Fi 或插拔网线之后原 IP 可能失效，页面会提示你切到可用的那个。

局域网 H5 也接受完整 URL，并需要配置「允许的来源」。这仍然是原有的 H5 令牌访问方式。要从其他网络连接手机 App 或浏览器，请使用下方的「Tailscale 远程连接」，将 Serve 接到独立的受限网关，不要直接映射桌面主服务端口。

通常无需填写 IP 或端口；开启后直接扫码。需要手动配置时，展开下方的「高级连接设置」。其中的**固定端口**用于保持局域网地址稳定，或配合局域网防火墙和反向代理。端口要在 1024–65535 之间，改完重启应用才生效——页面会告诉你现在还跑在哪个端口上。它与下方远程入口的本机端口相互独立。

### 手机锁屏不会打断任务

「断连保活」解决的是这个问题：手机锁屏、切后台或者短暂断网时，**正在执行的任务不会被停掉**，它会在后台跑完，重连就能看到结果。

只有当任务已经空闲、并且没有任何设备连着时，才会在保活时间到期后停掉对应进程。默认 30 秒，可配范围是 5 秒到 24 小时。出门远程操作可以调大一些，比如 600。

### 手机上能做什么

会话列表和项目切换、发消息、停止、看流式回复、图片和文件附件、权限按钮、AI 提问、`@` 引用文件、复制和 Fork——对话主流程都在。

侧栏底部的「设置」提供「模型供应商」和「通用配置」。手机上可以添加、编辑、删除、排序和切换供应商；已有 API Key 不会回传，编辑时留空表示保持不变。更改主模型或图片模型的请求地址时，需要重新填写对应的 API Key，避免把电脑已保存的密钥自动发送到新地址。通用配置支持界面主题与语言，以及回复语言、输出风格、思考强度、发送方式和工作流关键词等偏好。主题和界面语言只影响当前浏览器；Agent 偏好与电脑共享。

供应商网页登录、配置文件导入和桌面专用管理仍在电脑上完成。桌面工作区、内嵌终端、原生「打开方式」、Computer Use 授权和桌面宠物不在 H5 里。终端暂未开放：它目前由 Electron 管理，远程终端需要单独支持连接恢复、设备授权和撤销，不能直接复用桌面 IPC。

## Tailscale 远程连接

同一局域网继续使用上面的扫码连接。离开家或办公室后，通过 **Tailscale** 把手机和电脑接入自己的私人网络，再连接 cc-haha。无需购买服务器、申请域名或配置 ngrok；Tailscale 负责设备间的网络通路，cc-haha 负责手机配对与访问授权。

### 1. 下载 Tailscale，连接电脑和手机

电脑和手机各安装一次 **Tailscale**。按设备选择下面的官方下载入口，无需再去官网查找安装包：

| 设备 | 下载 / 安装 | 安装后怎么做 |
|---|---|---|
| macOS 电脑 | [下载 macOS 安装包（.pkg）](https://pkgs.tailscale.com/stable/Tailscale-latest-macos.pkg) | 双击安装包，按提示安装并打开 Tailscale；推荐使用这个独立安装版 |
| Windows 电脑 | [下载 Windows 安装包（.exe）](https://pkgs.tailscale.com/stable/tailscale-setup-latest.exe) | 双击安装，安装器会自动选择适合系统的版本；安装时保持联网 |
| Android 手机 | [下载 Android 安装包（.apk）](https://pkgs.tailscale.com/stable/tailscale-android-universal-latest.apk) · [Google Play 安装](https://play.google.com/store/apps/details?id=com.tailscale.ipn) | 用手机打开下载链接；安装 APK 时，按系统提示允许当前浏览器安装应用 |
| iPhone / iPad | [前往 App Store 安装](https://apps.apple.com/us/app/tailscale/id1470499037?ls=1) | 在手机上打开链接，点「获取」安装；需 Apple 账号所在商店地区提供该应用 |

在电脑上阅读本页时，可以用手机浏览器打开本指南，再点对应的手机安装入口。桌面端 **手机连接 → 外出连接** 也提供按系统分类的 Tailscale 下载入口。

这些安装包由 Tailscale 官方提供，链接会下载当前稳定版。Android APK 需要手动更新；可以使用 Google Play 时，商店安装更便于自动更新。其他系统、旧系统或特殊安装需求，查看 [Tailscale 官方下载页](https://tailscale.com/download) 和 [官方安装指南](https://tailscale.com/docs/install)。

iPhone / iPad 目前通过 App Store 安装，Tailscale 没有提供适用于普通用户的独立 IPA 安装包。若提示「所在地区不可用」，这是商店地区的限制，详见 [Tailscale 官方说明](https://github.com/tailscale/tailscale/issues/19625)。同一 Wi-Fi 下仍可使用上方无需 Tailscale 的连接方式。

安装完成后，在电脑和手机上打开 Tailscale，**用同一个账号登录，并让两端都保持已连接状态**。首次使用时按系统提示允许添加 VPN 配置；macOS 还可能提示启用网络扩展。账号注册与登录帮助见 [官方入门指南](https://tailscale.com/docs/how-to/quickstart)。

这里使用 **Tailscale Serve**，地址只供私人网络中的授权设备访问。无需开启面向整个互联网的 Funnel，也无需配置出口节点或子网路由。完整原理见 [Serve 官方指南](https://tailscale.com/docs/features/tailscale-serve)。

### 2. 配置电脑入口

下面的命令**只在电脑运行**，手机无需运行命令。先准备好命令窗口：

- **macOS：** 按 `⌘ + 空格`，搜索「终端」并打开。在 Tailscale 的 **Settings → CLI integration → Show me how → Install Now** 安装命令行入口，按提示输入电脑管理员密码，再回到终端。已有 App Store 版的用户，可将下方命令开头的 `tailscale` 替换为 `/Applications/Tailscale.app/Contents/MacOS/Tailscale`。详见 [macOS 命令行说明](https://tailscale.com/docs/reference/tailscale-cli?tab=macos)。
- **Windows：** 从开始菜单搜索并打开 **PowerShell**。如果安装 Tailscale 前已经打开过 PowerShell，关闭后重新打开，再粘贴命令。详见 [Windows 命令行说明](https://tailscale.com/docs/reference/tailscale-cli?tab=windows)。

1. 打开桌面的 **手机连接 → 外出连接**。保留默认本机端口 `17463`，或选择未被占用的端口。
2. 在电脑的命令窗口先粘贴下面这条命令，按回车查看已有转发：

   ```sh
   tailscale serve status
   ```

   没有使用 HTTPS `443` 的服务时，再运行下面的命令；已有服务时使用后面的其他端口示例，避免覆盖原配置。

   ```sh
   tailscale serve --bg http://127.0.0.1:17463
   ```

3. 首次运行可能给出一个网页链接。按提示为自己的 Tailscale 网络启用 HTTPS；若提示 DNS 配置缺失，按 [官方 HTTPS 指南](https://tailscale.com/docs/how-to/set-up-https-certificates) 开启 MagicDNS 和 HTTPS Certificates。Serve 会管理证书，无需手动下载证书文件。
4. 复制命令输出的 HTTPS 地址，例如 `https://my-computer.example.ts.net`，粘贴到桌面的 **Tailscale HTTPS 地址**。使用你自己的实际地址，不要添加 `/remote`、查询参数或配对码，也不要填 `http://100.x.x.x`。
5. 阅读访问说明，开启连接入口。**本机入口已就绪**只表示 cc-haha 已开始接受连接，不代表手机到电脑的网络已经验证。

命令中的 `17463` 必须与页面上的本机端口一致。它连接的是 cc-haha 提供的独立受限网关，不是桌面主服务端口。应用显示的命令会随所填端口更新。

如果 HTTPS `443` 已被另一项 Serve 服务使用，可选择另一个未使用的端口，例如：

```sh
tailscale serve --bg --https=8443 http://127.0.0.1:17463
```

此时填写的地址也必须带上 `:8443`，例如 `https://my-computer.example.ts.net:8443`。保持根路径转发，不要只转发 `/remote`；页面、API 和 WebSocket 都要经过同一个入口。[Serve 命令参考](https://tailscale.com/docs/reference/tailscale-cli/serve)

### 3. 扫码配对并确认

1. 保持手机 Tailscale 已连接。先关闭 Wi-Fi、使用蜂窝网络验证远程路径。
2. 用手机相机扫描桌面的配对二维码，在常用浏览器中打开；使用 cc-haha 手机 App 时，也可在 App 内扫码。
3. 在桌面确认这部手机。配对成功后，手机会保存连接，可以查看任务和处理审批。

从 ngrok 升级后，旧远程配置不会自动启动；之前配置过 Tailscale HTTPS 地址的用户也需要重新确认开启。旧 ngrok 地址不能用于 Tailscale，请生成新的二维码配对。局域网配置和已有电脑会话不受影响。

### 常见问题

| 现象 | 检查什么 |
|---|---|
| 电脑显示入口就绪，手机仍连接失败 | 两边 Tailscale 是否都已连接、是否属于同一个私人网络；HTTPS 地址和端口是否与 Serve 输出一致；电脑上的 cc-haha 是否仍在运行 |
| 地址打不开或证书报错 | 检查 MagicDNS、HTTPS Certificates 和 `tailscale serve status`；不要用 `100.x.x.x` 代替完整的 HTTPS 域名 |
| 开启 Tailscale 后另一个 VPN 断开 | 手机系统通常只允许一个 VPN 同时启用，参见 [Tailscale 的 VPN 兼容说明](https://tailscale.com/docs/reference/faq/other-vpns) |
| 能连上，但流式回复慢 | 用 `tailscale status` / `tailscale ping` 判断是直连还是中继；中继线路会影响延迟。国内运营商和蜂窝网络需要实际验证，不能仅凭局域网速度判断。[连接类型](https://tailscale.com/docs/reference/connection-types) |
| 退到后台后没有系统通知 | Tailscale 只负责网络连接，后台推送仍需独立配置；重新打开 App 后同步任务状态 |

### 配对、关闭与恢复

二维码中的配对材料 5 分钟有效且只能使用一次；手机访问凭据默认有效 30 天。不要分享二维码。桌面可以单独撤销手机，或关闭远程入口立即断开远程连接；已经运行的任务会继续执行。

网络恢复且 HTTPS 地址保持不变时，手机 App 会用已保存的凭据重连并同步会话。临时断网或重启入口不等于授权失效，不需要因此重新扫码。授权到期或被撤销后需要重新配对，当前不会自动延长 30 天有效期。

手机 App 把凭据保存在系统安全存储中。浏览器使用安全 Cookie，有效期内再次扫码不会消耗新二维码。不同浏览器、无痕窗口和域名之间不会共享授权；若扫码器先打开内置浏览器，请先切换到常用浏览器再配对。

远程入口支持上述供应商与通用设置。任意本机目录浏览及路径式文件预览仍需在桌面操作；会话内的文件和审查接口继续可用。

“随桌面启动恢复连接入口”默认关闭，打开后只恢复 cc-haha 的本机入口。`--bg` 让 Serve 保留配置并在 Tailscale 重启后恢复；电脑和手机仍须连接 Tailscale，电脑必须保持开机、联网且未休眠。退出 cc-haha 或电脑休眠期间无法连接，也无法执行新任务。[Serve 重启行为](https://tailscale.com/docs/reference/tailscale-cli/serve#effects-of-rebooting-and-restarting)

关闭 cc-haha 入口不会删除你的 Tailscale 配置。若也要停止默认 HTTPS `443` 的转发，在电脑运行 `tailscale serve --https=443 off`；用过 `8443` 时换成 `--https=8443`。不要使用 `tailscale serve reset`，它会清空其他 Serve 配置。

## IM 接入

![设置 → IM 接入：平台标签与 Slack 配置表单](../images/app/zh-CN/settings-im.webp)

设置 → IM 接入 支持八个平台，接入方式各不相同。这里先列出常见接法，完整步骤见 [IM 接入总览](../im/index.md)：

| 平台 | 怎么接 |
|---|---|
| 微信 | 在设置页生成二维码，用微信扫码绑定账号 |
| 钉钉 | 扫码一键创建并授权机器人，也可以手动填 Client ID / Secret |
| WhatsApp | 生成二维码，在 WhatsApp 的「已关联设备」里扫码 |
| Telegram | 找 @BotFather 要一个 Bot Token 填进来 |
| 飞书 | 填 App ID 和 App Secret；没有机器人的话可以用页面上的模板一键创建 |
| 企业微信 | 在设置页扫码创建智能机器人 |
| QQ | 扫码授权，回填 App ID 和 App Secret |
| Slack | 用应用清单创建 App，再回填两枚 Token |

### 绑定账号 ≠ 允许对话

这是最容易踩的一步：**扫码只绑定了账号能力，具体哪个人能和 Bot 对话是另一回事。**

在「配对管理」里点「生成配对码」，然后用你自己的 IM 账号私聊 Bot 把这串码发过去，绑定才算完成。也可以在「允许的用户」里直接填用户 ID 列表。两者都为空时默认拒绝所有人——这是有意为之。

已配对的用户会列在下面，可以随时解绑，解绑后需要重新配对。

### 其他设置

- **默认项目** — 新 IM 会话用哪个工作目录。留空则用当前用户工作目录。它只是个起点，不限制机器人能访问哪些项目。
- **允许访问的项目目录** — 机器人的访问边界，`/projects` 只会列出这些目录里的项目。留空则默认为你的主目录（外加主目录之外的「默认项目」）。
- **流式卡片模式** — 实时更新消息内容，读起来更像在看它打字。
- **权限请求** — 钉钉可以配互动卡片模板 ID，用卡片按钮授权；不配的话所有平台都用 `/allow`、`/always`、`/deny` 文本命令。

五个平台各自的申请流程、权限配置和排查步骤，见[IM 接入](../im/index.md)。
