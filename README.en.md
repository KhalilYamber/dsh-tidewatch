# dsh-tidewatch

**DeepSeek peak/off-peak tide badge**: a floating badge beside the composer that tells you whether it's peak or off-peak right now, how long until the next phase, and how much this session costs.

- Status dot: **orange/red for peak, teal/green for off-peak**, readable at a glance
- Collapsed: `● 峰期 距谷期 03:33 · ¥0.12` (peak, 03:33 to off-peak, ¥0.12)
- Expanded (click to open): official peak windows (Beijing time), current tier prices, this session's token breakdown, **DeepSeek account balance**, currency switch
- Billing: official peak/off-peak tier prices billed by the **actual timestamp of each call** (three historical eras: base / first peak schedule / V4.1 Flash repricing), cache hit/miss charged separately
- Tier judgement: weekends, **Chinese public holidays** (built-in 2026 calendar) and the make-up working weekends are billed at off-peak prices all day
- Currency: CNY display by default (taken verbatim from the official Chinese pricing page); one-click switch to USD (official English-page figures, 4 decimals) in the expanded panel
- Follows the GUI light/dark theme (`--dsw-*` tokens)
- Front end prefers the official DSH UI primitives from the shell module table (`@deepseek-ai/dsh-client-ui-primitives`): `StateDot`, `Tag`, `Tooltip` and `useDismissOnOutsidePointer`; a shell whose module table lacks that package falls back to the built-in implementation, with no functional loss
- Account balance: read through the DSH account service (`ctx.remote.account.getBalance`), showing **paid / bonus / total** plus the reading time; the host performs the query, and the plugin never touches API keys, issues no HTTP request of its own, and persists nothing
- Scope: the peak/off-peak tiers and cost figures apply to **DeepSeek's own models** only. With another provider (Claude / GPT / Kimi…), the badge reads "not applicable", amounts read "—", the window table and price rows stay but carry a scope note, and the balance row still reports the DeepSeek account exactly — no figure is better than a flash-price guess

## Peak windows (official basis)

DeepSeek introduced peak/off-peak time-of-day pricing on 2026-08-17:

| Window (UTC) | Beijing time | Tier |
|---|---|---|
| 01:00 – 04:00 | 09:00 – 12:00 | peak |
| 04:00 – 06:00 | 12:00 – 14:00 | off-peak |
| 06:00 – 10:00 | 14:00 – 18:00 | peak |
| 10:00 – next 01:00 | 18:00 – next 09:00 | off-peak |

Off-peak prices are half of peak prices. The badge judges window position by the UTC hours (the official English page states them in UTC), while the weekday and public-holiday test uses Beijing calendar days (the official Chinese page anchors weekdays to Beijing time). The two readings are equivalent for the current windows: each window falls inside a single Beijing calendar day and the pair does not straddle a UTC day boundary. The table display always uses Beijing time.

**Weekend and public-holiday rule**: Saturdays and Sundays are billed at off-peak prices all day (since 2026-08-23 00:00 Beijing time); Chinese public holidays are billed at off-peak prices all day with no peak/off-peak switch and no effective date (official pricing-page footnote, verified 2026-10-10: “peak hours are Monday through Friday, **excluding Chinese public holidays** … all other hours are off-peak, including weekends and Chinese public holidays in full”); make-up working weekends are off-peak all day as well (official statement of 2026-09-19: make-up working weekends and Chinese public holidays are billed at off-peak rates in full). The next phase switch lands at the first peak window of the next working day. The holiday table follows the State Council notice for 2026 (国办发明电〔2025〕7号, 33 days in total): New Year Jan 1–3, Spring Festival Feb 15–23, Qingming Apr 4–6, Labor Day May 1–5, Dragon Boat Jun 19–21, Mid-Autumn Sep 25–27, National Day Oct 1–7.

## Billing model

- Unit: USD / 1M tokens (official pricing-page basis). Cost = input-miss × cacheMiss + output × output + (cache-read + cache-write) × cacheHit; "output" already includes reasoning tokens (billed at the output rate)
- **Three price eras**, selected by the call's own timestamp (historical correctness; tier order is cache-hit / cache-miss / output):

  | Era | Range (UTC) | `deepseek-flash` tiers |
  |---|---|---|
  | Base price | before 2026-08-16 16:00 | 0.0028 / 0.14 / 0.28 |
  | First peak schedule | 2026-08-16 16:00 – 2026-09-10 04:00 | peak 0.014 / 0.44 / 1.32, off-peak is half |
  | V4.1 Flash repricing | from 2026-09-10 04:00 | peak 0.006 / 0.3 / 1.2, off-peak is half |

- Each call is billed at the tier of its **event timestamp**, so costs do not drift across a peak/off-peak switch or a repricing
- The ledger stores USD; CNY display takes the official Chinese-page figures verbatim (default) and USD display takes the official English-page figures (4 decimals) — no cross-rate conversion

## Install

> Requires Node.js ≥ 20 + DeepSeek Harness (a build with the `dsh plugin` command).

```sh
# Option 1: straight from GitHub (recommended, tracks main)
dsh plugin --profile web add github:KhalilYamber/dsh-tidewatch

# Option 2: link a local checkout (source edits take effect immediately)
dsh plugin --profile web add link:/path/to/dsh-tidewatch

# Option 3: from a Release tarball (pinned version, works offline)
#   download dsh-tidewatch-<version>.tgz from the Releases page (1.1.9 at present), then:
dsh plugin --profile web add ./dsh-tidewatch-1.1.9.tgz
```

> **Only the current tarball lives in this repository**: the historical builds (0.1.0 – 1.1.9) have been archived out of the tree, leaving `dsh-tidewatch-1.1.9.tgz`. Older builds carry the billing defect that pinned the card cost at ¥0.00 — do not install them.

> **The npm channel is paused**: npm hosts only an old copy (1.0.6, published 2026-08-22) whose prices and rules are outdated. Do not install it or judge current billing from it — use the two options above.

Restart `dsh web` after installing; the tide badge appears to the right of the composer.

### Upgrade and uninstall

```sh
dsh plugin --profile web update dsh-tidewatch    # or re-run the add above
dsh plugin --profile web list dsh-tidewatch      # installed version
dsh plugin --profile web remove dsh-tidewatch    # uninstall
```

> **v1.1.9 holiday boundary removed**: the official holiday rule carries no effective date — "make-up working weekends and Chinese public holidays are billed at off-peak rates in full" applies unconditionally. Previous builds kept a self-imposed "holiday rule effective 2026-09-19", which made 91 hours of 2026 (peak-window moments on New Year, Spring Festival, Qingming, Labor Day and Dragon Boat holidays) read as peak working days, contradicting the official wording. This release drops that boundary so the holiday rule applies unconditionally. **Billing impact is zero**: all 91 hours fall before peak/off-peak pricing took effect (2026-08-17), where calls are billed at the era's base price and the peak/off-peak tier never participates; measured cost is 0.4200 USD either way. The projection stateVersion is unchanged, so no session replay on upgrade, and the UI only shows these past days as off-peak when reviewing them.
>
> **v1.1.8 tier-definition refresh**: re-verified the peak/off-peak definition against the official pages (Chinese page, English page and changelog, checked 2026-10-10) and landed three fixes. ① The official basis is now spelled out: the Chinese page anchors weekdays to Beijing time while the English page writes the windows in UTC, and for the current windows (UTC 01:00–04:00 / 06:00–10:00) the two readings are equivalent — each window sits inside one Beijing calendar day and the pair does not straddle a UTC day boundary. The weekday test therefore reads Beijing calendar days (it previously read the UTC weekday; the numbers happen to agree, so behaviour is unchanged — see the Beijing-boundary assertions in the self-check). ② The make-up working weekend rule is now stated in comments and in the panel copy (official statement of 2026-09-19: make-up working weekends and Chinese public holidays are billed off-peak in full), so a make-up working weekend stays off-peak all day rather than becoming a working day. ③ CNY display now takes the official Chinese-page figures verbatim: the two models carry different implied rates (flash ≈ 6.67, pro ≈ 6.82) and the previous single 6.67 rate understated pro by roughly 2% in CNY. **Billing math still uses the exact USD figures, historical bills are not recomputed**, and the projection stateVersion is unchanged, so no session replay on upgrade.
>
> **v1.1.6 holiday rule**: the official pricing-page footnote (verified 2026-09-19) states that peak hours are Monday through Friday, excluding Chinese public holidays, with weekends and public holidays off-peak in full. This release adds the 2026 Chinese public-holiday calendar (State Council notice) to tier judgement and billing: the upcoming Mid-Autumn Sep 25–27 and National Day Oct 1–7 are billed at off-peak rates all day. **Prices are unchanged from 1.1.5 (no official repricing this round)**; no stateVersion bump — no public holiday falls before the rule boundary (2026-09-19), so persisted sessions need no replay.
>
> **Upgrading to v1.1.1**: billing now selects the tier from three price eras by call timestamp, and the `costUsage` projection moved to stateVersion 4. Persisted sessions replay once after the upgrade, so calls made between 2026-08-16 and 2026-09-10 are restored to the **first** peak schedule (they were previously billed at the newer, lower rates). Live billing is unaffected.

## Usage

- The badge sits **inline in the official stats row below the composer**, right after the `cache hit xx%` pill (horizontal spacing and vertical alignment come from that row's own layout, so window resizing cannot misalign it); when the stats row is absent (older shell, or a session without token stats yet) it falls back to floating at the composer's right edge
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
│   ├── pricing.js        # pure functions: windows, isPeakHour/peakPhaseAt, three price eras, holiday table, costOf
│   ├── index.js          # host: costUsage session projection (billed per event time)
│   └── client.js         # browser: badge (__ModuleLoader__ bundle)
├── docs/PORTING.md       # adaptation notes for other hosts
└── test/verify.mjs       # pure-module self-test (node test/verify.mjs, 52 checks)
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
node test/verify.mjs                                       # peak math & billing self-test (52 checks, incl. dual-constant consistency)
```

## Known limitations

- Prices are built in, covering three eras (base price / first peak schedule / V4.1 Flash repricing); V4-Pro uses the official 2026-08-17 rates; per footnote (2) on the official pricing page and the changelog entry of 2026-09-10, V4 Pro keeps being served after 2026-09-14 **with its billing method unchanged** (further notice to follow if that changes), so pro is always billed on its own rates and `V4_PRO_RETIRE_BOUNDARY` stays a sentinel pending an official date. **When the official prices change, update both `lib/pricing.js` (billing) and the `DISPLAY_PRICES` constant in `lib/client.js` (display) manually, and keep the superseded tiers as another historical era**
- Model names: `deepseek-flash` is current (V4.1 Flash); the aliases `deepseek-v4-flash`, `deepseek-v4-flash-vision-exp` and `deepseek-v4.1-flash` are all billed at the current flash rate (see `MODEL_ALIASES`)
- Windows are read as UTC hours (the official English page states them that way); the weekday and holiday test reads Beijing calendar days (UTC+8), equivalent for the current windows; weekends, Chinese public holidays and make-up working weekends are off-peak all day — the holiday table covers 2026 (State Council notice), so **once the 2027 calendar is published you must sync `CN_PUBLIC_HOLIDAYS` by hand** (both `lib/pricing.js` and `lib/client.js`)
- Costs are computed in USD; CNY display uses the official Chinese-page figures and USD display the official English-page figures, with no cross-rate conversion

## Credits & license

The peak math (isPeakHour / peakPhaseAt / tierFor / costOf) and the session-projection structure are adapted from [dsh-cost-meter](https://github.com/Han-1413141/dsh-cost-meter) (MIT License), rewritten for a minimal footprint.

[MIT](LICENSE) © 2026 KhalilYamber
