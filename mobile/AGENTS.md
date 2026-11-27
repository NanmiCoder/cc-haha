This is an Expo/React Native mobile application. Prioritize mobile-first patterns, performance, and cross-platform compatibility.

## Expo has changed — do not trust your training data

Expo ships breaking changes every SDK release. APIs you remember are likely renamed, moved, or removed. Before writing any code that touches an Expo, EAS, or React Native API:

1. Read the major version of the `expo` package in `package.json`.
2. Fetch the matching versioned docs: `https://docs.expo.dev/versions/v<major>.0.0/`
3. For anything else, fetch https://docs.expo.dev/llms.txt — an index of all Expo docs with corrections to common LLM misconceptions. Follow its links to the specific page you need; never answer from memory.

## Commands

Use `bunx` instead of `npx` if the project uses bun (`bun.lock` present).

```bash
npx expo install <package>  # ALWAYS use instead of npm/yarn/pnpm/bun add — resolves SDK-compatible versions
npx expo start              # start the dev server
npx expo lint               # lint
npx tsc --noEmit            # typecheck
npx expo-doctor             # diagnose dependency and config issues
npx expo install --fix      # fix incompatible package versions
```

Run lint and typecheck before declaring any task done.

## Navigation & Routing

- Use **Expo Router** for all navigation. Routes live in `src/app/` — every file there is a screen, `_layout.tsx` files define navigators. Keep non-route code (components, hooks, utils) outside `src/app/`.
- Import `Link`, `router`, and `useLocalSearchParams` from `expo-router`.
- Docs: https://docs.expo.dev/router/introduction.md

## Building with EAS

Use EAS to build, sign, and submit the app in the cloud (`eas build`, `eas submit`) and to ship over-the-air updates (`eas update`) — no local Xcode or Android Studio required. Run EAS CLI as `bunx eas-cli <command>` in Bun projects, or `npx eas-cli@latest <command>` otherwise; substitute that for bare `eas` in docs examples.
Docs: https://docs.expo.dev/eas/index.md

## Rules

- If `ios/` and `android/` directories do not exist, they are generated (Continuous Native Generation). Never create or edit them by hand — configure native behavior in `app.json` and config plugins.
- Expo Go only includes its bundled native modules. After adding a library with native code, the app needs a development build: `npx expo run:ios|android` locally, or `eas build --profile development`.
- Prefer recommended Expo modules over third-party libraries, and check your available skills before adding dependencies. Docs: https://docs.expo.dev/versions/latest/index.md

## Design System (Codex Pure Neutral V6C — Mobile & `/m` H5)

Mobile and the Expo Web H5 bundle (`/m`) share the Desktop PR #2049 **Codex Pure Neutral V6C** design system:

- **Pure Neutral Surfaces & Borders (`src/ui/palette.ts`)**:
  - **Light (`#FFFFFF`)**: `bg: '#FFFFFF'`, `card: '#FAFAFA'`, `cardRaised: '#FFFFFF'`, `sheet: '#F6F6F6'`, `bubble: '#F4F4F4'`, `code: '#F3F3F3'`, `fill: '#EFEFEF'`, `hair: '#E8E8E8'`, `borderStrong: '#D4D4D4'`, `ink: '#1A1C1F'`, `ink2: '#4E4E4E'`, `ink3: '#666666'`, `brand: '#0169CC'`.
  - **Dark (`#181818`)**: `bg: '#181818'`, `card: '#212121'`, `cardRaised: '#282828'`, `sheet: '#131313'`, `bubble: '#242424'`, `code: '#222222'`, `fill: '#282828'`, `hair: '#2B2B2B'`, `borderStrong: '#3D3D3D'`, `ink: '#DFDFDF'`, `ink2: '#B4B4B4'`, `ink3: '#969696'`, `brand: '#339CFF'`.
  - All neutral grays must keep equal RGB channels (`R === G === B`). Do not reintroduce legacy Direction C warm shadows (`rgba(28,25,23,...)`, `rgba(20,19,17,...)`) or warm hexes (`#FAF9F7`, `#EEECE7`, `#F7F6F3`, `#1B1A18`, `#22211F`, `#272522`, `#C25934`, `#E07A52`, `#EDEAE4`, `#121110`, `#1D1C1A`).
- **Radius & Shadows (`src/ui/palette.ts`, `src/ui/theme.tsx`)**:
  - Use the canonical `radius` scale (`xs: 4`, `sm: 6`, `md: 8`, `control: 10`, `key: 11`, `inner: 12`, `button: 12`, `card: 14`, `group: 14`, `composer: 18`, `sheet: 20`, `full: 9999`).
  - Use `useTheme().shadows` / `useShadows()` / `shadowsFor(scheme)` instead of inline `boxShadow` strings. Light shadows use pure neutral `rgba(0,0,0,...)`; dark shadows add a subtle `0 0 0 0.5px rgba(255,255,255,0.06..0.10)` rim lift.
- **Automated Guardrails**:
  - `src/ui/palette.test.ts` locks V6C Light/Dark tokens, neutral RGB channels, `radius`, and `shadowsFor`.
  - `src/ui/contrast.test.ts` enforces WCAG 2.1 AA (`>= 4.5:1`) across both light and dark token pairs.
  - `src/ui/designSystem.test.ts` statically scans `mobile/src/` and `mobile/public/index.html` for legacy warm tokens/shadows.
- **H5 Theme Sync & Zero-Flash Pre-Paint (`src/state/preferences.ts`, `public/index.html`)**:
  - On web, when `cc-haha.mobile.preferences` is absent, `PreferencesRepository` inherits Desktop's same-origin `cc-haha-follow-system-theme` and `cc-haha-theme` keys.
  - Persisting preferences on web mirrors `cc-haha-follow-system-theme` (`'1'` for `'system'`, `'0'` otherwise) and `cc-haha-theme` (`'dark'` / `'white'`) back to `window.localStorage` (wrapped in `try/catch` for restricted WebViews) so `/` and `/m/` stay synchronized.
  - `public/index.html` runs a synchronous pre-paint `<script>` in `<head>` using the same precedence to set `data-theme`, `backgroundColor`, `colorScheme`, and `<meta name="theme-color">` (`#FFFFFF` / `#181818`) before first paint.
