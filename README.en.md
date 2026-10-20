# dsh-tidewatch

> A peak/off-peak tide widget for DeepSeek Harness. A little mascot parked in the bottom-right corner that tells you, at a glance, whether it's peak or off-peak right now, how long until the next switch, and how much this session has cost.

[![Release](https://img.shields.io/github/v/release/KhalilYamber/dsh-tidewatch)](https://github.com/KhalilYamber/dsh-tidewatch/releases)
[![License](https://img.shields.io/github/license/KhalilYamber/dsh-tidewatch)](LICENSE)

## What this is

Since 2026-08-17 DeepSeek bills its API on a peak/off-peak schedule: peak prices are double the off-peak ones, and weekends plus Chinese public holidays are billed off-peak all day. The same call can cost twice as much depending on the clock.

`dsh-tidewatch` puts that in front of you: which tier is active, how long until it flips, and what this conversation has cost so far. Every figure is priced at **the moment each call actually happened**, so revisiting an old session never reprices it at today's rates.

What it sells is a checkable definition: the peak windows, weekends, public holidays, make-up working days and all three historical price eras live in the code, backed by a full-year hour-by-hour comparison script.

## Two layouts, switch anytime

One build ships both interface layouts. Peak-window logic, session cost, token breakdown and account balance are identical — only the placement and appearance differ. Install once and switch **from the panel, effective immediately**, with no reinstall and no refresh.

| Layout | What it looks like | Best for |
|---|---|---|
| **Mascot widget** | A mascot in the bottom-right corner, draggable anywhere and snapping to either edge. One click pops a comic bubble; **a second click turns the page** to this session's cost. Different artwork for peak and off-peak | If you like having a character around and want the artwork to follow the tide |
| **Inline capsule** | Sits in the official composer row beside the built-in stats — **no screen space taken, nothing covered**; one click opens the full panel | If you want it minimal and out of the way |

### Switching layouts

Open the panel (click the mascot, then `详情 ›`; the capsule opens it directly) → the **Layout** row at the bottom → pick **Mascot widget** or **Inline capsule**. The switch is immediate and the choice is remembered.

> Both layouts stay mounted and only the selected one renders; the other runs no balance polling or timers and leaves no gap in the UI.

## Features

| Area | Capability |
|---|---|
| **Peak windows** | Official window rules; second-by-second countdown to the next phase; weekends and Chinese public holidays billed off-peak all day; make-up working weekends likewise |
| **Billing** | Three historical price eras (base / first peak schedule / V4.1 Flash repricing) chosen by each call's timestamp; cache hit and miss priced separately; output includes reasoning tokens |
| **Balance** | DeepSeek account balance (paid / bonus / total) with the reading time |
| **Widget** | Mascot pinned to the bottom-right corner, draggable, snaps to the nearer edge on release, position persisted; a different pose for peak and off-peak |
| **Layouts** | Mascot widget and inline capsule ship in one build; switch from the panel, effective immediately, and the choice is remembered |
| **Session isolation** | Each session keeps its own tally: a new session starts at zero, switching back restores that session's own figures, and concurrent sessions never bleed into each other |
| **Bubble** | Clicking the mascot pops a comic-style speech bubble (large radius, tail pointing at the head); **a click on the bubble turns the page**. It goes away in exactly two ways: it fades out after about five seconds, or a click anywhere outside the widget dismisses it |
| **Interaction** | Clicking the mascot opens the bubble; clicking the bubble turns the page; the full panel opens from `详情 ›` inside the bubble, and closes with its `✕`, another click on the mascot, or a click outside |
| **Editor** | The panel carries a bubble editor: add or remove pages and lines, edit templates, **reorder by dragging** (or use the arrows), a **module library** (`☆` saves a line, one click inserts it), restore the defaults |
| **Bubble tricks** | `A \|\| B` in a line picks one at random; a line starting with `img:https://…` renders as an image |
| **Look** | Follows the GUI light/dark theme (`--dsw-*` tokens); reuses the official DSH UI primitives; synthesized audio cues with no audio assets |
| **Account provider** | On this machine the account provider does carry usage, so its cost is priced from tokens; only when that channel really reports none does the plugin fall back to a balance-drop estimate marked "estimate" |
| **Diagnostics** | When usage is genuinely missing (no settlement events at all, or none carrying usage) the bubble shows one line of troubleshooting info; normal sessions stay clean |
| **Graceful scope** | With a non-DeepSeek provider it reads "not applicable" rather than pretending a Flash price; calls already priced earlier in the same session still count toward the total |

## Install

> For a quick install see "[Two layouts](#two-layouts-switch-anytime)" above. This section covers requirements and every installation route.

### Requirements

- Node.js ≥ 20
- A DeepSeek Harness build with the `dsh plugin` command
- **Desktop app users**: replace `--profile web` below with `--profile desktop`, since the desktop app reads the `desktop` profile

### From GitHub (recommended)

```sh
dsh plugin --profile web add github:KhalilYamber/dsh-tidewatch
```

### From a release tarball (pinned version, offline-capable)

Download the latest `dsh-tidewatch-<version>.tgz` from [Releases](https://github.com/KhalilYamber/dsh-tidewatch/releases), then:

```sh
dsh plugin --profile web add ./dsh-tidewatch-1.28.4.tgz
```

### From a local checkout (live edits)

```sh
dsh plugin --profile web add link:/path/to/dsh-tidewatch
```

**Restart DSH afterwards** (the desktop app needs a full quit and relaunch; hot reload cannot refresh the client bundle). The selected layout then appears: the mascot in the bottom-right corner, or the capsule in the composer stats row.

### Upgrade and removal

```sh
dsh plugin --profile web update dsh-tidewatch    # or re-run add
dsh plugin --profile web list dsh-tidewatch      # installed version
dsh plugin --profile web remove dsh-tidewatch    # uninstall
```

> **The npm channel is paused**: npm only holds an outdated build from 2026-08-22. Do not install it and do not judge current pricing by it.
>
> **This repository keeps only the current tarball**; older versions remain available on GitHub Releases.

## Usage

- **Click the mascot** → closes the panel when it is open, otherwise shows the bubble (clicking again never hides it, it only resets the timer); **clicking the bubble** turns to the next page; it fades out after about five seconds, and **a click outside the widget** dismisses it too
- **Click `详情 ›` inside the bubble** → the full panel
- **Click `详情 ›` in the bubble** → the full panel: account balance, this session's tokens and cost, current tier prices, official peak window table (Beijing time), layout and currency switches, bubble editor, sound switch
- **Drag the mascot** → move it anywhere; releasing near either edge snaps it there, and the position persists in `localStorage`
- **Click the session cost row** → per-model cost breakdown (tokens and cost per model; the total equals their sum)
- **Close the panel** → the `✕` at its top right, the mascot itself, or anywhere outside

The currency choice takes effect immediately and is remembered; CNY shows 2 decimals, USD shows 4.

## How billing works

### Peak windows (official basis)

DeepSeek introduced peak/off-peak pricing on 2026-08-17:

| Window (UTC) | Beijing time | Tier |
|---|---|---|
| 01:00 – 04:00 | 09:00 – 12:00 | peak |
| 04:00 – 06:00 | 12:00 – 14:00 | off-peak |
| 06:00 – 10:00 | 14:00 – 18:00 | peak |
| 10:00 – next 01:00 | 18:00 – next 09:00 | off-peak |

Off-peak prices are half the peak ones. The plugin judges the active tier by UTC windows (the official English page writes them in UTC hours) and judges weekdays and holidays by Beijing calendar days (the official Chinese page anchors the schedule to Beijing Monday–Friday). Both readings agree under the current windows: each window falls inside one Beijing calendar day and no pair straddles the UTC date line. The window table is always displayed in Beijing time.

### Three price eras

Prices are chosen by **the moment a call happened**, so old sessions are never repriced. Tiers read cache hit / input miss / output, in USD per 1M tokens:

| Era | Range (UTC) | deepseek-flash tiers |
|---|---|---|
| Base | before 2026-08-16 16:00 | 0.0028 / 0.14 / 0.28 |
| First peak schedule | 2026-08-16 16:00 – 2026-09-10 04:00 | peak 0.014 / 0.44 / 1.32, off-peak half |
| V4.1 Flash repricing | from 2026-09-10 04:00 | peak 0.006 / 0.3 / 1.2, off-peak half |

Cost = input-miss × cacheMiss + output × output + (cache read + cache write) × cacheHit; output already includes reasoning tokens. The ledger is kept in USD.

CNY figures are taken verbatim from the official **Chinese** pricing page rather than converted: the two models' implied exchange rates differ (flash ≈ 6.67, pro ≈ 6.82), so a single rate would put pro's yuan figure about 2% below the official one. **Session totals use each model's own official rate** — converted per model when the per-model ledger is available, and falling back to the single rate otherwise — so a session that mixes flash and pro is not skewed either.

### Weekends and public holidays

- **Saturday and Sunday** are billed off-peak all day (official announcement: weekends no longer split into peak/off-peak and are charged at the low tier)
- **Chinese public holidays** are off-peak all day with no peak window and no effective date (official pricing footnote: peak hours are Beijing Monday–Friday excluding Chinese public holidays; weekends and holidays are off-peak all day)
- **Make-up working weekends** are likewise off-peak all day (official note)
- The next switch point is the next working day's first entry into peak

The holiday table follows the State Council's 2026 arrangement (33 days): New Year 1/1–1/3, Spring Festival 2/15–2/23, Qingming 4/4–4/6, Labour Day 5/1–5/5, Dragon Boat 6/19–6/21, Mid-Autumn 9/25–9/27, National Day 10/1–10/7.

## Compatibility

| Item | Notes |
|---|---|
| DSH | 0.1.7-rc.2 and newer; adapted to 0.2.0 |
| Models | Peak tiers and amounts only hold for **DeepSeek's own models**; with another provider the amount reads "not applicable" |
| Official UI primitives | Prefers `@deepseek-ai/dsh-client-ui-primitives` from the shell module table, falling back to built-in implementations when absent |
| Theme | Follows the GUI light/dark theme |
| Data boundary | Balance queries run through the DSH host; the plugin never touches API keys, issues no HTTP request of its own and persists nothing |

Model aliases: `deepseek-flash` (V4.1 Flash) is current; `deepseek-v4-flash`, `deepseek-v4-flash-vision-exp` and `deepseek-v4.1-flash` are billed at the current Flash price.

## How it works

```
usage block of each model call (assistant/message and assistant/attempt)
        │  lib/index.js: costUsage session projection (zod schema validated)
        ▼
  token buckets + USD cost (tier chosen at the event's timestamp)
        │  the same view also carries two more fields:
        │    · official: the host's sample of the official tokenUsage projection
        │    · diag: usage diagnostic counters
        │  useProjection('costUsage') (browser side)
        ▼
  lib/client.js: widget rendering (mascot + countdown)
```

The widget registers on DSH's root overlay slot `shell.overlay`; its data comes from a probe registered on `conversation.composer.dock`, handed over through a module-level bridge, because root slots have no projection seat.

### Layout

```
dsh-tidewatch
├── lib/
│   ├── pricing.js        # pure functions: windows, price eras, holidays, costOf
│   ├── index.js          # host: costUsage session projection
│   ├── client.js         # browser: widget and panel (__ModuleLoader__ bundle)
│   └── assets/mascot/    # mascot originals (compressed into the bundle)
├── cordis.patch.yml      # assembly row
├── docs/PORTING.md       # porting notes for other hosts
└── test/
    ├── verify.mjs        # full self-check entry point
    ├── client-fixture.mjs# front-end fixture: loads the real lib/client.js in a fake React env
    ├── ui-smoke.mjs      # layout smoke: real stylesheet in headless Chrome
    └── adapt-repro.mjs   # host billing regression
```

## Development

```sh
# build (syntax check + zod dependency junction)
DSH_CHECKOUT=<harness source root> bash scripts/build.sh

# full self-check (128 checks): peak math, dual-constant parity, billing regression, dual-path usage reading, widget clamping, random variants, ownership regression, distinct peak/off-peak sprites, per-session official sampling, layout switching, empty-session bridge clearing
node test/verify.mjs

# layout smoke: renders the widget, bubble and panel in headless Chrome with the real
# stylesheet and asserts their geometry (skipped when no Chrome is present)
node test/ui-smoke.mjs
```

Under Git Bash, `DSH_CHECKOUT` must use a **Windows-style** path (e.g. `D:/DeepSeek-Harness/...`): a `/d/...` path is resolved by Node as `D:\d\...` and produces a dangling junction, which breaks assembly on the next launch for link-installed plugins. The script validates the resolved target before replacing the link.

## Known limitations

- **Price table is built in**; after an official price change, update both `lib/pricing.js` (billing) and `DISPLAY_PRICES` in `lib/client.js` (display), and add a historical era for the old prices
- **Holiday table covers 2026 only**; the 2027 arrangement needs to be added to `CN_PUBLIC_HOLIDAYS` (both files) once published. Past that point weekdays are billed as workdays, so the panel warns that the table has expired
- **The V4 Pro repricing boundary** is a sentinel for now: the official statement says billing is unchanged; if that changes, fill the date back into `V4_PRO_RETIRE_BOUNDARY`
- **Failed or retried calls are not billed**, matching the official token-meter definition; that is the ceiling of the definition, not an omission
- **Two pricing paths on the account provider**: on this machine the provider (`deepseek-account`) does report usage, so calls are priced from tokens. When a call really carries none, the plugin falls back to estimating from the account balance drop and marks the amount "estimate". The balance is account-wide, so concurrent sessions or devices draw it down together and the estimate runs high; only drops are accumulated, and a top-up never cancels spend already observed
- **Two trade-offs in sampling the official projection**: the host reads DSH's `tokenUsage` projection through `sessionProjections.snapshot(session, ['tokenUsage'])` (the source of the "351M tok · 97% cache hit" line) and ships it with the view. That projection exposes a running total only, so this path bills at the *current* tier rather than each call's historical tier, and only the latest sample is kept, so with several concurrent sessions the foreground one wins. The sample ships with the view only once the session itself has seen a settlement event, so an empty session never inherits the previous one's figures
- **Missing usage is labelled, never zeroed**: a provider may omit usage from its settlement events; the UI then shows "not reported" rather than `¥0.00`, so a missing number is not mistaken for a free one. Usage is read the same way DSH's own `token-meter` does it: both `assistant/message` and `assistant/attempt`, replaced by `(turn, step)`, with the slot cleared on a retry. If a settlement event carries `totalTokens` but none of the buckets (a renamed field), the UI also says "not reported" instead of quietly recording zero
- **No balance alert**: an earlier build beeped once when the balance dropped below a hard-coded threshold. The threshold was not configurable, the feature was half-finished, and the DeepSeek console may already notify on low balance, so it was removed rather than duplicated

## Acknowledgements

This plugin stands on other people's work:

- **[dsh-cost-meter](https://github.com/Han-1413141/dsh-cost-meter)** (MIT) — the starting point for the peak math (`isPeakHour` / `peakPhaseAt` / `tierFor` / `costOf`) and the session-projection structure; rewritten here against a smaller goal.
- **[DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)** (MIT) — the reference for the widget's product form: bottom-right placement, click-to-open bubble, audio cues and low-balance alerts were modelled on it. Its code and this plugin's are independent; nothing was imported.
- **The "Big Fat Fish" (大肥鱼) mascot** — a community personification of DeepSeek's whale mark, spread from the Baidu deepseek forum; the original OC "溟月" was established by community creator 上善无形, and the art used here comes from Xiaohongshu creators, stored under `lib/assets/mascot/`. Rights stay with each creator; **any rights holder can have it replaced or removed on request**.
- **[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)** — the host this runs on; state dots, tags, tooltips and outside-dismiss behaviour reuse its official UI primitives.

## Version notes

See [CHANGELOG.md](CHANGELOG.md). Current version **1.28.4**.

## License

[MIT](LICENSE) © 2026 KhalilYamber
