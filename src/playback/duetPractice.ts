import type { MidiNote, ParsedMidi } from '../midi/noteTypes'
import { keyboardBindingsForOctaveLevel } from './keyboardMap'

export type PracticeVoice = 'upper' | 'lower'

export interface PracticeEvent {
  start: number
  notes: MidiNote[]
}

export interface PracticeTracks {
  upper: number
  lower: number
}

const ONSET_TOLERANCE_SECONDS = 0.0001

const PRACTICE_OCTAVE_LEVELS = [1, 2, 3, 4, 5]

const playablePitchesByOctave = new Map(
  PRACTICE_OCTAVE_LEVELS.map((octaveLevel) => [
    octaveLevel,
    new Set(
      keyboardBindingsForOctaveLevel(octaveLevel)
        .map((binding) => binding.pitch)
        .filter((pitch): pitch is number => pitch !== undefined),
    ),
  ]),
)

export const getPracticeTracks = (
  midi: ParsedMidi,
): PracticeTracks | null => {
  if (midi.tracks.length !== 2) {
    return null
  }

  const byPitch = [...midi.tracks].sort(
    (left, right) => left.averagePitch - right.averagePitch,
  )
  const lower = byPitch[0]
  const upper = byPitch[1]

  return lower && upper
    ? {
        lower: lower.track,
        upper: upper.track,
      }
    : null
}

export const createPracticeEvents = (notes: MidiNote[]) => {
  const events: PracticeEvent[] = []

  notes
    .slice()
    .sort((left, right) => left.start - right.start || left.pitch - right.pitch)
    .forEach((note) => {
      const previous = events.at(-1)

      if (
        previous &&
        Math.abs(previous.start - note.start) <= ONSET_TOLERANCE_SECONDS
      ) {
        previous.notes.push(note)
        return
      }

      events.push({
        start: note.start,
        notes: [note],
      })
    })

  return events
}

export const choosePracticeOctaveLevels = (
  events: readonly PracticeEvent[],
  initialOctaveLevel: number,
) => {
  let previousLevel = initialOctaveLevel

  return events.map((event) => {
    const availableLevels = PRACTICE_OCTAVE_LEVELS.filter((octaveLevel) => {
      const playablePitches = playablePitchesByOctave.get(octaveLevel)

      return event.notes.every((note) => playablePitches?.has(note.pitch))
    })

    if (availableLevels.length === 0) {
      return previousLevel
    }

    const nextLevel = availableLevels.includes(previousLevel)
      ? previousLevel
      : availableLevels.reduce((closestLevel, octaveLevel) =>
          Math.abs(octaveLevel - previousLevel) <
          Math.abs(closestLevel - previousLevel)
            ? octaveLevel
            : closestLevel,
        )

    previousLevel = nextLevel
    return nextLevel
  })
}
