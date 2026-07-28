# GoldenXperience

A private, mobile-first forex trading workspace built with Next.js, TypeScript,
Tailwind CSS, and OANDA practice data. It includes a dashboard, signal review,
journal, risk plan, settings, light/dark themes, and explicit demo fallbacks when
broker credentials are absent.

## Stack

- Next.js App Router with React Server Components
- TypeScript and Tailwind CSS
- `next-themes` for persistent light/dark appearance
- Motion for reduced-motion-aware route and tab transitions
- Lucide icons
- Native `fetch` to the dedicated API server
- Lightweight Charts for custom forex candles and setup levels
- API-server WebSocket stream for live OANDA pricing ticks

Supabase is intentionally not installed or configured in this version.

## Local setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy `.env.example` to `.env.local`.

3. Configure the API server separately for live OANDA practice data. The web app only needs its API URLs:

   ```dotenv
   API_SERVER_URL=http://localhost:8787
   NEXT_PUBLIC_API_SERVER_URL=http://localhost:8787
   ```

   Keep OANDA credentials in `../api-server/.env.local`, never in this web
   service. The API returns clearly labeled demo data when they are absent.

4. Start the app:

   ```bash
   npm.cmd run dev
   ```

5. Open [http://localhost:3000](http://localhost:3000).

## OANDA integration

The OANDA API lives in `../api-server` and owns the OANDA credentials. The
web service calls it using `API_SERVER_URL` for server rendering and
`NEXT_PUBLIC_API_SERVER_URL` in the browser.

Available endpoints:

- `GET /api/oanda/status`
- `GET /api/oanda/account-summary`
- `GET /api/oanda/pricing?instruments=EUR_USD,GBP_USD,USD_JPY`
- `GET /api/oanda/candles?instrument=EUR_USD&granularity=M15&count=64`
- `GET /api/oanda/calendar?period=86400`
- `GET /api/oanda/test`

With the API server running, verify the connection or fallback contract:

```bash
npm run oanda:test
```

The script exits successfully for a connected account or the expected
not-configured fallback, and exits with an error when configured credentials
cannot authenticate or OANDA is unreachable.

## Market stream server

The real-time stream is part of `../api-server`. It connects to OANDA server-side
when credentials are configured, then broadcasts normalized ticks over WebSocket.
If credentials are missing, it broadcasts clearly labeled mock ticks.

Run it in a second terminal:

```powershell
cd ..\api-server
npm.cmd install
npm.cmd run start
```

The frontend defaults to:

```env
NEXT_PUBLIC_MARKET_STREAM_WS_URL=ws://localhost:8787
```

Verify the WebSocket stream:

```powershell
cd ..\api-server
npm.cmd run stream:test
```

## Quality checks

```bash
npm run lint
npm run typecheck
npm run build
```

## Current data boundaries

- Account, price, and candle data: OANDA practice when configured; demo fallback
  otherwise.
- Signal chart: server-loaded candles plus optional WebSocket ticks from the
  API-server market stream.
- Signal setup metadata: local typed plans, clearly separate from live pricing.
- Journal: device-local manual paper-trade records, with labeled demo seed rows.
- Risk: local deterministic position sizing and trade-permission rules.
- Persistence and authentication: intentionally deferred so Supabase can be
  added later without changing the OANDA service or route structure.
- This app does not place orders and does not provide automatic execution.

## Workflow checks

The dashboard only shows `Can Trade` after OANDA REST and the OANDA WebSocket
stream are connected, the daily limits are clear, and the manual news/setup
checks are confirmed. Mock pricing keeps permission at `Wait`.

The risk calculator sizes USD-account positions for EUR/USD, GBP/USD, and
USD/JPY. Run its deterministic sample checks with:

```powershell
npm.cmd run risk:test
```

Journal entries are stored in browser `localStorage` for this first version.
They are not broker orders and are not synchronized across devices.
