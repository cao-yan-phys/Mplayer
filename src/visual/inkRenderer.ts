import type { MidiNote, PitchRange } from '../midi/noteTypes'
import {
  type CoordinateSystem,
  createCoordinateSystem,
  roleBaseWidth,
  roleColor,
  visibleNotesInFlow,
} from './coordinate'

interface RenderInkOptions {
  ctx: CanvasRenderingContext2D
  width: number
  height: number
  notes: MidiNote[]
  duration: number
  currentTime: number
  overviewProgress?: number
  visibleTracks: ReadonlySet<number>
  keyboardRange?: PitchRange
}

export interface InkRenderMetrics {
  coordinates: CoordinateSystem
}

interface InkPoint {
  x: number
  y: number
  time: number
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max)

const withAlpha = (hex: string, alpha: number) => {
  const value = hex.replace('#', '')
  const r = Number.parseInt(value.slice(0, 2), 16)
  const g = Number.parseInt(value.slice(2, 4), 16)
  const b = Number.parseInt(value.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${clamp(alpha, 0, 1)})`
}

const lerp = (from: number, to: number, progress: number) =>
  from + (to - from) * progress

const easeOutCubic = (value: number) => 1 - (1 - value) ** 3

const inkWidthForNote = (note: MidiNote) =>
  roleBaseWidth(note.role) * (1.48 + note.velocity * 1.16)

const inkAlphaForNote = (note: MidiNote) =>
  note.role === 'bass'
    ? 0.44 + note.velocity * 0.2
    : note.role === 'melody'
      ? 0.42 + note.velocity * 0.22
      : 0.28 + note.velocity * 0.16

const getPitchRange = (notes: MidiNote[]) =>
  notes.reduce(
    (range, note) => ({
      min: Math.min(range.min, note.pitch),
      max: Math.max(range.max, note.pitch),
    }),
    { min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY },
  )

interface InkCoordinateOptions {
  width: number
  height: number
  notes: MidiNote[]
  duration: number
  currentTime: number
  overviewProgress?: number
  keyboardRange?: PitchRange
  flowPixelsPerSecond?: number
}

const createOverviewCoordinateSystem = (
  width: number,
  height: number,
  duration: number,
  pitchRange: { min: number; max: number },
): CoordinateSystem => {
  const safeDuration = Math.max(duration, 0.01)
  const pitchCoordinates = createCoordinateSystem(
    width,
    height,
    duration,
    safeDuration,
    pitchRange,
  )
  const paddingX = clamp(width * 0.065, 28, 64)
  const innerWidth = Math.max(1, width - paddingX * 2)
  const pixelsPerSecond = innerWidth / safeDuration

  return {
    ...pitchCoordinates,
    pixelsPerSecond,
    writeHeadX: paddingX,
    visibleStart: 0,
    visibleEnd: safeDuration,
    trailSeconds: safeDuration,
    timeToX: (time) =>
      paddingX + clamp(time / safeDuration, 0, 1) * innerWidth,
    durationToWidth: (noteDuration) =>
      clamp(noteDuration, 0, safeDuration) * pixelsPerSecond,
    alphaForTime: () => 1,
  }
}

const createSettledCoordinateSystem = (
  width: number,
  height: number,
  duration: number,
  currentTime: number,
  pitchRange: { min: number; max: number },
  overviewProgress: number,
  flowPixelsPerSecond?: number,
): CoordinateSystem => {
  const flow = createCoordinateSystem(
    width,
    height,
    duration,
    currentTime,
    pitchRange,
    flowPixelsPerSecond,
  )
  const overview = createOverviewCoordinateSystem(
    width,
    height,
    duration,
    pitchRange,
  )
  const progress = easeOutCubic(clamp(overviewProgress, 0, 1))

  if (progress <= 0) {
    return flow
  }

  if (progress >= 1) {
    return overview
  }

  return {
    ...flow,
    pixelsPerSecond: lerp(
      flow.pixelsPerSecond,
      overview.pixelsPerSecond,
      progress,
    ),
    writeHeadX: lerp(flow.writeHeadX, overview.writeHeadX, progress),
    visibleStart: lerp(flow.visibleStart, overview.visibleStart, progress),
    visibleEnd: lerp(flow.visibleEnd, overview.visibleEnd, progress),
    trailSeconds: lerp(flow.trailSeconds, overview.trailSeconds, progress),
    timeToX: (time) =>
      lerp(flow.timeToX(time), overview.timeToX(time), progress),
    pitchToY: (pitch, role) =>
      lerp(flow.pitchToY(pitch, role), overview.pitchToY(pitch, role), progress),
    durationToWidth: (noteDuration) =>
      lerp(
        flow.durationToWidth(noteDuration),
        overview.durationToWidth(noteDuration),
        progress,
      ),
    alphaForTime: (time) =>
      lerp(flow.alphaForTime(time), overview.alphaForTime(time), progress),
  }
}

export const getInkCoordinates = ({
  width,
  height,
  notes,
  duration,
  currentTime,
  overviewProgress = 0,
  keyboardRange,
  flowPixelsPerSecond,
}: InkCoordinateOptions) => {
  const pitchRange = getPitchRange(notes)
  const safePitchRange = {
    min: Math.min(
      Number.isFinite(pitchRange.min) ? pitchRange.min : 48,
      43,
      keyboardRange?.min ?? Number.POSITIVE_INFINITY,
    ),
    max: Math.max(
      Number.isFinite(pitchRange.max) ? pitchRange.max : 72,
      77,
      keyboardRange?.max ?? Number.NEGATIVE_INFINITY,
    ),
  }

  return createSettledCoordinateSystem(
    width,
    height,
    duration,
    currentTime,
    safePitchRange,
    clamp(overviewProgress, 0, 1),
    flowPixelsPerSecond,
  )
}

const makeStableTimes = (
  anchorTime: number,
  startTime: number,
  endTime: number,
  stepSeconds: number,
) => {
  if (endTime <= startTime) {
    return []
  }

  const times = [startTime]
  const firstIndex = Math.ceil((startTime - anchorTime) / stepSeconds)

  for (let index = firstIndex; ; index += 1) {
    const time = anchorTime + index * stepSeconds

    if (time <= startTime + 0.0001) {
      continue
    }

    if (time >= endTime - 0.0001) {
      break
    }

    times.push(time)
  }

  times.push(endTime)
  return times
}

const makeNotePoints = (
  note: MidiNote,
  startTime: number,
  endTime: number,
  coordinates: ReturnType<typeof createCoordinateSystem>,
) => {
  const span = endTime - startTime

  if (span <= 0) {
    return []
  }

  const sampleTimes = makeStableTimes(
    note.start,
    startTime,
    endTime,
    24 / coordinates.pixelsPerSecond,
  )
  const baseY = coordinates.pitchToY(note.pitch, note.role)

  if (sampleTimes.length < 2) {
    return []
  }

  return sampleTimes.map((t) => {
    return {
      x: coordinates.timeToX(t),
      y: baseY,
      time: t,
    }
  })
}

const makeTransitionPoints = (
  from: MidiNote,
  to: MidiNote,
  startTime: number,
  endTime: number,
  coordinates: ReturnType<typeof createCoordinateSystem>,
) => {
  const span = endTime - startTime

  if (span <= 0) {
    return []
  }

  const sampleTimes = makeStableTimes(
    from.end,
    startTime,
    endTime,
    22 / coordinates.pixelsPerSecond,
  )
  const y0 = coordinates.pitchToY(from.pitch, from.role)
  const y1 = coordinates.pitchToY(to.pitch, to.role)

  if (sampleTimes.length < 2) {
    return []
  }

  return sampleTimes.map((t) => {
    const local = (t - from.end) / Math.max(to.start - from.end, 0.001)
    const progress = clamp(local, 0, 1)

    return {
      x: coordinates.timeToX(t),
      y: y0 + (y1 - y0) * progress,
      time: t,
    }
  })
}

const drawInkStroke = (
  ctx: CanvasRenderingContext2D,
  points: InkPoint[],
  color: string,
  width: number,
  alpha: number,
  coordinates: ReturnType<typeof createCoordinateSystem>,
) => {
  if (points.length < 2) {
    return
  }

  const first = points[0]
  const last = points.at(-1)

  if (!first || !last) {
    return
  }

  const gradient = ctx.createLinearGradient(first.x, first.y, last.x, last.y)
  gradient.addColorStop(
    0,
    withAlpha(color, alpha * coordinates.alphaForTime(first.time)),
  )
  gradient.addColorStop(
    1,
    withAlpha(color, alpha * coordinates.alphaForTime(last.time)),
  )

  ctx.save()
  ctx.globalCompositeOperation = 'multiply'
  ctx.strokeStyle = gradient
  ctx.lineWidth = width
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.beginPath()
  ctx.moveTo(first.x, first.y)
  points.slice(1).forEach((point) => ctx.lineTo(point.x, point.y))
  ctx.stroke()
  ctx.restore()
}

const drawTrackInk = (
  ctx: CanvasRenderingContext2D,
  trackNotes: MidiNote[],
  visibleTrackNotes: MidiNote[],
  currentTime: number,
  coordinates: ReturnType<typeof createCoordinateSystem>,
  inkScale: number,
) => {
  const sorted = [...trackNotes].sort((a, b) => a.start - b.start)

  visibleTrackNotes.forEach((note) => {
    const start = Math.max(note.start, coordinates.visibleStart)
    const end = Math.min(note.end, currentTime, coordinates.visibleEnd)
    const points = makeNotePoints(note, start, end, coordinates)

    if (points.length < 2) {
      return
    }

    const color = roleColor(note.role, note.track)
    drawInkStroke(
      ctx,
      points,
      color,
      inkWidthForNote(note) * inkScale,
      inkAlphaForNote(note),
      coordinates,
    )
  })

  sorted.forEach((from, index) => {
    const to = sorted[index + 1]

    if (!to || from.track !== to.track) {
      return
    }

    const gap = to.start - from.end
    const writtenEnd = Math.min(currentTime, to.start, coordinates.visibleEnd)
    const start = Math.max(from.end, coordinates.visibleStart)

    if (
      gap < 0.025 ||
      gap > 0.42 ||
      writtenEnd <= start ||
      from.end > coordinates.visibleEnd ||
      to.start < coordinates.visibleStart
    ) {
      return
    }

    const points = makeTransitionPoints(
      from,
      to,
      start,
      writtenEnd,
      coordinates,
    )

    if (points.length < 2) {
      return
    }

    const color = roleColor(from.role, from.track)
    const width = (inkWidthForNote(from) + inkWidthForNote(to)) * 0.66 * inkScale
    const alpha = (inkAlphaForNote(from) + inkAlphaForNote(to)) * 0.58

    drawInkStroke(
      ctx,
      points,
      color,
      width,
      alpha,
      coordinates,
    )
  })
}

export const renderInkFlow = ({
  ctx,
  width,
  height,
  notes,
  duration,
  currentTime,
  overviewProgress = 0,
  visibleTracks,
  keyboardRange,
}: RenderInkOptions): InkRenderMetrics => {
  const progress = clamp(overviewProgress, 0, 1)
  const coordinates = getInkCoordinates({
    width,
    height,
    notes,
    duration,
    currentTime,
    overviewProgress: progress,
    keyboardRange,
  })
  const overviewInkScale = clamp(width / Math.max(duration * 120, width), 0.3, 1)
  const inkScale = lerp(1, overviewInkScale, easeOutCubic(progress))
  const visibleNotes = visibleNotesInFlow(
    notes,
    coordinates,
    currentTime,
    visibleTracks,
  )

  const allByTrack = new Map<number, MidiNote[]>()
  const visibleByTrack = new Map<number, MidiNote[]>()

  notes.forEach((note) => {
    if (!visibleTracks.has(note.track)) {
      return
    }

    const trackNotes = allByTrack.get(note.track)

    if (trackNotes) {
      trackNotes.push(note)
      return
    }

    allByTrack.set(note.track, [note])
  })

  visibleNotes.forEach((note) => {
    const trackNotes = visibleByTrack.get(note.track)

    if (trackNotes) {
      trackNotes.push(note)
      return
    }

    visibleByTrack.set(note.track, [note])
  })

  ;[...visibleByTrack.entries()]
    .sort(([, a], [, b]) => {
      const roleRank = { bass: 0, inner: 1, melody: 2 }
      return roleRank[a[0].role] - roleRank[b[0].role]
    })
    .forEach(([track, visibleTrackNotes]) => {
      drawTrackInk(
        ctx,
        allByTrack.get(track) ?? [],
        visibleTrackNotes,
        currentTime,
        coordinates,
        inkScale,
      )
    })

  return { coordinates }
}
