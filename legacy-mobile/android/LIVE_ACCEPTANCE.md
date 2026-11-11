# Private deployment acceptance

This optional check uses a real public HTTPS directory and tunnel, the production Android APK, AndroidKeyStore and the Android system trust store. It never calls a model provider. It is separate from the deterministic Android quality gate and is skipped unless explicitly selected. Do not run it on a phone or emulator containing personal app data.

## Prerequisites

- An explicitly owned disposable emulator, with a recent System WebView supporting profiles, and `adb` on PATH (or `ADB=/absolute/path/to/adb`).
- Production `app-debug.apk` and a test APK built with `./gradlew :app:assembleDebugAndroidTest`. Installing the test APK does not add code or runtime config to the production APK.
- A backend launched with a disposable HOME/config and the mock SDK, serving the real built H5. Keep the same isolated identity and device-grant files across backend restarts.
- A public tunnel to that backend, and the deployed directory configured through the backend's local authenticated `native/configure` route. Sign announcements through the production local `native/announcement` route and publish them to the deployed directory.
- The directory's private host allowlist includes the chosen host identity. For a disposable test identity, remove it after acceptance. Alternatively, create a dedicated private desktop profile first and use that same new identity for acceptance and subsequent user testing; keep only that intended identity allowed. Keep model/provider configuration and transcripts isolated, remove the test phone grant afterwards, and never copy a pre-existing user's private keys or grants into a fixture.
- Desktop approval and revocation use authenticated **local** routes. Do not add public test-control endpoints, server credentials, CA overrides or a tunnel bypass to run these checks.

The test class has no hardcoded address, secret, certificate or private host identity. Runtime JSON belongs outside tracked source, for example in the ignored `artifacts/` directory with mode `0600`. Do not paste QR links into shell command arguments or logs. The helper streams JSON into the app's private files; enrollment deletes its one-time QR config after success.

## Run each phase separately

Install the production and instrumentation APKs onto the selected disposable emulator. Set `SERIAL` to that emulator's explicit ID. Each phase force-stops the app, so the resume phase really runs in a different process.

1. Obtain a v2 pairing link through the isolated backend's local pairing route. Write `{"pairingUrl":"<full v2 QR URL>"}` to a private runtime JSON file. Run `./run-live-acceptance.sh "$SERIAL" enroll "$CONFIG"`. While it waits (at most 90 seconds), approve the pending device named `Android private acceptance` through the local desktop route. The phase exercises the real public pair/claim/enroll APIs, saves the grant and cookie, and checks that the Android private key cannot be exported.
2. Replace the runtime JSON with `{}`. Run `./run-live-acceptance.sh "$SERIAL" resume "$CONFIG"`. It checks the persisted key and cookie, and authenticates after force-stop without rescanning.
3. Run `./run-live-acceptance.sh "$SERIAL" webview "$CONFIG"`. It opens the real app, presses the saved computer's Connect button, and waits for the authenticated production H5 mobile-state bridge, completed session-list loading and a compositor frame. No injected browser transport or test HTML is used. Pull `/sdcard/Android/data/com.cchaha.mobile/files/live-acceptance/webview.png` from this emulator for visual review; keep the screenshot with private acceptance evidence, not source.
4. Stop the old public tunnel and backend. Restart the backend using the same isolated identity and grant store; allocate a new tunnel address, set it on the backend, and publish a new signed directory announcement. Confirm that the old address no longer routes to this backend. Write `{"expectedOrigin":"<new HTTPS tunnel origin>"}` to the private runtime config. Run `./run-live-acceptance.sh "$SERIAL" rotate "$CONFIG"`. It requires a new directory sequence, the expected new origin, the same pinned host and device grant, a freshly signed cookie, and an authenticated session on the new origin.
5. Replace runtime JSON with `{}`. Run the `resume` and `webview` phases again. Run `./run-live-acceptance.sh "$SERIAL" network "$CONFIG"` to disable emulator Wi-Fi and mobile data, assert there is no active network, then restore the previous settings and reconnect. This proves loss/recovery in an emulator; it does not prove a physical phone's Wi-Fi-to-cellular handover.
6. Revoke only this test device using the local desktop revoke route, then run `./run-live-acceptance.sh "$SERIAL" revoked "$CONFIG"`. The app must return `PAIR_REQUIRED`, even though its old cookie and private key still exist.
7. Run `./run-live-acceptance.sh "$SERIAL" cleanup "$CONFIG"`. It removes only the marked acceptance record, key and all profiles reached during this run. Stop the owned tunnel/backend, remove any temporary allowlist entry, delete the runtime QR config and disposable server state, and uninstall both APKs from the owned emulator. If the identity belongs to a newly created private desktop profile intended for user testing, retain that identity and its configured allowlist entry; remove test grants and fixture transcripts rather than deleting the intended profile.

The helper prints Android's instrumentation report and returns failure unless the selected method reports `OK (1 test)`. Android's `am instrument` process exit code alone is not proof of a passing test. Preserve the report with the acceptance evidence. These phases prove native authorization recovery and H5 loading; session streaming, chat actions and file uploads require their separate UI acceptance checks.

## Failure cleanup

If enrollment fails before writing its marker, do not relax assertions or overwrite an existing record. Use a fresh disposable emulator/app install, revoke any pending test grant on the local backend, and remove the temporary allowlist entry. Network toggling restores the observed settings in a `finally` block; if instrumentation itself is killed during that phase, restore the emulator network before continuing. Never keep a throwaway host permanently allowed just to make a test pass.
