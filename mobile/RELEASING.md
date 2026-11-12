# Mobile Releases

The mobile app uses its own user-facing version number. Desktop Releases keep using `vX.Y.Z`, and desktop-only changes don't require a mobile version bump; release notes should link to the existing mobile version. iOS is delivered automatically to App Store Connect / TestFlight, with formal App Store review and listing handled separately; Android publishes a production-signed APK and is not submitted to Google Play.

## Linked projects

- Expo: `@relakkesyangs-team/cc-haha`
- Project ID: `4e75f835-1b64-463c-a196-cc181b4c83ec`
- App Store Connect App ID: `6826961014`
- iOS Bundle ID: `com.yunce.cchaha.mobile`
- iOS Widget: `com.yunce.cchaha.mobile.widgets`
- App Group: `group.com.yunce.cchaha.mobile`
- Android package: `app.cchaha.mobile`

Project identifiers can be public; credentials must not be committed. EAS manages production signing credentials; keep and back up the Android keystore, since future updates must keep the same signing identity.

## One-time account setup

1. The account holder accepts the current agreements in Apple Developer / App Store Connect and creates the app for the Bundle ID above in App Store Connect.
2. Register the main app, the Widget, and the App Group, configure the capabilities actually used (such as notifications), and prepare separate App Store distribution provisioning profiles for the main app and the extension.
3. In `mobile/`, configure signing with `bunx eas-cli@25.3.0 credentials:configure-build --platform ios --profile production`; for Android, replace `ios` with `android`. This accesses real accounts and is not part of offline testing.
4. Configure the App Store Connect API Key used by EAS Submit via `bunx eas-cli@25.3.0 credentials --platform ios`. This is different from the APNs push key.
5. In GitHub Actions Secrets, configure `EXPO_TOKEN` (a dedicated release bot is recommended). In Variables, configure `EXPO_PROJECT_ID`, `EXPO_OWNER`, and the numeric `ASC_APP_ID`.
6. Once the first build and delivery are confirmed to work, set the GitHub variable `MOBILE_RELEASE_ENABLED=true` to enable automatic delivery with each official desktop Release. Until then, desktop releases are not affected by unfinished mobile account setup.

The root `.easignore` keeps mobile and shared source, and excludes Git objects, other product directories, generated native projects, and signing files; EAS regenerates native projects from the Expo config.

`eas.json` pins the EAS CLI version, uses the `production` environment, remote signing credentials, and auto-incrementing build numbers, and explicitly sets the Android artifact to APK. Do not use the local default debug keystore to sign public distributions.

To enable Android FCM, set the file variable `CC_HAHA_GOOGLE_SERVICES_FILE` in the EAS production environment, containing the Firebase Android client JSON matching `app.cchaha.mobile`. Service account private keys must never go into the app. Optional: Android uses phone-side pull by default and doesn't need FCM. See the [push notes](PUSH_NOTIFICATIONS.md).

## Regular releases

After preparing release notes at the repository root, follow the existing release PR flow:

```sh
# Desktop update; mobile keeps its current version
bun run scripts/release.ts patch --dry

# Also bump the mobile version; preview first, then remove --dry to run it
bun run scripts/release.ts patch --mobile patch --dry
```

The mobile `mobile/app.json#expo.version` and `mobile/package.json#version` must match. The release script only updates these two files when `--mobile` is passed explicitly. Production code changes without a user version bump block mobile delivery and prompt you to bump the version first; they don't affect already-published desktop artifacts.

The mobile release is invoked explicitly by `Release Desktop` after the official release completes, and does not depend on the `release.published` event. Release events produced with the GitHub Token cannot reliably trigger another workflow.

Each platform stores `mobile-release-ios.json` or `mobile-release-android.json` as a Release attachment. These record the source commit, build input digest, mobile version, and EAS build ID successfully delivered for that platform; Android also includes the APK name and SHA-256. iOS success only means the upload finished, not that Apple review passed.

The change detection covers mobile code, plugins, dependencies, assets, build configuration, and the shared source and runtime transitive dependencies actually imported by mobile (not following type-only imports); shared files not used by mobile don't trigger a mobile release. Tests, docs, and generated files don't trigger a new package. Unresolvable local runtime dependencies block the release, to avoid wrongly concluding no update is needed. It compares against the platform's last successful delivery, not the last desktop tag, so previously failed deliveries aren't missed. With no history, it performs the first release.

## Retrying failures and read-only previews

GitHub Actions → `Release Mobile` → `Run workflow`:

- `release_tag`: an already publicly released stable tag containing this release code, e.g. `v1.2.3`. The workflow checks out the tag's commit and does not build the current default branch.
- `platform`: `ios`, `android`, or `all`.
- `dry_run`: on by default; only analyzes, without building, uploading, or consuming EAS build quota. Turn it off for real delivery.

Platforms that already succeeded are skipped. When the build succeeded but delivery failed, an EAS build with the same commit, version, and input digest is reused first; an identical build already in progress is not started again. When the Apple upload succeeded but writing the GitHub success record failed, a retry first checks the submission result for that build. The success record is only written after upload/publish completes; never hand-forge a record to clear a failure.

Automatic uploads and manual retries share a serial lock and don't cancel store uploads in progress. The Android APK's package structure and signature are verified before it's attached to the Release, and the default Android Debug signature is rejected.

## First App Store submission

Prepare real screenshots, description, support URL, mobile privacy policy and privacy disclosures, age rating, export compliance, and any material required for target regions. iPad is currently supported, so include the corresponding acceptance testing and presentation.

The app depends on desktop pairing, so review notes need to provide an actually accessible, isolated test environment and steps. The internal fixture server is not a ready-to-use official review entry. Only after TestFlight on-device verification passes should you select a build to submit for App Review; a successful CI upload cannot replace this step.

Background push doesn't need desktop-configured credentials: iOS relays through the Expo push service (the APNs Push Key must be configured in the EAS project credentials, with Enhanced Push Security kept off), and Android's foreground service pulls directly from the paired computer. Never bundle developer private keys into the desktop or mobile app. See the [push notes](PUSH_NOTIFICATIONS.md).

## Deterministic checks

```sh
bun run check:mobile
bun test scripts/mobile-release.test.ts scripts/release.test.ts
bun run check:policy
bun run check:impact
```

Use `bun run verify` for full verification. Mobile checks isolate HOME, disable Expo networking and telemetry, and don't use production credentials. EAS builds, TestFlight on-device experience, and actual push delivery are online evidence recorded separately.
