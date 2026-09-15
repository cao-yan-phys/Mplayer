import type { MidiNote, ParsedMidi } from './noteTypes'

export interface SubjectTrace {
  id: string
  label?: string
  color: string
  noteIds: string[]
}

interface SubjectDefinition {
  id: string
  label: string
  color: string
  track: number
  start: number
  pitches: number[]
}

const subjects: SubjectDefinition[] = [
  {
    id: '1',
    label: '1',
    color: '#b42432',
    track: 3,
    start: 1,
    pitches: [50, 57, 55, 53, 55, 57, 50],
  },
  {
    id: '2',
    label: '2',
    color: '#b57400',
    track: 1,
    start: 226.5,
    pitches: [
      65, 67, 65, 64, 62, 61, 62, 57, 62, 64, 65, 64, 62, 65, 64, 57,
      64, 65, 67, 65, 64, 65, 67, 69, 67, 65, 67, 69, 67, 66, 67, 69,
      70, 69, 67, 65, 64, 62, 64, 67, 65,
    ],
  },
  {
    id: '3',
    label: '3',
    color: '#762a75',
    track: 2,
    start: 385,
    pitches: [58, 57, 60, 59, 61, 62, 61, 59, 61, 62],
  },
  {
    id: '4',
    label: '4',
    color: '#12665c',
    track: 2,
    start: 480,
    pitches: [50, 57, 53, 50, 49, 50, 52, 53],
  },
]

const matchesSubject = (
  notes: readonly MidiNote[],
  definition: SubjectDefinition,
) =>
  notes.length === definition.pitches.length &&
  notes.slice(1).every(
    (note, index) =>
      note.pitch - notes[index]!.pitch ===
      definition.pitches[index + 1]! - definition.pitches[index]!,
  )

export const findContrapunctusSubjectTraces = (
  midi: ParsedMidi,
): SubjectTrace[] =>
  subjects.flatMap((definition) => {
    const occurrences: MidiNote[][] = []

    midi.tracks.forEach((track) => {
      const trackNotes = midi.notes
        .filter((note) => note.track === track.track)
        .sort((left, right) => left.start - right.start || left.pitch - right.pitch)

      for (
        let index = 0;
        index + definition.pitches.length <= trackNotes.length;
        index += 1
      ) {
        const notes = trackNotes.slice(
          index,
          index + definition.pitches.length,
        )

        if (matchesSubject(notes, definition)) {
          occurrences.push(notes)
        }
      }
    })

    return occurrences
      .sort(
        (left, right) =>
          (left[0]?.start ?? 0) - (right[0]?.start ?? 0) ||
          (left[0]?.track ?? 0) - (right[0]?.track ?? 0),
      )
      .map((notes, index) => ({
        id: `${definition.id}:${notes[0]?.track ?? 0}:${notes[0]?.start ?? 0}`,
        label: index === 0 ? definition.label : undefined,
        color: definition.color,
        noteIds: notes.map((note) => note.id),
      }))
  })
