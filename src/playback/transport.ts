import { Piano } from '@tonejs/piano/build/piano/Piano'
import {
  Filter,
  Gain,
  getContext as getToneContext,
  now as toneNow,
  start as startTone,
} from 'tone'
import type { MidiNote } from '../midi/noteTypes'
import {
  KEYBOARD_MAX_MIDI,
  KEYBOARD_MIN_MIDI,
  keyboardRangeForOctaveLevel,
} from './keyboardMap'
import { ExternalMidiOutput, type MidiOutputPort } from './midiOutput'
import { TrackPianoBank } from './trackPianoBank'

type TransportState = 'stopped' | 'paused' | 'playing'

export type SoundPreset =
  | 'grandPiano'
  | 'musicBox'

export interface TrackSoundOverride {
  soundPreset: SoundPreset
  gain: number
  naturalMusicBoxDuration?: boolean
}

interface Voice {
  sources: AudioScheduledSourceNode[]
  gains: GainNode[]
}

type KeyboardVoice =
  | {
      kind: 'piano'
      piano: Piano
    }
  | {
      kind: 'webAudio'
      voice: Voice
    }

interface KeyboardPreviewOptions {
  soundPresetOverride?: SoundPreset
  velocity?: number
  useFullPiano?: boolean
  musicBoxGain?: number
  transposeSemitones?: number
}

const LOOKAHEAD_SECONDS = 1.35
const SCHEDULER_MS = 55
const SOUND_SWITCH_SETTLE_SECONDS = 0.05
const MUSIC_BOX_MASTER_GAIN = 2
const NON_GRAND_PRESET_GAIN = 4
const GRAND_PIANO_LOOKAHEAD_SECONDS = 0.72
const GRAND_PIANO_FILTER_FREQUENCY = 6800
const KEYBOARD_NOTE_VELOCITY = 0.76
export const DEFAULT_VOLUME = 0.85
export const MAX_VOLUME = 2
const PIANO_BASE_VOLUME = {
  strings: -7,
  keybed: -23,
  harmonics: -28,
  pedal: -32,
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max)

const volumeToDecibelOffset = (volume: number) =>
  volume <= 0.0001 ? -80 : 20 * Math.log10(volume)

const MUSIC_BOX_BASE_URL =
  'https://gleitz.github.io/midi-js-soundfonts/MusyngKite/music_box-mp3/'
const MUSIC_BOX_MIN_MIDI = 21
const MUSIC_BOX_MAX_MIDI = 108
const MUSIC_BOX_SAMPLE_NAMES = [
  'C',
  'Db',
  'D',
  'Eb',
  'E',
  'F',
  'Gb',
  'G',
  'Ab',
  'A',
  'Bb',
  'B',
]

export const PLAYBACK_RATES = [
  0.25,
  0.5,
  0.6666666666666666,
  0.75,
  1,
  1.3333333333333333,
  1.5,
  2,
  4,
] as const

export type PlaybackRate = (typeof PLAYBACK_RATES)[number]

export const normalizePlaybackRate = (rate: number): PlaybackRate => {
  const closest = PLAYBACK_RATES.reduce((best, candidate) =>
    Math.abs(candidate - rate) < Math.abs(best - rate) ? candidate : best,
  )

  return closest
}

export class MidiTransport {
  readonly revision = 15

  private context: AudioContext | null = null

  private master: GainNode | null = null

  private limiter: DynamicsCompressorNode | null = null

  private notes: MidiNote[] = []

  private visibleTracks = new Set<number>()

  private soundPreset: SoundPreset = 'grandPiano'

  private trackSoundOverrides = new Map<number, TrackSoundOverride>()

  private piano: Piano | null = null

  private pianoLoadPromise: Promise<void> | null = null

  private pianoPreview: Piano | null = null

  private pianoPreviewLoadPromise: Promise<void> | null = null

  private keyboardPianos = new Map<string, Piano>()

  private keyboardPianoLoadPromises = new Map<string, Promise<void>>()

  private keyboardPianoGeneration = 0

  private pianoToneFilter: Filter | null = null

  private pianoOutputGate: Gain | null = null

  private pianoRangeKey = ''

  private pianoGeneration = 0

  private trackPianoBank: TrackPianoBank | null = null

  private musicBoxBuffers = new Map<string, AudioBuffer>()

  private musicBoxLoadPromises = new Map<string, Promise<AudioBuffer | null>>()

  private failedMusicBoxSamples = new Set<string>()

  private duration = 0

  private state: TransportState = 'stopped'

  private position = 0

  private basePosition = 0

  private startedAt = 0

  private playbackRate: PlaybackRate = 1

  private volume = DEFAULT_VOLUME

  private pieceGain = 1

  private pianoOutputOpen = false

  private nextNoteIndex = 0

  private schedulerId: number | null = null

  private activeVoices: Voice[] = []

  private keyboardHeldPitches = new Set<number>()

  private keyboardVoices = new Map<number, KeyboardVoice>()

  private externalMidiOutput = new ExternalMidiOutput()

  private resumeAfterSeek = false

  private readonly onEnded: (time: number) => void

  constructor(onEnded: (time: number) => void) {
    this.onEnded = onEnded
  }

  load(notes: MidiNote[], duration: number, visibleTracks: ReadonlySet<number>) {
    this.stop()
    this.notes = [...notes].sort((a, b) => a.start - b.start)
    this.duration = duration
    this.visibleTracks = new Set(visibleTracks)
    this.position = 0
    this.basePosition = 0
    this.nextNoteIndex = 0

    const nextRangeKey = this.getPianoRange().key

    if (this.pianoRangeKey && this.pianoRangeKey !== nextRangeKey) {
      this.resetPiano()
    }
  }

  setVisibleTracks(visibleTracks: ReadonlySet<number>) {
    this.visibleTracks = new Set(visibleTracks)
  }

  getMidiOutputPorts(): Promise<MidiOutputPort[]> {
    return this.externalMidiOutput.listPorts()
  }

  selectMidiOutput(id: string | null): Promise<MidiOutputPort[]> {
    return this.externalMidiOutput.selectPort(id)
  }

  setSoundPreset(soundPreset: SoundPreset) {
    if (soundPreset === this.soundPreset) {
      return
    }

    const wasPlaying = this.state === 'playing'
    const currentTime = this.getCurrentTime()
    const externalMidiSelected = this.externalMidiOutput.hasSelectedPort()

    this.releaseKeyboardNotes()

    if (wasPlaying) {
      this.clearScheduler()
      this.stopActiveVoices()
    }

    this.soundPreset = soundPreset
    if (
      wasPlaying &&
      soundPreset === 'grandPiano' &&
      !externalMidiSelected
    ) {
      this.openPianoOutput()
    }
    this.applyMasterGain(
      wasPlaying ? SOUND_SWITCH_SETTLE_SECONDS : 0,
    )

    if (
      wasPlaying &&
      soundPreset === 'musicBox' &&
      !externalMidiSelected
    ) {
      void this.ensureMusicBoxLoaded(this.notesForSoundPreset('musicBox')).then(() => {
        if (
          this.state !== 'playing' ||
          this.soundPreset !== 'musicBox' ||
          !this.context
        ) {
          return
        }

        const resumedTime = this.getCurrentTime()
        this.position = resumedTime
        this.basePosition = resumedTime
        this.startedAt = this.context.currentTime
        this.nextNoteIndex = this.findNextNoteIndex(resumedTime)
        this.tickScheduler()
        this.schedulerId = window.setInterval(() => {
          this.tickScheduler()
        }, SCHEDULER_MS)
      })
    } else if (wasPlaying && this.context) {
      this.position = currentTime
      this.basePosition = currentTime
      this.startedAt = this.context.currentTime
      this.nextNoteIndex = this.findNextNoteIndex(currentTime)
      this.tickScheduler()
      this.schedulerId = window.setInterval(() => {
        this.tickScheduler()
      }, SCHEDULER_MS)
    }

    if (!externalMidiSelected) {
      this.preloadCurrentSound()
    }
  }

  setTrackSoundOverrides(
    trackSoundOverrides: ReadonlyMap<number, TrackSoundOverride>,
  ) {
    this.trackSoundOverrides = new Map(trackSoundOverrides)
  }

  preloadCurrentSound() {
    if (this.externalMidiOutput.hasSelectedPort()) {
      return
    }

    if (this.hasSoundPreset('grandPiano')) {
      void this.ensurePianoLoaded()
    }

    if (this.hasSoundPreset('musicBox')) {
      void this.ensureMusicBoxLoaded(this.notesForSoundPreset('musicBox'))
    }

  }

  async preparePractice() {
    const context = this.ensureContext()
    await context.resume()

    if (this.externalMidiOutput.hasSelectedPort()) {
      return
    }

    if (this.hasSoundPreset('grandPiano')) {
      await startTone()
      await this.ensurePianoLoaded()
    }

    if (this.hasSoundPreset('musicBox')) {
      await this.ensureMusicBoxLoaded(this.notesForSoundPreset('musicBox'))
    }

  }

  async playPracticeNotes(
    notes: readonly MidiNote[],
    startAt: number,
    endAt: number,
  ) {
    await this.preparePractice()

    if (this.hasSoundPreset('grandPiano')) {
      this.openPianoOutput()
    }

    const context = this.context

    if (!context || endAt <= startAt) {
      return
    }

    const audioStart = context.currentTime +
      (this.hasTrackSoundOverride('musicBox') ? 0 : 0.025)

    notes.forEach((note) => {
      if (note.start >= startAt && note.start < endAt) {
        this.scheduleNote(note, startAt, audioStart)
      }
    })
  }

  async prepareTrackPianoBank(notes: readonly MidiNote[]) {
    if (this.externalMidiOutput.hasSelectedPort()) {
      return
    }

    if (this.soundPreset === 'musicBox') {
      await this.ensureMusicBoxLoaded(notes)
      return
    }

    const context = this.ensureContext()
    await context.resume()
    await startTone()

    if (!this.trackPianoBank) {
      this.trackPianoBank = new TrackPianoBank(this.getPianoToneFilter())
    }

    const range = this.getPianoRange()
    await this.trackPianoBank.prepare(notes, range, this.getPianoVolumes())
  }

  playTrackPianoBank(
    notes: readonly MidiNote[],
    startAt: number,
    endAt: number,
  ) {
    const externalMidiSelected = this.externalMidiOutput.hasSelectedPort()

    notes.forEach((note) => {
      if (note.start >= startAt && note.start < endAt) {
        this.externalMidiOutput.scheduleNote(
          note,
          startAt,
          this.playbackRate,
        )
      }
    })

    if (externalMidiSelected) {
      return
    }

    if (this.soundPreset === 'musicBox') {
      const context = this.context
      const master = this.master

      if (!context || !master) {
        return
      }

      notes.forEach((note) => {
        if (note.start >= startAt && note.start < endAt) {
          this.scheduleMusicBoxNote(
            note,
            startAt,
            context.currentTime + 0.025,
            context,
            master,
            this.getNoteSoundGain(note, 'musicBox'),
          )
        }
      })
      return
    }

    this.openPianoOutput()
    this.trackPianoBank?.schedule(
      notes,
      startAt,
      endAt,
      this.playbackRate,
    )
  }

  clearTrackPianoBank() {
    this.trackPianoBank?.clear()
    this.trackPianoBank = null
  }

  cancelTrackPianoBank() {
    this.trackPianoBank?.cancel()
  }

  setPlaybackRate(playbackRate: PlaybackRate) {
    const nextRate = normalizePlaybackRate(playbackRate)

    if (nextRate === this.playbackRate) {
      return
    }

    const wasPlaying = this.state === 'playing'
    const currentTime = this.getCurrentTime()

    this.playbackRate = nextRate
    this.position = currentTime
    this.basePosition = currentTime
    this.nextNoteIndex = this.findNextNoteIndex(currentTime)

    if (!wasPlaying || !this.context) {
      return
    }

    this.startedAt = this.context.currentTime
    this.clearScheduler()
    this.stopActiveVoices()
    if (this.hasSoundPreset('grandPiano')) {
      this.openPianoOutput()
    }
    this.tickScheduler()
    this.schedulerId = window.setInterval(() => {
      this.tickScheduler()
    }, SCHEDULER_MS)
  }

  setVolume(volume: number) {
    this.volume = clamp(
      Number.isFinite(volume) ? volume : DEFAULT_VOLUME,
      0,
      MAX_VOLUME,
    )

    if (this.context && this.master) {
      this.applyMasterGain()
    }

    this.applyPianoVolume()
  }

  setPieceGain(pieceGain: number) {
    this.pieceGain = clamp(
      Number.isFinite(pieceGain) ? pieceGain : 1,
      0,
      1,
    )

    if (this.context && this.master) {
      this.applyMasterGain()
    }

    if (this.pianoOutputGate && this.pianoOutputOpen) {
      const time = toneNow()
      this.pianoOutputGate.gain.cancelScheduledValues(time)
      this.pianoOutputGate.gain.setTargetAtTime(this.pieceGain, time, 0.015)
    }

  }

  getCurrentTime() {
    if (this.state !== 'playing' || !this.context) {
      return this.position
    }

    return clamp(
      this.basePosition +
        (this.context.currentTime - this.startedAt) * this.playbackRate,
      0,
      this.duration,
    )
  }

  async play(startAt = this.position) {
    const context = this.ensureContext()
    await context.resume()
    const externalMidiSelected = this.externalMidiOutput.hasSelectedPort()

    if (!externalMidiSelected && this.hasSoundPreset('grandPiano')) {
      await startTone()
      await this.ensurePianoLoaded()
    }

    if (!externalMidiSelected && this.hasSoundPreset('musicBox')) {
      await this.ensureMusicBoxLoaded(this.notesForSoundPreset('musicBox'))
    }

    this.clearScheduler()
    this.releaseKeyboardNotes()
    this.stopActiveVoices()
    if (!externalMidiSelected && this.hasSoundPreset('grandPiano')) {
      this.openPianoOutput()
    }
    this.state = 'playing'
    this.position = clamp(startAt, 0, this.duration)
    this.basePosition = this.position
    this.startedAt = context.currentTime
    this.nextNoteIndex = this.findNextNoteIndex(this.position)
    this.tickScheduler()
    this.schedulerId = window.setInterval(() => {
      this.tickScheduler()
    }, SCHEDULER_MS)
  }

  pause() {
    this.position = this.getCurrentTime()
    this.state = 'paused'
    this.clearScheduler()
    this.stopActiveVoices()
  }

  stop() {
    this.position = 0
    this.basePosition = 0
    this.state = 'stopped'
    this.nextNoteIndex = 0
    this.clearScheduler()
    this.stopActiveVoices()
  }

  beginSeek(options: { preserveMainPiano?: boolean } = {}) {
    this.resumeAfterSeek = this.state === 'playing'
    this.position = this.getCurrentTime()
    this.basePosition = this.position
    this.state = 'paused'
    this.clearScheduler()
    this.silenceScheduledPlayback(options.preserveMainPiano ?? false)
  }

  async finishSeek(time: number, resumePlayback = this.resumeAfterSeek) {
    const nextTime = clamp(time, 0, this.duration)
    this.position = nextTime
    this.basePosition = nextTime
    this.nextNoteIndex = this.findNextNoteIndex(nextTime)
    this.resumeAfterSeek = false

    if (resumePlayback) {
      await this.play(nextTime)
    }
  }

  seek(time: number) {
    const nextTime = clamp(time, 0, this.duration)

    if (this.state === 'playing') {
      void this.play(nextTime)
      return
    }

    this.position = nextTime
    this.basePosition = nextTime
    this.nextNoteIndex = this.findNextNoteIndex(nextTime)
  }

  async previewKeyDown(
    pitch: number,
    octaveLevel = 3,
    options: KeyboardPreviewOptions = {},
  ) {
    const safePitch = Math.round(
      clamp(pitch, KEYBOARD_MIN_MIDI, KEYBOARD_MAX_MIDI),
    )

    if (this.state === 'playing' || this.keyboardHeldPitches.has(safePitch)) {
      return
    }

    this.keyboardHeldPitches.add(safePitch)
    this.externalMidiOutput.noteOn(
      safePitch,
      options.velocity ?? KEYBOARD_NOTE_VELOCITY,
    )

    if (this.externalMidiOutput.hasSelectedPort()) {
      return
    }

    try {
      const context = this.ensureContext()
      await context.resume()

      if (!this.isKeyboardPitchHeld(safePitch)) {
        return
      }

      const master = this.master

      if (!master) {
        return
      }

      if (options.soundPresetOverride === 'musicBox') {
        const sample = this.getMusicBoxSample(safePitch)
        await this.loadMusicBoxSample(sample.name, context)

        if (!this.isKeyboardPitchHeld(safePitch)) {
          return
        }

        const voice = this.scheduleMusicBoxNote(
          {
            id: `keyboard:${safePitch}`,
            pitch: safePitch,
            start: 0,
            duration: 4,
            velocity: options.velocity ?? KEYBOARD_NOTE_VELOCITY,
            track: -1,
            trackName: '',
            role: 'melody',
            end: 4,
          },
          0,
          context.currentTime,
          context,
          master,
          this.getSoundPresetGain('musicBox') * (options.musicBoxGain ?? 1),
          true,
        )

        if (voice) {
          this.keyboardVoices.set(safePitch, { kind: 'webAudio', voice })
        }
        return
      }

      await startTone()

      if (!this.isKeyboardPitchHeld(safePitch)) {
        return
      }

      const piano =
        options.useFullPiano && this.piano?.loaded
          ? this.piano
          : await this.getKeyboardPiano(
              this.getKeyboardPianoRange(
                octaveLevel,
                options.transposeSemitones,
              ),
            )

      if (!piano || !this.isKeyboardPitchHeld(safePitch)) {
        return
      }

      this.openPianoOutput()
      piano.keyDown({
        midi: safePitch,
        time: toneNow(),
        velocity: options.velocity ?? KEYBOARD_NOTE_VELOCITY,
      })
      this.keyboardVoices.set(safePitch, { kind: 'piano', piano })
    } catch {
      this.previewKeyUp(safePitch)
    }
  }

  previewKeyUp(pitch: number) {
    const safePitch = Math.round(
      clamp(pitch, KEYBOARD_MIN_MIDI, KEYBOARD_MAX_MIDI),
    )
    this.keyboardHeldPitches.delete(safePitch)
    this.externalMidiOutput.noteOff(safePitch)

    const voice = this.keyboardVoices.get(safePitch)

    if (!voice) {
      return
    }

    this.keyboardVoices.delete(safePitch)

    if (voice.kind === 'piano') {
      voice.piano.keyUp({
        midi: safePitch,
        time: toneNow(),
        velocity: 0.55,
      })
      return
    }

    this.releaseVoice(voice.voice)
  }

  releaseKeyboardNotes() {
    const heldPitches = new Set([
      ...this.keyboardHeldPitches,
      ...this.keyboardVoices.keys(),
    ])

    heldPitches.forEach((pitch) => this.previewKeyUp(pitch))
    this.keyboardHeldPitches.clear()
  }

  prepareKeyboardOctave(octaveLevel: number, transposeSemitones = 0) {
    return this.ensureKeyboardPianoLoaded(
      this.getKeyboardPianoRange(octaveLevel, transposeSemitones),
    )
  }

  async prepareKeyboardOctaves(
    octaveLevels: readonly number[],
    transposeSemitones = 0,
  ) {
    await Promise.all(
      [...new Set(octaveLevels)].map((octaveLevel) =>
        this.prepareKeyboardOctave(octaveLevel, transposeSemitones),
      ),
    )
  }

  private ensureContext() {
    if (this.context) {
      return this.context
    }

    this.context = new AudioContext()
    this.master = this.context.createGain()
    this.limiter = this.context.createDynamicsCompressor()
    this.limiter.threshold.value = -1
    this.limiter.knee.value = 8
    this.limiter.ratio.value = 16
    this.limiter.attack.value = 0.005
    this.limiter.release.value = 0.1
    this.master.gain.value = this.getMasterGain()
    this.master.connect(this.limiter)
    this.limiter.connect(this.context.destination)
    return this.context
  }

  private findNextNoteIndex(time: number) {
    const index = this.notes.findIndex((note) => note.end >= time)
    return index === -1 ? this.notes.length : index
  }

  private tickScheduler() {
    const context = this.context

    if (!context || this.state !== 'playing') {
      return
    }

    const currentTime = this.getCurrentTime()

    if (currentTime >= this.duration) {
      this.finish()
      this.onEnded(this.duration)
      return
    }

    const horizon =
      currentTime +
      (this.hasSoundPreset('grandPiano')
        ? GRAND_PIANO_LOOKAHEAD_SECONDS
        : LOOKAHEAD_SECONDS) *
        this.playbackRate

    while (
      this.nextNoteIndex < this.notes.length &&
      this.notes[this.nextNoteIndex].start <= horizon
    ) {
      const note = this.notes[this.nextNoteIndex]

      if (note.end >= currentTime && this.visibleTracks.has(note.track)) {
        this.scheduleNote(note, currentTime, context.currentTime)
      }

      this.nextNoteIndex += 1
    }
  }

  private scheduleNote(
    note: MidiNote,
    playbackTime: number,
    audioTime: number,
  ) {
    this.externalMidiOutput.scheduleNote(
      note,
      playbackTime,
      this.playbackRate,
    )

    if (this.externalMidiOutput.hasSelectedPort()) {
      return
    }

    const soundPreset = this.getSoundPreset(note)

    const context = this.context
    const master = this.master

    if (!context || !master) {
      return
    }

    if (soundPreset === 'musicBox') {
      this.scheduleMusicBoxNote(
        note,
        playbackTime,
        audioTime,
        context,
        master,
        this.getNoteSoundGain(note, soundPreset),
        this.trackSoundOverrides.get(note.track)?.naturalMusicBoxDuration ??
          false,
      )
      return
    }

    if (soundPreset === 'grandPiano') {
      const piano = this.piano?.loaded ? this.piano : null

      if (piano) {
        this.scheduleGrandPianoNote(piano, note, playbackTime)
      }
    }
  }

  private getPianoRange() {
    const pitches =
      this.notes.length > 0 ? this.notes.map((note) => note.pitch) : [60]
    const minPitch = Math.min(...pitches)
    const maxPitch = Math.max(...pitches)
    const minNote = Math.max(21, minPitch - 3)
    const maxNote = Math.min(108, maxPitch + 3)

    return {
      key: `${minNote}-${maxNote}`,
      minNote,
      maxNote,
    }
  }

  private async ensurePianoLoaded() {
    if (this.notes.length === 0) {
      return
    }

    const range = this.getPianoRange()

    if (this.piano?.loaded && this.pianoRangeKey === range.key) {
      return
    }

    if (this.pianoLoadPromise && this.pianoRangeKey === range.key) {
      try {
        await this.pianoLoadPromise
      } catch {
      }
      return
    }

    if (this.pianoRangeKey && this.pianoRangeKey !== range.key) {
      this.resetPiano()
    }

    const previewReady = await this.ensurePianoPreviewLoaded(range)

    if (!previewReady || this.getPianoRange().key !== range.key) {
      return
    }

    if (this.piano?.loaded && this.pianoRangeKey === range.key) {
      return
    }

    if (this.pianoLoadPromise && this.pianoRangeKey === range.key) {
      try {
        await this.pianoLoadPromise
      } catch {
      }
      return
    }

    const generation = this.pianoGeneration
    const piano = this.createPiano(range, 5, true)
    const loadPromise = piano.load()

    this.piano = piano
    this.pianoLoadPromise = loadPromise

    try {
      await loadPromise
    } catch {
      if (this.piano === piano) {
        piano.dispose()
        this.piano = null
      }
    } finally {
      if (
        this.pianoGeneration === generation &&
        this.pianoLoadPromise === loadPromise
      ) {
        this.pianoLoadPromise = null
      }
    }
  }

  private async ensurePianoPreviewLoaded(range = this.getPianoRange()) {
    if (this.notes.length === 0) {
      return false
    }

    if (this.pianoPreview?.loaded && this.pianoRangeKey === range.key) {
      return true
    }

    if (this.pianoPreviewLoadPromise && this.pianoRangeKey === range.key) {
      try {
        await this.pianoPreviewLoadPromise
      } catch {
        return false
      }
      return Boolean(this.pianoPreview?.loaded)
    }

    if (this.pianoRangeKey && this.pianoRangeKey !== range.key) {
      this.resetPiano()
    }

    this.pianoRangeKey = range.key
    const generation = this.pianoGeneration
    const piano = this.createPiano(range, 1, false)
    const loadPromise = piano.load()

    this.pianoPreview = piano
    this.pianoPreviewLoadPromise = loadPromise

    try {
      await loadPromise
      return this.pianoGeneration === generation && this.pianoPreview === piano
    } catch {
      if (this.pianoPreview === piano) {
        piano.dispose()
        this.pianoPreview = null
      }

      return false
    } finally {
      if (
        this.pianoGeneration === generation &&
        this.pianoPreviewLoadPromise === loadPromise
      ) {
        this.pianoPreviewLoadPromise = null
      }
    }
  }

  private getKeyboardPianoRange(
    octaveLevel: number,
    transposeSemitones = 0,
  ) {
    const range = keyboardRangeForOctaveLevel(
      octaveLevel,
      transposeSemitones,
    )
    const minNote = Math.max(21, range.min - 3)
    const maxNote = Math.min(108, range.max + 3)

    return {
      key: `${minNote}-${maxNote}`,
      minNote,
      maxNote,
    }
  }

  private async getKeyboardPiano(
    range: ReturnType<MidiTransport['getKeyboardPianoRange']>,
  ) {
    const loaded = await this.ensureKeyboardPianoLoaded(range)
    const piano = this.keyboardPianos.get(range.key)

    return loaded && piano?.loaded ? piano : null
  }

  private async ensureKeyboardPianoLoaded(
    range: ReturnType<MidiTransport['getKeyboardPianoRange']>,
  ) {
    const existingPiano = this.keyboardPianos.get(range.key)

    if (existingPiano?.loaded) {
      return true
    }

    const existingLoadPromise = this.keyboardPianoLoadPromises.get(range.key)

    if (existingLoadPromise) {
      try {
        await existingLoadPromise
      } catch {
        return false
      }

      return Boolean(this.keyboardPianos.get(range.key)?.loaded)
    }

    const generation = this.keyboardPianoGeneration
    const piano = this.createPiano(range, 1, false)
    const loadPromise = piano.load()

    this.keyboardPianos.set(range.key, piano)
    this.keyboardPianoLoadPromises.set(range.key, loadPromise)

    try {
      await loadPromise
      return (
        this.keyboardPianoGeneration === generation &&
        this.keyboardPianos.get(range.key) === piano
      )
    } catch {
      if (this.keyboardPianos.get(range.key) === piano) {
        piano.dispose()
        this.keyboardPianos.delete(range.key)
      }

      return false
    } finally {
      if (
        this.keyboardPianoGeneration === generation &&
        this.keyboardPianoLoadPromises.get(range.key) === loadPromise
      ) {
        this.keyboardPianoLoadPromises.delete(range.key)
      }
    }
  }

  private createPiano(
    range: ReturnType<MidiTransport['getPianoRange']>,
    velocities: number,
    release: boolean,
  ) {
    const piano = new Piano({
      velocities,
      minNote: range.minNote,
      maxNote: range.maxNote,
      release,
      pedal: false,
      maxPolyphony: 64,
      volume: this.getPianoVolumes(),
    })

    piano.connect(this.getPianoToneFilter())
    return piano
  }

  private getPianoToneFilter() {
    if (this.pianoToneFilter) {
      return this.pianoToneFilter
    }

    this.pianoToneFilter = new Filter({
      type: 'lowpass',
      frequency: GRAND_PIANO_FILTER_FREQUENCY,
      Q: 0.16,
      rolloff: -12,
    })
    this.pianoToneFilter.connect(this.getPianoOutputGate())

    return this.pianoToneFilter
  }

  private getPianoOutputGate() {
    if (this.pianoOutputGate) {
      return this.pianoOutputGate
    }

    this.pianoOutputGate = new Gain(1).toDestination()
    return this.pianoOutputGate
  }

  private openPianoOutput() {
    if (!this.pianoOutputGate) {
      return
    }

    const time = toneNow()
    this.pianoOutputGate.gain.cancelScheduledValues(time)
    this.pianoOutputGate.gain.setValueAtTime(this.pieceGain, time)
    this.pianoOutputOpen = true
  }

  private closePianoOutput() {
    if (!this.pianoOutputGate) {
      return
    }

    const time = toneNow()
    this.pianoOutputGate.gain.cancelScheduledValues(time)
    this.pianoOutputGate.gain.setTargetAtTime(0.0001, time, 0.006)
    this.pianoOutputOpen = false
  }

  private silenceScheduledPlayback(preserveMainPiano: boolean) {
    const contextTime = this.context?.currentTime ?? 0

    if (this.pianoOutputGate) {
      const time = toneNow()
      this.pianoOutputGate.gain.cancelScheduledValues(time)
      this.pianoOutputGate.gain.setValueAtTime(0.0001, time)
      this.pianoOutputOpen = false
    }

    this.releaseKeyboardNotes()
    this.externalMidiOutput.stopAll()
    if (!preserveMainPiano) {
      this.discardPianoForSeek()
    }
    this.cancelTrackPianoBank()

    this.activeVoices.forEach((voice) => {
      voice.gains.forEach((gain) => {
        gain.gain.cancelScheduledValues(contextTime)
        gain.gain.setValueAtTime(0.0001, contextTime)
      })

      voice.sources.forEach((source) => {
        try {
          source.stop(contextTime)
        } catch {
        }
      })
    })

    this.activeVoices = []
  }

  private discardPianoForSeek() {
    this.pianoGeneration += 1
    this.piano?.dispose()
    this.pianoPreview?.dispose()
    this.piano = null
    this.pianoLoadPromise = null
    this.pianoPreview = null
    this.pianoPreviewLoadPromise = null
  }

  private resetPiano() {
    this.releaseKeyboardNotes()
    this.resetKeyboardPiano()
    this.piano?.stopAll()
    this.pianoPreview?.stopAll()
    this.discardScheduledPiano()
  }

  private discardScheduledPiano() {
    this.clearTrackPianoBank()
    this.pianoGeneration += 1
    this.piano?.dispose()
    this.pianoPreview?.dispose()
    this.piano = null
    this.pianoLoadPromise = null
    this.pianoPreview = null
    this.pianoPreviewLoadPromise = null
    this.pianoToneFilter?.dispose()
    this.pianoToneFilter = null
    this.pianoOutputGate?.dispose()
    this.pianoOutputGate = null
    this.pianoRangeKey = ''
  }

  private resetKeyboardPiano() {
    this.keyboardPianoGeneration += 1
    this.keyboardPianos.forEach((piano) => {
      piano.stopAll()
      piano.dispose()
    })
    this.keyboardPianos.clear()
    this.keyboardPianoLoadPromises.clear()
  }

  private getSoundPreset(note: MidiNote) {
    return this.trackSoundOverrides.get(note.track)?.soundPreset ??
      this.soundPreset
  }

  private hasSoundPreset(soundPreset: SoundPreset) {
    return this.notes.some(
      (note) => this.getSoundPreset(note) === soundPreset,
    )
  }

  private hasTrackSoundOverride(soundPreset: SoundPreset) {
    return [...this.trackSoundOverrides.values()].some(
      (override) => override.soundPreset === soundPreset,
    )
  }

  private notesForSoundPreset(soundPreset: SoundPreset) {
    return this.notes.filter(
      (note) => this.getSoundPreset(note) === soundPreset,
    )
  }

  private getSoundPresetGain(soundPreset: SoundPreset) {
    return this.getSoundPresetBaseGain(soundPreset) /
      this.getSoundPresetBaseGain(this.soundPreset)
  }

  private getNoteSoundGain(note: MidiNote, soundPreset: SoundPreset) {
    const overrideGain = this.trackSoundOverrides.get(note.track)?.gain ?? 1

    return this.getSoundPresetGain(soundPreset) * overrideGain
  }

  private getSoundPresetBaseGain(soundPreset: SoundPreset) {
    return soundPreset === 'musicBox'
      ? MUSIC_BOX_MASTER_GAIN * NON_GRAND_PRESET_GAIN
      : 1
  }

  private getMasterGain() {
    return this.getSoundPresetBaseGain(this.soundPreset) *
      this.volume *
      this.pieceGain
  }

  private applyMasterGain(delaySeconds = 0) {
    if (!this.context || !this.master) {
      return
    }

    const contextTime = this.context.currentTime

    this.master.gain.cancelScheduledValues(contextTime)
    this.master.gain.setTargetAtTime(
      this.getMasterGain(),
      contextTime + delaySeconds,
      0.015,
    )
  }

  private getPianoVolumes() {
    const offset = volumeToDecibelOffset(this.volume)

    return {
      strings: PIANO_BASE_VOLUME.strings + offset,
      keybed: PIANO_BASE_VOLUME.keybed + offset,
      harmonics: PIANO_BASE_VOLUME.harmonics + offset,
      pedal: PIANO_BASE_VOLUME.pedal + offset,
    }
  }

  private applyPianoVolume() {
    const volumes = this.getPianoVolumes()
    const pianos = [
      this.piano,
      this.pianoPreview,
      ...this.keyboardPianos.values(),
    ]

    pianos.forEach((piano) => {
      if (!piano) {
        return
      }

      piano.strings.value = volumes.strings
      piano.keybed.value = volumes.keybed
      piano.harmonics.value = volumes.harmonics
      piano.pedal.value = volumes.pedal
    })
  }

  private getMusicBoxSample(pitch: number) {
    const samplePitch = Math.round(
      clamp(pitch, MUSIC_BOX_MIN_MIDI, MUSIC_BOX_MAX_MIDI),
    )
    const noteName = MUSIC_BOX_SAMPLE_NAMES[samplePitch % 12]
    const octave = Math.floor(samplePitch / 12) - 1

    return {
      name: `${noteName}${octave}`,
      playbackRatio: 2 ** ((pitch - samplePitch) / 12),
    }
  }

  private async loadMusicBoxSample(
    sampleName: string,
    context = this.ensureContext(),
  ) {
    const loaded = this.musicBoxBuffers.get(sampleName)

    if (loaded) {
      return loaded
    }

    const pending = this.musicBoxLoadPromises.get(sampleName)

    if (pending) {
      return pending
    }

    const promise = fetch(`${MUSIC_BOX_BASE_URL}${sampleName}.mp3`)
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Could not load music box sample ${sampleName}.`)
        }

        return response.arrayBuffer()
      })
      .then((buffer) => context.decodeAudioData(buffer))
      .then((buffer) => {
        this.musicBoxBuffers.set(sampleName, buffer)
        this.failedMusicBoxSamples.delete(sampleName)
        return buffer
      })
      .catch(() => {
        this.failedMusicBoxSamples.add(sampleName)
        return null
      })
      .finally(() => {
        this.musicBoxLoadPromises.delete(sampleName)
      })

    this.musicBoxLoadPromises.set(sampleName, promise)
    return promise
  }

  private async ensureMusicBoxLoaded(notes: readonly MidiNote[] = this.notes) {
    const context = this.ensureContext()
    const sampleNames = [
      ...new Set(notes.map((note) => this.getMusicBoxSample(note.pitch).name)),
    ]

    await Promise.allSettled(
      sampleNames.map((sampleName) =>
        this.loadMusicBoxSample(sampleName, context),
      ),
    )
  }

  private scheduleGrandPianoNote(
    piano: Piano,
    note: MidiNote,
    playbackTime: number,
  ) {
    const offset = Math.max(0, note.start - playbackTime) / this.playbackRate
    const startAt = toneNow() + offset
    const heldDuration = Math.max(
      0.08,
      (note.end - Math.max(note.start, playbackTime)) / this.playbackRate,
    )
    const releaseAt = startAt + heldDuration

    piano.keyDown({
      midi: note.pitch,
      time: startAt,
      velocity: clamp(note.velocity * 0.86 + 0.07, 0.05, 0.93),
    })
    piano.keyUp({
      midi: note.pitch,
      time: releaseAt,
      velocity: 0.55,
    })
  }

  private scheduleMusicBoxNote(
    note: MidiNote,
    playbackTime: number,
    audioTime: number,
    context: AudioContext,
    master: GainNode,
    gainMultiplier = 1,
    naturalDurationOnly = false,
  ): Voice | null {
    {
      const sample = this.getMusicBoxSample(note.pitch)
      const buffer = this.musicBoxBuffers.get(sample.name)

      if (buffer) {
        const startAt = this.getWebAudioScheduledTime(
          audioTime,
          note.start,
          playbackTime,
          naturalDurationOnly,
        )
        const source = context.createBufferSource()
        const gain = context.createGain()
        const velocityLevel = 0.28 + note.velocity * 0.72
        const roleLevel =
          note.role === 'bass' ? 0.44 : note.role === 'melody' ? 0.52 : 0.42
        const level = roleLevel * velocityLevel * gainMultiplier
        const naturalDuration = buffer.duration / sample.playbackRatio
        const scaledDuration = note.duration / this.playbackRate
        const stopAt =
          startAt +
          (naturalDurationOnly
            ? naturalDuration
            : Math.min(
                naturalDuration,
                Math.max(0.65, scaledDuration + 1.8),
              ))

        source.buffer = buffer
        source.playbackRate.setValueAtTime(sample.playbackRatio, startAt)
        gain.gain.setValueAtTime(0.0001, startAt)
        gain.gain.linearRampToValueAtTime(level, startAt + 0.008)
        gain.gain.setValueAtTime(level, Math.max(startAt + 0.01, stopAt - 0.08))
        gain.gain.exponentialRampToValueAtTime(0.0001, stopAt)
        source.connect(gain)
        gain.connect(master)
        source.start(startAt)
        source.stop(stopAt + 0.03)

        const voice = { sources: [source], gains: [gain] }
        this.activeVoices.push(voice)
        source.onended = () => {
          this.cleanupVoice(voice)
        }
        return voice
      }

      if (!this.failedMusicBoxSamples.has(sample.name)) {
        void this.loadMusicBoxSample(sample.name, context)
      }
    }

    return null
  }

  private isKeyboardPitchHeld(pitch: number) {
    return this.state !== 'playing' && this.keyboardHeldPitches.has(pitch)
  }

  private getWebAudioScheduledTime(
    audioTime: number,
    noteStart: number,
    playbackTime: number,
    alignWithTone = false,
  ) {
    return audioTime +
      (alignWithTone ? getToneContext().lookAhead : 0) +
      Math.max(0, noteStart - playbackTime) / this.playbackRate
  }

  private cleanupVoice(voice: Voice) {
    voice.gains.forEach((gain) => {
      try {
        gain.disconnect()
      } catch {
      }
    })
    this.activeVoices = this.activeVoices.filter((item) => item !== voice)
  }

  private releaseVoice(voice: Voice) {
    const contextTime = this.context?.currentTime ?? 0

    voice.gains.forEach((gain) => {
      gain.gain.cancelScheduledValues(contextTime)
      gain.gain.setTargetAtTime(0.0001, contextTime, 0.012)
    })

    voice.sources.forEach((source) => {
      try {
        source.stop(contextTime + 0.08)
      } catch {
      }
    })
  }

  private clearScheduler() {
    if (this.schedulerId === null) {
      return
    }

    window.clearInterval(this.schedulerId)
    this.schedulerId = null
  }

  private finish() {
    this.position = this.duration
    this.basePosition = this.duration
    this.state = 'stopped'
    this.nextNoteIndex = this.notes.length
    this.clearScheduler()
    this.stopActiveVoices()
  }

  private stopActiveVoices() {
    const contextTime = this.context?.currentTime ?? 0

    this.releaseKeyboardNotes()
    this.externalMidiOutput.stopAll()
    this.closePianoOutput()

    this.piano?.stopAll()
    this.pianoPreview?.stopAll()
    this.keyboardPianos.forEach((piano) => piano.stopAll())

    this.activeVoices.forEach((voice) => {
      voice.gains.forEach((gain) => {
        gain.gain.cancelScheduledValues(contextTime)
        gain.gain.setTargetAtTime(0.0001, contextTime, 0.008)
      })

      voice.sources.forEach((source) => {
        try {
          source.stop(contextTime + 0.06)
        } catch {
        }
      })
    })

    this.activeVoices = []
  }
}
