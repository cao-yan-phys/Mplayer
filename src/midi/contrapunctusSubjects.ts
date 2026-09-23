import type { MidiNote, ParsedMidi } from './noteTypes'

export interface SubjectTrace {
  id: string
  label?: string
  color: string
  lineStyle: 'solid' | 'dashed'
  noteIds: string[]
}

interface SubjectDefinition {
  id: string
  label: string
  color: string
  occurrences: SubjectOccurrence[]
}

interface SubjectOccurrence {
  track: number
  start: number
  noteCount: number
  inverted?: boolean
}

const subjects: SubjectDefinition[] = [
  {
    id: '1',
    label: '1',
    color: '#b42432',
    occurrences: [
      { track: 3, start: 1, noteCount: 7 },
      { track: 2, start: 11, noteCount: 7 },
      { track: 1, start: 21, noteCount: 7 },
      { track: 0, start: 31, noteCount: 7 },
      { track: 3, start: 41, noteCount: 7, inverted: true },
      { track: 2, start: 47, noteCount: 7 },
      { track: 1, start: 59, noteCount: 7, inverted: true },
      { track: 0, start: 73, noteCount: 7 },
      { track: 1, start: 75, noteCount: 7 },
      { track: 3, start: 85, noteCount: 7 },
      { track: 2, start: 109, noteCount: 7, inverted: true },
      { track: 3, start: 121, noteCount: 7 },
      { track: 0, start: 123, noteCount: 7 },
      { track: 1, start: 140, noteCount: 7, inverted: true },
      { track: 2, start: 143, noteCount: 7, inverted: true },
      { track: 0, start: 157, noteCount: 7, inverted: true },
      { track: 1, start: 161, noteCount: 7 },
      { track: 3, start: 177, noteCount: 7 },
      { track: 2, start: 179, noteCount: 7, inverted: true },
      { track: 1, start: 183, noteCount: 7 },
      { track: 2, start: 193, noteCount: 7 },
      { track: 1, start: 197, noteCount: 7 },
      { track: 3, start: 209.5, noteCount: 7 },
      { track: 3, start: 295, noteCount: 7 },
      { track: 2, start: 313, noteCount: 7 },
      { track: 0, start: 337, noteCount: 7 },
      { track: 1, start: 363, noteCount: 7 },
      { track: 0, start: 365, noteCount: 7 },
      { track: 3, start: 467, noteCount: 7 },
    ],
  },
  {
    id: '2',
    label: '2',
    color: '#b57400',
    occurrences: [
      { track: 1, start: 226.5, noteCount: 41 },
      { track: 0, start: 240.5, noteCount: 41 },
      { track: 3, start: 254.5, noteCount: 41 },
      { track: 2, start: 268.5, noteCount: 41 },
      { track: 0, start: 292.5, noteCount: 41 },
      { track: 1, start: 310.5, noteCount: 41 },
      { track: 2, start: 332.5, noteCount: 41 },
      { track: 3, start: 358.5, noteCount: 41 },
      { track: 1, start: 464.5, noteCount: 41 },
    ],
  },
  {
    id: '3',
    label: '3',
    color: '#762a75',
    occurrences: [
      { track: 2, start: 385, noteCount: 10 },
      { track: 1, start: 389, noteCount: 10 },
      { track: 0, start: 401, noteCount: 10 },
      { track: 3, start: 405, noteCount: 10 },
      { track: 2, start: 419, noteCount: 10 },
      { track: 0, start: 433, noteCount: 10 },
      { track: 3, start: 434, noteCount: 10 },
      { track: 2, start: 449.5, noteCount: 10 },
      { track: 1, start: 451, noteCount: 10 },
      { track: 2, start: 469, noteCount: 10 },
    ],
  },
]

const notesForOccurrence = (
  notes: readonly MidiNote[],
  occurrence: SubjectOccurrence,
) => {
  const startIndex = notes.findIndex(
    (note) => Math.abs(note.start - occurrence.start) < 0.01,
  )

  if (startIndex === -1) {
    return []
  }

  const subjectNotes = notes.slice(
    startIndex,
    startIndex + occurrence.noteCount,
  )

  return subjectNotes.length === occurrence.noteCount ? subjectNotes : []
}

export const findContrapunctusSubjectTraces = (
  midi: ParsedMidi,
): SubjectTrace[] =>
  subjects.flatMap((definition) => {
    return definition.occurrences
      .map((occurrence) => {
        const trackNotes = midi.notes
          .filter((note) => note.track === occurrence.track)
          .sort(
            (left, right) =>
              left.start - right.start || left.pitch - right.pitch,
          )

        return {
          notes: notesForOccurrence(trackNotes, occurrence),
          lineStyle: occurrence.inverted
            ? ('dashed' as const)
            : ('solid' as const),
        }
      })
      .filter((occurrence) => occurrence.notes.length > 0)
      .map((occurrence, index) => ({
        id: `${definition.id}:${occurrence.notes[0]?.track ?? 0}:${occurrence.notes[0]?.start ?? 0}`,
        label: index === 0 ? definition.label : undefined,
        color: definition.color,
        lineStyle: occurrence.lineStyle,
        noteIds: occurrence.notes.map((note) => note.id),
      }))
  })
