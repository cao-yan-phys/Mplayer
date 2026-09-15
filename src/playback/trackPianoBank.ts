import { Piano } from '@tonejs/piano/build/piano/Piano'
import { Filter, Gain, now as toneNow } from 'tone'
import type { MidiNote } from '../midi/noteTypes'

interface PianoRange {
  minNote: number
  maxNote: number
}

interface PianoVolumes {
  strings: number
  keybed: number
  harmonics: number
  pedal: number
}

export class TrackPianoBank {
  private pianos = new Map<number, Piano>()

  private output: Gain | null = null

  private key = ''

  private loadPromise: Promise<void> | null = null

  private generation = 0

  private schedulerGeneration = 0

  private schedulerTimer: number | null = null

  private releaseTimers = new Set<number>()

  private readonly destination: Filter

  constructor(destination: Filter) {
    this.destination = destination
  }

  async prepare(
    notes: readonly MidiNote[],
    range: PianoRange,
    volumes: PianoVolumes,
  ) {
    const tracks = [...new Set(notes.map((note) => note.track))].sort(
      (left, right) => left - right,
    )

    if (tracks.length === 0) {
      this.clear()
      return
    }

    const key = `${range.minNote}-${range.maxNote}:${tracks.join(',')}`

    if (
      this.key === key &&
      tracks.every((track) => this.pianos.get(track)?.loaded)
    ) {
      return
    }

    if (this.loadPromise && this.key === key) {
      await this.loadPromise
      return
    }

    this.clear()
    this.key = key
    const generation = this.generation
    const output = new Gain(1)
    output.connect(this.destination)
    this.output = output

    const pianos = tracks.map((track) => [
      track,
      new Piano({
        velocities: 5,
        minNote: range.minNote,
        maxNote: range.maxNote,
        release: true,
        pedal: false,
        maxPolyphony: 64,
        volume: volumes,
      }),
    ] as const)

    pianos.forEach(([track, piano]) => {
      piano.connect(output)
      this.pianos.set(track, piano)
    })

    const loadPromise = Promise.all(
      pianos.map(([, piano]) => piano.load()),
    ).then(() => undefined)
    this.loadPromise = loadPromise

    try {
      await loadPromise
    } catch {
      if (this.generation === generation) {
        this.clear()
      }
    } finally {
      if (
        this.generation === generation &&
        this.loadPromise === loadPromise
      ) {
        this.loadPromise = null
      }
    }
  }

  schedule(
    notes: readonly MidiNote[],
    startAt: number,
    endAt: number,
    playbackRate: number,
  ) {
    if (!this.output || endAt <= startAt) {
      return
    }

    this.schedulerGeneration += 1
    const schedulerGeneration = this.schedulerGeneration
    this.clearSchedulerTimer()
    this.output.gain.cancelScheduledValues(toneNow())
    this.output.gain.setValueAtTime(1, toneNow())

    const generation = this.generation
    const scheduledNotes = notes
      .filter((note) => note.start >= startAt && note.start < endAt)
      .sort((left, right) => left.start - right.start)
    const scheduledAt = performance.now()
    let nextNoteIndex = 0

    const tick = () => {
      if (
        this.generation !== generation ||
        this.schedulerGeneration !== schedulerGeneration
      ) {
        return
      }

      const elapsed =
        ((performance.now() - scheduledAt) / 1000) * playbackRate
      const playbackTime = startAt + elapsed

      while (
        nextNoteIndex < scheduledNotes.length &&
        scheduledNotes[nextNoteIndex]!.start <= playbackTime
      ) {
        const note = scheduledNotes[nextNoteIndex]!
        const piano = this.pianos.get(note.track)
        nextNoteIndex += 1

        if (!piano?.loaded) {
          continue
        }

        piano.keyDown({
          midi: note.pitch,
          time: toneNow(),
          velocity: Math.min(
            Math.max(note.velocity * 0.86 + 0.07, 0.05),
            0.93,
          ),
        })

        const heldDuration = Math.max(
          0.08,
          (note.end - Math.max(note.start, startAt)) / playbackRate,
        )
        const releaseTimer = window.setTimeout(() => {
          this.releaseTimers.delete(releaseTimer)

          if (this.generation === generation) {
            piano.keyUp({
              midi: note.pitch,
              time: toneNow(),
              velocity: 0.55,
            })
          }
        }, heldDuration * 1000)
        this.releaseTimers.add(releaseTimer)
      }

      if (nextNoteIndex >= scheduledNotes.length) {
        this.schedulerTimer = null
        return
      }

      const nextStart = scheduledNotes[nextNoteIndex]!.start
      const delay = Math.max(
        1,
        Math.min(
          16,
          ((nextStart - playbackTime) / playbackRate) * 1000,
        ),
      )
      this.schedulerTimer = window.setTimeout(tick, delay)
    }

    tick()
  }

  cancel() {
    this.generation += 1
    this.schedulerGeneration += 1

    this.clearSchedulerTimer()

    this.releaseTimers.forEach((timer) => window.clearTimeout(timer))
    this.releaseTimers.clear()

    this.pianos.forEach((piano) => {
      piano.stopAll()
    })

    if (this.output) {
      const time = toneNow()
      this.output.gain.cancelScheduledValues(time)
      this.output.gain.setValueAtTime(0.0001, time)
    }
  }

  private clearSchedulerTimer() {
    if (this.schedulerTimer === null) {
      return
    }

    window.clearTimeout(this.schedulerTimer)
    this.schedulerTimer = null
  }

  clear() {
    this.cancel()

    if (this.output) {
      this.output.dispose()
      this.output = null
    }

    this.pianos.forEach((piano) => {
      piano.dispose()
    })
    this.pianos.clear()
    this.loadPromise = null
    this.key = ''
  }
}
