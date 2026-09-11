import { Piano } from '@tonejs/piano/build/piano/Piano'
import { Filter, Gain, now as toneNow, start as startTone } from 'tone'
import type { MidiNote } from '../midi/noteTypes'
import {
  KEYBOARD_MAX_MIDI,
  KEYBOARD_MIN_MIDI,
  keyboardRangeForOctaveLevel,
} from './keyboardMap'
import {
  getOcarinaGainProfile,
  getSmallPianoVoiceProfile,
} from './soundProfiles'

type TransportState = 'stopped' | 'paused' | 'playing'

export type SoundPreset =
  | 'grandPiano'
  | 'harmonicPiano'
  | 'ocarina'
  | 'musicBox'

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

const LOOKAHEAD_SECONDS = 1.35
const SCHEDULER_MS = 55
const SOUND_SWITCH_SETTLE_SECONDS = 0.05
const OCARINA_MASTER_GAIN = 0.38
const OCARINA_MIN_SAMPLE_MIDI = 24
const OCARINA_MAX_SAMPLE_MIDI = 96
const OCARINA_SAMPLE_INTERVAL = 3
const OCARINA_CLEAR_LOW_SAMPLE_THRESHOLD = 52
const OCARINA_CLEAR_LOW_SAMPLE_OFFSET = 12
const OCARINA_TARGET_RMS = 0.055
const OCARINA_MAX_SAMPLE_NORMALIZATION = 6
const OCARINA_PIANO_THRESHOLD = 72
const SCORE_PIANO_MASTER_GAIN = 1.1
const MUSIC_BOX_MASTER_GAIN = 2
const NON_GRAND_PRESET_GAIN = 4
const SMALL_PIANO_PRESET_GAIN = 1.25
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

const midiToFrequency = (pitch: number) =>
  440 * 2 ** ((pitch - 69) / 12)

const volumeToDecibelOffset = (volume: number) =>
  volume <= 0.0001 ? -80 : 20 * Math.log10(volume)

const getBufferRms = (buffer: AudioBuffer) => {
  let energy = 0
  let sampleCount = 0

  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const samples = buffer.getChannelData(channel)

    for (let index = 0; index < samples.length; index += 1) {
      energy += samples[index] ** 2
    }

    sampleCount += samples.length
  }

  return Math.sqrt(energy / Math.max(sampleCount, 1))
}

const MUSIC_BOX_BASE_URL =
  'https://gleitz.github.io/midi-js-soundfonts/MusyngKite/music_box-mp3/'
const OCARINA_BASE_URL =
  'https://gleitz.github.io/midi-js-soundfonts/MusyngKite/ocarina-mp3/'
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
  1,
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
  private context: AudioContext | null = null

  private master: GainNode | null = null

  private limiter: DynamicsCompressorNode | null = null

  private notes: MidiNote[] = []

  private visibleTracks = new Set<number>()

  private soundPreset: SoundPreset = 'grandPiano'

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

  private musicBoxBuffers = new Map<string, AudioBuffer>()

  private musicBoxLoadPromises = new Map<string, Promise<AudioBuffer | null>>()

  private failedMusicBoxSamples = new Set<string>()

  private ocarinaBuffers = new Map<string, AudioBuffer>()

  private ocarinaSampleNormalizations = new Map<string, number>()

  private ocarinaLoadPromises = new Map<string, Promise<AudioBuffer | null>>()

  private failedOcarinaSamples = new Set<string>()

  private duration = 0

  private state: TransportState = 'stopped'

  private position = 0

  private basePosition = 0

  private startedAt = 0

  private playbackRate: PlaybackRate = 1

  private volume = DEFAULT_VOLUME

  private nextNoteIndex = 0

  private schedulerId: number | null = null

  private activeVoices: Voice[] = []

  private keyboardHeldPitches = new Set<number>()

  private keyboardVoices = new Map<number, KeyboardVoice>()

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

  setSoundPreset(soundPreset: SoundPreset) {
    if (soundPreset === this.soundPreset) {
      return
    }

    const wasPlaying = this.state === 'playing'
    const currentTime = this.getCurrentTime()

    this.releaseKeyboardNotes()

    if (wasPlaying) {
      this.clearScheduler()
      this.stopActiveVoices()
    }

    this.soundPreset = soundPreset
    if (wasPlaying && soundPreset === 'grandPiano') {
      this.openPianoOutput()
    }
    this.applyMasterGain(
      wasPlaying ? SOUND_SWITCH_SETTLE_SECONDS : 0,
    )

    if (wasPlaying && this.context) {
      this.position = currentTime
      this.basePosition = currentTime
      this.startedAt = this.context.currentTime
      this.nextNoteIndex = this.findNextNoteIndex(currentTime)
      this.tickScheduler()
      this.schedulerId = window.setInterval(() => {
        this.tickScheduler()
      }, SCHEDULER_MS)
    }

    if (soundPreset === 'grandPiano' && this.notes.length > 0) {
      void this.ensurePianoLoaded()
    }

    if (soundPreset === 'musicBox' && this.notes.length > 0) {
      void this.ensureMusicBoxLoaded()
    }

    if (soundPreset === 'ocarina' && this.notes.length > 0) {
      void this.ensureOcarinaLoaded()
    }
  }

  preloadCurrentSound() {
    if (this.soundPreset === 'grandPiano' && this.notes.length > 0) {
      void this.ensurePianoLoaded()
    }

    if (this.soundPreset === 'musicBox' && this.notes.length > 0) {
      void this.ensureMusicBoxLoaded()
    }

    if (this.soundPreset === 'ocarina' && this.notes.length > 0) {
      void this.ensureOcarinaLoaded()
    }
  }

  async preparePractice() {
    const context = this.ensureContext()
    await context.resume()

    if (this.soundPreset === 'grandPiano') {
      await startTone()
      await this.ensurePianoLoaded()
    }

    if (this.soundPreset === 'musicBox') {
      await this.ensureMusicBoxLoaded()
    }

    if (this.soundPreset === 'ocarina') {
      await this.ensureOcarinaLoaded()
    }
  }

  async playPracticeNotes(
    notes: readonly MidiNote[],
    startAt: number,
    endAt: number,
  ) {
    await this.preparePractice()

    if (this.soundPreset === 'grandPiano') {
      this.openPianoOutput()
    }

    const context = this.context

    if (!context || endAt <= startAt) {
      return
    }

    const audioStart = context.currentTime + 0.025

    notes.forEach((note) => {
      if (note.start >= startAt && note.start < endAt) {
        this.scheduleNote(note, startAt, audioStart)
      }
    })
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

    if (this.soundPreset === 'grandPiano') {
      await startTone()
      await this.ensurePianoLoaded()
    }

    if (this.soundPreset === 'musicBox') {
      await this.ensureMusicBoxLoaded()
    }

    if (this.soundPreset === 'ocarina') {
      await this.ensureOcarinaLoaded()
    }

    this.clearScheduler()
    this.releaseKeyboardNotes()
    this.stopActiveVoices()
    if (this.soundPreset === 'grandPiano') {
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

  async previewKeyDown(pitch: number, octaveLevel = 3) {
    const safePitch = Math.round(
      clamp(pitch, KEYBOARD_MIN_MIDI, KEYBOARD_MAX_MIDI),
    )

    if (this.state === 'playing' || this.keyboardHeldPitches.has(safePitch)) {
      return
    }

    this.keyboardHeldPitches.add(safePitch)

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

      await startTone()

      if (!this.isKeyboardPitchHeld(safePitch)) {
        return
      }

      const piano = await this.getKeyboardPiano(
        this.getKeyboardPianoRange(octaveLevel),
      )

      if (!piano || !this.isKeyboardPitchHeld(safePitch)) {
        return
      }

      this.openPianoOutput()
      piano.keyDown({
        midi: safePitch,
        time: toneNow(),
        velocity: KEYBOARD_NOTE_VELOCITY,
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

  prepareKeyboardOctave(octaveLevel: number) {
    return this.ensureKeyboardPianoLoaded(
      this.getKeyboardPianoRange(octaveLevel),
    )
  }

  async prepareKeyboardOctaves(octaveLevels: readonly number[]) {
    await Promise.all(
      [...new Set(octaveLevels)].map((octaveLevel) =>
        this.prepareKeyboardOctave(octaveLevel),
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
      (this.soundPreset === 'grandPiano'
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
    const context = this.context
    const master = this.master

    if (!context || !master) {
      return
    }

    if (this.soundPreset === 'musicBox') {
      this.scheduleMusicBoxNote(note, playbackTime, audioTime, context, master)
      return
    }

    if (this.soundPreset === 'ocarina') {
      if (note.pitch < OCARINA_PIANO_THRESHOLD) {
        this.scheduleHarmonicPianoNote(
          note,
          playbackTime,
          audioTime,
          context,
          master,
        )
        return
      }

      this.scheduleOcarinaNote(note, playbackTime, audioTime, context, master)
      return
    }

    if (this.soundPreset === 'grandPiano') {
      const piano = this.piano?.loaded ? this.piano : null

      if (piano) {
        this.scheduleGrandPianoNote(piano, note, playbackTime)
      } else {
        this.scheduleHarmonicPianoNote(
          note,
          playbackTime,
          audioTime,
          context,
          master,
        )
      }
      return
    }

    if (this.soundPreset === 'harmonicPiano') {
      this.scheduleHarmonicPianoNote(
        note,
        playbackTime,
        audioTime,
        context,
        master,
      )
      return
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
        // The preview piano remains available if the full sample set fails.
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
        // The preview piano remains available if the full sample set fails.
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

  private getKeyboardPianoRange(octaveLevel: number) {
    const range = keyboardRangeForOctaveLevel(octaveLevel)
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
    this.pianoOutputGate.gain.setValueAtTime(1, time)
  }

  private closePianoOutput() {
    if (!this.pianoOutputGate) {
      return
    }

    const time = toneNow()
    this.pianoOutputGate.gain.cancelScheduledValues(time)
    this.pianoOutputGate.gain.setTargetAtTime(0.0001, time, 0.006)
  }

  private resetPiano() {
    this.releaseKeyboardNotes()
    this.resetKeyboardPiano()
    this.pianoGeneration += 1
    this.piano?.stopAll()
    this.piano?.dispose()
    this.pianoPreview?.stopAll()
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

  private getMasterGain() {
    const presetGain =
      this.soundPreset === 'musicBox'
        ? MUSIC_BOX_MASTER_GAIN
        : this.soundPreset === 'ocarina'
          ? OCARINA_MASTER_GAIN
        : this.soundPreset === 'harmonicPiano'
          ? SCORE_PIANO_MASTER_GAIN / DEFAULT_VOLUME
          : 1
    const presetMultiplier =
      this.soundPreset === 'grandPiano'
        ? 1
        : this.soundPreset === 'harmonicPiano'
          ? SMALL_PIANO_PRESET_GAIN
        : NON_GRAND_PRESET_GAIN

    return presetGain * presetMultiplier * this.volume
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

  private async ensureMusicBoxLoaded() {
    const context = this.ensureContext()
    const sampleNames = [
      ...new Set(this.notes.map((note) => this.getMusicBoxSample(note.pitch).name)),
    ]

    await Promise.allSettled(
      sampleNames.map((sampleName) =>
        this.loadMusicBoxSample(sampleName, context),
      ),
    )
  }

  private async loadOcarinaSample(
    sampleName: string,
    context = this.ensureContext(),
  ) {
    const loaded = this.ocarinaBuffers.get(sampleName)

    if (loaded) {
      return loaded
    }

    const pending = this.ocarinaLoadPromises.get(sampleName)

    if (pending) {
      return pending
    }

    const promise = fetch(`${OCARINA_BASE_URL}${sampleName}.mp3`)
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Could not load ocarina sample ${sampleName}.`)
        }

        return response.arrayBuffer()
      })
      .then((buffer) => context.decodeAudioData(buffer))
      .then((buffer) => {
        this.ocarinaBuffers.set(sampleName, buffer)
        this.ocarinaSampleNormalizations.set(
          sampleName,
          clamp(
            OCARINA_TARGET_RMS / Math.max(getBufferRms(buffer), 0.0001),
            1,
            OCARINA_MAX_SAMPLE_NORMALIZATION,
          ),
        )
        this.failedOcarinaSamples.delete(sampleName)
        return buffer
      })
      .catch(() => {
        this.failedOcarinaSamples.add(sampleName)
        return null
      })
      .finally(() => {
        this.ocarinaLoadPromises.delete(sampleName)
      })

    this.ocarinaLoadPromises.set(sampleName, promise)
    return promise
  }

  private async ensureOcarinaLoaded() {
    const context = this.ensureContext()
    const sampleNames = [
      ...new Set(this.notes.map((note) => this.getOcarinaSample(note.pitch).name)),
    ]

    await Promise.allSettled(
      sampleNames.map((sampleName) =>
        this.loadOcarinaSample(sampleName, context),
      ),
    )
  }

  private getOcarinaSample(pitch: number) {
    const sourcePitch =
      pitch < OCARINA_CLEAR_LOW_SAMPLE_THRESHOLD
        ? pitch + OCARINA_CLEAR_LOW_SAMPLE_OFFSET
        : pitch
    const samplePitch =
      Math.round(
        clamp(sourcePitch, OCARINA_MIN_SAMPLE_MIDI, OCARINA_MAX_SAMPLE_MIDI) /
          OCARINA_SAMPLE_INTERVAL,
      ) * OCARINA_SAMPLE_INTERVAL
    const noteName = MUSIC_BOX_SAMPLE_NAMES[samplePitch % 12]
    const octave = Math.floor(samplePitch / 12) - 1

    return {
      name: `${noteName}${octave}`,
      playbackRatio: 2 ** ((pitch - samplePitch) / 12),
    }
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

  private scheduleOcarinaNote(
    note: MidiNote,
    playbackTime: number,
    audioTime: number,
    context: AudioContext,
    master: GainNode,
  ): Voice | null {
    const sample = this.getOcarinaSample(note.pitch)
    const buffer = this.ocarinaBuffers.get(sample.name)

    if (!buffer) {
      if (!this.failedOcarinaSamples.has(sample.name)) {
        void this.loadOcarinaSample(sample.name, context)
      }
      return null
    }

    const startAt =
      audioTime + Math.max(0, note.start - playbackTime) / this.playbackRate
    const naturalDuration = buffer.duration / sample.playbackRatio
    const scaledDuration = note.duration / this.playbackRate
    const source = context.createBufferSource()
    const gain = context.createGain()
    const { level, lowRegisterGain } = getOcarinaGainProfile(
      note.pitch,
      note.velocity,
      this.ocarinaSampleNormalizations.get(sample.name) ?? 1,
    )
    const hasLowPresence = lowRegisterGain > 1
    const stopAt =
      startAt +
      Math.min(
        naturalDuration,
        Math.max(
          hasLowPresence ? 0.5 : 0.28,
          scaledDuration + (hasLowPresence ? 0.38 : 0.24),
        ),
      )
    const attack = Math.min(0.018, Math.max(0.006, scaledDuration * 0.12))
    const release = hasLowPresence
      ? Math.min(0.2, Math.max(0.08, scaledDuration * 0.3))
      : Math.min(0.11, Math.max(0.035, scaledDuration * 0.18))

    source.buffer = buffer
    source.playbackRate.setValueAtTime(sample.playbackRatio, startAt)
    gain.gain.setValueAtTime(0.0001, startAt)
    gain.gain.linearRampToValueAtTime(level, startAt + attack)
    gain.gain.setValueAtTime(level, Math.max(startAt + attack, stopAt - release))
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

  private scheduleHarmonicPianoNote(
    note: MidiNote,
    playbackTime: number,
    audioTime: number,
    context: AudioContext,
    master: GainNode,
  ): Voice | null {
    const startAt =
      audioTime + Math.max(0, note.start - playbackTime) / this.playbackRate
    const audibleDuration = Math.max(
      0.06,
      (note.end - Math.max(note.start, playbackTime)) / this.playbackRate,
    )
    const profile = getSmallPianoVoiceProfile(
      note.pitch,
      note.velocity,
      audibleDuration,
    )
    const frequency = midiToFrequency(note.pitch)
    const sources: OscillatorNode[] = []
    const output = context.createGain()
    const filter = context.createBiquadFilter()
    const gains: GainNode[] = [output]
    const partials = profile.partials.filter(
      (partial) => frequency * partial.ratio < context.sampleRate * 0.45,
    )

    if (partials.length === 0) {
      return null
    }

    output.gain.setValueAtTime(0.0001, startAt)
    output.gain.linearRampToValueAtTime(profile.noteLevel, startAt + 0.014)
    filter.type = 'lowpass'
    filter.frequency.setValueAtTime(profile.filterFrequency, startAt)
    filter.Q.setValueAtTime(0.35, startAt)
    output.connect(filter)
    filter.connect(master)

    partials.forEach((partial) => {
      const oscillator = context.createOscillator()
      const gain = context.createGain()
      const partialDecay = profile.decay * partial.decay
      const stopAt = startAt + partialDecay + 0.05

      oscillator.type = 'sine'
      oscillator.frequency.value = frequency * partial.ratio
      oscillator.detune.value = 0
      gain.gain.setValueAtTime(0, startAt)
      gain.gain.linearRampToValueAtTime(partial.level, startAt + 0.014)
      gain.gain.exponentialRampToValueAtTime(0.0001, startAt + partialDecay)
      gain.gain.setValueAtTime(0, stopAt)
      oscillator.connect(gain)
      gain.connect(output)
      oscillator.start(startAt)
      oscillator.stop(stopAt)
      sources.push(oscillator)
      gains.push(gain)
    })

    const voice = { sources, gains }
    this.activeVoices.push(voice)
    sources[0]?.addEventListener('ended', () => {
      filter.disconnect()
      this.cleanupVoice(voice)
    })
    return voice
  }

  private scheduleMusicBoxNote(
    note: MidiNote,
    playbackTime: number,
    audioTime: number,
    context: AudioContext,
    master: GainNode,
  ): Voice | null {
    {
      const sample = this.getMusicBoxSample(note.pitch)
      const buffer = this.musicBoxBuffers.get(sample.name)

      if (buffer) {
        const startAt =
          audioTime + Math.max(0, note.start - playbackTime) / this.playbackRate
        const source = context.createBufferSource()
        const gain = context.createGain()
        const velocityLevel = 0.28 + note.velocity * 0.72
        const roleLevel =
          note.role === 'bass' ? 0.44 : note.role === 'melody' ? 0.52 : 0.42
        const level = roleLevel * velocityLevel
        const naturalDuration = buffer.duration / sample.playbackRatio
        const scaledDuration = note.duration / this.playbackRate
        const stopAt =
          startAt + Math.min(naturalDuration, Math.max(0.65, scaledDuration + 1.8))

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

    const startAt =
      audioTime + Math.max(0, note.start - playbackTime) / this.playbackRate
    const frequency = midiToFrequency(note.pitch)
    const scaledDuration = note.duration / this.playbackRate
    const ringDuration = Math.min(3.2, Math.max(0.85, scaledDuration * 1.25 + 0.7))
    const stopAt = startAt + ringDuration
    const velocityLevel = 0.35 + note.velocity * 0.65
    const roleLevel = note.role === 'bass' ? 0.11 : note.role === 'melody' ? 0.13 : 0.085
    const baseLevel = roleLevel * velocityLevel
    const output = context.createGain()
    const filter = context.createBiquadFilter()
    const partials = [
      { ratio: 1, level: 1, decay: 1 },
      { ratio: 2.01, level: 0.34, decay: 0.62 },
      { ratio: 3.02, level: 0.16, decay: 0.42 },
      { ratio: 4.18, level: 0.09, decay: 0.28 },
    ]
    const oscillators: OscillatorNode[] = []
    const gains: GainNode[] = [output]

    filter.type = 'highshelf'
    filter.frequency.setValueAtTime(1800, startAt)
    filter.gain.setValueAtTime(5, startAt)
    output.gain.setValueAtTime(0.0001, startAt)
    output.gain.linearRampToValueAtTime(baseLevel, startAt + 0.012)
    output.gain.exponentialRampToValueAtTime(baseLevel * 0.34, startAt + 0.22)
    output.gain.exponentialRampToValueAtTime(0.0001, stopAt)
    output.connect(filter)
    filter.connect(master)

    partials.forEach((partial, index) => {
      const oscillator = context.createOscillator()
      const partialGain = context.createGain()
      const detune = index === 0 ? 0 : (index % 2 === 0 ? -4 : 5)

      oscillator.type = index === 0 ? 'triangle' : 'sine'
      oscillator.frequency.setValueAtTime(frequency * partial.ratio, startAt)
      oscillator.detune.setValueAtTime(detune, startAt)
      partialGain.gain.setValueAtTime(0.0001, startAt)
      partialGain.gain.linearRampToValueAtTime(partial.level, startAt + 0.006)
      partialGain.gain.exponentialRampToValueAtTime(
        Math.max(0.0001, partial.level * 0.18),
        startAt + 0.16 * partial.decay,
      )
      partialGain.gain.exponentialRampToValueAtTime(0.0001, stopAt)

      oscillator.connect(partialGain)
      partialGain.connect(output)
      oscillator.start(startAt)
      oscillator.stop(stopAt + 0.03)
      oscillators.push(oscillator)
      gains.push(partialGain)
    })

    const click = context.createOscillator()
    const clickGain = context.createGain()

    click.type = 'square'
    click.frequency.setValueAtTime(frequency * 9.5, startAt)
    clickGain.gain.setValueAtTime(0.0001, startAt)
    clickGain.gain.linearRampToValueAtTime(baseLevel * 0.16, startAt + 0.003)
    clickGain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.045)
    click.connect(clickGain)
    clickGain.connect(output)
    click.start(startAt)
    click.stop(startAt + 0.055)
    oscillators.push(click)
    gains.push(clickGain)

    const voice = { sources: oscillators, gains }
    this.activeVoices.push(voice)

    oscillators[0].onended = () => {
      filter.disconnect()
      this.cleanupVoice(voice)
    }
    return voice
  }

  private isKeyboardPitchHeld(pitch: number) {
    return this.state !== 'playing' && this.keyboardHeldPitches.has(pitch)
  }

  private cleanupVoice(voice: Voice) {
    voice.gains.forEach((gain) => {
      try {
        gain.disconnect()
      } catch {
        // Already disconnected.
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
        // Already stopped by the WebAudio scheduler.
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
          // Already stopped by the WebAudio scheduler.
        }
      })
    })

    this.activeVoices = []
  }
}
