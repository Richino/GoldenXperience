# News push reminders

Subscribed devices receive reminders for medium- and high-impact calendar releases,
at 60 and 30 minutes before their scheduled time. Releases for the same currency
at the same time share one notification. Tapping opens Home; reminders also appear
in the notification inbox for those users.

The API checks once per minute and shares the existing 15-minute calendar cache.
Only a current calendar with verified event timestamps is used. A five-minute
grace window allows brief restarts; older reminders are skipped. Push messages
expire at the end of that window, so an offline device is not sent obsolete alerts
later. Push delivery timing ultimately depends on the device and push provider.
The existing unique user/dedupe key prevents repeated sends across restarts and
replicas. No order is placed by this worker.

Deploy migration `066_news_reminders.sql` before starting the updated API (the normal
Railway migration command handles this). `NEWS_REMINDERS_ENABLED` defaults on;
`NEWS_REMINDERS_ENABLED=false` disables it. The worker also respects
`ENABLE_SCHEDULERS=false`, so local instances cannot duplicate production work.
Use the existing notification setting to enable push on each device. On Apple
mobile devices, use the installed Home Screen app.

Run `npm run news-reminders:test` and `npm run typecheck` in `api-server`.
The reminder tests use fake database/push transports and never send real alerts.
