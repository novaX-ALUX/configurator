# Tuning sliders write through the Review Gate — no live-bind, no tuning mode

Status: accepted

The PID tuning milestone (roadmap #3) needed a write path for its sliders.
Both competitors live-bind: axPlanner's tuning sliders write the parameter
store in real time (every intermediate value of a drag reaches the vehicle,
including overshoots), and this is the pattern users may expect. We decided
tuning sliders follow the same **Review Gate** doctrine as every other
parameter surface (see `CONTEXT.md`): releasing a slider stages a change;
only an explicit Apply writes, with per-write readback. No direct-write
path exists anywhere in the product, and tuning is not an exception.

The deciding argument: the "fast iteration" case for live-bind assumes the
tool is connected while the vehicle flies. Web Serial over USB means the
vehicle is tethered to the bench — the real tuning loop is *fly (radio/other
GCS) → land, plug in → adjust → unplug, fly*, so the iteration bottleneck is
the cable, not one Apply click.

## Considered Options

- **Live-bind (axPlanner-style)** — rejected: drag glitches write every
  intermediate value; contradicts the Review Gate; solves a scenario the
  platform physically excludes.
- **A "Tuning Mode" safety tier** (explicit opt-in, write-on-release with
  readback, snapshot rollback on exit) — rejected as speculative: its
  legitimate scenario is a live telemetry link during flight, which belongs
  to the GCS milestone. If that milestone's safety ADR wants such a mode, it
  creates it then, with real field requirements in hand.

## Consequences

- The initial-tune calculator also only produces Staged Changes (a
  current → suggested diff the user applies through the same gate); it never
  writes on its own.
- Reviewers gain a rejection ground: any parameter write triggered by an
  input event (drag, change, toggle) rather than an explicit Apply.
