# GoldenXperience Mobile

The GoldenXperience (GX) mobile client — iOS and Android — built with **React
Native + Expo (SDK 57) + TypeScript + Expo Router**.

It is a **new frontend for the existing GX backend**, not a new backend. All
trading logic, OANDA integration, signal generation and account data live on the
existing GX API server; the mobile app only reads from it and renders it.

```
OANDA / trading infrastructure
        ↓
   Existing GX backend            (api-server/ — unchanged)
        ↓
   GX API + realtime layer        (HTTP + WebSocket on :8787)
     ↙            ↘
  Web app        Mobile app       (frontend/ — unchanged)   (apps/mobile/ — this)
```

Broker credentials never leave the server. The mobile app talks only to the GX
API and reads only `EXPO_PUBLIC_*` config — no secret is ever bundled into the
client.

---

## Quick start

```bash
cd apps/mobile
cp .env.example .env      # then set EXPO_PUBLIC_GX_API_URL (see below)
npm install
npx expo start
```

The API server must be running (`npm --workspace api-server run dev` from the
repo root, on `:8787`).

### Scripts

| Command | What it does |
| --- | --- |
| `npm run start` | Start the Expo dev server (Metro) |
| `npm run ios` / `npm run android` | Start and open a simulator/emulator |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint (expo config) |
| `npm run test` | Jest (pure logic units) |

### Environment variables

Only `EXPO_PUBLIC_*` values reach the client. **Never** put a server secret
(OANDA keys, `DATABASE_URL`, VAPID private key) here.

| Variable | Required | Notes |
| --- | --- | --- |
| `EXPO_PUBLIC_GX_API_URL` | yes | Origin of the GX API server. On a **physical device**, `localhost` is the phone — use your dev machine's LAN IP, e.g. `http://192.168.1.50:8787`. |
| `EXPO_PUBLIC_GX_WS_URL` | no | Override the market-stream WebSocket origin. Defaults to the API origin with `http`→`ws`. |

---

## Development build (not Expo Go)

This app uses a native module (`@react-native-cookies/cookies`) to capture the
session cookie, so it must run in a **development build**, not Expo Go:

```bash
npx expo run:ios      # or run:android — builds a dev client
```

Expo Go is fine for pure-UI iteration, but auth and the full flow need the dev
build. The production architecture is not constrained to Expo Go.

---

## Architecture

```
app/                         Expo Router routes (file-based)
  _layout.tsx                Providers (SafeArea → Theme → Auth) + themed Stack
  index.tsx                  Auth gate → redirects to (tabs) or login
  login.tsx                  Sign in against the existing GX account system
  (tabs)/                    The five primary destinations
    _layout.tsx              Bottom tabs + auth guard + MarketStreamProvider
    index.tsx  signals.tsx  chart.tsx  trades.tsx  more.tsx
  signals/[id].tsx           Nested detail (Phase 1 stub)
  trades/[id].tsx            Nested detail (Phase 1 stub)
src/
  api/                       config · session · client · auth · endpoints
  auth/                      AuthProvider (session lifecycle)
  realtime/                  MarketStore + MarketStreamProvider (WebSocket)
  hooks/                     useResource (loading/refreshing/error states)
  lib/                       instruments · format · signals · home (pure logic)
  theme/                     tokens (GX Design System V1) + ThemeProvider
  components/ui/             Screen, Card, Skeleton, Tags, States, banner…
  features/                  home/ · signals/ · trades/ (screens + view-models)
  types/                     Vendored GX domain types
```

Data flow: **screens → hooks → `src/api` → GX API**. No component calls `fetch`
directly. API responses use types vendored from `frontend/src/types` (see
"Shared types" below).

### Backend endpoints consumed

Auth: `POST /api/auth/login`, `GET /api/auth/me`, `POST /api/auth/logout`.
Data: `/api/oanda/{account-summary,account-history,open-positions,pricing}`,
`/api/watchlist`, `/api/multistrategy/watchlist`, `/api/paper-cycle`,
`/api/journal/trades`, `/api/strategy`. Realtime: the WebSocket at the API root
(`price` / `status` / `heartbeat` messages).

### Authentication

The GX backend uses an HttpOnly `gx_session` cookie. Because iOS/Android strip
`Set-Cookie` from JS, after login the app reads the cookie back out of the
native jar (`@react-native-cookies/cookies`), stores **only the token** in the
device keychain (`expo-secure-store`), and attaches it as a `Cookie` header on
every request. No backend change; the session survives cold starts; no broker
credential is ever stored client-side.

### Realtime

A single WebSocket (`MarketStreamProvider`) feeds an external store read through
`useSyncExternalStore`, so a price tick for one instrument re-renders only the
components subscribed to that instrument. It reconnects with exponential
backoff, detects a stalled stream, and force-reconnects on foreground. The UI
never crashes when the stream is down — screens show the last snapshot and the
connection banner reflects connecting / reconnecting / offline / simulated.

### Theming

`src/theme/tokens.ts` defines the GX Design System V1 semantic tokens for both
**light and dark**, ported verbatim from the web `globals.css`. Components read
semantic names (`colors.surfaceElevated`, `colors.positive`), never raw hex.
Theme follows the OS by default; **More → Appearance** forces light/dark.

---

## Shared types (`packages/` path)

Phase 1 **vendors** the pure GX domain interfaces into `src/types` rather than
importing across the repo, so the mobile Metro bundler never reaches into the
React-19/Next web project. No business logic is duplicated — only structural
types. When web and mobile need to stay in lockstep, promote these to
`packages/types` and have both import them. That extraction is deliberately
deferred until it earns its keep, per the brief.

---

## Phase 1 scope & known tradeoffs

**Built:** app shell, dual theme, bottom navigation, auth, Home (+ idle state),
Signals (+ history), Trades, realtime foundation, loading/empty/error/offline
states. **Chart** is an intentional placeholder — the real trading chart is
**Phase 2** against the approved GX Chart design.

- **Legacy architecture (`newArchEnabled: false`, via `expo-build-properties`).**
  `@react-native-cookies/cookies` does not support the New Architecture. This is
  the one dependency forcing legacy arch; when moving to the New Architecture,
  swap it for a New-Arch cookie manager (e.g. `react-native-nitro-cookies`).
- **`expo-doctor` "duplicate react" warning** is expected: the web app at the
  repo root ships its own React, and this standalone app (not a workspace member)
  ships its own. Metro resolves the local copy — verified by a clean
  `expo export`. It is a static-scan artifact of the repo layout, not a bundle
  problem.

The existing web app and API server are untouched.
