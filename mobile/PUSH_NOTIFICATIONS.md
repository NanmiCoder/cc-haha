# 系统推送与实时活动

手机前台连接和系统推送是两条独立链路。电脑定期读取真实运行状态：进入等待时提醒审批、问答或计划；收到新的持久化成功结果时提醒完成；从运行转为失败时提醒错误。停止、离线和未知状态不会当作成功，初次发现的历史成功只建立基线。成功投递后同一状态不会重复发送。暂时失败最多尝试 3 次（间隔 5 秒、10 秒），每次重新检查当前状态与设备授权；已失效的审批不会重放。运行中超过 5 分钟没有进展时，错误偏好可触发一次提醒，等待用户批准不算无进展。初次发现历史失败或空闲状态不会伪造新通知。

## 电脑配置

默认没有凭据，接口返回 `notConfigured`，手机应显示“电脑未配置系统推送”。这不影响聊天、手动刷新和前台提醒。

iOS 需要与已安装 App 的 bundle ID 和签名环境对应的 APNs 配置。仅从明确设置的环境变量读取；不会扫描钥匙串或开发者目录。

```sh
CC_HAHA_APNS_KEY_PATH=/absolute/path/AuthKey.p8
CC_HAHA_APNS_KEY_ID=YOUR_KEY_ID
CC_HAHA_APNS_TEAM_ID=YOUR_TEAM_ID
CC_HAHA_APNS_TOPIC=com.yunce.cchaha.mobile
CC_HAHA_APNS_SANDBOX=false
```

`SANDBOX=true` 用于开发 APNs 环境，Ad Hoc / TestFlight / 正式分发通常使用生产环境。应以实际签名 entitlement 为准，不能用手机型号判断。普通通知使用 bundle topic；实时活动自动使用 `.push-type.liveactivity` 后缀。实时活动需要用户允许、系统支持及具备正确 entitlement 的原生构建。

Android 使用 `GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/service-account.json`。当前支持显式 service-account ADC 文件；不自动读取 gcloud 用户登录或云机器元数据。手机必须配置属于同一 Firebase 项目的原生 FCM 文件并获得设备 token。通知 channel 默认为 `cc-haha`；登记带 `delivery.channels: 'split'` 时按事件使用 `cc-haha-decisions` / `cc-haha-completed` / `cc-haha-errors`。没有这部分配置不能宣称后台推送可用。

电脑必须保持运行且可连接 Apple / Google。系统免打扰、设备网络、通知权限和系统节流仍会影响展示；接口的 `configured` 仅表明已配置文件，不能证明真机已收到。投递失败显示不含凭据的诊断，APNs / FCM 报废的 token 会移除。

## 手机 API

所有请求复用当前主机的 LAN 或远程配对认证。不能在请求中提交 owner/device ID；远程设备归属来自服务端验证的配对凭据。

- `GET /api/sessions/mobile-push` → `{ platforms: { ios, android }, status: 'configured' | 'notConfigured', error? }`。不列出设备或 token。
- `PUT /api/sessions/mobile-push` → `{ registered, status: 'registered' | 'notConfigured', id?, expiresAt? }`。
- `DELETE /api/sessions/mobile-push`，body `{ token: ordinaryDevicePushToken, hostId }` → `{ removed: number }`，幂等删除本手机在此主机的普通通知和关联的实时活动。未配置 provider 时也能删除旧登记。
- `DELETE /api/sessions/mobile-push/:id`，body `{ token }` 保留单项注销；不匹配返回 404。
- `POST /api/sessions/mobile-push/test`，body `{ token: ordinaryDevicePushToken, hostId?: string }` → `{ status: 'sent' | 'notConfigured' | 'noRegistration' | 'failed', error? }`。只匹配当前调用者（LAN 为该 token 的归属，远程为已验证的配对设备）自己的普通通知登记，不接受 owner/device ID；`hostId` 给出时只发该主机的登记。发送标题“测试通知 · cc-haha”、正文“电脑推送正常：这条是电脑发给你手机的。”，APNs category 为 `cchahaResult`，data 为 `{ hostId, eventType: 'test' }`（没有 sessionId）。这是用户主动测试，不受通知类别偏好和免打扰限制；Android 在拆分渠道下使用 `cc-haha-completed`。`notConfigured` 表示电脑没有该平台的 APNs / FCM 配置，`noRegistration` 表示没有匹配登记，`failed` 的 `error` 不含 token 或凭据。

普通注册 body：

```ts
{
  platform: 'ios' | 'android',
  token: nativeDevicePushToken,
  hostId: phoneLocalHostId,
  hostName: optionalDisplayName,
  kind: 'notification',
  preferences: { decisions: true, completed: true, errors: true },
  quietHours: { enabled: false, start: '22:00', end: '08:00' },
  timeZone: 'Asia/Shanghai'
}
```

可选的 `delivery`（普通通知和实时活动登记都可携带，缺省即旧行为）：

```ts
delivery?: {
  channels?: 'split',                       // Android：按事件拆分通知渠道
  timeSensitive?: boolean,                  // iOS：决定类推送使用时间敏感级别
  liveActivity?: 'running' | 'decisions',   // 实时活动远程更新范围
  showCommand?: boolean                     // false：实时活动不携带原始命令 / 预览
}
```

- 各字段类型严格校验，未知字段被拒绝；随登记保存，再次注册会整体替换（不带 `delivery` 的注册会清除旧值）。旧数据没有该字段也能原样加载。
- `channels: 'split'`：FCM `channel_id` 按事件选择，等待审批 / 问答 / 计划为 `cc-haha-decisions`，完成为 `cc-haha-completed`，失败和无进展为 `cc-haha-errors`；否则一律 `cc-haha`。手机需要自己创建这三个渠道。
- `timeSensitive: true`：决定类推送的 aps 带 `"interruption-level": "time-sensitive"`，其他类型保持默认 `active`。
- `liveActivity: 'decisions'`：只在等待决定时远程更新实时活动；运行中状态不发 `update`，而是对仅在运行的活动发送 `end` 并移除登记，避免远程推送把它重新唤起。缺省或 `'running'` 保持原样。
- `showCommand: false`：实时活动 `detail` 不含原始命令 / 预览：等待中的 Bash 为“打开 App 查看命令”，其他等待为“需要你做决定”，运行中为空，结束为“本次运行已结束”。

`hostId` 仅用于返回手机后的主机导航，不能建立或改变授权。客户端需要安全保存注册 ID 及原 token，以便重启后、移除主机时或 token 轮换时撤销旧登记。离线注销不能表示成功，应保留待注销记录以重试。注册有效期为 30 天，不超过远程配对的实际期限；实时活动登记最多 8 小时。

Live Activity 增加 `{ kind: 'liveActivity', sessionId, activityId, name: 'CCHahaTaskActivity', deviceToken: ordinaryDevicePushToken }`，`token` 使用 ActivityKit 的专用推送 token；`deviceToken` 只保存摘要，用于关联普通设备登记和整机注销。服务端发送 `aps.event=update/end`、`timestamp`、`stale-date`，以及 `content-state: { name, props: JSON.stringify(props) }`。持续运行或等待中的活动每 60 秒刷新一次，stale-date 延长到本次投递后 90 秒；电脑离线时不会继续伪造新鲜状态。真实会话结束后会发送 end 并移除登记。客户端仍应在本地结束活动时撤销注册。

普通通知 data 为 `{ hostId, sessionId, requestId?, eventType }`。APNs category 为 `cchahaTool`、`cchahaDecision` 或 `cchahaResult`。只有普通工具权限提供允许/拒绝动作；问答、计划和 Computer Use 必须打开 App 处理。动作到达 App 后必须再次核对原主机、原会话及仍待处理的 request ID；推送本身不批准权限。

## 持久化与撤销

配置目录的 `cc-haha/mobile-push.json` 保存 token 摘要、设备归属、偏好和 AES-GCM 密文；相邻 `.key` 文件为随机本地加密密钥。两者权限为 0600。未注册时不会创建文件。空 v0 数据迁移为 v1，未知扩展字段保留，未来 schema 拒绝写入。不要把这些文件加入 Git 或同步到公共存储。

撤销配对、配对到期、关闭远程入口后，服务端不再向该远程设备投递。迁移或关闭服务时停止轮询并等待在途工作，避免迁移过程中写回数据。

参考：[Apple APNs token authentication](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns)、[ActivityKit push updates](https://developer.apple.com/documentation/activitykit/starting-and-updating-live-activities-with-activitykit-push-notifications)、[FCM HTTP v1](https://firebase.google.com/docs/cloud-messaging/send/v1-api)。
