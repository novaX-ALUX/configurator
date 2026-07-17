# Initial-Tune Calculator — Official Formula Table

Research note for issue #34 (part of PRD #32). This is the formula basis for the
Tuning page's initial-tune calculator: a pure function
`(prop diameter, battery cell count, battery chemistry) → suggested parameter map`.

Governing discipline (PRD #32 Implementation Decisions — "Outputs the wiki does not
define are omitted, never invented" — a corollary of ADR-0003's calculator consequence,
restated in #34): **outputs the official sources do not define are omitted, never
invented.** Everything below carries
a citation; anything a competitor computes without an official formula is listed in the
"Deliberately omitted" section with the reason.

## Sources

All fetched 2026-07-17. Line numbers refer to the pinned commits, which were the tip
of `master` for each file on that date.

- **S1 — ArduPilot wiki, "Setting the Aircraft Up for Tuning"**
  Rendered: <https://ardupilot.org/copter/docs/setting-up-for-tuning.html>
  Source RST (pinned): <https://github.com/ArduPilot/ardupilot_wiki/blob/c7c19f6d64d4d68fba9a34494260e79978a3334e/copter/source/docs/setting-up-for-tuning.rst>
  The wiki's own "Mission Planner Helper" section (L91–94) points to S2 as the tool
  that "setup[s] the above parameters easily" — i.e. the wiki blesses S2 as its
  implementation.
- **S2 — Mission Planner built-in "Initial Parameter Setup" tab** (SETUP ▸ Mandatory
  Hardware ▸ Initial Parameter Setup), the current shipping implementation.
  Pinned: <https://github.com/ArduPilot/MissionPlanner/blob/feb7f8e2ef067ce408e7283cdfb930eb1630bf72/GCSViews/ConfigurationView/ConfigInitialParams.cs>
- **S3 — Mission Planner Alt-A plugin v1.1** (`InitialParamsCalculator.cs`), the
  predecessor of S2, unchanged since 2021. Kept as a source because the wiki's
  rule-of-thumb table matches *its* curve, not S2's (see "Discrepancies").
  Pinned: <https://github.com/ArduPilot/MissionPlanner/blob/c1c9001ae2faefe03fb6f112e1a1fe85d8a0b82b/plugins/InitialParamsCalculator.cs>
- **S4 — MicoConfigurator production bundle** (`assets/Settings-Ld5oZ1dX.js`, reached
  from `assets/index-_Vv2FU57.js`, fetched via curl 2026-07-17). **Not a formula
  source** — used only to enumerate what Mico's "Initial Tune Parameters" card
  computes, for the omitted-outputs cross-check. Same access method as the Mico
  research note (`mico-research-2026-07.md`): reading the shipped public JS.

**Recommendation: implement S2 exactly.** It is what Mission Planner ships today and
what the wiki's Mission Planner Helper section points at. S1's prose values are coarse
anchor points, S3 is superseded. Where S1 and S2 disagree, the table below flags it.

## Inputs

| Input | Domain | Source |
|---|---|---|
| `prop` — propeller diameter, inches | `> 0` (S2 L133 rejects `<= 0`; UI default 9) | S2 L56, L133–139 |
| `cells` — battery cell count | `>= 1` (S2 L141–145; UI default 4) | S2 L57, L141–145 |
| `chemistry` — battery type preset | LiPo / LiPoHV / Li-ion | S2 L245–273 |

Chemistry resolves to a per-cell voltage pair `(cellMax, cellMin)` — S2 L251–268:

| Chemistry | `cellMax` (V) | `cellMin` (V) |
|---|---|---|
| LiPo (also the fallback default) | 4.2 | 3.3 |
| LiPoHV | 4.35 | 3.3 |
| Li-ion | 4.1 | 2.8 |

S3's input prompts agree ("LiPo - 4.2, LipoHV - 4.35, LiIon - 4.1 or 4.2";
"LiPo/LipoHV - 3.3, LiIon - 2.8", S3 L144–145). S2 presents the pair as editable
defaults; our calculator treats them as the chemistry definition. S1 only gives the
LiPo case in prose ("4.2v x No. Cells", "3.3v x No. Cells … or as appropriate if using
a different battery type", S1 L28–29), so S2 is the citation for the Li-ion variant.

## Output formulas (S2, `calc_values()` L89–121 unless noted)

Helper `roundTo100(x)` is S2's `RoundTo(value, -2)` (L74–86): add 50, then subtract
`value % 100` — i.e. round half-up to the nearest 100. `round(x)` / `round(x, n)` is
C# `Math.Round` — **banker's rounding** (half to even); see implementation notes.

| Parameter | Formula | Unit | Source |
|---|---|---|---|
| `ATC_ACCEL_Y_MAX` | `max(8000, roundTo100(-900·prop + 36000))` | cdeg/s² | S2 L91 |
| `ACRO_YAW_P` | `0.5 · ATC_ACCEL_Y_MAX / 4500` | — | S2 L93 |
| `ATC_ACCEL_P_MAX` | `max(10000, roundTo100(-2.613267·prop³ + 343.39216·prop² − 15083.7121·prop + 235771))` | cdeg/s² | S2 L95 |
| `ATC_ACCEL_R_MAX` | `= ATC_ACCEL_P_MAX` | cdeg/s² | S2 L96 |
| `INS_GYRO_FILTER` | `max(20, round(289.22 · prop^−0.838))` | Hz | S2 L98 |
| `ATC_RAT_PIT_FLTD` | `max(10, INS_GYRO_FILTER / 2)` (no rounding — can be x.5) | Hz | S2 L100; S1 L75 |
| `ATC_RAT_PIT_FLTE` | `0` | Hz | S2 L101 |
| `ATC_RAT_PIT_FLTT` | `max(10, INS_GYRO_FILTER / 2)` | Hz | S2 L102; S1 L76 |
| `ATC_RAT_RLL_FLTD` | `max(10, INS_GYRO_FILTER / 2)` | Hz | S2 L103; S1 L77 |
| `ATC_RAT_RLL_FLTE` | `0` | Hz | S2 L104 |
| `ATC_RAT_RLL_FLTT` | `max(10, INS_GYRO_FILTER / 2)` | Hz | S2 L105; S1 L78 |
| `ATC_RAT_YAW_FLTD` | `0` | Hz | S2 L106 |
| `ATC_RAT_YAW_FLTE` | `2` | Hz | S2 L107; S1 L79 |
| `ATC_RAT_YAW_FLTT` | `max(10, INS_GYRO_FILTER / 2)` | Hz | S2 L108; S1 L80 |
| `ATC_THR_MIX_MAN` | `0.1` | — | S2 L110 |
| `INS_ACCEL_FILTER` | `10` | Hz | S2 L111; S1 L70 |
| `MOT_THST_EXPO` | `min(round(0.15686·ln(prop) + 0.23693, 2), 0.80)` | — | S2 L112 |
| `MOT_THST_HOVER` | `0.2` | — | S2 L113 |
| `BATT_ARM_VOLT` | `(cells − 1)·0.1 + (cellMin + 0.3)·cells` | V | S2 L115 |
| `BATT_CRT_VOLT` | `(cellMin + 0.2)·cells` | V | S2 L116 |
| `BATT_LOW_VOLT` | `(cellMin + 0.3)·cells` | V | S2 L117 |
| `MOT_BAT_VOLT_MAX` | `cellMax · cells` | V | S2 L118; S1 L28 |
| `MOT_BAT_VOLT_MIN` | `cellMin · cells` | V | S2 L119; S1 L29 |

Parameter names above are the Copter 4.x names, which is all this product targets.
S2 additionally maps to 3.x names (`ATC_RAT_*_FILT`, L194–197), pre-4.x
`ATC_ACC_*_MAX` in deg/s² (`value / 100`, L173–175), and QuadPlane `Q_A_`/`Q_M_`
prefixes (L153–159) — all out of scope here (see omitted list).

## Discrepancies between the official sources

The wiki's prose values (S1) and the two MP implementations do not fully agree.
Documented so the implementation ticket doesn't "fix" one against the other:

| Topic | S1 wiki | S3 plugin (2021) | S2 built-in tab (current) |
|---|---|---|---|
| `MOT_THST_EXPO` curve | 0.55 @5", 0.65 @10", 0.75 @20"+ (L40) | `round(0.1405·ln(prop) + 0.3254, 2)` → 0.55 / 0.65 / 0.75 — **matches the wiki table exactly** (S3 L256) | `min(round(0.15686·ln(prop) + 0.23693, 2), 0.80)` → 0.49 / 0.60 / 0.71 — a deliberately lower curve, capped at 0.80 (S2 L112) |
| `INS_GYRO_FILTER` | 80 @5", 40 @10", 20 @20"+ (L71) | same power fit as S2 | `max(20, round(289.22·prop^−0.838))` → 75 / 42 / 23 — a continuous fit near, not equal to, the wiki steps (S2 L98) |
| `INS_ACCEL_FILTER` | 10 Hz (L70) | 20 (S3 L255) | 10 (S2 L111) — S2 agrees with the wiki; S3 superseded |
| `BATT_ARM_VOLT` | not defined | `(cells−1)·0.1 + 3.6·cells` (S3 L259) | `(cells−1)·0.1 + (cellMin+0.3)·cells` (S2 L115) — chemistry-aware; equals S3 only for LiPo-ish `cellMin=3.3` |
| `MOT_THST_HOVER` | "0.25 or below … (lower is safe)" (L60) | 0.2 | 0.2 — within the wiki's "or below" envelope |
| `ATC_ACCEL_P/R/Y_MAX` | 1100/500/200 and 200/100/90 in pre-4.x deg/s² names (L72–74) | same polynomials as S2 | S2's polynomials, ÷100 at the wiki's prop sizes, land near the wiki values (e.g. 10" → 116700 cdeg/s² ≈ wiki's 1100) |

Where a row disagrees, **S2 wins** (it is the current shipping calculator the wiki
points to). The S3 column exists so a reviewer comparing against the wiki table
understands why our expo output is lower than the wiki's rule of thumb.

## Golden test vectors

Computed by executing the S2 formulas above verbatim (script, not by hand).
Intended for direct transcription into the table-driven tests of the calculator
ticket (`(prop, cells, chemistry) → map`).

| Parameter | 5" 4S LiPo | 9" 4S LiPo (MP defaults) | 10" 6S LiPo | 13" 6S Li-ion | 20" 12S LiPo | 30" 12S LiPo |
|---|---|---|---|---|---|---|
| `ATC_ACCEL_Y_MAX` | 31500 | 27900 | 27000 | 24300 | 18000 | 9000 |
| `ACRO_YAW_P` | 3.5 | 3.1 | 3.0 | 2.7 | 2.0 | 1.0 |
| `ATC_ACCEL_P_MAX` = `_R_MAX` | 168600 | 125900 | 116700 | 92000 | 50500 | 21800 |
| `INS_GYRO_FILTER` | 75 | 46 | 42 | 34 | 23 | 20 |
| `ATC_RAT_{PIT,RLL}_FLTD/FLTT`, `ATC_RAT_YAW_FLTT` | 37.5 | 23 | 21 | 17 | 11.5 | 10 |
| `MOT_THST_EXPO` | 0.49 | 0.58 | 0.60 | 0.64 | 0.71 | 0.77 |
| `BATT_ARM_VOLT` | 14.7 | 14.7 | 22.1 | 19.1 | 44.3 | 44.3 |
| `BATT_CRT_VOLT` | 14.0 | 14.0 | 21.0 | 18.0 | 42.0 | 42.0 |
| `BATT_LOW_VOLT` | 14.4 | 14.4 | 21.6 | 18.6 | 43.2 | 43.2 |
| `MOT_BAT_VOLT_MAX` | 16.8 | 16.8 | 25.2 | 24.6 | 50.4 | 50.4 |
| `MOT_BAT_VOLT_MIN` | 13.2 | 13.2 | 19.8 | 16.8 | 39.6 | 39.6 |

Constants for every case: `ATC_RAT_PIT_FLTE = ATC_RAT_RLL_FLTE = ATC_RAT_YAW_FLTD = 0`,
`ATC_RAT_YAW_FLTE = 2`, `ATC_THR_MIX_MAN = 0.1`, `INS_ACCEL_FILTER = 10`,
`MOT_THST_HOVER = 0.2`.

## Implementation notes for the pure function

- **Rounding.** C# `Math.Round` is banker's rounding (half to even); JS `Math.round`
  rounds half up. The difference is only reachable at exact midpoints
  (`round(x)`, `round(x, 2)`), which real prop diameters essentially never hit — but
  the calculator tests should avoid inventing inputs that sit on a midpoint, and the
  port should note which convention it uses. `roundTo100` as specified (add 50,
  truncate to 100) is itself plain half-up and ports directly.
- **Non-integer filter outputs are real**: `INS_GYRO_FILTER/2` is written unrounded by
  S2 (37.5 Hz for a 5" build). Do not round it to match S4's behavior (Mico rounds) —
  that would be editing the official formula.
- **4.x names only**, per product scope; none of S2's 3.x/QuadPlane name mapping.
- S2 applies no upper bound on `cells` and no upper prop bound; the `max(...)` floors
  (8000 / 10000 / 20 / 10) are the only clamps besides the 0.80 expo cap.

## MP outputs gated behind explicit checkboxes (documented, decision for the ticket)

These are official (they ship in S2) but are not part of the formula set — they are
opt-in extras behind checkboxes, and none of them is a function of our three inputs.
Default position: exclude from the calculator; if ever wanted, they are separate
explicit toggles, mirroring S2's own UI.

- **"T-Motor Flame ESC" checkbox** (S2 L150, L211–216): overrides
  `MOT_THST_EXPO = 0.2` and adds `MOT_PWM_MIN = 1100`, `MOT_PWM_MAX = 1940`.
- **"Suggested settings" checkbox** (S2 L218–228, Copter 4.x only): constants
  `BATT_FS_CRT_ACT = 1`, `BATT_FS_LOW_ACT = 2`, `FENCE_ACTION = 3`,
  `FENCE_ALT_MAX = 120`, `FENCE_ENABLE = 1`, `FENCE_RADIUS = 150`, `FENCE_TYPE = 7`.

## Deliberately omitted

Per the #34 discipline, everything here is **not** an output of our calculator, with
the reason and the evidence.

**From the wiki's setup checklist (S1) — no formula exists:**

- `MOT_PWM_MIN` / `MOT_PWM_MAX` — "Check ESC manual for fixed range or
  1000/2000us" (S1 L55–56). A procedure, not a function of the inputs.
- `MOT_SPIN_ARM`, `MOT_SPIN_MIN` — determined via the motor-test feature
  (S1 L57, L59). Procedure.
- `MOT_SPIN_MAX = 0.95` and `MOT_OPTIONS = 0` — official constants (S1 L58, L30) but
  not in S2's calculator output set; S2 is the output-set authority we mirror.
  (Mico does write `MOT_SPIN_MAX` — see below.)

**Post-flight adjustments — not *initial* tune outputs:** after the first test
flight, MP's closing dialog instructs `ATC_THR_MIX_MAN → 0.5`,
`PSC_ACCZ_P/PSC_D_ACC_P → MOT_THST_HOVER`,
`PSC_ACCZ_I/PSC_D_ACC_I → 2·MOT_THST_HOVER` (S2 L240). These
depend on the learned hover throttle from an actual flight, so a bench calculator
cannot compute them. Candidate for a UI hint next to the calculator, never for the
output map.

**Computed by Mico (S4) without an official formula — omitted, never invented:**

Mico's "Initial Tune Parameters" card (verified in S4: inputs Prop Size / Battery
Cells / Battery Type, prop choices `[3,5,7,10,13,15,20,25,30]`, cells 2–14) uses
**piecewise-linear interpolation tables** whose anchor points only partially coincide
with official values:

- `INS_GYRO_FILTER` over `[[3,100],[5,80],[7,60],[10,40],[15,25],[20,20],[30,15]]` —
  the 80/40/20 anchors are the wiki's, but 3"→100, 7"→60, 15"→25 and 30"→15 have no
  official source.
- `ATC_ACCEL_P/R_MAX` over `[[5,162000],[10,110000],[20,50000],[30,20000]]` and
  `ATC_ACCEL_Y_MAX` over `[[5,40000],[10,20000],[20,10000],[30,9000]]` — the 10"/20"/30"
  anchors are the wiki's ×100, the 5" anchors are invented (and differ from S2's
  polynomial: 162000 vs 168600 at 5").
- `MOT_THST_EXPO` over `[[3,50],[5,55],[10,65],[20,75],[30,80]]/100` — wiki anchors
  plus invented 3" and 30" points; also diverges from S2's current curve.
- `INS_LOG_BAT_MASK = 1` — batch-logging enable for notch/FFT work; not part of any
  official initial-parameter set.
- Li-ion preset `4.2/3.0 V` and LiHV `4.35/3.5 V` — conflicts with S2's `4.1/2.8` and
  `4.35/3.3`; we follow S2.
- Mico omits `INS_ACCEL_FILTER`, `ACRO_YAW_P`, `ATC_THR_MIX_MAN` and all
  `BATT_*_VOLT` failsafe voltages entirely, and writes `MOT_THST_HOVER = 0.25`,
  `MOT_SPIN_MAX = 0.95` (wiki constants). No action for us either way — listed only
  to show the delta was examined, not overlooked.

**Version/vehicle name mapping (S2 L153–159, L173–175, L194–197):** Copter 3.x
`ATC_RAT_*_FILT` names, pre-4.x `ATC_ACC_*_MAX` deg/s² scaling, QuadPlane `Q_A_`/`Q_M_`
prefixes. Out of product scope (Copter 4.x only).
