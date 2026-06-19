# Electron 发布与自动更新

本页是维护者发版 runbook。桌面端版本来源是 `desktop/package.json`，正式发布必须让版本号、Git tag 和 `release-notes/vX.Y.Z.md` 严格一致。

## 更新链路

应用内更新由 `electron-updater` 驱动，发布产物托管在 GitHub Releases：

| 平台 | 安装/更新目标 | Metadata |
|------|---------------|----------|
| macOS arm64/x64 | `dmg` 用于首次安装，`zip` 用于 Squirrel.Mac 更新 | `latest-mac.yml` |
| Windows x64 | NSIS `.exe` | `latest.yml` |
| Linux x64 | `.AppImage`，同时发布 `.deb` 供手动安装 | `latest-linux.yml` |
| Linux arm64 | `.AppImage`，同时发布 `.deb` 供手动安装 | `latest-linux-arm64.yml` |

Release workflow 会先在各平台 matrix 中生成 `latest*.yml`，把同名 metadata 临时改名为 `latest-<platform>.yml`，最后由 `scripts/release-update-metadata.ts` 合并回 electron-updater 期望的标准文件名。不要改成 matrix job 直接发布 GitHub Release，否则 metadata 可能互相覆盖。

## Signing Secrets

macOS signed/notarized release 依赖 GitHub Actions repository secrets：

```text
MACOS_CERTIFICATE
MACOS_CERTIFICATE_PASSWORD
APPLE_ID
APPLE_APP_SPECIFIC_PASSWORD
APPLE_TEAM_ID
```

`MACOS_CERTIFICATE` 是 Developer ID Application `.p12` 的 base64 内容。当前项目不发布 `.pkg`，不需要 Developer ID Installer 证书。

Windows signing secrets 是可选项：

```text
WINDOWS_CERTIFICATE
WINDOWS_CERTIFICATE_PASSWORD
```

缺少 Windows 签名时 NSIS 自动更新仍可工作，但用户可能看到 SmartScreen 提示。

## v0.4.3 首次切换

`v0.4.3` 是从旧 unsigned macOS 发布迁移到 Developer ID 签名/notarization 的第一个版本时，建议不要直接依赖旧版本自动更新：

1. 用 release workflow 产出 signed/notarized `v0.4.3`。
2. 在一台未安装开发证书的 macOS 机器上手动下载 `Claude-Code-Haha-0.4.3-mac-arm64.dmg`。
3. 不执行 `xattr -d` 或 `xattr -cr`，直接安装并打开。
4. 确认只出现标准下载来源确认，不出现无法验证开发者、文件损坏或 unidentified developer。
5. 再把后续 `v0.4.4` 作为自动更新验证目标。

## v0.4.4 自动更新验证

发布 `v0.4.4` 时至少验证一条真实更新链路：

1. 安装 GitHub Release 中的 `v0.4.3` 正式包。
2. 发布 `v0.4.4` tag，让 `Release Desktop` workflow 完整通过。
3. 打开 `v0.4.3` 应用，等待启动后自动检查，或进入 Settings 手动检查更新。
4. 确认应用提示 `v0.4.4`，下载完成后点击安装并重启。
5. 重启后确认 About/Settings 中版本为 `0.4.4`。

平台重点：

- macOS：确认 Release job 使用 `Build signed macOS Electron release artifacts`，且 `Verify macOS launch policy` 通过。
- Windows：确认 `latest.yml`、`.exe`、`.exe.blockmap` 都在 GitHub Release 中；未签名时 SmartScreen 不代表 updater 失败。
- Linux：优先用 AppImage 验证自动更新；`.deb` 继续作为手动安装包发布。

## 发版前检查

发版前至少运行：

```bash
bun run scripts/release.ts 0.4.3 --dry
bun test scripts/pr/release-workflow.test.ts scripts/release-update-metadata.test.ts scripts/quality-gate/package-smoke/index.test.ts
bun run check:policy
```

正式调用 `bun run scripts/release.ts 0.4.3` 前，先确认对应 `release-notes/v0.4.3.md` 已经存在。
