---
title: Download and install
nav_title: Install
description: Installers for macOS, Windows, and Linux, plus what to do when the OS blocks them.
order: 1
---

# Download and install

Install and go. You don't need Node.js, Python, or Claude Code — the CLI engine and the ripgrep binary used for file search are both bundled inside the installer.

The product is now called **cc-haha**. Existing packages, installed apps, and system processes may still use the legacy name `Claude Code Haha`; filenames and commands below match those published packages.

## Pick the right package

Everything lives on [GitHub Releases](https://github.com/NanmiCoder/cc-haha/releases/latest). Choose by operating system and CPU architecture:

| Your system | Download |
|---|---|
| macOS, Apple Silicon (M series) | `Claude-Code-Haha-<version>-macOS-Apple-Silicon.dmg` |
| macOS, Intel | `Claude-Code-Haha-<version>-macOS-Intel.dmg` |
| Windows x64 | `Claude-Code-Haha-<version>-Windows-x64-Setup.exe` |
| Windows ARM64 | `Claude-Code-Haha-<version>-Windows-arm64-Setup.exe` |
| Linux x64 | `Claude-Code-Haha-<version>-Linux-x64.AppImage`, `.deb` or `.rpm` |
| Linux ARM64 | `Claude-Code-Haha-<version>-Linux-arm64.AppImage`, `.deb` or `.rpm` |

Not sure which architecture you have? On macOS check the chip listed in "About This Mac"; on Windows check the system type under Settings → System → About. Don't guess from the brand of the machine.

Files ending in `-update.zip` and the `latest*.yml` files are used by the app's own updater. You don't need to download them. v0.7.6 and earlier used older names such as `mac-arm64`, `win-x64` and `linux-x86_64`.

## macOS

1. Open the DMG.
2. Drag cc-haha into Applications.
3. Launch it from Applications.

### If macOS says the app is damaged

Nothing is actually damaged. macOS quarantines anything downloaded from the web and refuses to launch it without an Apple signature — but it words the error as "damaged", which is thoroughly misleading. Releases are signed and notarized and skip this entirely; if you have an unsigned development build, use one of the two routes below.

**Option 1: the script that ships with the build**

Unsigned development builds include `install-macos-unsigned.sh`. Put it in **the same folder as the DMG** (Downloads, for example), then run:

```bash
cd ~/Downloads
bash install-macos-unsigned.sh
```

The script picks the DMG matching your architecture, mounts it, installs the app into `/Applications`, strips the quarantine attribute, and launches it. Any existing install is moved to the Trash first rather than overwritten in place.

**Option 2: clear the quarantine flag yourself**

If the app is already in Applications:

```bash
xattr -dr com.apple.quarantine "/Applications/Claude Code Haha.app"
```

Only do this for packages you have confirmed came from this repository's Releases. Never bypass Gatekeeper for software of unknown origin.

## Windows

1. Fully quit any running copy of the old version, including the system tray icon.
2. Double-click the `.exe`.
3. **Don't** right-click and choose "Run as administrator" — the installer is per-user, and running it elevated puts your data directory in the wrong place.

Unsigned packages trigger a SmartScreen warning. Once you've confirmed the file came from this repository's Releases, click "More info" → "Run anyway".

When upgrading in place, the installer inspects user data in the old install directory. If it reports that the program is still running, quit the main window and the tray icon, give the background sidecar, terminal, and IM adapter processes a few seconds to exit, then run the installer again. Don't delete the old install directory by hand first.

## Linux

**AppImage** (no installation, just run it):

```bash
chmod +x Claude-Code-Haha-<version>-Linux-x64.AppImage
./Claude-Code-Haha-<version>-Linux-x64.AppImage
```

If it fails with a FUSE-related error, install the runtime: `sudo apt install libfuse2` on Ubuntu 22.04 and earlier, `libfuse2t64` on 24.04 and later.

**deb** (Ubuntu, Debian and similar; installs into your application menu):

```bash
sudo apt install ./Claude-Code-Haha-<version>-Linux-x64.deb
```

**rpm** (Fedora, openSUSE and similar):

```bash
sudo dnf install ./Claude-Code-Haha-<version>-Linux-x64.rpm
```

On ARM64 machines, use the corresponding `Linux-arm64` file.

## Running from source

If you want to modify the code, debug the engine, or just use the CLI in a terminal:

```bash
git clone https://github.com/NanmiCoder/cc-haha.git
cd cc-haha
bun install
cp .env.example .env
./bin/claude-haha
```

Requires [Bun](https://bun.sh) and Git. This runs the CLI only; for building the desktop app and configuring the local server, see [Command line](../cli/index.md).

## Updating

**In-app updates (recommended).** Open Settings → About → App Updates and click "Check now". It compares your installed version against the latest GitHub Release, downloads the new build, and offers "Install and restart".

Before updating, stop any running sessions and save uncommitted work.

If the download stalls, you probably can't reach GitHub. The same panel has an "Advanced update proxy" setting where you can switch to the system proxy or enter a local HTTP proxy address (`http://127.0.0.1:7890`, for instance). This proxy only affects the app's own update downloads — it has no effect on model requests.

**Manual replacement.** Download the new installer from Releases and repeat the steps for your platform. Sessions, provider configuration, skills, agents, and memory live under `~/.claude`, not in the application directory, so installing over the top doesn't touch them.

:::warning
The installer's data protection is not a backup. Keep your own copy of anything you can't afford to lose.
:::

## Code signing policy

See the [Code signing policy](./code-signing.md) for the Windows signing scope, manual approval, responsible roles, and verification steps. Until SignPath Foundation onboarding is complete, Windows releases remain explicitly identified as unsigned. See [Privacy and network access](./privacy.md) for network and local-data behavior.

## Next

Go to [Connect a model](./models.md). Until a model is connected, the app opens but can't send a single message.

If it won't install or won't open, see [Won't install, won't open, won't connect](./troubleshooting.md).
