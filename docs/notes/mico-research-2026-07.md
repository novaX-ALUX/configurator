# MicoConfigurator Research — 2026-07

Follow-up research answering four specific questions not covered by `docs/feature-status.md` (2026-07-06). That document already inventories Mico's 11 sidebar pages at a coarse grain; this note goes one level deeper on classification, Charts parity, community sentiment, and UX evidence.

## Method note (read this before the findings)

Two access paths were used, both against primary sources:

1. **WebSearch / WebFetch** against micoair.com, discuss.ardupilot.org, and general web search. This worked well for the ArduPilot Discourse thread (server-rendered) but poorly for `micoair.com/configurator/` itself — that page is a client-side-rendered SPA (Vite/React), so WebFetch's HTML→Markdown conversion only ever saw the `<title>` tag and empty `<div id="root">`, never the rendered UI.
2. **Direct inspection of the shipped production JS bundle via `curl`** (`https://micoair.com/configurator/assets/index-*.js` and its lazy-loaded page chunks, e.g. `Charts-*.js`, `RTK-*.js`, `TerminalTab-*.js`). This is the same static JavaScript any visitor's browser downloads to run the app — no login, no bypassing anything, just reading a public file, equivalent to "View Source." Because the app ships all-language i18n dictionaries in the same bundle (en/zh/ja/ko/vi/fr/de/ru/uk/es), the English UI strings (button labels, tab names, page subtitles, error hints) could be extracted verbatim. This turned out to be a very high-fidelity primary source — it's literally the product's own copy, not a summary of it — and is cited below as "Mico JS bundle" with the specific asset URL.

**Environment limitation, disclosed for transparency**: the `claude-in-chrome` browser tool available in this session, when navigated to `https://micoair.com/configurator/`, was silently redirected to this repo's own local dev server (`http://localhost:5173/configurator/`) instead of the real site — confirmed by navigating to `https://example.com` (worked normally) and `https://micoair.com/` root (worked normally); only the `/configurator/` path redirected. This looks like a local proxy/hosts rule specific to this sandbox, not a security issue, but it means **no live screenshots of the real Mico app could be captured this session** via the browser tool. This directly affects Q4 — see that section.

---

## Q1 — Feature classification: configurator core vs. light GCS

Classification method: each sidebar page's own i18n copy, extracted from the production bundle, plus the ArduPilot Discourse thread's descriptions.

### Configurator core (bench setup)

| Page/area | Depth evidence |
|---|---|
| Dashboard | 3D attitude via `three.js` (`vendor-three-*.js` chunk present) — already noted in feature-status.md, corroborated. |
| Settings | Tabs confirmed verbatim from bundle: `Frame Type, Motors, RC Input, Ports, PID Tuning, QP Tuning, VTOL, OSD, EKF, Other, Advanced`. EKF tab has `Source Set 1/2/3` cards with `Horizontal/Vertical Position Source`, `Horizontal/Vertical Velocity Source`, `Yaw Source` — this exactly matches feature-status.md's listed gap ("EKF Source Selection PosXY/PosZ/VelXY/VelZ/Yaw"), now verified from Mico's own code rather than inferred. [Mico JS bundle, `assets/index-_Vv2FU57.js`, fetched 2026-07-16] |
| Sensors | Has a `HW ID` tab: "Sensor Hardware Info — All detected sensors and their device identifiers" — a sub-feature not currently listed in feature-status.md's Sensor Calibration gap section. [Mico JS bundle] |
| Parameters | No dedicated lazy chunk found (likely folded into Settings/Advanced), consistent with a "browse/search/modify, beginner/expert modes" description found in bundle copy. [Mico JS bundle] |
| Firmware | Confirmed: vehicle types `Copter, Heli, Plane, Rover, Sub, Tracker`; channels `Stable, Beta, Dev`; both online (`Select Vehicle`/`Select Version`/`Download Firmware`) and local `.apj` flashing, plus a separate `DFU Flash` tab. Exactly matches feature-status.md's stated gap — verified, not just inferred. [Mico JS bundle] |
| Hardware | Confirmed to be a **product catalog**, not a technical page: strings `"Hardware products"`, `"Full MicoAir range"`, `"View details"`, category labels like `"Flight controller"`. Matches feature-status.md's description ("vendor product catalog/shopping guide"). [Mico JS bundle] |
| **AI Assistant** (new finding, not in feature-status.md at all) | A tab inside Settings, title "AI Assistant," subtitle "Analyze current flight-controller parameters, MAVLink state, and status text." It collects params + recent MAVLink messages + STATUSTEXT, sends to an AI backend, and returns "Findings" / "Configuration suggestions" / "Missing data" / "Next checks" with a severity (info/warning/critical) and an explicit safety disclaimer: *"AI suggestions are only auxiliary. Remove propellers and verify official documentation before changing safety, motor, firmware, or failsafe settings."* This is a genuine bench-setup diagnostic feature, verified from bundle strings. **Not found in any marketing copy or the Discourse thread** — could not verify how prominently (or whether at all) it's marketed; treat as inferred-exists-but-unmarketed. [Mico JS bundle] |
| Console | Deeper than feature-status.md currently credits — see correction below. |

### Light GCS (field operation)

| Page | Depth found | Marketing prominence |
|---|---|---|
| **Map** ("FlightMap") | Real, not a toy: online/offline base-tile toggle, tile caching ("Satellite tiles you have viewed are cached" — offline caching confirmed verbatim), follow-vehicle / center-vehicle / clear-track controls. [Mico JS bundle, `bc={title:"Map",subtitle:"View satellite imagery, vehicle position, and flight track. Satellite tiles you have viewed are ca[ched]..."}`] | Not mentioned in the page's SEO `<meta name="keywords">` list at all (see below) — de-emphasized in marketing despite being functionally real. |
| **Mission** | **Full mission editor, not a toy.** Confirmed commands include `Waypoint`, `Spline WP`, `Loiter` (list truncated by grep, likely more); survey-grid generation with a point-count warning ("This survey will generate {{count}} mission points, which can noticeably increase upload/recording time"); camera trigger integration (`Camera`, hover-capture/hover-photo, gimbal pitch default); speed profile (cruise/climb/descend speed, turn radius); `RTL after mission` vs. fixed-altitude options; **live mission execution stats** (flown distance, remaining time) with an arm-and-switch-to-AUTO confirmation dialog. This is comparable in scope to a scaled-down Mission Planner Flight Plan screen, not a "draw one waypoint" demo. [Mico JS bundle, i18n mission-tab strings] | Also absent from the SEO keyword list — see below. One caveat found directly in the UI copy: *"Mission generated; terrain-following is kept, but this Web build has not fetched terrain elevations yet."* — i.e., **terrain elevation lookup is a disclosed, currently-non-functional stub in the shipped web build**, not a working feature (correction to feature-status.md — see that section). |
| **RTK** | Real, moderately deep base-station bridge: baud-rate config, connect/disconnect with status states, RTCM frame/byte/forwarded counters, RTCM latency, FC-forwarding-link status, satellite-observation status (parses RTCM 1005/1006 for base coordinates), base position lat/lon/alt display, invalid-frame counter. Comparable to Mission Planner's/QGC's RTK injection panel, not a checkbox. [Mico JS bundle, `Tc={title:"RTK Base",subtitle:"Connect a base station serial port, parse RTCM satellites and base coordinates, and forward corrections to the flight controller."...}`] | Absent from SEO keywords too. |
| Follow-me (as listed in feature-status.md's "Map + Mission Planning" gap item) | **Likely does not exist as a standalone GCS capability.** The only "Follow Me" string found is inside a flight-mode name table (`Takeoff, Hold, Mission, Return, Land, "Follow Me", Precision Land, RTL, Simple...`) — i.e., Mico is just localizing ArduPilot's built-in `FOLLOW` flight-mode name for display (e.g. in a flight-mode picker), the same way any GCS shows mode names. No companion-tracking/phone-GPS-follow UI strings were found. **Inferred correction** — flag for the team, not fully proven absent. [Mico JS bundle] |

### Marketing prominence — direct evidence

The configurator's own SEO tags (fetched via `curl` from the page `<head>`) are the clearest signal of what Mico wants to be known for:

> `<meta name="keywords" content="MicoConfigurator, ArduPilot, PX4, 飞控配置, flight controller, ground station, Ardupilot setup guide, MicoAir, 传感器校准, 参数调整, PID调参, Ardupilot motor setup" />`
> `<meta name="description" content="MicoConfigurator is a modern, web-based setup tool for ArduPilot/PX4. Powerful and easy to use...">`

[https://micoair.com/configurator/, raw HTML fetched via curl, 2026-07-16 — verified]

Notice: **"sensor calibration," "parameter tuning," "PID tuning," and "motor setup" are the SEO keywords — Map, RTK, and Mission are not mentioned at all**, despite being functionally substantial (see table above). This is strong, verified evidence that Mico positions itself publicly as a *setup/configurator* tool first, even though it quietly ships a genuinely deep field-ops GCS layer. The ArduPilot Discourse thread shows the same pattern from the user side: multiple commenters call it "a GCS much like the couple of new GCSs" and are visibly surprised by how capable the Charts/mission tooling is, suggesting the depth is discovered by using it, not by reading about it. [https://discuss.ardupilot.org/t/micoair-configurator/142904, Evans (StrikeEagle), 2026-03-16 — verified]

---

## Q2 — Charts parity check

Source: `Charts-aNqnDNwk.js` + `vendor-chart-*.js` chunks and their i18n strings in the main bundle, fetched 2026-07-16. This is a primary-source (shipped code), not a screenshot — verified functional presence, not visual polish.

Mico's Charts page ("波形" / "Data Charts", tagline in bundle: *"Multi-channel real-time data charts with zoom and export support"*):

| Sub-feature | Mico | Evidence |
|---|---|---|
| Channel/series selection | Searchable field picker (`"Search variable name…"`, `"Click to change data source"`), organized into **~11 named groups**: attitude, flightData, battery, vibration, optflow, rangefinder, accelerometer, gyroscope, magnetometer, rc, servo | verified, bundle strings `groups:{attitude,flightData,battery,vibration,optflow,rangefinder,accelerometer,gyroscope,magnetometer,rc,servo}` |
| Number of chart panels | **User-controlled**: explicit `"Add Chart"` / `"Remove Chart"` buttons, plus `"Chart Height"` (resizable panels) | verified |
| Time window | **No fixed rolling window found.** Instead: samples accumulate until manually `"Clear"`ed; supports `"Reset Zoom"` and has `zoomLevel/zoom_pos/zoom_step` state — implies pan/zoom across the whole accumulated history rather than a fixed 60s buffer | verified (functional presence); could not verify a maximum retention/memory cap — worth flagging as an open question, not a confirmed gap |
| Pause / Resume | Yes (`"Pause"` / `"Resume"`) | verified |
| Hover readout / crosshair | Yes — `"Hover capture"` toggle plus a legend with per-channel colored dot + live value (`charts__legend`, `charts__legend-dot`, `charts__legend-val`) | verified |
| Legend | Yes, same evidence as above | verified |
| CSV export | Yes (`"Export CSV"`) | verified |
| Sample-rate transparency | Explicit hint: *"Chart sample rate only, not data source rate"* — UX detail disclosing that the chart's redraw rate is decoupled from the telemetry stream rate | verified |
| Reset-to-default layout | Yes, with a confirm dialog (`"Reset Defaults"`, `"Are you sure you want to restore default data sources?"`) — implies the chart layout persists across sessions | verified |

### Comparison against our shipped Charts (60s fixed window, subplots grouped by physical unit, pause/resume, crosshair readout, legend, per `docs/feature-status.md` and recent commit `ad83796`)

**Sub-features Mico has that we currently lack:**
- User-controlled number of chart panels + resizable height (ours auto-groups by unit, fixed layout)
- A much broader, searchable channel catalog (11 named groups including optical-flow, rangefinder, servo output, RC — not just attitude/IMU-adjacent signals)
- CSV export
- Zoom/pan across accumulated history + explicit reset-zoom (ours is a fixed 60s window, no pan)
- Persisted, resettable layout

**Sub-features we likely have that Mico's Charts may lack:**
- A guaranteed bounded time window (60s) — Mico's "accumulate until cleared" model risks unbounded memory growth in long sessions; this is speculative reasoning, not something the community reported as a complaint (could not verify with a real bug report)

**Could not verify from static analysis:** default number of visible channels on first load, exact visual crosshair behavior (single-line vs. multi-chart synced cursor), whether unit grouping (like ours) exists in addition to the category grouping found. A live session with a connected FC would be needed to observe these.

---

## Q3 — Community sentiment

**Primary source, and apparently the only substantial public discussion found**: ArduPilot Discourse, ["Micoair configurator"](https://discuss.ardupilot.org/t/micoair-configurator/142904), 17 posts, 6 participants, 2026-03-16 through 2026-03-19. No Reddit thread was found (`site:reddit.com` search returned zero results), and no YouTube demo or review video was found by search — both are **could-not-verify / no-evidence-found, not confirmed absence** (a demo could exist and simply not be indexed under searched terms).

**What drives praise** (all from the Discourse thread, verified quotes):
- *Charts / real-time monitoring* — directly confirms the "charts is a praise driver" hypothesis: Riz (2026-03-17), after testing with a MicoAir F405: *"It is indeed impressive"*, specifically calling out the *"Charts option which [is] almost like a logviewer in realtime,"* and noting potential for in-flight telemetry monitoring over a telemetry radio.
- *Motor test + auto-mapping* — Allister Schreiber (2026-03-17): *"Gotta say, I'm impressed. If for nothing else but the motor test and auto-mapping."* Adam Borowski (2026-03-16) describes it as automating "motors setup and detection assignment during motors test."
- *Cross-vendor compatibility* — Adam Borowski (2026-03-17): *"This tool does not require micoair FC to work. Seems can be used with all ardupilot FCs."* Confirmed independently by Allister Schreiber (2026-03-17): tried it with a Flywoo FC, "worked nicely."
- *Browser/WebSerial compatibility* — Evans (2026-03-16): "Firefox Webserial works" called out as a positive.
- *Ease of use vs. Mission Planner/AMC for basic setup* — Adam Borowski (2026-03-16): GUI is "a bit more user friendly than MP and AMC," positioned as a basic-setup tool rather than a Mission-Planner replacement.
- *Log download speed* — Adam Borowski (2026-03-19): "slightly better than MP."

**Top complaints** (verified quotes):
- **A serious compass-corruption bug**: Jai GAY (2026-03-16): *"I gave the web version a try, and it just screw up my internal and external compass. i have to use the MP to fix it."* Follow-up: *"Compass external becomes 0, compass id changed."* Required a manual re-enable/disable workaround; Jai GAY confirmed compass ID is ArduPilot-generated, not GCS-set, meaning something in Mico's compass write path clobbered IDs/priority. **This is directly relevant to our own repo**: `docs/feature-status.md` section IV already claims our pre-write review gate for compass calibration is "informed by the lesson of a competitor that once silently corrupted users' compass configurations" — this Discourse thread is very likely (though not explicitly confirmed by name in our doc) the incident being referenced. Worth citing explicitly as the primary source for that claim.
- **Lack of traceability / defined sequence**, from Amilcar Lucas, an ArduPilot core developer/moderator (2026-03-16): the tool "feels easy to use" but is "easier to make mistakes" than AMC (ArduPilot Methodic Configurator), which lacks a "clearly defined sequence of steps" and offers no record/traceability of what was changed and why. This is a structural/architectural critique from a credible source, not a bug report — a priority signal that guardrails and change-traceability matter to the ArduPilot dev community, not just end users.
- No other bugs, UX complaints, or missing-feature complaints were found in the thread beyond these two threads of discussion; the thread is short (17 posts) and skews positive overall.

**Priority signal for us**: the two real complaints found (compass corruption; lack of traceability/guardrails) are exactly the two things `docs/feature-status.md` section IV already lists as our differentiating advantages ("pre-write review gate + read-back confirmation," informed by "a competitor that once silently corrupted users' compass configurations"). This research **corroborates that our existing safety-first positioning is well-aimed at real, documented pain**, not a hypothetical.

---

## Q4 — UX evidence (screenshots, recordings, community commentary)

**This section is materially limited — stated plainly per the task's own instruction to flag when a live page requires a connected flight controller.**

What was attempted and why it fell short:
1. **Browser tool (`claude-in-chrome`)**: navigating to `https://micoair.com/configurator/` was silently redirected to this repo's own local dev server (see Method note above). No real screenshots of the live app could be captured this session. This is an environment-side issue in this sandbox, not a finding about Mico.
2. **WebFetch**: only returns the SPA's empty shell (`<div id="root">`) since it doesn't execute JavaScript — no rendered screenshots or DOM text available this way either.
3. Even had browser access worked, **most pages likely require a connected, WebSerial-paired flight controller to render meaningfully** — bundle strings like `"console.connectFirst"` ("Please connect the flight controller first") and `"Please connect the flight controller first. Online upgrade requires reading the board type."` confirm several pages (Console, Firmware online-upgrade, presumably Dashboard/Sensors/RTK/Charts) gate their real content behind a live connection. No physical FC was available this session, so even a working browser session would only have shown empty/connect-prompt states for most pages.
4. **Search for external screenshots/recordings**: no YouTube demo video was found (`"MicoConfigurator" site:youtube.com` returned unrelated results — a Copilot "Mico" mascot, a Brawl Stars character, etc.). No screenshot galleries were found on micoair.com or micoair.cn beyond a Chinese-language configuration tutorial page (`https://micoair.cn/docs/MicoAir743-fei-kong-pei-zhi-jiao-cheng-Ardupilot-gu-jian`) that could not be fetched this session (fetch failed with a socket error) — **flagged as could-not-verify, worth a retry in a follow-up session**, as it's the single most promising lead for real screenshots.
5. The ArduPilot Discourse thread (our best community-commentary source) contains **no images or screenshots**, only text.

**What we do have (indirect, text-derived UX signals, not visual evidence)**:
- It's a PWA: `manifest.webmanifest` declares `"display":"standalone"`, and the bundle contains an install prompt ("Install MicoConfigurator to your desktop for a better experience" / "Install"), consistent with feature-status.md's note that Mico is a PWA and we are not (cut from M1).
- Dark theme by default: `theme_color`/`background_color` `#0A0A0F` in both the manifest and page meta tags.
- The UI is heavily i18n'd (10 languages found: zh, en, ja, ko, vi, fr, de, ru, uk, es) — broader than our 4-language (en/zh/ko/ja) support noted in feature-status.md.

**Recommendation for the upcoming UI/UX review**: this question needs a follow-up session with either (a) the browser-tool redirect issue fixed so the live app can actually be navigated and screenshotted, ideally with a real (or SITL-simulated) flight controller connected over WebSerial so gated pages render, or (b) a manual pass by a person with a physical MicoAir/ArduPilot board. Static JS-bundle inspection (this session's method) is excellent for confirming *what exists* but cannot speak to visual quality, layout, or actual usability — the artifact this question actually needs.

---

## Corrections to feature-status.md

1. **Console gap is understated.** Current text: *"Interactive MAVLink console / command input (we only have a read-only STATUSTEXT panel)."* Bundle evidence shows Mico's Console page is a full **MAVLink message-type monitor** — a table of message types with per-type rate (Hz) and count, expandable rows showing raw decoded field values — plus a separate 8-level syslog-style status bar (`EMERG/ALERT/CRIT/ERROR/WARN/NOTICE/INFO/DEBUG`) and a `TerminalTab` component with command-history navigation (arrow-key history, "Terminal input" string) suggesting actual command entry, not just message display. The gap is broader than "no command input" — it's "no message-type/rate table, no raw field inspector, no 8-level severity status bar." [Mico JS bundle, `Yl={title:"Message Console",subtitle:"Real-time MAVLink message monitoring",types:"X message types",...}`]

2. **Terrain elevation is likely not a real, working Mico feature — it's a disclosed stub.** Current text lists *"terrain elevation (opentopodata)"* as a completed Mico capability under Map + Mission Planning. Mico's own UI copy says otherwise: *"Mission generated; terrain-following is kept, but this Web build has not fetched terrain elevations yet."* This reads as an honest in-product disclosure that the web build doesn't actually fetch terrain data yet. Recommend downgrading this from "gap to close" to "not actually verified working on their side either" — worth re-testing with a live session rather than assuming Mico already has it solved.

3. **"Follow-me/tracking" is likely an overstatement.** Current text bundles "follow-me/tracking" into the missing Map + Mission Planning page description. The only "Follow Me" string found in the bundle is ArduPilot's standard `FOLLOW` flight-mode name being localized for display in a mode list/picker — the same thing every ArduPilot GCS does — not a companion/phone-GPS follow-me capability implemented by Mico itself. Recommend either removing this from the gap list or re-labeling it as "displays FOLLOW mode name" rather than "has follow-me." Flagged as **inferred**, not fully proven — a quick live test would confirm.

4. **New capability class not currently tracked at all: AI Assistant.** Mico ships an "AI Assistant" tab in Settings that sends current parameters + recent MAVLink messages + STATUSTEXT to an AI backend and returns categorized findings/suggestions with a safety disclaimer. This doesn't fit cleanly into the existing "entire pages missing" / "sub-features missing" taxonomy and should be added as its own line item for a product decision (whether to pursue something similar), not silently absorbed into "Console" or "Parameters."

5. **Corroboration, no change needed**: Firmware page's multi-vehicle-type + stable/beta/dev channel gap, and the EKF-source-selection gap, are both confirmed verbatim from Mico's shipped code (exact tab/button label matches) — these two items in feature-status.md can be considered fully verified rather than inferred.

6. **Marketing-prominence nuance worth adding**: feature-status.md currently treats Map/Mission/RTK as clear entire-page gaps without comment on how Mico presents them. Verified: Mico's own SEO keywords omit Map/RTK/Mission entirely, favoring "sensor calibration / parameter tuning / PID tuning / motor setup" — i.e., even Mico appears to treat these as a secondary, undersold layer rather than its lead pitch, despite them being functionally substantial. This matters for prioritization: closing the Charts/setup gap may matter more for competitive positioning than matching Mico's own most heavily-invested-but-least-marketed pages.
