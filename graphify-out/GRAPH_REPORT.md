# Graph Report - C:\Users\arche\Desktop\code\GoldenXperience  (2026-07-24)

## Corpus Check
- Corpus is ~17,592 words - fits in a single context window. You may not need a graph.

## Summary
- 397 nodes · 660 edges · 23 communities (18 shown, 5 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 3 edges (avg confidence: 0.5)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Community 0
- Community 1
- Community 2
- Community 3
- Community 4
- Community 5
- Community 6
- Community 7
- Community 8
- Community 9
- Community 10
- Community 11
- Community 12
- Community 13
- Community 14
- Community 15
- Community 16
- Community 17
- Community 18

## God Nodes (most connected - your core abstractions)
1. `SetupChart()` - 19 edges
2. `MajorInstrument` - 16 edges
3. `compilerOptions` - 16 edges
4. `compilerOptions` - 10 edges
5. `getAccountSummary()` - 9 edges
6. `getCandles()` - 9 edges
7. `SignalWorkspace()` - 8 edges
8. `formatChartPrice()` - 8 edges
9. `testOandaConnection()` - 8 edges
10. `OandaPricingStream` - 7 edges

## Surprising Connections (you probably didn't know these)
- `DashboardPage()` --calls--> `getAccountSummary()`  [EXTRACTED]
  frontend/src/app/(workspace)/page.tsx → frontend/src/lib/oanda/client.ts
- `SettingsPage()` --calls--> `testOandaConnection()`  [EXTRACTED]
  frontend/src/app/(workspace)/settings/page.tsx → frontend/src/lib/oanda/client.ts
- `SignalsPage()` --calls--> `getCandles()`  [EXTRACTED]
  frontend/src/app/(workspace)/signals/page.tsx → frontend/src/lib/oanda/client.ts
- `GET()` --calls--> `getAccountSummary()`  [EXTRACTED]
  frontend/src/app/api/oanda/account-summary/route.ts → frontend/src/lib/oanda/client.ts
- `GET()` --calls--> `testOandaConnection()`  [EXTRACTED]
  frontend/src/app/api/oanda/status/route.ts → frontend/src/lib/oanda/client.ts

## Import Cycles
- None detected.

## Communities (23 total, 5 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.08
Nodes (39): getMarketStreamConfig(), loadEnvFiles(), MarketStreamConfig, parseInstruments(), parsePort(), createMockTick(), precision, prices (+31 more)

### Community 1 - "Community 1"
Cohesion: 0.07
Nodes (31): metadata, alignTimeToGranularity(), applyTickToCandles(), ENTRY_CHECKLIST, getSignalSearchText(), GRANULARITY_MS, mergeCandles(), MOBILE_TABS (+23 more)

### Community 2 - "Community 2"
Cohesion: 0.10
Nodes (36): GET(), GET(), GRANULARITIES, GET(), parseInstruments(), DashboardPage(), SignalsPage(), createMockCandles() (+28 more)

### Community 3 - "Community 3"
Cohesion: 0.10
Nodes (36): ChartTypeSelect(), VARIANT_ICONS, FILTER_INDICATORS, IndicatorSelect(), OVERLAY_INDICATORS, addOscillatorPane(), addOverlayLine(), addSetupLevels() (+28 more)

### Community 4 - "Community 4"
Cohesion: 0.06
Nodes (30): dependencies, lightweight-charts, lucide-react, motion, next, next-themes, react, react-dom (+22 more)

### Community 5 - "Community 5"
Cohesion: 0.07
Nodes (28): compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules, jsx, lib, module (+20 more)

### Community 6 - "Community 6"
Cohesion: 0.10
Nodes (16): GET(), GET(), metadata, metadata, rules, metadata, SettingsPage(), filters (+8 more)

### Community 7 - "Community 7"
Cohesion: 0.08
Nodes (23): dependencies, dotenv, ws, devDependencies, tsx, @types/node, @types/ws, typescript (+15 more)

### Community 8 - "Community 8"
Cohesion: 0.10
Nodes (21): eslint, eslint-config-next, devDependencies, eslint, eslint-config-next, @next/env, tailwindcss, @tailwindcss/postcss (+13 more)

### Community 9 - "Community 9"
Cohesion: 0.18
Nodes (14): DashboardView(), formatResultR(), permissionOptions, watchlistToneClass, PairAvatar(), dashboardState, signals, TradePermission (+6 more)

### Community 10 - "Community 10"
Cohesion: 0.12
Nodes (16): compilerOptions, esModuleInterop, forceConsistentCasingInFileNames, lib, module, moduleResolution, skipLibCheck, strict (+8 more)

### Community 11 - "Community 11"
Cohesion: 0.24
Nodes (6): AppShell(), isActive(), NavItem, navItems, primaryNavItems, BrandMark()

### Community 12 - "Community 12"
Cohesion: 0.33
Nodes (4): geistMono, geistSans, metadata, ThemeProvider()

### Community 13 - "Community 13"
Cohesion: 0.48
Nodes (6): formatPrice(), monthLabel(), Point, pointsToString(), PriceChart(), uniqueMonthIndices()

## Knowledge Gaps
- **130 isolated node(s):** `name`, `version`, `private`, `type`, `dev` (+125 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **5 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `MajorInstrument` connect `Community 2` to `Community 9`, `Community 3`, `Community 1`?**
  _High betweenness centrality (0.023) - this node is a cross-community bridge._
- **Why does `CandleSeries` connect `Community 2` to `Community 1`, `Community 3`, `Community 13`?**
  _High betweenness centrality (0.010) - this node is a cross-community bridge._
- **Why does `devDependencies` connect `Community 8` to `Community 4`?**
  _High betweenness centrality (0.010) - this node is a cross-community bridge._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _130 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.07910014513788098 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.06767676767676768 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.09830866807610994 - nodes in this community are weakly interconnected._