# cc-haha 移动端

React Native / Expo 58 / Expo Router 的 iOS、Android 客户端。按「cc-haha 移动端主题提案」重做界面和功能分工：手机负责收到提醒、做决定、派任务、查看结果和及时停止；模型执行、仓库和配置保留在电脑上。

## 页面与真实行为

| 页面 | 行为与桌面端边界 |
| --- | --- |
| 首页（浅色 / 深色） | 大标题是当前电脑，点开查看这台电脑（定时任务、后台活动、新任务默认模型）或切换电脑；常驻搜索与项目筛选；按“等你决定 / 进行中 / 最近”分组，工具审批可在首页直接允许或拒绝（经会话页重新校验后提交）；运行时间来自桌面任务时钟，一次网络抖动不判离线 |
| 会话与审批 | 流式内容、历史分页、工具步骤时间线；运行中追加的消息在手机上排队，这一轮顺利结束后自动发送（出错或未确认送达时暂停，停止或离开会话时退回输入框）；允许 / 本会话同类不再询问 / 拒绝并说明；文件修改审批显示差异；审批只发送当前主机、会话和请求 ID |
| 提问 | 单选、多选、自定义答案；桌面提供的 AI 代答倒计时与取消；问题和工具权限使用不同协议 |
| 计划 | 查看完整计划，选择执行权限和当前会话模型；批准后执行，或反馈后继续规划 |
| 新任务 | 目录、分支、工作树、Standard / Lean、权限与模型；等待 WebSocket 同步及运行配置确认后才发送首条任务 |
| 输入与材料 | 图片、相机、文件、电脑已有技能引用、下一条消息的 Teams 设置；听写使用系统键盘；有明确材料大小限制，不静默丢弃 |
| 改动 | 检查点文件差异、代码 / 对话 / 两者回退；可复制、编辑重发、分叉消息，使用服务器实际消息标识 |
| 后台活动 | 真实后台任务及耗时；单项或全部停止；任务由电脑运行，不依赖手机保持前台 |
| 定时任务 | 列表、详情、启停、立即运行、改执行时间与最近结果；按每天 / 工作日和电脑本地时刻新建；“下次运行”按手机时区推算，手机和电脑不在同一时区时可能不准；已有任务内容与高级配置在桌面修改 |
| 你的电脑与扫码 | 多主机独立地址、凭据和草稿；局域网连接与 HTTPS 原生配对；移除前撤销推送登记 |
| 设置 | 通知、勿扰、AI 代答、外观；电脑默认模型在首页“这台电脑”里；API Key、MCP、插件和系统权限留在桌面端 |
| 工作区 | 文件树、文本和差异只读预览，原生保存或分享文件；下载经过带认证的固定主机连接与大小限制 |
| 系统通知与 Live Activity | iOS 原生锁屏 / Dynamic Island，Android 通知；动作进入 App 后重新校验当前审批，过期内容不允许直接批准 |

外观是「值守」设计（`src/ui/palette.ts` + `src/ui/kit.tsx`）：系统字体，命令、路径和计时用 Geist Mono（许可位于 `assets/fonts/OFL.txt`）；颜色只表达状态——琥珀是等你决定、蓝是运行、绿是完成、红是出错，主按钮用墨色，品牌陶土色只出现在标识上。额外的加载、断线、权限未授权、空列表、失败和大字体状态属于运行时必须处理的情况，不能用设计稿样例数据替代。

## 运行与构建

正式 CI 签名、随 Release 发布 APK / TestFlight、独立版本号及失败重试，见 [移动端发布](RELEASING.md)。

以下命令在 `mobile/` 执行。需要 Bun、Node；iOS 需要 Xcode / CocoaPods，Android 需要 JDK / Android SDK。

```sh
bun install --frozen-lockfile
bun run ios
# 或
bun run android
```

原生目录由 Expo 根据 `app.json`、`app.config.ts` 和配置插件生成，禁止手工维护生成的 `ios/`、`android/`。原生依赖或配置变化后需要重新构建。

Android 必须使用独立构建：`plugins/withPinnedWebSockets.js` 关闭 WebSocket 的自动跨地址重定向；Expo Go 不具备该保护，代码会阻止其连接。网页 `bun run web` 仅用于布局和协议检查，凭据仅保存在页面内存；刷新后需重新连接，不能替代原生验收。

Release 模拟器构建可运行 `bunx expo run:ios --configuration Release`。直接调用 `xcodebuild` 时应保留正常的模拟器代码签名；完全关闭签名会使 SecureStore / Keychain 不能保存连接凭据。模拟器 `.app` 不能作为手机 IPA 安装。

Android 本地测试包：

```sh
bunx expo prebuild --platform android --no-install
./android/gradlew -p android :app:assembleRelease \
  -PreactNativeArchitectures=arm64-v8a \
  '-Dorg.gradle.jvmargs=-Xmx4096m -XX:MaxMetaspaceSize=1536m' \
  --max-workers=4
```

上述 JVM 参数已用于本地成功构建，避免新增原生模块使默认 512 MiB Metaspace 不足。仅应用界面或业务逻辑改动、原生依赖与配置不变时，可直接增量执行 Gradle，无须再次 prebuild。本地 release 默认仍使用测试 keystore。正式商店签名、商店提交、EAS 发布与生产凭据不是本地构建的一部分。

## 连接电脑

局域网：电脑启用「H5 访问」，手机扫描连接二维码，或输入电脑可达的 `http://局域网IP:端口` 和访问令牌。实体手机的 `127.0.0.1` 指向手机自身；同机 iOS 模拟器可访问 Mac 的回环地址。

外网：在桌面「设置 → H5 访问 → 公网访问」选择连接方式。默认 ngrok 只需用户提供 Authtoken，连接成功后自动显示配对二维码，无需自备服务器或域名。已有 Cloudflare Named Tunnel、frp 或反向代理的用户可选择「已有 HTTPS 隧道」，填写固定的 HTTPS 根地址，将自己的隧道转发到界面提供的**独立公网网关**，默认目标为 `http://127.0.0.1:17463`。不要直接映射桌面主服务端口；填入地址不会自动创建隧道或 DNS 记录。

ngrok 免费账户的开发域名会被自动记住并复用；付费账户已有固定域名时，可在 ngrok 高级选项中填写完整 HTTPS 根地址，不含端口或路径。付费账户未指定固定域名时可能分配随机地址，不能保证下次连接不变。自带隧道应原样转发根路径和全部子路径，才能同时支持 H5 静态资源、API 和 WebSocket。

手机不托管中继，也不运行隧道客户端。自带入口必须提供系统信任的 HTTPS 证书并支持 WebSocket；「本机网关已就绪」不代表公网可达，应使用蜂窝网络另外验证。两种连接方式都扫描 / 粘贴 `https://host/remote#pair=一次性码`，随后仍须电脑批准手机。具体步骤见[公网访问说明](../docs/desktop/remote.md#公网访问)。

后端必须包含本次原生配对协议：`pair` 带 `clientType: native`；`claim` 返回 `native_` Bearer 凭据、设备 ID 和真实期限。后续请求及 WebSocket 在固定 origin 上发送凭据，拒绝公开 HTTP、重定向和 URL 查询 token。浏览器继续使用独立 Cookie 配对流程；电脑撤销授权后手机必须重新配对。

每台电脑独立保存元数据（AsyncStorage）与连接凭据（SecureStore）。手机设置有版本迁移；不能读取的未来版本不会被覆盖。公网地址保持不变时，临时断线或网关重启后使用原凭据重连并同步历史和运行状态，结果不确定的消息不自动重发；确认凭据失效才要求重新配对。公网设备凭据有效 30 天，当前不自动续期。电脑休眠或退出时 App 不能代替电脑执行任务，也不提供远程唤醒；桌面启动后恢复公网访问仍需用户主动开启对应选项，已有隧道的客户端另由用户启动。

移除电脑会先撤销已登记的通知和 Live Activity，再清理手机凭据；若电脑不可达且仍有登记，保留连接供重试。电脑会话不会被删除。公网设备的整个访问授权可另在桌面撤销。

## 通知配置

详见 [PUSH_NOTIFICATIONS.md](PUSH_NOTIFICATIONS.md)。前台本地提醒、系统通知授权和后台远程推送是不同路径。没有 APNs / FCM 配置时，设置页会明确提示，不能据此声称后台远程投递成功。

- iOS：构建包含通知与 ActivityKit entitlement，桌面端显式配置 APNs 密钥、Team ID、Key ID、topic 及环境。私钥不进入手机或仓库。
- Android：构建前设置 `CC_HAHA_GOOGLE_SERVICES_FILE=/绝对路径/google-services.json`，文件必须含 `app.cchaha.mobile` 的 Firebase 客户端；重新 prebuild / 构建。桌面另需 FCM 服务账户。这两个 JSON 用途不同，不能互相代替。参见 [Expo 官方配置说明](https://docs.expo.dev/push-notifications/fcm-credentials/)。
- 服务端登记按设备权限、偏好、勿扰时段与期限校验；令牌加密保存。推送不携带模型密钥。通知按钮会重新验证审批，AskUserQuestion 和计划不能被普通「允许」动作替代。

## 验证

```sh
bun run typecheck
bun run lint
bun run test
bun scripts/fixture-server.ts --self-test
bun test scripts/design-fixture.test.ts
bun run export
```

测试使用假凭据、内存、临时 HOME 和回环服务，不读写开发者真实 `~/.claude`、Keychain 或模型。根目录的 `bun run verify` 和 `bun run check:persistence-upgrade` 覆盖服务器及持久化边界。静态 export 只产生 JavaScript 与资源，不是 APK / IPA。

设计验收服务：

```sh
bun scripts/design-fixture.ts --port=3467 --second-port=3468
```

同机模拟器连接 `http://127.0.0.1:3467` 或 `:3468`，测试 token 为 `mobile-fixture`。六条设计会话支持审批、问答、计划、材料、差异、回退、后台停止、定时任务和主机隔离。数据只在内存中，**没有模型、命令执行或真实文件修改**。测试专用场景切换见 `scripts/design-fixture.ts`，这些接口不进入生产服务器。

真实模型验证须另获维护者授权，在独立桌面配置和临时工作区运行。UI Fixture、真实协议、打包构建、模拟器触屏及远程推送投递应分别记录证据，任何一种都不能替代其他验证。

2026-10-24 的验证记录：移动端单元与协议测试 261 项通过，typecheck / lint 通过；根目录 `bun run verify` 的 8 个选中检查通过，5 个检查按影响范围跳过。iOS、Android Release 包及独立 iPhone 开发签名包已构建并校验，Android 已安装到专用模拟器，实际相机扫码能够解析桌面连接凭据。

真实模型验证使用两份独立桌面配置和 `/tmp` 工作区，由 iOS App 驱动 DeepSeek Flash 多轮编写、修改和执行票据 API / CLI 与日志聚合 CLI。独立黑盒检查最终分别通过 37 项、18 项及 13 项；日志 CLI 首轮发现的服务名排序错误已由真实模型修复并复测。实际文件下载、系统保存、重新附加和模型读取的内容哈希一致。Sandbox APNs 已经 Apple 实投到 iOS 模拟器，通知点击进入对应会话和待审批请求。

以上记录不表示全部原生验收完成：最终 Android 包的新任务模型请求、单个「完成」按钮保存思考强度、最终后台活动页输出与停止操作仍需继续验收；Live Activity 锁屏外观尚无充分视觉证据。Android FCM 缺少客户端及服务端配置，尚未实投；最新 iPhone 包的真机验收由用户另行完成。
