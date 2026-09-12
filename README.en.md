# dsh-tidewatch

**DeepSeek peak/off-peak tide badge**: a floating badge beside the composer that tells you whether it's peak or off-peak right now, how long until the next phase, and how much this session costs.

- Status dot: **orange/red for peak, teal/green for off-peak**, readable at a glance
- Collapsed: `● 峰期 距谷期 03:33 · ¥0.12` (peak, 03:33 to off-peak, ¥0.12)
- Expanded (click to open): official peak windows (Beijing time), current tier prices, this session's token breakdown, exchange-rate setting
- Billing: official peak/off-peak tier prices billed by the **actual timestamp of each call** (three historical eras: base / first peak schedule / V4.1 Flash repricing), cache hit/miss charged separately
- Currency: CNY display by default (fixed rate 6.67, matching the official CNY prices); one-click switch to USD (4 decimals) in the expanded panel
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

**Weekend rule (since 2026-08-23)**: Saturdays and Sundays (UTC calendar days) are billed at off-peak prices all day, with no peak/off-peak switch; the next phase switch lands at the first peak window of the following Monday.

## Billing model

- Unit: USD / 1M tokens (official pricing-page basis). Cost = input-miss × cacheMiss + output × output + (cache-read + cache-write) × cacheHit; "output" already includes reasoning tokens (billed at the output rate)
- **Three price eras**, selected by the call's own timestamp (historical correctness; tier order is cache-hit / cache-miss / output):

  | Era | Range (UTC) | `deepseek-flash` tiers |
  |---|---|---|
  | Base price | before 2026-08-16 16:00 | 0.0028 / 0.14 / 0.28 |
  | First peak schedule | 2026-08-16 16:00 – 2026-09-10 04:00 | peak 0.014 / 0.44 / 1.32, off-peak is half |
  | V4.1 Flash repricing | from 2026-09-10 04:00 | peak 0.006 / 0.3 / 1.2, off-peak is half |

- Each call is billed at the tier of its **event timestamp**, so costs do not drift across a peak/off-peak switch or a repricing
- The ledger stores USD; display converts via the fixed 6.67 rate to CNY (default) or shows USD directly

## Install

> Requires Node.js ≥ 20 + DeepSeek Harness (a build with the `dsh plugin` command).

```sh
# Option 1: straight from GitHub (recommended, tracks main)
dsh plugin --profile web add github:KhalilYamber/dsh-tidewatch

# Option 2: from a Release tarball (pinned version, works offline)
#   download dsh-tidewatch-<version>.tgz from the Releases page, then:
dsh plugin --profile web add ./dsh-tidewatch-1.1.1.tgz

# Option 3: npm (note: the npm copy can lag behind GitHub Releases — trust the Releases page)
dsh plugin --profile web add dsh-tidewatch

# Local directory (development)
dsh plugin --profile web add link:/path/to/dsh-tidewatch
```

Restart `dsh web` after installing; the tide badge appears to the right of the composer.

### Upgrade and uninstall

```sh
dsh plugin --profile web update dsh-tidewatch    # or re-run the add above
dsh plugin --profile web list dsh-tidewatch      # installed version
dsh plugin --profile web remove dsh-tidewatch    # uninstall
```

> **Upgrading to v1.1.1**: billing now selects the tier from three price eras by call timestamp, and the `costUsage` projection moved to stateVersion 4. Persisted sessions replay once after the upgrade, so calls made between 2026-08-16 and 2026-09-10 are restored to the **first** peak schedule (they were previously billed at the newer, lower rates). Live billing is unaffected.

## Usage

- The badge floats to the right of the composer, vertically centered with it; on narrow windows it moves above the composer instead, never covering the input area or the built-in stats line
- Click the badge to expand/collapse the detail panel: windows, current tier prices, token breakdown, currency switch (¥ / $)
- Click the "Session cost" row to expand the **per-model cost breakdown** (each model's tokens and cost listed separately; the total equals the sum of per-model costs)
- Currency choice applies immediately and persists; CNY shows 2 decimals, USD 4 decimals

## Layout

```
dsh-tidewatch
├── package.json          # dsh.bundle.patch + dsh.client.platform manifest
├── cordis.patch.yml      # bundle patch row
├── scripts/build.sh      # build: syntax check + zod junction
├── lib/
│   ├── pricing.js        # pure functions: windows, isPeakHour/peakPhaseAt, three price eras, costOf
│   ├── index.js          # host: costUsage session projection (billed per event time)
│   └── client.js         # browser: floating badge (__ModuleLoader__ bundle)
├── docs/PORTING.md       # adaptation notes for other hosts
└── test/verify.mjs       # pure-module self-test (node test/verify.mjs, 38 checks)
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
node test/verify.mjs                                       # peak math & billing self-test (38 checks, incl. dual-constant consistency)
```

## Known limitations

- Prices are built in, covering three eras (base price / first peak schedule / V4.1 Flash repricing); V4-Pro uses the official 2026-08-17 rates. Since 2026-09-14 04:00 UTC (12:00 Beijing), `deepseek-v4-pro` routes to Flash and is billed at Flash prices. **When the official prices change, update both `lib/pricing.js` (billing) and the `DISPLAY_PRICES` constant in `lib/client.js` (display) manually, and keep the superseded tiers as another historical era**
- Model names: `deepseek-flash` is current (V4.1 Flash); the aliases `deepseek-v4-flash`, `deepseek-v4-flash-vision-exp` and `deepseek-v4.1-flash` are all billed at the current flash rate (see `MODEL_ALIASES`)
- Tier judgement is fixed to UTC (official definition); the window table displays Beijing time (UTC+8)
- Cost is USD-ledger × fixed 6.67 rate for CNY (matching the official CNY prices); switchable to USD in the expanded panel

## Credits & license

The peak math (isPeakHour / peakPhaseAt / tierFor / costOf) and the session-projection structure are adapted from [dsh-cost-meter](https://github.com/Han-1413141/dsh-cost-meter) (MIT License), rewritten for a minimal footprint.

[MIT](LICENSE) © 2026 KhalilYamber
