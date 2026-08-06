---
title: Code signing policy
nav_title: Signing policy
description: Signing scope, responsible roles, approval, verification, and revocation rules for official Claude Code Haha releases.
order: 5
---

# Code signing policy

This policy applies to official Windows releases of Claude Code Haha. The project is applying for free code signing through the SignPath Foundation. Until onboarding is complete, the Windows download page will continue to identify installers as unsigned. After onboarding, only artifacts that comply with this policy will be submitted for signing.

Free code signing provided by SignPath.io, certificate by SignPath Foundation.

The service is provided by [SignPath.io](https://about.signpath.io) and the [SignPath Foundation](https://signpath.org).

## Signing scope

Signing is limited to the Windows desktop application, project-owned sidecars, and final x64 and ARM64 NSIS installers built from source owned by this project in [NanmiCoder/cc-haha](https://github.com/NanmiCoder/cc-haha).

Release packages may include third-party or upstream open-source components distributed under their respective licenses. Those components may be bundled unchanged, but they will not be signed as binaries owned by Claude Code Haha. The certificate will not be used for other projects, personal builds, debug builds, or files of unknown origin.

## Trusted source and build

- The only trusted source is a protected release commit or tag in the public GitHub repository.
- Official Windows artifacts are built by version-controlled GitHub Actions workflows on GitHub-hosted runners.
- Every signing request must be traceable to a specific commit, release tag, workflow run, and build artifact.
- An artifact must not be published if signing fails, its origin is unclear, or its metadata does not match the release.

## Responsible roles

- **Authors / Committers:** [@NanmiCoder](https://github.com/NanmiCoder), plus external contributors whose changes have been reviewed and accepted.
- **Reviewers:** [@NanmiCoder](https://github.com/NanmiCoder); external contributions require maintainer review before entering an official release commit.
- **Approvers:** [@NanmiCoder](https://github.com/NanmiCoder).

Team members must enable multi-factor authentication for their GitHub and SignPath accounts. This page will be updated when roles or members change.

## Approval and release

Every signing request for an official release requires manual approval by an Approver. Automatic approval and approval bypasses are not permitted. Before approval, the commit or tag, build workflow, target architecture, file name, product name, version, and release notes must be checked. An artifact may be uploaded to GitHub Releases only after approval and signature verification.

## User verification

After onboarding is complete, a Windows installer can be inspected in PowerShell:

```powershell
Get-AuthenticodeSignature ".\Claude-Code-Haha-<version>-win-x64.exe" |
  Format-List Status, StatusMessage, SignerCertificate, TimeStamperCertificate
```

Continue with installation only when `Status` is `Valid`, the product and version are expected, and the file came from this project's [GitHub Releases](https://github.com/NanmiCoder/cc-haha/releases).

## Security incidents and revocation

Report suspected misuse of the certificate, signing accounts, build process, or release artifacts through a [private GitHub security advisory](https://github.com/NanmiCoder/cc-haha/security/advisories/new) or by email to [relakkes@gmail.com](mailto:relakkes@gmail.com). The maintainer will pause affected releases and signing requests, remove affected downloads, investigate the source, and ask the SignPath Foundation to revoke the certificate or signature when necessary.

See [Privacy and network access](./privacy.md) for the software's network and local-data behavior.
