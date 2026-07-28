# GoldenXperience API server

This Railway service owns every HTTP API endpoint and the browser WebSocket market stream. It binds Railway's injected `PORT` (or `8787` locally).

## Local run

```powershell
cd api-server
npm.cmd install
npm.cmd run start
```

Configure `.env.local` from `.env.example`. Put OANDA credentials here, never in the frontend service.

## Railway

Set the service root directory to `api-server` and the start command to `npm run start`.

Required variables:

- `OANDA_ACCOUNT_ID`
- `OANDA_API_KEY`
- `OANDA_ENVIRONMENT=practice`
- `FRONTEND_ORIGIN=https://your-web-service.up.railway.app`

The web service needs `API_SERVER_URL` (Railway private URL, if available) and `NEXT_PUBLIC_API_SERVER_URL` (the API service's public HTTPS URL). The latter is used by browser API and WebSocket requests.

Health check: `GET /health`
