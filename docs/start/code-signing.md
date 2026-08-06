---
title: Code signing policy
nav_title: 签名政策
description: Claude Code Haha 正式发布包的签名范围、责任角色、审批、验证与撤销规则。
order: 5
---

# Code signing policy

本政策适用于 Claude Code Haha 的正式 Windows 发布包。项目正在申请 SignPath Foundation 免费代码签名；接入完成前，Windows 下载页会继续明确标注安装包尚未签名。接入完成后，只有符合本政策的构建产物才会提交签名。

Free code signing provided by SignPath.io, certificate by SignPath Foundation.

服务由 [SignPath.io](https://about.signpath.io) 和 [SignPath Foundation](https://signpath.org) 提供。

## 签名范围

签名仅用于本项目拥有并从 [NanmiCoder/cc-haha](https://github.com/NanmiCoder/cc-haha) 源码构建的 Windows 桌面程序、项目自有 sidecar，以及最终的 x64 和 ARM64 NSIS 安装包。

发布包可能包含在各自许可证下分发的第三方或上游开源组件。这些组件可以原样打包，但不会以 Claude Code Haha 自有二进制的身份签名。证书不会用于其他项目、个人构建、调试构建或来源不明的文件。

## 可信来源与构建

- 唯一可信源码来源是公开 GitHub 仓库的受保护发布提交或标签。
- 正式 Windows 产物由仓库内受版本控制的 GitHub Actions 工作流在 GitHub 托管的运行器上构建。
- 签名请求必须能追溯到具体提交、发布标签、工作流运行和构建产物。
- 签名失败、来源不明或元数据不一致的产物不得发布。

## 责任角色

- **Authors / Committers：** [@NanmiCoder](https://github.com/NanmiCoder)，以及提交经审核贡献的外部贡献者。
- **Reviewers：** [@NanmiCoder](https://github.com/NanmiCoder)；外部贡献必须经过维护者审核后才能进入正式发布提交。
- **Approvers：** [@NanmiCoder](https://github.com/NanmiCoder)。

团队成员必须为 GitHub 和 SignPath 账户启用多因素认证。角色或成员发生变化时，本页会同步更新。

## 审批与发布

每一次正式发布的签名请求都必须由 Approver 手动审批，不允许自动批准或绕过审批。批准前需要核对提交或标签、构建工作流、目标架构、文件名、产品名称、版本和发布说明。审批完成并验证签名后，产物才可以上传到 GitHub Releases。

## 用户验证

接入完成后，可以在 PowerShell 中检查 Windows 安装包：

```powershell
Get-AuthenticodeSignature ".\Claude-Code-Haha-<version>-win-x64.exe" |
  Format-List Status, StatusMessage, SignerCertificate, TimeStamperCertificate
```

只在 `Status` 为 `Valid`、产品与版本符合预期且文件来自本项目 [GitHub Releases](https://github.com/NanmiCoder/cc-haha/releases) 时继续安装。

## 安全事件与撤销

如发现证书、签名账户、构建流程或发布产物可能被滥用，请通过 [GitHub 私密安全报告](https://github.com/NanmiCoder/cc-haha/security/advisories/new) 或发送邮件至 [relakkes@gmail.com](mailto:relakkes@gmail.com) 报告。维护者会暂停相关发布和签名请求、移除受影响的下载、调查来源，并在需要时联系 SignPath Foundation 撤销证书或签名。

软件联网与本地数据处理方式见[隐私与联网说明](./privacy.md)。
