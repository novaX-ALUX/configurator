import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../i18n'
import { SetupGuideDrawer } from '../SetupGuideDrawer'
import { useGuideStore } from '../guideStore'
import { useConnectionStore } from '../../../store/connection'
import { useNavigationStore } from '../../../store/navigation'
import { useSetupStore } from '../../setup/setupStore'
import { useCalibrationProgress } from '../../calibration/calibrationProgress'
import { useMotorTestStore } from '../../motors/motorTestStore'
import { useTuningStore } from '../../tuning/tuningStore'
import { MockTransport } from '../../../core/transport/mock'
import { defs } from '../../../core/mavlink/defs'
import { encodeFrame } from '../../../core/mavlink/frame'
import { encodePayload } from '../../../core/mavlink/encode'
import { MavRouter } from '../../../core/mavlink/router'
import { ParamStore } from '../../../core/mavlink/params'

const MAV_PARAM_TYPE_INT32 = 6

const initialGuide = useGuideStore.getState()
const initialConnection = useConnectionStore.getState()
const initialNav = useNavigationStore.getState()
const initialSetup = useSetupStore.getState()
const initialCalProgress = useCalibrationProgress.getState()
const initialMotorTest = useMotorTestStore.getState()
const initialTuning = useTuningStore.getState()

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  useGuideStore.setState(initialGuide, true)
  useConnectionStore.setState(initialConnection, true)
  useNavigationStore.setState(initialNav, true)
  useSetupStore.setState(initialSetup, true)
  useCalibrationProgress.setState(initialCalProgress, true)
  useMotorTestStore.setState(initialMotorTest, true)
  useTuningStore.setState(initialTuning, true)
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function paramValueFrame(name: string, value: number, type = MAV_PARAM_TYPE_INT32): Uint8Array {
  const payload = encodePayload(defs, 22, { param_id: name, param_value: value, param_type: type, param_count: 1, param_index: 0 })
  return encodeFrame(defs, { msgid: 22, payload }, 0, 1, 1)
}

async function makeParamStore(): Promise<{ transport: MockTransport; paramStore: ParamStore }> {
  const transport = new MockTransport()
  const router = new MavRouter(transport, defs, {})
  await transport.open()
  router.start()
  const paramStore = new ParamStore(router, { sysid: 1, compid: 1 })
  return { transport, paramStore }
}

async function tick(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
}

describe('SetupGuideDrawer: open/close', () => {
  it('renders nothing while closed', () => {
    render(<SetupGuideDrawer />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('renders the dialog once the shared guide store opens it', () => {
    act(() => useGuideStore.getState().openGuide())
    render(<SetupGuideDrawer />)
    expect(screen.getByRole('dialog', { name: 'First-flight Setup Guide' })).toBeInTheDocument()
  })

  it('closes via the × button', () => {
    act(() => useGuideStore.getState().openGuide())
    render(<SetupGuideDrawer />)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(useGuideStore.getState().open).toBe(false)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('closes via clicking the scrim', () => {
    act(() => useGuideStore.getState().openGuide())
    const { container } = render(<SetupGuideDrawer />)
    fireEvent.click(container.querySelector('.fixed.inset-0')!)
    expect(useGuideStore.getState().open).toBe(false)
  })

  it('closes via "Skip for now"', () => {
    act(() => useGuideStore.getState().openGuide())
    render(<SetupGuideDrawer />)
    fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }))
    expect(useGuideStore.getState().open).toBe(false)
  })
})

describe('SetupGuideDrawer: step derivation + progress', () => {
  it('all 6 steps read as "To do" and 0 / 6 when nothing has happened yet', () => {
    act(() => useGuideStore.getState().openGuide())
    render(<SetupGuideDrawer />)
    expect(screen.getByText('0 / 6')).toBeInTheDocument()
    expect(screen.getAllByText('To do')).toHaveLength(6)
    expect(screen.queryByText('Done')).not.toBeInTheDocument()
  })

  it('derives each step from its own store flag, independent of the others', () => {
    useConnectionStore.setState({ phase: 'connected' })
    useSetupStore.setState({ frameEscTouched: true, fsTouched: false })
    useCalibrationProgress.setState({ accelDone: true, compassApplied: true, rcCalApplied: true })
    useMotorTestStore.setState({ motorsTested: false })

    act(() => useGuideStore.getState().openGuide())
    render(<SetupGuideDrawer />)

    // connect + frameEsc + calibrate done; motorTest + failsafes + initialTune still to do
    expect(screen.getByText('3 / 6')).toBeInTheDocument()
    expect(screen.getAllByText('Done')).toHaveLength(3)
    expect(screen.getAllByText('To do')).toHaveLength(3)
  })

  it('step 3 needs accelDone, compassApplied AND rcCalApplied — accel alone is not enough', () => {
    useCalibrationProgress.setState({ accelDone: true, compassApplied: false })
    act(() => useGuideStore.getState().openGuide())
    render(<SetupGuideDrawer />)
    expect(screen.getByText('Accel done · compass and RC pending')).toBeInTheDocument()
    expect(screen.getByText('0 / 6')).toBeInTheDocument() // step 3 not counted as done
  })

  it('step 3 stays pending after accel + compass until the RC-cal write latches (issue #46)', () => {
    useCalibrationProgress.setState({ accelDone: true, compassApplied: true, rcCalApplied: false })
    act(() => useGuideStore.getState().openGuide())
    render(<SetupGuideDrawer />)
    expect(screen.getByText('Accel and compass done · RC calibration pending')).toBeInTheDocument()
    expect(screen.getByText('0 / 6')).toBeInTheDocument() // step 3 not counted as done
  })

  it('all 6 done reaches 6 / 6 with no special terminal/celebration state — just every row green', () => {
    useConnectionStore.setState({ phase: 'connected' })
    useSetupStore.setState({ frameEscTouched: true, fsTouched: true })
    useCalibrationProgress.setState({ accelDone: true, compassApplied: true, rcCalApplied: true })
    useMotorTestStore.setState({ motorsTested: true })
    useTuningStore.setState({ initialTuneStaged: true })
    act(() => useGuideStore.getState().openGuide())
    render(<SetupGuideDrawer />)
    expect(screen.getByText('6 / 6')).toBeInTheDocument()
    expect(screen.getAllByText('Done')).toHaveLength(6)
  })
})

describe('SetupGuideDrawer: routing', () => {
  it('"Open page" switches the active page to that step\'s target and closes the drawer', () => {
    act(() => useGuideStore.getState().openGuide())
    render(<SetupGuideDrawer />)
    const openPageButtons = screen.getAllByRole('button', { name: 'Open page' })
    fireEvent.click(openPageButtons[3]) // step 4: motor test
    expect(useNavigationStore.getState().activePage).toBe('motors')
    expect(useGuideStore.getState().open).toBe(false)
  })

  it('routes step 2 and step 5 both to setup, step 3 to calibration, step 1 to dashboard, step 6 to tuning', () => {
    act(() => useGuideStore.getState().openGuide())
    render(<SetupGuideDrawer />)
    let openPageButtons = screen.getAllByRole('button', { name: 'Open page' })
    fireEvent.click(openPageButtons[0])
    expect(useNavigationStore.getState().activePage).toBe('dashboard')

    act(() => useGuideStore.getState().openGuide())
    openPageButtons = screen.getAllByRole('button', { name: 'Open page' })
    fireEvent.click(openPageButtons[2])
    expect(useNavigationStore.getState().activePage).toBe('calibration')

    act(() => useGuideStore.getState().openGuide())
    openPageButtons = screen.getAllByRole('button', { name: 'Open page' })
    fireEvent.click(openPageButtons[4])
    expect(useNavigationStore.getState().activePage).toBe('setup')

    act(() => useGuideStore.getState().openGuide())
    openPageButtons = screen.getAllByRole('button', { name: 'Open page' })
    fireEvent.click(openPageButtons[5])
    expect(useNavigationStore.getState().activePage).toBe('tuning')
  })
})

describe('SetupGuideDrawer: read-only guarantee', () => {
  it('never calls paramStore.set, across every close path and every "Open page" click', async () => {
    const { transport, paramStore } = await makeParamStore()
    transport.feed(paramValueFrame('FRAME_CLASS', 1))
    transport.feed(paramValueFrame('FRAME_TYPE', 1))
    transport.feed(paramValueFrame('MOT_PWM_TYPE', 5))
    await tick()
    const setSpy = vi.spyOn(paramStore, 'set')
    useConnectionStore.setState({ phase: 'connected', paramStore })

    act(() => useGuideStore.getState().openGuide())
    render(<SetupGuideDrawer />)

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    act(() => useGuideStore.getState().openGuide())
    fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }))
    act(() => useGuideStore.getState().openGuide())

    for (const btn of screen.getAllByRole('button', { name: 'Open page' })) {
      fireEvent.click(btn)
      act(() => useGuideStore.getState().openGuide())
    }

    expect(setSpy).not.toHaveBeenCalled()
  })

  it('never touches setupStore/motorTestStore/calibrationProgress/tuningStore state either — only reads them', () => {
    const stageSpy = vi.spyOn(useSetupStore.getState(), 'stage')
    const setPercentSpy = vi.spyOn(useMotorTestStore.getState(), 'setMotorPercent')
    const markAccelSpy = vi.spyOn(useCalibrationProgress.getState(), 'markAccelDone')
    const stageManySpy = vi.spyOn(useTuningStore.getState(), 'stageMany')

    act(() => useGuideStore.getState().openGuide())
    render(<SetupGuideDrawer />)
    for (const btn of screen.getAllByRole('button', { name: 'Open page' })) {
      fireEvent.click(btn)
      act(() => useGuideStore.getState().openGuide())
    }
    fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }))

    expect(stageSpy).not.toHaveBeenCalled()
    expect(setPercentSpy).not.toHaveBeenCalled()
    expect(markAccelSpy).not.toHaveBeenCalled()
    expect(stageManySpy).not.toHaveBeenCalled()
  })
})
