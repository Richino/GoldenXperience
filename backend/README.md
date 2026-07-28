# GoldenXperience Market Stream

Backend WebSocket bridge for real-time forex ticks.

OANDA's pricing stream is an HTTP streaming endpoint, not a browser WebSocket endpoint. This service connects to OANDA server-side, normalizes price updates, then broadcasts them to the Next.js frontend over WebSocket.

## Setup

```powershell
cd backend
npm install
```

Environment variables can live in `backend/.env.local`, the repo root, or `frontend/.env.local`.
Copy `backend/.env.example` to `backend/.env.local` if you want the stream
service to own its local configuration.

```env
OANDA_API_KEY=your_oanda_personal_access_token
OANDA_ACCOUNT_ID=xxx-xxx-xxxxxxx-xxx
OANDA_ENVIRONMENT=practice
MARKET_STREAM_WS_PORT=8787
```

`OANDA_API_TOKEN` is also accepted as a backward-compatible alias, but `OANDA_API_KEY` is the preferred name for this service.

## Run

```powershell
cd backend
npm.cmd run start
```

The server listens on:

```text
ws://localhost:8787
```

To verify it:

```powershell
npm.cmd run stream:test
```

If OANDA credentials are missing, the server still starts and broadcasts mock EUR/USD, GBP/USD, and USD/JPY ticks with `source: "mock"`.

The bridge reconnects with exponential backoff when the OANDA HTTP stream
closes, returns an error, or stops sending its expected heartbeat. Browser
clients also reconnect when the local WebSocket becomes stale.
