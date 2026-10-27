# 移动端发布

移动端使用独立的用户版本号。桌面 Release 继续使用 `vX.Y.Z`，只改桌面时不用升级移动端；发布说明应链接现有移动版本。iOS 自动交付到 App Store Connect / TestFlight，正式 App Store 审核与上架另行处理；Android 发布正式签名 APK，不提交 Google Play。

## 已关联的项目

- Expo：`@relakkesyangs-team/cc-haha`
- Project ID：`4e75f835-1b64-463c-a196-cc181b4c83ec`
- App Store Connect App ID：`6826961014`
- iOS Bundle ID：`com.yunce.cchaha.mobile`
- iOS Widget：`com.yunce.cchaha.mobile.widgets`
- App Group：`group.com.yunce.cchaha.mobile`
- Android package：`app.cchaha.mobile`

项目标识可公开，凭据不能提交。EAS 管理生产签名凭据；保管并备份 Android keystore，后续升级必须保持签名身份。

## 一次性账号设置

1. 账户持有人在 Apple Developer / App Store Connect 接受当前协议，在 App Store Connect 创建上述 Bundle ID 的应用。
2. 注册主 App、Widget 和 App Group，配置通知等实际使用的 capabilities，为主 App 和扩展分别准备 App Store 分发描述文件。
3. 在 `mobile/` 使用 `bunx eas-cli@25.3.0 credentials:configure-build --platform ios --profile production` 配置签名；Android 将 `ios` 改为 `android`。这会访问真实账号，不属于离线测试。
4. 通过 `bunx eas-cli@25.3.0 credentials --platform ios` 配置 EAS Submit 使用的 App Store Connect API Key。它与 APNs 推送密钥不同。
5. GitHub Actions Secrets 配置 `EXPO_TOKEN`，推荐专用发布机器人。Variables 配置 `EXPO_PROJECT_ID`、`EXPO_OWNER` 和数字形式的 `ASC_APP_ID`。
6. 首次构建和交付确认可用后，设置 GitHub variable `MOBILE_RELEASE_ENABLED=true`，启用随桌面正式 Release 自动交付。此前桌面发布不会被未完成的移动端账号设置影响。

仓库根目录 `.easignore` 保留移动端及共享源码，排除 Git 对象、其他产品目录、生成的原生工程和签名文件；EAS 会从 Expo 配置重新生成原生工程。

`eas.json` 固定 EAS CLI 版本，使用 `production` 环境、远程签名凭据、自动递增构建号，Android 产物明确设为 APK。不要使用本地默认 debug keystore 作为公开分发签名。

Android FCM 如果需要启用，在 EAS production 环境设置文件变量 `CC_HAHA_GOOGLE_SERVICES_FILE`，内容是匹配 `app.cchaha.mobile` 的 Firebase Android 客户端 JSON。服务账户私钥不能放进应用。未配置时不宣称后台推送可用。详见 [推送说明](PUSH_NOTIFICATIONS.md)。

## 日常发版

在根目录准备 release notes 后，沿用现有 release PR 流程：

```sh
# 桌面更新，移动端保持原版本
bun run scripts/release.ts patch --dry

# 同时升级移动端版本；先预览，再移除 --dry 执行
bun run scripts/release.ts patch --mobile patch --dry
```

移动端的 `mobile/app.json#expo.version` 和 `mobile/package.json#version` 必须一致。Release 脚本只在显式传入 `--mobile` 时更新这两个文件。生产代码变化而用户版本未升级会阻止移动端交付，提示先补版本；不会影响已经发布的桌面产物。

移动端调用由 `Release Desktop` 在正式发布完成后显式执行，不依赖 `release.published` 事件。GitHub Token 产生的 Release 事件不能用来可靠触发另一条工作流。

每个平台在 Release 附件中保存 `mobile-release-ios.json` 或 `mobile-release-android.json`。它们记录该平台成功交付的源码提交、构建输入摘要、移动版本和 EAS build ID；安卓另含 APK 名称及 SHA-256。iOS 成功仅代表上传完成，不代表苹果审核通过。

判定覆盖移动端代码、插件、依赖、资源、构建配置，以及移动端实际导入的共享源码和运行时传递依赖（不沿仅类型导入扩展）；未被移动端使用的共享文件不会触发移动发布。测试、文档和生成文件不触发新包。无法解析的本地运行时依赖会阻止发布，避免误判为无需更新。它对比该平台上一次成功交付，而不是上一个桌面标签，所以之前失败的交付不会被漏过。没有历史记录时执行首发。

## 失败重试与只读预览

GitHub Actions → `Release Mobile` → `Run workflow`：

- `release_tag`：包含这套发布代码的、已经公开发布的稳定标签，例如 `v1.2.3`。工作流检出标签对应提交，不构建当前默认分支。
- `platform`：`ios`、`android` 或 `all`。
- `dry_run`：默认开启，仅分析，不构建、上传或消耗 EAS 构建配额。真正交付时关闭。

已成功的平台会跳过。构建已成功但交付失败时优先复用同一提交、版本和输入摘要的 EAS build；正在进行中的同一构建不会重复启动。Apple 上传成功而 GitHub 成功记录写入失败时，重试会先检查该 build 的提交结果。仅在上传/发布完成后写成功记录，不能手工伪造记录来消除失败。

自动上传和手动重试共享串行锁，不取消正在进行的商店上传。安卓 APK 在附加到 Release 前验证安装包结构与签名，拒绝默认 Android Debug 签名。

## 首次 App Store 提审

准备真实截图、描述、支持网址、移动端隐私政策与隐私披露、年龄分级、出口合规和目标地区所需资料。当前支持 iPad，需包含相应验收和展示。

该 App 依赖桌面配对，审核说明需要提供可实际访问的隔离测试环境与操作步骤。内部 fixture 服务不是已经可用的正式审核入口。TestFlight 真机验证通过后，再选择构建提交 App Review；CI 上传成功不能替代此步骤。

后台推送目前要求桌面配置 APNs / FCM 服务端凭据。普通用户开箱即用的后台推送需要单独的受控服务方案，不可把开发者私钥打包进桌面端或移动端。

## 确定性检查

```sh
bun run check:mobile
bun test scripts/mobile-release.test.ts scripts/release.test.ts
bun run check:policy
bun run check:impact
```

完整验证使用 `bun run verify`。移动端检查隔离 HOME、关闭 Expo 网络与遥测，不使用生产凭据。EAS 构建、TestFlight 真机体验及实际推送属于另外记录的线上证据。
