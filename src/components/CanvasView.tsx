import { useEffect, useRef, useState } from 'react'
import type { MotifGroup } from '../midi/motifAnalysis'
import type { ParsedMidi } from '../midi/noteTypes'
import type { SymmetryGroups } from '../midi/symmetryAnalysis'
import { drawVisualizationFrame } from '../visual/drawFrame'
import { getInkCoordinates } from '../visual/inkRenderer'
import { renderClefRail } from '../visual/clefRenderer'
import { KeyboardIndex } from './KeyboardIndex'

interface CanvasViewProps {
  midi: ParsedMidi | null
  currentTime: number
  isAnimating: boolean
  isOverview: boolean
  getCurrentTime: () => number
  visibleTracks: ReadonlySet<number>
  motifGroups: MotifGroup[]
  motifTraceEnabled: boolean
  symmetryGroups: SymmetryGroups
  axisSymmetryEnabled: boolean
  centerSymmetryEnabled: boolean
  showChromaticLines: boolean
  showStaffLines: boolean
  highlightedPitches: ReadonlySet<number>
  keyboardOctaveLevel: number
  pressedKeyboardCodes: ReadonlySet<string>
  keyboardIndexVisible: boolean
  keyName: string | null
}

interface CanvasSize {
  width: number
  height: number
}

interface RailSize {
  width: number
  height: number
}

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

export function CanvasView({
  midi,
  currentTime,
  isAnimating,
  isOverview,
  getCurrentTime,
  visibleTracks,
  motifGroups,
  motifTraceEnabled,
  symmetryGroups,
  axisSymmetryEnabled,
  centerSymmetryEnabled,
  showChromaticLines,
  showStaffLines,
  highlightedPitches,
  keyboardOctaveLevel,
  pressedKeyboardCodes,
  keyboardIndexVisible,
  keyName,
}: CanvasViewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const clefCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const frameRef = useRef<HTMLDivElement | null>(null)
  const railRef = useRef<HTMLElement | null>(null)
  const [size, setSize] = useState<CanvasSize>(emptySize)
  const [railSize, setRailSize] = useState<RailSize>(emptyRailSize)
  const [clefFontReady, setClefFontReady] = useState(false)
  const hasStartedOverviewRef = useRef(false)
  const stationaryTime = isAnimating ? null : currentTime

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

    const pixelRatio = window.devicePixelRatio || 1
    canvas.width = Math.round(size.width * pixelRatio)
    canvas.height = Math.round(size.height * pixelRatio)
    clefCanvas.width = Math.round(railSize.width * pixelRatio)
    clefCanvas.height = Math.round(railSize.height * pixelRatio)
  }, [railSize.height, railSize.width, size.height, size.width])

  useEffect(() => {
    const canvas = clefCanvasRef.current

    if (!canvas || railSize.width <= 0 || railSize.height <= 0) {
      return
    }

    const pixelRatio = window.devicePixelRatio || 1
    const ctx = canvas.getContext('2d')

    if (!ctx) {
      return
    }

    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)

    if (!midi || !clefFontReady || size.width <= 0 || size.height <= 0) {
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
    const pixelRatio = window.devicePixelRatio || 1
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
        symmetryGroups,
        axisSymmetryEnabled,
        centerSymmetryEnabled,
        showChromaticLines,
        showStaffLines,
        highlightedPitches,
        keyName,
        showEmptyState: true,
      })
    }

    if (isOverview) {
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
    symmetryGroups,
    axisSymmetryEnabled,
    centerSymmetryEnabled,
    showChromaticLines,
    showStaffLines,
    highlightedPitches,
    size.height,
    size.width,
    visibleTracks,
    keyName,
    stationaryTime,
  ])

  return (
    <div className="visual-stage">
      <aside className="clef-rail" ref={railRef} aria-hidden="true">
        <canvas ref={clefCanvasRef} />
      </aside>
      {keyboardIndexVisible ? (
        <KeyboardIndex
          octaveLevel={keyboardOctaveLevel}
          pressedCodes={pressedKeyboardCodes}
        />
      ) : null}
      <div className="canvas-frame" ref={frameRef}>
        <canvas ref={canvasRef} />
      </div>
    </div>
  )
}
