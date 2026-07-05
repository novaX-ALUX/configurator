import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useConnectionStore } from '../../store/connection'
import { useMotorTestStore } from './motorTestStore'
import { MotorLayout } from './MotorLayout'
import { SafetyGate } from './SafetyGate'
import { MotorSliders } from './MotorSliders'
import { ManualMapGuide } from './ManualMapGuide'
import type { SafetyState } from './motorSafety'
import { FRAME_FIELD, type FrameTileOption } from '../setup/paramEnums'
import type { ParamStore } from '../../core/mavlink/params'

/** The page's own tick cadence -- `motorSafety.ts`'s module doc calls this out by name ("the page ... drives everything here (tick() on a ~200ms interval)"). */
const TICK_MS = 200

interface ResolvedFrame {
  option: FrameTileOption
  /** False when `FRAME_CLASS`/`FRAME_TYPE` haven't been fetched yet -- `option` is then a placeholder, not a read of the board's real frame (see `resolveFrameOption`'s own doc). The page must disclose this rather than silently presenting a guessed frame/motor-count as fact (architecture-review finding: a pilot on a hex/octo vehicle who connects and goes straight to Motor Test without ever visiting Setup/Parameters would otherwise see an unlabeled Quad X). */
  known: boolean
}

/**
 * Resolves the frame diagram to draw from the board's own `FRAME_CLASS`/
 * `FRAME_TYPE` (Setup's fields, Task 7.1) rather than duplicating that
 * lookup -- this is the "layout follows Setup -> Frame" link the task brief
 * asks for. Falls back to `FRAME_FIELD.options[0]` (Quad X, 4 motors) when
 * either param hasn't been fetched yet (no `paramStore`, params not yet
 * loaded, or an unrecognized frameClass/frameType combination) -- purely a
 * display default, never written anywhere. `known` tells the page whether
 * this is a real read or a placeholder, so it can disclose the difference
 * instead of silently presenting a guess as the vehicle's actual frame.
 */
function resolveFrameOption(paramStore: ParamStore | null): ResolvedFrame {
  const frameClass = paramStore?.get('FRAME_CLASS')?.value
  const frameType = paramStore?.get('FRAME_TYPE')?.value
  const option = FRAME_FIELD.options.find((o) => o.frameClass === frameClass && o.frameType === frameType)
  return { option: option ?? FRAME_FIELD.options[0], known: option !== undefined }
}

interface SafetyProgressProps {
  state: SafetyState
  propsConfirmed: boolean
  countdown: number
  idleLeft: number
}

/** The design mock's 3-step safety progress strip above the two-column layout -- purely a read-out of the same `useMotorTestStore` fields `SafetyGate`/the global banners already show, laid out as a compact "1. confirm -> 2. enable -> 3. test" strip. */
function SafetyProgress({ state, propsConfirmed, countdown, idleLeft }: SafetyProgressProps) {
  const { t } = useTranslation()
  const step2Live = state === 'ready' || state === 'testing'

  return (
    <div className="mb-4 flex items-stretch gap-0 rounded-xl border border-nvx-border bg-white p-3.5 shadow-card">
      <div className="flex flex-1 items-center gap-2.5">
        <span className="relative flex h-[30px] w-[30px] flex-none items-center justify-center rounded-full border-[1.5px] border-nvx-borderStrong font-mono text-[12px] font-semibold text-nvx-subtle">
          {propsConfirmed && (
            <span className="absolute -inset-[1.5px] flex items-center justify-center rounded-full bg-nvx-success text-white">✓</span>
          )}
          {!propsConfirmed && '1'}
        </span>
        <span className="flex flex-col">
          <span className="text-[12.5px] font-bold text-nvx-text">{t('motors.steps.confirmProps')}</span>
          <span className="text-[11px] text-nvx-faint">{t('motors.steps.confirmPropsHint')}</span>
        </span>
      </div>
      <span className="mx-3 self-center text-nvx-borderStrong">→</span>
      <div className="flex flex-1 items-center gap-2.5">
        <span className="relative flex h-[30px] w-[30px] flex-none items-center justify-center rounded-full border-[1.5px] border-nvx-borderStrong font-mono text-[12px] font-semibold text-nvx-subtle">
          {state === 'counting' && (
            <span className="absolute -inset-[1.5px] flex items-center justify-center rounded-full bg-nvx-warning text-[13px] font-extrabold text-white">
              {Math.ceil(countdown / 1000)}
            </span>
          )}
          {step2Live && (
            <span className="absolute -inset-[1.5px] flex items-center justify-center rounded-full bg-nvx-success text-white">✓</span>
          )}
          {state === 'locked' && '2'}
        </span>
        <span className="flex flex-col">
          <span className="text-[12.5px] font-bold text-nvx-text">{t('motors.steps.enable')}</span>
          <span className="text-[11px] text-nvx-faint">{t('motors.steps.enableHint', { s: Math.ceil((idleLeft || 30000) / 1000) })}</span>
        </span>
      </div>
      <span className="mx-3 self-center text-nvx-borderStrong">→</span>
      <div className="flex flex-[1.3] items-center gap-2.5">
        <span className="relative flex h-[30px] w-[30px] flex-none items-center justify-center rounded-full border-[1.5px] border-nvx-borderStrong font-mono text-[12px] font-semibold text-nvx-subtle">
          {state === 'testing' ? (
            <span className="absolute -inset-[1.5px] flex animate-nvxPulse items-center justify-center rounded-full bg-nvx-danger text-white">●</span>
          ) : (
            '3'
          )}
        </span>
        <span className="flex flex-col">
          <span className="text-[12.5px] font-bold text-nvx-text">{t('motors.steps.test')}</span>
          <span className="text-[11px] text-nvx-faint">{t('motors.steps.testHint', { s: 5 })}</span>
        </span>
      </div>
    </div>
  )
}

/**
 * Motor Test page (Task 9.3) -- the highest-risk UI in the project. Every
 * one of `motorSafety.ts`'s six kill switches must actually stop a spinning
 * motor on the flight controller, not just flip a UI flag:
 *
 *  1. window `blur`
 *  2. `visibilitychange` -> tab hidden
 *  3. `Escape` keydown
 *  4. leaving this page
 *  5. unchecking "props removed" while armed (`SafetyGate`'s checkbox ->
 *     `confirmProps(false)`, which `motorSafety.ts` itself turns into a stop)
 *  6. the STOP ALL button (here, in `SafetyGate`, and in `App.tsx`'s global
 *     banner)
 *
 * 1-3 are real DOM listeners registered on mount; 4 is this component's own
 * unmount cleanup, since the page switcher (`App.tsx`) only ever unmounts
 * this component by navigating away -- that unmount IS "left Motor Test
 * page". `useMotorTestStore` (a module-scope store, not local state) owns
 * the actual `MotorSafety` instance and the FC-command wiring
 * (`onStop`/`onRenew`, Task 9.2) so `App.tsx`'s global safety banners can
 * read the same live state even though they're a sibling in the tree, not a
 * descendant of this page.
 *
 * This component is the one thing that drives `tick()` on a real ~200ms
 * interval and reads a real clock -- `motorSafety.ts`'s own module doc calls
 * that out explicitly as the deliberate exception to "no timers, no real
 * clock" everywhere else in the safety engine.
 *
 * Also watches `phase`: a disconnect while armed/testing is not one of the
 * six kill switches (the link merely going away isn't a DOM event), but it
 * must still stop -- there is no flight controller left to keep talking to
 * either way, and the safety state must not silently stay "armed" for a
 * link that no longer exists (mirrors Task 8.3's own link-state handling).
 */
export function MotorTestPage() {
  const { t } = useTranslation()
  const phase = useConnectionStore((s) => s.phase)
  const baud = useConnectionStore((s) => s.baud)
  const connect = useConnectionStore((s) => s.connect)
  const session = useConnectionStore((s) => s.session)
  const paramStore = useConnectionStore((s) => s.paramStore)

  const state = useMotorTestStore((s) => s.state)
  const propsConfirmed = useMotorTestStore((s) => s.propsConfirmed)
  const countdown = useMotorTestStore((s) => s.countdown)
  const idleLeft = useMotorTestStore((s) => s.idleLeft)
  const percents = useMotorTestStore((s) => s.percents)
  const confirmProps = useMotorTestStore((s) => s.confirmProps)
  const enable = useMotorTestStore((s) => s.enable)
  const setMotorPercent = useMotorTestStore((s) => s.setMotorPercent)
  const setSessionInfo = useMotorTestStore((s) => s.setSessionInfo)
  const tick = useMotorTestStore((s) => s.tick)
  const stop = useMotorTestStore((s) => s.stop)

  const [loadingFrame, setLoadingFrame] = useState(false)
  // `paramStore.get()` reads are otherwise not reactive to values arriving
  // after this component has already rendered -- a passively-received
  // PARAM_VALUE (another GCS's write, or the FC's own listener, per
  // `params.ts`'s own doc) or a `fetchAll()` this page itself triggers below
  // would silently never update the frame diagram/motor count without this,
  // same `onChange` + version-bump idiom `SetupPage.tsx` already uses.
  const [version, setVersion] = useState(0)
  useEffect(() => {
    if (!paramStore) return
    return paramStore.onChange(() => setVersion((v) => v + 1))
  }, [paramStore])

  void version
  const { option: frameOption, known: frameKnown } = resolveFrameOption(paramStore)
  const motorCount = frameOption.motors.length

  async function handleLoadFrame(): Promise<void> {
    if (!paramStore) return
    setLoadingFrame(true)
    try {
      await paramStore.fetchAll()
    } finally {
      setLoadingFrame(false)
    }
  }

  // Keep the store's session/motorCount current -- read at onStop/onRenew
  // call time, not captured once (a reconnect swaps `session` identity; the
  // selected frame can change on Setup while this page isn't even mounted).
  useEffect(() => {
    setSessionInfo(session, motorCount)
  }, [session, motorCount, setSessionInfo])

  // The page's ~200ms tick loop.
  useEffect(() => {
    const id = setInterval(() => tick(), TICK_MS)
    return () => clearInterval(id)
  }, [tick])

  // Kill switches 1-3: window blur, tab hidden, Escape.
  useEffect(() => {
    function onBlur(): void {
      stop('Window lost focus')
    }
    function onVisibilityChange(): void {
      if (document.hidden) stop('Tab hidden')
    }
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') stop('ESC pressed')
    }
    window.addEventListener('blur', onBlur)
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [stop])

  // Kill switch 4: leaving this page. `stop()` is idempotent (a no-op if
  // already locked), so this is safe to call unconditionally on every
  // unmount, whatever the reason.
  useEffect(() => {
    return () => {
      stop('Left Motor Test page')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Not one of the six kill switches, but the same principle: no live link
  // means nothing left to keep testing against (mirrors Task 8.3's
  // link-state handling for calibration).
  useEffect(() => {
    if (phase !== 'connected') stop('Link disconnected')
  }, [phase, stop])

  const connected = phase === 'connected'

  if (!connected) {
    return (
      <div className="flex min-h-[70vh] flex-col items-center justify-center gap-3.5 px-5">
        <div className="flex h-[74px] w-[74px] items-center justify-center rounded-[22px] border border-nvx-border bg-white text-nvx-faint shadow-card">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
            <circle cx="6.2" cy="6.2" r="2.45" />
            <circle cx="17.8" cy="6.2" r="2.45" />
            <circle cx="6.2" cy="17.8" r="2.45" />
            <circle cx="17.8" cy="17.8" r="2.45" />
            <path d="M8.1 8.1l7.8 7.8M15.9 8.1l-7.8 7.8" />
          </svg>
        </div>
        <div className="font-heading text-[19px] font-bold text-nvx-text">{t('motors.notConnectedTitle')}</div>
        <div className="max-w-[420px] text-center text-[13px] leading-relaxed text-nvx-muted">{t('motors.notConnectedBody')}</div>
        <button
          type="button"
          disabled={phase !== 'disconnected'}
          onClick={() => void connect(baud)}
          className="rounded-[10px] bg-nvx-primary px-[22px] py-2.5 text-[13px] font-bold text-white hover:bg-nvx-primaryHover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t('motors.connectCta')}
        </button>
      </div>
    )
  }

  return (
    <div className="px-5 pb-6 pt-[18px]">
      <div className="max-w-[1100px]">
        <div className="mb-1 flex items-baseline">
          <span className="font-heading text-[19px] font-bold text-nvx-text">{t('motors.title')}</span>
          <span className="ml-auto text-[12px] text-nvx-faint">{t('motors.titleNote')}</span>
        </div>
        <p className="mb-4 text-[12.5px] text-nvx-subtle">{t('motors.subtitle')}</p>

        {!frameKnown && (
          <div className="mb-4 flex items-center gap-2.5 rounded-[10px] border border-nvx-warningBorder bg-nvx-warningSoft px-3.5 py-2.5 text-[12px] font-semibold text-nvx-warningText">
            <span>{t('motors.frameUnknownNote')}</span>
            <button
              type="button"
              disabled={!paramStore || loadingFrame}
              onClick={() => void handleLoadFrame()}
              className="ml-auto flex-none rounded-lg border border-nvx-warningBorder bg-white px-3 py-1.5 text-[11.5px] font-bold text-nvx-warningText hover:bg-nvx-field disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loadingFrame ? t('params.loadingIndeterminate') : t('params.loadCta')}
            </button>
          </div>
        )}

        <SafetyProgress state={state} propsConfirmed={propsConfirmed} countdown={countdown} idleLeft={idleLeft} />

        <div className="grid grid-cols-2 items-start gap-4">
          <div className="flex flex-col gap-4">
            <MotorLayout frameOption={frameOption} percents={percents} />
            <ManualMapGuide motorCount={motorCount} state={state} onSetPercent={setMotorPercent} />
          </div>
          <div className="flex flex-col gap-4">
            <SafetyGate
              propsConfirmed={propsConfirmed}
              connected={connected}
              state={state}
              countdown={countdown}
              idleLeft={idleLeft}
              onToggleProps={confirmProps}
              onEnable={enable}
              onStopAll={() => stop('STOP pressed')}
            />
            <MotorSliders motorCount={motorCount} percents={percents} state={state} onSetPercent={setMotorPercent} />
          </div>
        </div>
      </div>
    </div>
  )
}
