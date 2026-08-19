# dsh-tidewatch

**DeepSeek peak/off-peak tide badge**: a floating badge beside the composer that tells you whether it's peak or off-peak right now, how long until the next phase, and how much this session costs.

- Status dot: **orange/red for peak, teal/green for off-peak**, readable at a glance
- Collapsed: `● 峰期 距谷期 03:33 · ¥0.12` (peak, 03:33 to off-peak, ¥0.12)
- Expanded (click to open): official peak windows (Beijing time), current tier prices, this session's token breakdown, exchange-rate setting
- Billing: official peak/off-peak tier prices, billed by the **actual timestamp of each call**, cache hit/miss charged separately
- Currency: USD ledger → CNY display, configurable rate (default 7.2, persisted in localStorage)
- Follows the GUI light/dark theme (`--dsw-*` tokens)

## Peak windows (official basis)

DeepSeek introduced peak/off-peak time-of-day pricing on 2026-08-17:

| Window (UTC) | Beijing time | Tier |
|---|---|---|
| 01:00 – 04:00 | 09:00 – 12:00 | peak |
| 04:00 – 06:00 | 12:00 – 14:00 | off-peak |
| 06:00 – 10:00 | 14:00 – 18:00 | peak |
| 10:00 – next 01:00 | 18:00 – next 09:00 | off-peak |

Off-peak prices are half of peak prices. The badge judges the current tier by the UTC windows (official definition); the table display uses Beijing time.

## Billing model

- Unit: USD / 1M tokens (official pricing-page basis). Cost = input-miss × cacheMiss + output × output + (cache-read + cache-write) × cacheHit
- Calls before the peak-era boundary (2026-08-16 16:00 UTC) are billed at the then-current base price (historical correctness)
- Each call is billed at the tier of its **event timestamp**, so costs do not drift across a peak/off-peak switch
- The ledger stores USD; display converts via the configurable exchange rate

## Install

> Requires Node.js ≥ 20 + DeepSeek Harness (a build with the `dsh plugin` command).

```sh
# from npm (once published)
dsh plugin --profile web add dsh-tidewatch

# or a local directory (development)
dsh plugin --profile web add link:./dsh-tidewatch
```

Restart `dsh web` after installing.

## Usage

- The badge floats to the right of the composer, vertically centered with it; on narrow windows it moves above the composer instead, never covering the input area or the built-in stats line
- Click the badge to expand/collapse the detail panel: windows, current tier prices, token breakdown, exchange rate
- Exchange-rate edits apply immediately and persist

## Layout

```
dsh-tidewatch
├── package.json          # dsh.bundle.patch + dsh.client.platform manifest
├── cordis.patch.yml      # bundle patch row
├── scripts/build.sh      # build: syntax check + zod junction
├── lib/
│   ├── pricing.js        # pure functions: windows, isPeakHour/peakPhaseAt, price table, costOf
│   ├── index.js          # host: costUsage session projection (billed per event time)
│   └── client.js         # browser: floating badge (__ModuleLoader__ bundle)
├── docs/PORTING.md       # adaptation notes for other hosts
└── test/verify.mjs       # pure-module self-test (node test/verify.mjs, 17 checks)
```

## Data flow

```
model-call usage blocks (assistant/chunk, assistant/message events)
        │  lib/index.js: costUsage session projection (zod-schema validated)
        ▼
  token buckets + USD cost (per-event-time peak/off-peak tier)
        │  useProjection('costUsage') (browser)
        ▼
  lib/client.js: badge rendering (per-second countdown + FX conversion)
```

## Develop & verify

```sh
DSH_CHECKOUT=<harness source root> bash scripts/build.sh   # syntax check + zod junction
node test/verify.mjs                                       # peak math & billing self-test (17 checks)
```

## Known limitations

- Prices are built in (V4-Flash / V4-Pro, official 2026-08-17 rates). **When the official prices change, update both `lib/pricing.js` (billing) and the `DISPLAY_PRICES` constant in `lib/client.js` (display) manually**
- Tier judgement is fixed to UTC (official definition); the window table displays Beijing time (UTC+8)
- Cost is USD-ledger × exchange rate; default 7.2, adjustable in the expanded panel

## Credits & license

The peak math (isPeakHour / peakPhaseAt / tierFor / costOf) and the session-projection structure are adapted from [dsh-cost-meter](https://github.com/Han-1413141/dsh-cost-meter) (MIT License), rewritten for a minimal footprint.

[MIT](LICENSE) © 2026 KhalilYamber
