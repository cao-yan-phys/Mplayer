import type { MotifGroup } from '../midi/motifAnalysis'
import type { SubjectTrace } from '../midi/contrapunctusSubjects'
import type { ParsedMidi, PitchRange } from '../midi/noteTypes'
import type { SymmetryGroups } from '../midi/symmetryAnalysis'
import { getInkCoordinates, renderInkFlow } from './inkRenderer'
import { renderMotifTrace } from './motifRenderer'
import { renderSubjectTraces } from './subjectRenderer'
import { renderGrandStaff } from './staffRenderer'
import { renderSymmetryTrace } from './symmetryRenderer'
import { renderGwWaveform } from './waveformRenderer'

interface DrawFrameOptions {
  ctx: CanvasRenderingContext2D
  width: number
  height: number
  midi: ParsedMidi | null
  currentTime: number
  overviewProgress?: number
  visibleTracks: ReadonlySet<number>
  motifGroups?: MotifGroup[]
  motifTraceEnabled?: boolean
  subjectTraces?: SubjectTrace[]
  symmetryGroups?: SymmetryGroups
  axisSymmetryEnabled?: boolean
  centerSymmetryEnabled?: boolean
  showChromaticLines?: boolean
  showStaffLines?: boolean
  goldInkMode?: boolean
  highlightedPitches?: ReadonlySet<number>
  keyboardRange?: PitchRange
  keyName?: string | null
  cutoffTime?: number | null
  showEmptyState?: boolean
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max)

const paperNoise = (seed: number) => {
  const value = Math.sin(seed * 12.9898) * 43758.5453
  return value - Math.floor(value)
}

export const drawPaperBackground = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  currentTime: number,
  goldInkMode = false,
) => {
  if (goldInkMode) {
    ctx.fillStyle = '#030302'
    ctx.fillRect(0, 0, width, height)
    return
  }

  const paperSpeed = clamp(width / 13.5, 44, 92)
  const fiberSpacing = 54
  const fleckSpacing = 78
  const fiberOffset = -((currentTime * paperSpeed) % fiberSpacing)
  const fleckOffset = -((currentTime * paperSpeed) % fleckSpacing)

  ctx.fillStyle = '#fbfaf4'
  ctx.fillRect(0, 0, width, height)

  const paperGrain = ctx.createLinearGradient(0, 0, width, height)
  paperGrain.addColorStop(0, 'rgba(255,255,255,0.22)')
  paperGrain.addColorStop(0.48, 'rgba(226,216,194,0.08)')
  paperGrain.addColorStop(1, 'rgba(188,179,156,0.09)')
  ctx.fillStyle = paperGrain
  ctx.fillRect(0, 0, width, height)

  ctx.save()
  ctx.lineWidth = 1
  ctx.strokeStyle = 'rgba(93, 84, 68, 0.022)'

  for (let y = height * 0.12; y < height * 0.92; y += 28) {
    for (let x = fiberOffset - fiberSpacing; x < width + fiberSpacing; x += fiberSpacing) {
      const seed = y * 17 + Math.floor((x - fiberOffset) / fiberSpacing) * 31
      const segment = 16 + paperNoise(seed) * 34
      const lift = (paperNoise(seed + 5) - 0.5) * 2.2

      ctx.beginPath()
      ctx.moveTo(x, y + lift)
      ctx.bezierCurveTo(
        x + segment * 0.35,
        y + lift + (paperNoise(seed + 1) - 0.5) * 1.4,
        x + segment * 0.68,
        y + lift + (paperNoise(seed + 2) - 0.5) * 1.4,
        x + segment,
        y + lift + (paperNoise(seed + 3) - 0.5) * 1.2,
      )
      ctx.stroke()
    }
  }

  ctx.fillStyle = 'rgba(93, 84, 68, 0.025)'

  for (let y = 18; y < height; y += fleckSpacing) {
    for (let x = fleckOffset - fleckSpacing; x < width + fleckSpacing; x += fleckSpacing) {
      const seed = y * 23 + Math.floor((x - fleckOffset) / fleckSpacing) * 41
      const px = x + paperNoise(seed) * fleckSpacing
      const py = y + paperNoise(seed + 7) * fleckSpacing
      const radius = 0.35 + paperNoise(seed + 11) * 0.9

      ctx.beginPath()
      ctx.ellipse(px, py, radius * 1.6, radius, 0, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  ctx.restore()
}

export const drawVisualizationFrame = ({
  ctx,
  width,
  height,
  midi,
  currentTime,
  overviewProgress = 0,
  visibleTracks,
  motifGroups = [],
  motifTraceEnabled = false,
  subjectTraces = [],
  symmetryGroups = { axis: [], center: [] },
  axisSymmetryEnabled = false,
  centerSymmetryEnabled = false,
  showChromaticLines = true,
  showStaffLines = true,
  goldInkMode = false,
  highlightedPitches = new Set<number>(),
  keyboardRange,
  keyName = null,
  cutoffTime = null,
  showEmptyState = false,
}: DrawFrameOptions) => {
  ctx.clearRect(0, 0, width, height)
  drawPaperBackground(ctx, width, height, currentTime, goldInkMode)

  if (!midi) {
    if (showEmptyState) {
      ctx.fillStyle = 'rgba(54, 50, 43, 0.42)'
      ctx.font = '16px "Courier New", "Courier Prime", Courier, monospace'
      ctx.textAlign = 'center'
      ctx.fillText('Drop a MIDI file to begin', width / 2, height / 2)
    }

    return
  }

  const waveformHeight = !goldInkMode && midi.gwWaveform
    ? clamp(height * 0.24, 96, 158)
    : 0
  const inkHeight = Math.max(1, height - waveformHeight)
  const options = {
    ctx,
    width,
    height: inkHeight,
    notes: midi.notes,
    duration: midi.duration,
    currentTime,
    overviewProgress,
    keyboardRange,
    visibleTracks,
    goldInkMode,
  }

  const coordinates = getInkCoordinates({
    width,
    height: inkHeight,
    notes: midi.notes,
    duration: midi.duration,
    currentTime,
    overviewProgress,
    keyboardRange,
  })
  if (!goldInkMode) {
    renderGrandStaff({
      ctx,
      width,
      height: inkHeight,
      coordinates,
      showChromaticLines,
      showStaffLines,
      highlightedPitches,
    })
  }

  if (!goldInkMode && cutoffTime !== null) {
    const cutoffX = coordinates.timeToX(cutoffTime)

    if (cutoffX >= -1 && cutoffX <= width + 1) {
      ctx.save()
      ctx.strokeStyle = 'rgba(47, 44, 39, 0.52)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(cutoffX, 0)
      ctx.lineTo(cutoffX, inkHeight)
      ctx.stroke()
      ctx.restore()
    }
  }

  if (!goldInkMode && keyName) {
    ctx.save()
    ctx.fillStyle = 'rgba(47, 44, 39, 0.76)'
    ctx.font = '600 14px "Courier New", "Courier Prime", Courier, monospace'
    ctx.textAlign = 'right'
    ctx.textBaseline = 'top'
    ctx.fillText(keyName, width - 20, 18)
    ctx.restore()
  }

  const inkMetrics = renderInkFlow(options)

  if (!goldInkMode && subjectTraces.length > 0) {
    renderSubjectTraces({
      ctx,
      traces: subjectTraces,
      notes: midi.notes,
      currentTime,
      coordinates: inkMetrics.coordinates,
      visibleTracks,
    })
  }

  if (!goldInkMode && motifTraceEnabled && motifGroups.length > 0) {
    renderMotifTrace({
      ctx,
      groups: motifGroups,
      notes: midi.notes,
      currentTime,
      coordinates: inkMetrics.coordinates,
      visibleTracks,
    })
  }

  if (!goldInkMode && axisSymmetryEnabled && symmetryGroups.axis.length > 0) {
    renderSymmetryTrace({
      ctx,
      occurrences: symmetryGroups.axis,
      notes: midi.notes,
      currentTime,
      coordinates: inkMetrics.coordinates,
      visibleTracks,
    })
  }

  if (!goldInkMode && centerSymmetryEnabled && symmetryGroups.center.length > 0) {
    renderSymmetryTrace({
      ctx,
      occurrences: symmetryGroups.center,
      notes: midi.notes,
      currentTime,
      coordinates: inkMetrics.coordinates,
      visibleTracks,
    })
  }

  if (!goldInkMode && midi.gwWaveform) {
    renderGwWaveform({
      ctx,
      width,
      top: inkHeight,
      height: waveformHeight,
      waveform: midi.gwWaveform,
      duration: midi.duration,
      currentTime,
      overviewProgress,
      visibleTracks,
    })
  }
}
