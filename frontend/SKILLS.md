# GoldenXperience Product Skill

Use this skill when building or modifying GoldenXperience, a personal forex trading app.

## Product Principle

GoldenXperience is not a generic trading dashboard. It is a focused personal forex cockpit.

Every screen must help answer one of these questions:

1. What pair am I watching?
2. Is there a valid setup?
3. What is my entry, stop, target, and risk?
4. Can I safely paper trade?
5. What happened to my past trades?
6. Is OANDA connected?

If a UI element does not support one of those jobs, remove it.

## Anti-Slop Rules

Do not add:
- generic fintech filler
- fake AI insight panels
- random “premium dashboard” widgets
- meaningless stats
- decorative gradient cards
- unused buttons
- fake analytics
- placeholder features pretending to work
- marketing landing-page sections
- overbuilt abstractions
- animations that hurt usability

If data is mocked, clearly label it as demo/mock data.

If a feature is not functional, either omit it or mark it as pending.

## UI Direction

Design mobile-first.

Dark theme:
- black/charcoal background
- muted gold accents
- white text
- green/red only for trade status

Light theme:
- warm white background
- charcoal text
- subtle borders
- muted gold accents
- green/red only for trade status

The UI should feel clean, focused, premium, and fast.

## Core Screens

Build only these first:

- Dashboard
- Signals
- Journal
- Risk
- Settings

Mobile should use bottom navigation.
Desktop should use sidebar navigation.

## OANDA Rules

OANDA integration must stay backend-only.

Never expose OANDA credentials in frontend code.

Use environment variables:
- OANDA_API_KEY
- OANDA_ACCOUNT_ID
- OANDA_ENVIRONMENT=practice

If credentials are missing, show a clear disconnected/mock state.

## Engineering Rules

Use:
- Next.js
- TypeScript
- Tailwind CSS
- clean component structure
- server-side OANDA service layer
- `.env.example`
- README setup instructions

Do not set up Supabase yet.

Structure code so Supabase can be added later without rewriting the app.

## Animation Rules

Use motion sparingly:
- route transitions
- card entrance
- tab transitions
- mobile tap feedback

Respect reduced-motion preferences.

No flashy effects that make the app feel fake or slow.

## Completion Standard

Before finishing:
- run lint/build if available
- fix errors
- verify OANDA route works or clearly reports missing credentials
- make sure light and dark themes both look intentional
- make sure mobile layout is not cramped