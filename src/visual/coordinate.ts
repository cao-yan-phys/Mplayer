import type { MidiNote, PitchRange, TrackRole } from '../midi/noteTypes'

export interface CoordinateSystem {
  width: number
  height: number
  duration: number
  pitchRange: PitchRange
  pixelsPerSecond: number
  writeHeadX: number
  visibleStart: number
  visibleEnd: number
  trailSeconds: number
  timeToX: (time: number) => number
  pitchToY: (pitch: number, role?: TrackRole) => number
  durationToWidth: (duration: number) => number
  alphaForTime: (time: number) => number
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max)

const trackInkPalette = [
  '#161411',
  '#174c86',
  '#982626',
  '#1f6b43',
  '#69308f',
  '#9a551d',
  '#176b73',
  '#6f611f',
  '#7d2d52',
  '#384f9a',
]

export const roleColor = (_role: TrackRole, track: number) => {
  return trackInkPalette[track % trackInkPalette.length]
}

export const roleBaseWidth = (_role: TrackRole) => 7

export const getWriteHeadX = (width: number) =>
  width - clamp(width * 0.04, 24, 48)

export const createCoordinateSystem = (
  width: number,
  height: number,
  duration: number,
  currentTime: number,
  pitchRange: PitchRange,
  pixelsPerSecondOverride?: number,
): CoordinateSystem => {
  const paddingTop = clamp(height * 0.12, 38, 96)
  const paddingBottom = clamp(height * 0.16, 48, 128)
  const innerHeight = Math.max(1, height - paddingTop - paddingBottom)
  const pitchPadding = 5
  const minPitch = pitchRange.min - pitchPadding
  const maxPitch = pitchRange.max + pitchPadding
  const pitchSpan = Math.max(1, maxPitch - minPitch)
  const safeDuration = Math.max(duration, 0.01)
  const writeHeadX = getWriteHeadX(width)
  const pixelsPerSecond =
    pixelsPerSecondOverride ?? clamp(width / 13.5, 44, 92)
  const trailSeconds = writeHeadX / pixelsPerSecond
  const visibleStart = currentTime - trailSeconds - 0.8
  const visibleEnd = currentTime + (width - writeHeadX) / pixelsPerSecond

  return {
    width,
    height,
    duration: safeDuration,
    pitchRange,
    pixelsPerSecond,
    writeHeadX,
    visibleStart,
    visibleEnd,
    trailSeconds,
    timeToX: (time) => writeHeadX + (time - currentTime) * pixelsPerSecond,
    pitchToY: (pitch, _role) => {
      const normalized =
        (clamp(pitch, minPitch, maxPitch) - minPitch) / pitchSpan
      return paddingTop + (1 - normalized) * innerHeight
    },
    durationToWidth: (noteDuration) =>
      clamp(noteDuration, 0, safeDuration) * pixelsPerSecond,
    alphaForTime: (time) => {
      const x = writeHeadX + (time - currentTime) * pixelsPerSecond
      const edgeFade = clamp((x + 120) / 160, 0, 1)
      const rightFade = clamp((width - x + 80) / 120, 0, 1)
      return edgeFade * rightFade
    },
  }
}

export const visibleNotesInFlow = (
  notes: MidiNote[],
  coordinates: CoordinateSystem,
  currentTime: number,
  visibleTracks: ReadonlySet<number>,
) =>
  notes.filter(
    (note) =>
      visibleTracks.has(note.track) &&
      note.start <= currentTime &&
      note.end >= coordinates.visibleStart - 1.2 &&
      note.start <= coordinates.visibleEnd,
  )
