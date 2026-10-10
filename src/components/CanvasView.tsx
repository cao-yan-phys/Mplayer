import { useEffect, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { MotifGroup } from '../midi/motifAnalysis'
import type { SubjectTrace } from '../midi/contrapunctusSubjects'
import type { ParsedMidi } from '../midi/noteTypes'
import type { SymmetryGroups } from '../midi/symmetryAnalysis'
import { drawVisualizationFrame } from '../visual/drawFrame'
import { GoldMeteorRenderer } from '../visual/goldMeteorRenderer'
import { getInkCoordinates } from '../visual/inkRenderer'
import { LiquidScoreRenderer } from '../visual/liquidRenderer'
import {
  getBassClefHitArea,
  getTrebleClefHitArea,
  renderClefRail,
} from '../visual/clefRenderer'
import { KeyboardIndex } from './KeyboardIndex'
import { GwMassRing } from './GwMassRing'

interface CanvasViewProps {
  midi: ParsedMidi | null
  currentTime: number
  isAnimating: boolean
  isOverview: boolean
  getCurrentTime: () => number
  visibleTracks: ReadonlySet<number>
  motifGroups: MotifGroup[]
  motifTraceEnabled: boolean
  subjectTraces: SubjectTrace[]
  symmetryGroups: SymmetryGroups
  axisSymmetryEnabled: boolean
  centerSymmetryEnabled: boolean
  showChromaticLines: boolean
  showStaffLines: boolean
  goldInkMode: boolean
  liquidScoreMode: boolean
  highlightedPitches: ReadonlySet<number>
  keyboardOctaveLevel: number
  transposeSemitones: number
  pressedKeyboardCodes: ReadonlySet<string>
  keyboardIndexVisible: boolean
  keyName: string | null
  cutoffTime: number | null
}

interface CanvasSize {
  width: number
  height: number
}

interface RailSize {
  width: number
  height: number
}

type ClefPanelPage = 'notes' | 'links'

const emptySize: CanvasSize = {
  width: 0,
  height: 0,
}

const emptyRailSize: RailSize = {
  width: 0,
  height: 0,
}

const OVERVIEW_TRANSITION_MS = 1800

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max)

const getCanvasPixelRatio = (goldInkMode: boolean) => {
  const pixelRatio = window.devicePixelRatio || 1

  return goldInkMode ? Math.min(pixelRatio, 1.5) : pixelRatio
}

export function CanvasView({
  midi,
  currentTime,
  isAnimating,
  isOverview,
  getCurrentTime,
  visibleTracks,
  motifGroups,
  motifTraceEnabled,
  subjectTraces,
  symmetryGroups,
  axisSymmetryEnabled,
  centerSymmetryEnabled,
  showChromaticLines,
  showStaffLines,
  goldInkMode,
  liquidScoreMode,
  highlightedPitches,
  keyboardOctaveLevel,
  transposeSemitones,
  pressedKeyboardCodes,
  keyboardIndexVisible,
  keyName,
  cutoffTime,
}: CanvasViewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const clefCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const frameRef = useRef<HTMLDivElement | null>(null)
  const railRef = useRef<HTMLElement | null>(null)
  const [size, setSize] = useState<CanvasSize>(emptySize)
  const [railSize, setRailSize] = useState<RailSize>(emptyRailSize)
  const [clefFontReady, setClefFontReady] = useState(false)
  const [goldSkyVersion, setGoldSkyVersion] = useState(0)
  const [clefPanelOpen, setClefPanelOpen] = useState(false)
  const [clefPanelPage, setClefPanelPage] = useState<ClefPanelPage>('notes')
  const hasStartedOverviewRef = useRef(false)
  const goldMeteorRendererRef = useRef(new GoldMeteorRenderer())
  const liquidScoreRendererRef = useRef(new LiquidScoreRenderer())
  const stationaryTime = isAnimating ? null : currentTime
  const bassClefHitArea = useMemo(() => {
    if (
      goldInkMode ||
      liquidScoreMode ||
      !midi ||
      !clefFontReady ||
      !showStaffLines ||
      railSize.width <= 0 ||
      size.width <= 0 ||
      size.height <= 0
    ) {
      return null
    }

    const waveformHeight = midi.gwWaveform
      ? clamp(size.height * 0.24, 96, 158)
      : 0
    const inkHeight = Math.max(1, size.height - waveformHeight)
    const coordinates = getInkCoordinates({
      width: size.width,
      height: inkHeight,
      notes: midi.notes,
      duration: midi.duration,
      currentTime: 0,
    })
    const ctx = clefCanvasRef.current?.getContext('2d')

    return ctx
      ? getBassClefHitArea(ctx, railSize.width, inkHeight, coordinates)
      : null
  }, [clefFontReady, goldInkMode, liquidScoreMode, midi, railSize.width, showStaffLines, size.height, size.width])
  const trebleClefHitArea = useMemo(() => {
    if (
      goldInkMode ||
      liquidScoreMode ||
      !midi ||
      !clefFontReady ||
      !showStaffLines ||
      railSize.width <= 0 ||
      size.width <= 0 ||
      size.height <= 0
    ) {
      return null
    }

    const waveformHeight = midi.gwWaveform
      ? clamp(size.height * 0.24, 96, 158)
      : 0
    const inkHeight = Math.max(1, size.height - waveformHeight)
    const coordinates = getInkCoordinates({
      width: size.width,
      height: inkHeight,
      notes: midi.notes,
      duration: midi.duration,
      currentTime: 0,
    })
    const ctx = clefCanvasRef.current?.getContext('2d')

    return ctx
      ? getTrebleClefHitArea(ctx, railSize.width, inkHeight, coordinates)
      : null
  }, [clefFontReady, goldInkMode, liquidScoreMode, midi, railSize.width, showStaffLines, size.height, size.width])

  useEffect(() => {
    goldMeteorRendererRef.current.preloadSky(() => {
      setGoldSkyVersion((version) => version + 1)
    })
  }, [])

  useEffect(() => {
    if (!liquidScoreMode) {
      liquidScoreRendererRef.current.reset()
    }
  }, [liquidScoreMode])

  useEffect(() => {
    const frame = frameRef.current
    const rail = railRef.current

    if (!frame || !rail) {
      return
    }

    const updateSize = (width: number, height: number) => {
      const nextSize = {
        width: Math.round(width),
        height: Math.round(height),
      }

      setSize((current) =>
        current.width === nextSize.width && current.height === nextSize.height
          ? current
          : nextSize,
      )
    }

    const measureFrame = () => {
      const { width, height } = frame.getBoundingClientRect()
      updateSize(width, height)
    }

    const updateRailSize = (width: number, height: number) => {
      const nextSize = {
        width: Math.round(width),
        height: Math.round(height),
      }

      setRailSize((current) =>
        current.width === nextSize.width && current.height === nextSize.height
          ? current
          : nextSize,
      )
    }

    const measureRail = () => {
      const { width, height } = rail.getBoundingClientRect()
      updateRailSize(width, height)
    }

    let firstFrame = 0
    let secondFrame = 0
    const queueMeasurement = () => {
      window.cancelAnimationFrame(firstFrame)
      window.cancelAnimationFrame(secondFrame)
      firstFrame = window.requestAnimationFrame(() => {
        secondFrame = window.requestAnimationFrame(() => {
          measureFrame()
          measureRail()
        })
      })
    }

    const observer = new ResizeObserver((entries) => {
      entries.forEach((entry) => {
        const { width, height } = entry.contentRect

        if (entry.target === frame) {
          updateSize(width, height)
          return
        }

        if (entry.target === rail) {
          updateRailSize(width, height)
        }
      })
    })

    observer.observe(frame)
    observer.observe(rail)
    window.addEventListener('resize', queueMeasurement)
    window.visualViewport?.addEventListener('resize', queueMeasurement)
    document.addEventListener('fullscreenchange', queueMeasurement)
    queueMeasurement()

    return () => {
      observer.disconnect()
      window.cancelAnimationFrame(firstFrame)
      window.cancelAnimationFrame(secondFrame)
      window.removeEventListener('resize', queueMeasurement)
      window.visualViewport?.removeEventListener('resize', queueMeasurement)
      document.removeEventListener('fullscreenchange', queueMeasurement)
    }
  }, [])

  useEffect(() => {
    let active = true

    void document.fonts
      .load('16px Bravura')
      .then(() => {
        if (active) {
          setClefFontReady(true)
        }
      })
      .catch(() => {
        if (active) {
          setClefFontReady(false)
        }
      })

    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    const clefCanvas = clefCanvasRef.current

    if (!canvas || !clefCanvas || size.width <= 0 || size.height <= 0) {
      return
    }

    const pixelRatio = getCanvasPixelRatio(goldInkMode)
    canvas.width = Math.round(size.width * pixelRatio)
    canvas.height = Math.round(size.height * pixelRatio)
    clefCanvas.width = Math.round(railSize.width * pixelRatio)
    clefCanvas.height = Math.round(railSize.height * pixelRatio)
  }, [goldInkMode, railSize.height, railSize.width, size.height, size.width])

  useEffect(() => {
    const canvas = clefCanvasRef.current

    if (!canvas || railSize.width <= 0 || railSize.height <= 0) {
      return
    }

    const pixelRatio = getCanvasPixelRatio(goldInkMode)
    const ctx = canvas.getContext('2d')

    if (!ctx) {
      return
    }

    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)

    if (
      goldInkMode ||
      liquidScoreMode ||
      !midi ||
      !clefFontReady ||
      size.width <= 0 ||
      size.height <= 0
    ) {
      ctx.clearRect(0, 0, railSize.width, railSize.height)
      return
    }

    const waveformHeight = midi.gwWaveform
      ? clamp(size.height * 0.24, 96, 158)
      : 0
    const inkHeight = Math.max(1, size.height - waveformHeight)
    const coordinates = getInkCoordinates({
      width: size.width,
      height: inkHeight,
      notes: midi.notes,
      duration: midi.duration,
      currentTime: 0,
    })

    renderClefRail({
      ctx,
      width: railSize.width,
      height: railSize.height,
      inkHeight,
      coordinates,
      showStaffLines,
    })
  }, [
    clefFontReady,
    goldInkMode,
    liquidScoreMode,
    midi,
    railSize.height,
    railSize.width,
    showStaffLines,
    size.height,
    size.width,
  ])

  useEffect(() => {
    const canvas = canvasRef.current

    if (!canvas || size.width <= 0 || size.height <= 0) {
      return
    }

    let frameId = 0
    const pixelRatio = getCanvasPixelRatio(goldInkMode)
    const ctx = canvas.getContext('2d')

    if (!ctx) {
      return
    }

    const draw = (time: number, overviewProgress = 0) => {
      ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
      drawVisualizationFrame({
        ctx,
        width: size.width,
        height: size.height,
        midi,
        currentTime: time,
        overviewProgress,
        visibleTracks,
        motifGroups,
        motifTraceEnabled,
        subjectTraces,
        symmetryGroups,
        axisSymmetryEnabled,
        centerSymmetryEnabled,
        showChromaticLines,
        showStaffLines,
        goldInkMode,
        liquidScoreMode,
        goldMeteorRenderer: goldMeteorRendererRef.current,
        liquidScoreRenderer: liquidScoreRendererRef.current,
        isAnimating,
        highlightedPitches,
        keyName,
        cutoffTime,
        showEmptyState: true,
      })
    }

    if (isOverview && !liquidScoreMode) {
      if (hasStartedOverviewRef.current) {
        draw(stationaryTime ?? 0, 1)
        return
      }

      hasStartedOverviewRef.current = true
      const startedAt = performance.now()

      const animateOverview = (now: number) => {
        const progress = Math.min(
          Math.max((now - startedAt) / OVERVIEW_TRANSITION_MS, 0),
          1,
        )

        draw(stationaryTime ?? 0, progress)

        if (progress < 1) {
          frameId = window.requestAnimationFrame(animateOverview)
        }
      }

      frameId = window.requestAnimationFrame(animateOverview)
      return () => {
        window.cancelAnimationFrame(frameId)
      }
    }

    hasStartedOverviewRef.current = false

    if (!isAnimating) {
      draw(stationaryTime ?? 0)

      const hasActiveKeyboardVisual = () =>
        (goldInkMode &&
          goldMeteorRendererRef.current.hasActiveKeyboardMeteors()) ||
        (liquidScoreMode &&
          liquidScoreRendererRef.current.hasActiveKeyboardFlow())

      if (hasActiveKeyboardVisual()) {
        const animateKeyboardVisual = () => {
          draw(stationaryTime ?? 0)

          if (hasActiveKeyboardVisual()) {
            frameId = window.requestAnimationFrame(animateKeyboardVisual)
          }
        }

        frameId = window.requestAnimationFrame(animateKeyboardVisual)
        return () => {
          window.cancelAnimationFrame(frameId)
        }
      }

      return
    }

    const animate = () => {
      draw(getCurrentTime())
      frameId = window.requestAnimationFrame(animate)
    }

    frameId = window.requestAnimationFrame(animate)
    return () => {
      window.cancelAnimationFrame(frameId)
    }
  }, [
    getCurrentTime,
    isOverview,
    isAnimating,
    midi,
    motifGroups,
    motifTraceEnabled,
    subjectTraces,
    symmetryGroups,
    axisSymmetryEnabled,
    centerSymmetryEnabled,
    showChromaticLines,
    showStaffLines,
    goldInkMode,
    goldSkyVersion,
    liquidScoreMode,
    highlightedPitches,
    size.height,
    size.width,
    visibleTracks,
    keyName,
    cutoffTime,
    stationaryTime,
  ])

  return (
    <div className="visual-stage">
      <aside className="clef-rail" ref={railRef}>
        <canvas ref={clefCanvasRef} />
        {midi?.gwWaveform && !goldInkMode && !liquidScoreMode ? (
          <GwMassRing
            waveform={midi.gwWaveform}
            duration={midi.duration}
            width={railSize.width}
            height={railSize.height}
            waveformHeight={clamp(size.height * 0.24, 96, 158)}
            centerX={bassClefHitArea ? bassClefHitArea.left + bassClefHitArea.width / 2 : railSize.width / 2}
            visibleTracks={visibleTracks}
            currentTime={currentTime}
            isAnimating={isAnimating}
            getCurrentTime={getCurrentTime}
          />
        ) : null}
        {trebleClefHitArea ? (
          <button
            className="treble-clef-link"
            type="button"
            aria-label="Open notes"
            title="Open notes"
            style={trebleClefHitArea}
            onClick={() => {
              setClefPanelPage('notes')
              setClefPanelOpen(true)
            }}
          />
        ) : null}
        {bassClefHitArea ? (
          <button
            className="bass-clef-link"
            type="button"
            aria-label="View repository"
            title="View repository"
            style={bassClefHitArea}
            onClick={() => {
              window.open(
                'https://github.com/cao-yan-phys/Mplayer',
                '_blank',
                'noopener,noreferrer',
              )
            }}
          />
        ) : null}
      </aside>
      {keyboardIndexVisible ? (
        <KeyboardIndex
          octaveLevel={keyboardOctaveLevel}
          transposeSemitones={transposeSemitones}
          pressedCodes={pressedKeyboardCodes}
        />
      ) : null}
      <div className="canvas-frame" ref={frameRef}>
        <canvas ref={canvasRef} />
      </div>
      {clefPanelOpen ? (
        <section
          className="clef-panel"
          role="dialog"
          aria-modal="true"
          aria-label="Notes"
        >
          <div className="clef-panel__header">
            <div className="clef-panel__tabs" role="tablist" aria-label="Panel">
              <button
                className={clefPanelPage === 'notes' ? 'is-active' : undefined}
                type="button"
                role="tab"
                aria-selected={clefPanelPage === 'notes'}
                onClick={() => setClefPanelPage('notes')}
              >
                Notes
              </button>
              <button
                className={clefPanelPage === 'links' ? 'is-active' : undefined}
                type="button"
                role="tab"
                aria-selected={clefPanelPage === 'links'}
                onClick={() => setClefPanelPage('links')}
              >
                Links
              </button>
            </div>
            <button
              className="icon-button compact-button clef-panel__close"
              type="button"
              aria-label="Close"
              title="Close"
              onClick={() => setClefPanelOpen(false)}
            >
              <X size={15} />
            </button>
          </div>
          {clefPanelPage === 'notes' ? (
            <dl className="clef-panel__notes">
              <div>
                <dt>1-5</dt>
                <dd>Keyboard octave level</dd>
              </div>
              <div>
                <dt>9, 0</dt>
                <dd>Visualizations</dd>
              </div>
              <div>
                <dt>Backspace</dt>
                <dd>Play / pause</dd>
              </div>
              <div>
                <dt>Instruments</dt>
                <dd>
                  Virtual Piano or Dot Piano can be used through a virtual
                  MIDI port, e.g., loopMIDI. Keep this page in the foreground
                  during playback.
                </dd>
              </div>
            </dl>
          ) : (
            <div className="clef-panel__links" style={{ padding: '16px 20px' }}>
              <a href={`${import.meta.env.BASE_URL}music-fundamentals/index.html`} target="_blank" rel="noopener noreferrer">
                Tonal music fundamentals
              </a>
            </div>
          )}
        </section>
      ) : null}
    </div>
  )
}
