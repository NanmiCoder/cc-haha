# Connecting a private desktop installation

An independently operated directory can be used for development or personal use without changing the source default. Keep its real hostname, server access credentials, and private client state outside the repository. The contributor build keeps `REMOTE_DIRECTORY_URL` empty; merging the feature does not direct other users to a contributor's service.

## Select the service once

Exit the desktop app fully. Launch its executable once with `CC_HAHA_REMOTE_DIRECTORY_URL` set to your directory's canonical HTTPS origin. Use the exact origin, with no trailing slash, path, query, fragment, or username/password. The hostname below is a documentation placeholder, not a deployed service:

```sh
CC_HAHA_REMOTE_DIRECTORY_URL='https://directory.example' /path/to/desktop-executable
```

For macOS, invoke the executable inside the `.app/Contents/MacOS/` directory. An already running app may keep its original process configuration, so quit it before this launch. For isolated tests, keep using the same test profile on later launches: the directory choice, computer identity, and device grants belong to that profile.

The desktop writes this selection to its existing `cc-haha/public-access/public-access-private.json` under the active desktop configuration directory. The file is written atomically with mode `0600` where supported. The v4 settings migration preserves unrelated and unknown fields, existing consent, remote enablement, and login preferences. A real directory URL never needs to be placed in `src/shared/remoteServiceConfig.ts`, an Android build setting, or a tracked deployment file.

The selected origin survives quitting, restarting, and login startup without the environment variable. The phone learns and pins the directory origin and computer public key during its initial trusted pairing. Switching the directory later requires an explicit operator change and another trusted pairing for phones that still pin the previous directory. It does not regenerate the computer's identity key or device grants.

Directory selection does not enable remote access or grant consent by itself. Enable remote access in Settings and complete the desktop confirmation and phone pairing as usual. The public tunnel still carries requests and session output; the directory stores signed current-address announcements only.

## Selection and clearing rules

The precedence is:

1. An explicit integration/test `directoryUrl` option.
2. An explicitly present `CC_HAHA_REMOTE_DIRECTORY_URL` environment variable.
3. The `directoryUrl` saved in the private settings file.
4. The project build's `REMOTE_DIRECTORY_URL` default.

An explicit override is validated before it is saved. A missing override leaves the saved choice intact. Older files without `directoryUrl` retain the build-default behavior; migration does not invent a private endpoint or opt them into a service. A saved choice also takes precedence over a later project's build default, preventing an upgrade from silently moving a private installation to another directory.

To deliberately disable discovery, quit and launch once with an empty value:

```sh
CC_HAHA_REMOTE_DIRECTORY_URL='' /path/to/desktop-executable
```

The empty selection is persisted. Future launches remain in temporary access mode, even if a later build gains a project directory default. Existing phones cannot discover subsequent address changes through the disabled service. To return to a service, repeat the launch with its HTTPS origin. To opt back into the build default, quit the app and remove only the `directoryUrl` field from the private JSON, preserving the other fields and permissions.

Invalid overrides or invalid saved directory values fail closed: no tunnel opens and no fallback service is selected. The existing file is left unchanged during startup and subsequent settings operations. Credential/provider changes reject until the configuration is corrected; Stop and quitting still close runtime access without overwriting the rejected file. Correct the selection and restart; an invalid value already saved in the file needs to be corrected there before startup. Preserve the other fields, including the intended `enabled` value, when repairing it. Errors returned to the renderer do not include the origin or any accidentally supplied credentials.

## Restrict a personal deployment

Use the private server's host allowlist to authorize only the selected computer identity. The directory origin itself is not a password. Device authorization remains a separate boundary: each phone must be approved on the desktop, and the desktop can revoke that grant. Do not distribute the private profile, identity file, pairing QR, or an APK containing credentials. A generic Android APK can learn the private origin from the trusted QR without any private server information in its source or assets.

Test the allowlist, signed publication, restart persistence, address changes, phone cold start, network reconnection, and device revocation before treating a deployment as ready. Distinguish isolated fixtures, emulator network tests, public internet tests, and physical phone testing in the validation report.
