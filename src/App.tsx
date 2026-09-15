import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { CanvasView } from './components/CanvasView'
import { Controls } from './components/Controls'
import { MidiDropzone } from './components/MidiDropzone'
import { findMotifGroups } from './midi/motifAnalysis'
import { analyzeLocalKey } from './midi/keyAnalysis'
import { findContrapunctusSubjectTraces } from './midi/contrapunctusSubjects'
import {
  DEFAULT_KEYBOARD_OCTAVE_LEVEL,
  clampKeyboardOctaveLevel,
  isEditableKeyboardTarget,
  keyboardBindingsForOctaveLevel,
  keyboardOctaveLevelForCode,
  keyboardOctaveStepForCode,
  keyboardPitchForCode,
} from './playback/keyboardMap'
import { parseGwCsv } from './midi/parseGwCsv'
import { parseMidi } from './midi/parseMidi'
import type { MidiNote, ParsedMidi } from './midi/noteTypes'
import { reverseMidi } from './midi/reverseMidi'
import { findSymmetryGroups } from './midi/symmetryAnalysis'
import { clampTranspose, transposeMidi } from './midi/transposeMidi'
import {
  DEFAULT_VOLUME,
  normalizePlaybackRate,
  MidiTransport,
  type TrackSoundOverride,
  type PlaybackRate,
  type SoundPreset,
} from './playback/transport'
import {
  choosePracticeOctaveLevels,
  createPracticeEvents,
  getOuterPracticeTracks,
  getPracticeTracks,
  type PracticeEvent,
  type PracticeVoice,
} from './playback/duetPractice'

const defaultMidiFileName = 'BWV862_prelude.mid'
const defaultMidiUrl = `${import.meta.env.BASE_URL}${defaultMidiFileName}`
const ariaMidiFileName = 'BWV988_aria.mid'
const preludeMidiFileName = 'BWV846_prelude.mid'
const contrapunctusMidiFileName = 'BWV1080_14.mid'
const defaultCsvFileName = 'sxs_bbh_0001_i60_phi0_ell8.csv'
const defaultCsvUrl = `${import.meta.env.BASE_URL}${defaultCsvFileName}`
const PRACTICE_SEQUENCE_LENGTH = 10
const PRACTICE_QUICK_INTERVAL_SECONDS = 0.3
const CONTRAPUNCTUS_PLAYBACK_GAIN = 0.55
const BACH_CUTOFF_SECONDS = 478

type SourceKind = 'midi' | 'csv'

type PracticeStatus = 'preparing' | 'waiting' | 'running' | 'complete'

type DuetMode = PracticeVoice | 'demonstration'

type PracticePieceId = 'aria' | 'prelude' | 'contrapunctus'

interface PracticePiece {
  id: PracticePieceId
  label: string
  fileName: string
  defaultOctaveLevels: Partial<Record<PracticeVoice, number>>
  automaticallySwitchOctaves: boolean
  trackLayout: 'pair' | 'all'
}

const practicePieces: Record<PracticePieceId, PracticePiece> = {
  aria: {
    id: 'aria',
    label: 'Duet 1',
    fileName: ariaMidiFileName,
    defaultOctaveLevels: { upper: 5, lower: 3 },
    automaticallySwitchOctaves: false,
    trackLayout: 'pair',
  },
  prelude: {
    id: 'prelude',
    label: 'Duet 2',
    fileName: preludeMidiFileName,
    defaultOctaveLevels: { upper: 4, lower: 3 },
    automaticallySwitchOctaves: true,
    trackLayout: 'pair',
  },
  contrapunctus: {
    id: 'contrapunctus',
    label: 'Duet 3',
    fileName: contrapunctusMidiFileName,
    defaultOctaveLevels: { sound1: 5, sound2: 4, sound3: 3, sound4: 3 },
    automaticallySwitchOctaves: true,
    trackLayout: 'all',
  },
}

interface PracticeSession {
  runId: number
  piece: PracticePieceId
  voice: PracticeVoice
  events: PracticeEvent[]
  fixedOctaveLevel: number | null
  octaveLevels: number[]
  companionNotes: MidiNote[]
  duration: number
  gateIndex: number
  status: PracticeStatus
}

interface PracticeSequenceData {
  lineStart: number
  timingProgress: number | null
  items: Array<{
    isCompleted: boolean
    isCurrent: boolean
    isQuick: boolean
    notes: Array<{
      keyLabel: string
    }>
  }>
}

interface PracticeSequencePosition {
  left: number
  top: number
}

const isMidiFile = (file: File) => /\.(mid|midi)$/i.test(file.name)
const isCsvFile = (file: File) => /\.csv$/i.test(file.name)
const practicePieceForFileName = (fileName: string) =>
  Object.values(practicePieces).find(
    (piece) => piece.fileName.toLowerCase() === fileName.toLowerCase(),
  )

const trackSoundOverridesForMidi = (_midi: ParsedMidi) =>
  new Map<number, TrackSoundOverride>()

const practiceTracksForPiece = (
  piece: PracticePiece,
  midi: ParsedMidi,
) =>
  piece.trackLayout === 'all'
    ? getOuterPracticeTracks(midi)
    : getPracticeTracks(midi)

const trackForPracticeVoice = (
  piece: PracticePiece,
  midi: ParsedMidi,
  voice: PracticeVoice,
  tracks: { upper: number; lower: number },
) => {
  if (piece.trackLayout === 'pair') {
    return voice === 'upper' ? tracks.upper : tracks.lower
  }

  const soundNumber = Number(voice.replace('sound', ''))

  return midi.tracks.find((track) => track.name === `Sound ${soundNumber}`)?.track
}

const practiceVoiceOptions = (piece: PracticePiece): PracticeVoice[] =>
  piece.trackLayout === 'all'
    ? ['sound1', 'sound2', 'sound3', 'sound4']
    : ['upper', 'lower']

const practiceVoiceLabel = (voice: PracticeVoice) => {
  if (voice === 'upper') {
    return 'Upper Voice'
  }

  if (voice === 'lower') {
    return 'Lower Voice'
  }

  return `Sound ${voice.at(-1)}`
}

const defaultOctaveLevelForVoice = (
  piece: PracticePiece,
  voice: PracticeVoice,
) => piece.defaultOctaveLevels[voice] ?? DEFAULT_KEYBOARD_OCTAVE_LEVEL

function PracticeSequence({
  sequence,
  position,
}: {
  sequence: PracticeSequenceData
  position: PracticeSequencePosition
}) {
  return (
    <div
      className="practice-sequence-host"
      style={{ left: position.left, top: position.top }}
    >
      <div
        className="practice-sequence"
        aria-label="Practice sequence"
        key={sequence.lineStart}
      >
        {sequence.items.map((event, eventIndex) => (
          <div
            className={
              [
                'practice-sequence__event',
                event.isCompleted ? 'is-completed' : '',
                event.isCurrent ? 'is-current' : '',
                event.isQuick ? 'is-quick' : '',
              ]
                .filter(Boolean)
                .join(' ')
            }
            key={eventIndex}
          >
            <div className="practice-sequence__keys">
              {event.notes.map((note, noteIndex) => (
                <kbd key={`${note.keyLabel}-${noteIndex}`}>
                  {note.keyLabel}
                </kbd>
              ))}
            </div>
          </div>
        ))}
      </div>
      {sequence.timingProgress !== null ? (
        <div className="practice-sequence__timing" aria-hidden="true">
          <div
            className="practice-sequence__timing-fill"
            style={{ width: `${sequence.timingProgress * 100}%` }}
          />
        </div>
      ) : null}
    </div>
  )
}

function App() {
  const [sourceMidi, setSourceMidi] = useState<ParsedMidi | null>(null)
  const [sourceKind, setSourceKind] = useState<SourceKind | null>(null)
  const [currentTime, setCurrentTime] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [isPreparing, setIsPreparing] = useState(false)
  const [visibleTracks, setVisibleTracks] = useState<Set<number>>(new Set())
  const [soundPreset, setSoundPreset] = useState<SoundPreset>('grandPiano')
  const [playbackRate, setPlaybackRate] = useState<PlaybackRate>(1)
  const [volume, setVolume] = useState(DEFAULT_VOLUME)
  const [transposeSemitones, setTransposeSemitones] = useState(0)
  const [reversePlayback, setReversePlayback] = useState(false)
  const [motifTraceEnabled, setMotifTraceEnabled] = useState(false)
  const [axisSymmetryEnabled, setAxisSymmetryEnabled] = useState(false)
  const [centerSymmetryEnabled, setCenterSymmetryEnabled] = useState(false)
  const [showChromaticLines, setShowChromaticLines] = useState(true)
  const [showStaffLines, setShowStaffLines] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [isZen, setIsZen] = useState(false)
  const [isOverview, setIsOverview] = useState(false)
  const [keyName, setKeyName] = useState<string | null>(null)
  const [pressedKeyboardPitches, setPressedKeyboardPitches] = useState<
    ReadonlySet<number>
  >(new Set())
  const [pressedKeyboardCodes, setPressedKeyboardCodes] = useState<
    ReadonlySet<string>
  >(new Set())
  const [keyboardOctaveLevel, setKeyboardOctaveLevel] = useState(
    DEFAULT_KEYBOARD_OCTAVE_LEVEL,
  )
  const [activeGameMenu, setActiveGameMenu] =
    useState<PracticePieceId | null>(null)
  const [demonstrationPiece, setDemonstrationPiece] =
    useState<PracticePieceId | null>(null)
  const [practiceSession, setPracticeSession] =
    useState<PracticeSession | null>(null)
  const [isDuetTwoLeadIn, setIsDuetTwoLeadIn] = useState(false)
  const [practiceSequencePosition, setPracticeSequencePosition] =
    useState<PracticeSequencePosition | null>(null)
  const appRef = useRef<HTMLDivElement | null>(null)
  const controlsAnchorRef = useRef<HTMLDivElement | null>(null)
  const transportRef = useRef<MidiTransport | null>(null)
  const loadRequestIdRef = useRef(0)
  const playRequestIdRef = useRef(0)
  const practiceRef = useRef<PracticeSession | null>(null)
  const practiceFrameRef = useRef<number | null>(null)
  const duetTwoLeadInFrameRef = useRef<number | null>(null)
  const duetTwoLeadInRef = useRef(false)
  const practiceRunIdRef = useRef(0)
  const heldKeyboardPitchesRef = useRef(new Set<number>())
  const practiceMatchedPitchesRef = useRef(new Set<number>())
  const currentTimeRef = useRef(currentTime)
  const keyboardOctaveLevelRef = useRef(keyboardOctaveLevel)
  const lastPracticeUiUpdateRef = useRef(0)

  const isDemonstration = demonstrationPiece !== null
  const isPracticeAnimating =
    practiceSession?.status === 'running' || isDuetTwoLeadIn

  if (
    practiceRef.current?.status !== 'running' &&
    !duetTwoLeadInRef.current
  ) {
    currentTimeRef.current = currentTime
  }
  keyboardOctaveLevelRef.current = keyboardOctaveLevel
  const midi = useMemo(() => {
    if (!sourceMidi) {
      return null
    }

    const transposed = transposeMidi(sourceMidi, transposeSemitones)

    return reversePlayback ? reverseMidi(transposed) : transposed
  }, [reversePlayback, sourceMidi, transposeSemitones])
  const motifGroups = useMemo(
    () =>
      sourceKind === 'midi' && midi
        ? findMotifGroups(midi.notes)
        : [],
    [sourceKind, midi, findMotifGroups],
  )
  const motifOccurrenceCount = useMemo(
    () =>
      motifGroups.reduce(
        (count, group) => count + group.occurrences.length,
        0,
      ),
    [motifGroups],
  )
  const symmetryGroups = useMemo(
    () =>
      sourceKind === 'midi' && midi
        ? findSymmetryGroups(midi.notes)
        : { axis: [], center: [] },
    [sourceKind, midi],
  )
  const duetThreeSubjectTraces = useMemo(
    () =>
      demonstrationPiece === 'contrapunctus' && midi
        ? findContrapunctusSubjectTraces(midi)
        : [],
    [demonstrationPiece, midi],
  )
  const practiceSequence = useMemo<PracticeSequenceData | null>(() => {
    if (
      !practiceSession ||
      practiceSession.status === 'preparing' ||
      practiceSession.status === 'complete'
    ) {
      return null
    }

    const nextEventIndex =
      practiceSession.status === 'running'
        ? practiceSession.gateIndex + 1
        : practiceSession.gateIndex
    const currentEventIndex =
      practiceSession.status === 'waiting' ? practiceSession.gateIndex : -1

    if (nextEventIndex >= practiceSession.events.length) {
      return null
    }

    const lineStart =
      Math.floor(nextEventIndex / PRACTICE_SEQUENCE_LENGTH) *
      PRACTICE_SEQUENCE_LENGTH
    const currentEvent = practiceSession.events[practiceSession.gateIndex]
    const nextEvent = practiceSession.events[practiceSession.gateIndex + 1]
    const timingProgress =
      practiceSession.status === 'running' && currentEvent && nextEvent
        ? Math.min(
            Math.max(
              (currentTime - currentEvent.start) /
                Math.max(nextEvent.start - currentEvent.start, 0.0001),
              0,
            ),
            1,
          )
        : 1

    return {
      lineStart,
      timingProgress,
      items: practiceSession.events
        .slice(lineStart, lineStart + PRACTICE_SEQUENCE_LENGTH)
        .map((event, index) => ({
          isCompleted: lineStart + index < nextEventIndex,
          isCurrent: lineStart + index === currentEventIndex,
          isQuick:
            event.notes.some(
              (note) =>
                note.duration / playbackRate < PRACTICE_QUICK_INTERVAL_SECONDS,
            ) ||
            (lineStart + index > 0 &&
              (event.start -
                practiceSession.events[lineStart + index - 1]!.start) /
                playbackRate <
                PRACTICE_QUICK_INTERVAL_SECONDS),
          notes: event.notes.map((note) => {
            const bindings = keyboardBindingsForOctaveLevel(
              practiceSession.fixedOctaveLevel ??
                practiceSession.octaveLevels[lineStart + index] ??
                keyboardOctaveLevel,
            )
            const binding = bindings.find((item) => item.pitch === note.pitch)

            return {
              keyLabel: binding?.label ?? '?',
            }
          }),
        })),
    }
  }, [currentTime, keyboardOctaveLevel, playbackRate, practiceSession])

  const activeSequence = practiceSequence
  const hasActiveSequence = activeSequence !== null

  useLayoutEffect(() => {
    const anchor = controlsAnchorRef.current

    if (!hasActiveSequence || !anchor) {
      setPracticeSequencePosition(null)
      return
    }

    const updatePosition = () => {
      const rect = anchor.getBoundingClientRect()
      const availableHeight = Math.max(window.innerHeight - rect.bottom, 0)
      const nextPosition = {
        left: rect.left + rect.width * 0.3,
        top: rect.bottom + availableHeight / 2,
      }

      setPracticeSequencePosition((current) =>
        current &&
        Math.abs(current.left - nextPosition.left) < 0.5 &&
        Math.abs(current.top - nextPosition.top) < 0.5
          ? current
          : nextPosition,
      )
    }

    const observer = new ResizeObserver(updatePosition)

    observer.observe(anchor)
    window.addEventListener('resize', updatePosition)
    window.visualViewport?.addEventListener('resize', updatePosition)
    updatePosition()

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', updatePosition)
      window.visualViewport?.removeEventListener('resize', updatePosition)
    }
  }, [hasActiveSequence])

  const transportHasTrackSoundOverrides =
    typeof (
      transportRef.current as
        | (MidiTransport & { setTrackSoundOverrides?: unknown })
        | null
    )?.setTrackSoundOverrides === 'function' &&
    transportRef.current?.revision === 8

  if (!transportHasTrackSoundOverrides) {
    const transport = new MidiTransport((endedAt) => {
      setCurrentTime(endedAt)
      setIsPlaying(false)
      setIsOverview(true)
      setDemonstrationPiece(null)
    })

    transportRef.current?.stop()
    transport.setSoundPreset(soundPreset)
    transport.setPlaybackRate(playbackRate)
    transport.setVolume(volume)

    if (midi) {
      transport.setPieceGain(
        practicePieceForFileName(midi.fileName)?.id === 'contrapunctus'
          ? CONTRAPUNCTUS_PLAYBACK_GAIN
          : 1,
      )
      transport.setTrackSoundOverrides(trackSoundOverridesForMidi(midi))
      transport.load(midi.notes, midi.duration, visibleTracks)
      transport.seek(currentTime)
      transport.preloadCurrentSound()
    }

    transportRef.current = transport
  }

  const clearPracticeSession = useCallback(() => {
    const activePiece = practiceRef.current?.piece

    practiceRunIdRef.current += 1

    if (practiceFrameRef.current !== null) {
      window.cancelAnimationFrame(practiceFrameRef.current)
      practiceFrameRef.current = null
    }

    if (duetTwoLeadInFrameRef.current !== null) {
      window.cancelAnimationFrame(duetTwoLeadInFrameRef.current)
      duetTwoLeadInFrameRef.current = null
    }

    practiceRef.current = null
    duetTwoLeadInRef.current = false
    heldKeyboardPitchesRef.current.clear()
    practiceMatchedPitchesRef.current.clear()
    if (activePiece === 'contrapunctus') {
      transportRef.current?.stopDuetThree()
    } else {
      transportRef.current?.stop()
    }
    setPracticeSession(null)
    setIsDuetTwoLeadIn(false)
    setDemonstrationPiece(null)
    setActiveGameMenu(null)
    setPressedKeyboardPitches(new Set())
    setPressedKeyboardCodes(new Set())
  }, [])

  const loadParsedMidi = useCallback((
    parsed: ParsedMidi,
    kind: SourceKind,
    options: { preloadKeyboard?: boolean } = {},
  ) => {
    playRequestIdRef.current += 1
    clearPracticeSession()
    const nextVisibleTracks = new Set(parsed.tracks.map((track) => track.track))

    transportRef.current?.setPieceGain(
      practicePieceForFileName(parsed.fileName)?.id === 'contrapunctus'
        ? CONTRAPUNCTUS_PLAYBACK_GAIN
        : 1,
    )
    transportRef.current?.setTrackSoundOverrides(
      trackSoundOverridesForMidi(parsed),
    )
    transportRef.current?.load(parsed.notes, parsed.duration, nextVisibleTracks)
    transportRef.current?.preloadCurrentSound()
    if (options.preloadKeyboard !== false) {
      void transportRef.current?.prepareKeyboardOctave(
        DEFAULT_KEYBOARD_OCTAVE_LEVEL,
      )
    }
    setError(null)
    setSourceMidi(parsed)
    setSourceKind(kind)
    setTransposeSemitones(0)
    setReversePlayback(false)
    setMotifTraceEnabled(false)
    setCurrentTime(0)
    setIsPlaying(false)
    setIsPreparing(false)
    setIsOverview(false)
    setKeyName(null)
    setKeyboardOctaveLevel(DEFAULT_KEYBOARD_OCTAVE_LEVEL)
    setPressedKeyboardPitches(new Set())
    setPressedKeyboardCodes(new Set())
    setVisibleTracks(nextVisibleTracks)
  }, [clearPracticeSession])

  useEffect(() => {
    if (!isPlaying) {
      return
    }

    const intervalId = window.setInterval(() => {
      const transport = transportRef.current

      if (transport) {
        setCurrentTime(transport.getCurrentTime())
      }
    }, 100)

    return () => {
      window.clearInterval(intervalId)
    }
  }, [isPlaying])

  const loadDefaultMidi = useCallback(async (signal?: AbortSignal) => {
    const requestId = ++loadRequestIdRef.current

    setError(null)

    try {
      const response = await fetch(defaultMidiUrl, { signal })

      if (!response.ok) {
        throw new Error(`Could not load ${defaultMidiFileName}.`)
      }

      const parsed = await parseMidi(defaultMidiFileName, await response.arrayBuffer())

      if (signal?.aborted || requestId !== loadRequestIdRef.current) {
        return
      }

      loadParsedMidi(parsed, 'midi')
    } catch (caughtError) {
      if (signal?.aborted || requestId !== loadRequestIdRef.current) {
        return
      }

      setError(
        caughtError instanceof Error
          ? caughtError.message
          : `Could not load ${defaultMidiFileName}.`,
      )
    }
  }, [loadParsedMidi])

  const loadDefaultCsv = useCallback(async (signal?: AbortSignal) => {
    const requestId = ++loadRequestIdRef.current

    setError(null)

    try {
      const response = await fetch(defaultCsvUrl, { signal })

      if (!response.ok) {
        throw new Error(`Could not load ${defaultCsvFileName}.`)
      }

      const parsed = parseGwCsv(defaultCsvFileName, await response.text())

      if (signal?.aborted || requestId !== loadRequestIdRef.current) {
        return
      }

      loadParsedMidi(parsed, 'csv')
    } catch (caughtError) {
      if (signal?.aborted || requestId !== loadRequestIdRef.current) {
        return
      }

      setError(
        caughtError instanceof Error
          ? caughtError.message
          : `Could not load ${defaultCsvFileName}.`,
      )
    }
  }, [loadParsedMidi])

  useEffect(() => {
    const controller = new AbortController()

    void loadDefaultMidi(controller.signal)

    return () => {
      controller.abort()
    }
  }, [loadDefaultMidi])

  useEffect(() => {
    transportRef.current?.setVisibleTracks(visibleTracks)
  }, [visibleTracks])

  useEffect(() => {
    const transport = transportRef.current
    transport?.releaseKeyboardNotes()
    setPressedKeyboardPitches(new Set())
    setPressedKeyboardCodes(new Set())
    transport?.setSoundPreset(soundPreset)
  }, [soundPreset])

  useEffect(() => {
    transportRef.current?.setPlaybackRate(playbackRate)
  }, [playbackRate])

  useEffect(() => {
    transportRef.current?.setVolume(volume)
  }, [volume])

  const applyKeyboardOctave = useCallback((
    octaveLevel: number,
    preload = true,
  ) => {
    const nextOctaveLevel = clampKeyboardOctaveLevel(octaveLevel)

    if (nextOctaveLevel === keyboardOctaveLevelRef.current) {
      return
    }

    transportRef.current?.releaseKeyboardNotes()
    heldKeyboardPitchesRef.current.clear()
    practiceMatchedPitchesRef.current.clear()
    setPressedKeyboardPitches(new Set())
    setPressedKeyboardCodes(new Set())
    keyboardOctaveLevelRef.current = nextOctaveLevel
    setKeyboardOctaveLevel(nextOctaveLevel)
    if (preload) {
      void transportRef.current?.prepareKeyboardOctave(nextOctaveLevel)
    }
  }, [])

  const advancePractice = useCallback(() => {
    const session = practiceRef.current
    const transport = transportRef.current

    if (!session || !transport || session.status !== 'waiting') {
      return
    }

    const event = session.events[session.gateIndex]

    if (!event) {
      return
    }

    const targetPitches = new Set(event.notes.map((note) => note.pitch))
    if (
      [...targetPitches].some(
        (pitch) => !practiceMatchedPitchesRef.current.has(pitch),
      )
    ) {
      return
    }

    const nextEvent = session.events[session.gateIndex + 1]
    const segmentStart = event.start
    const segmentEnd = nextEvent?.start ?? session.duration
    const runningSession = {
      ...session,
      status: 'running' as const,
    }

    practiceRef.current = runningSession
    setPracticeSession(runningSession)

    void (async () => {
      try {
        await transport.playPracticeNotes(
          runningSession.companionNotes,
          segmentStart,
          segmentEnd,
        )
      } catch (caughtError) {
        if (practiceRef.current?.runId === runningSession.runId) {
          setError(
            caughtError instanceof Error
              ? caughtError.message
              : 'Could not continue Game.',
          )
          clearPracticeSession()
        }
        return
      }

      if (practiceRef.current?.runId !== runningSession.runId) {
        return
      }

      const startedAt = performance.now()
      currentTimeRef.current = segmentStart
      lastPracticeUiUpdateRef.current = startedAt
      const durationMs = Math.max(
        1,
        ((segmentEnd - segmentStart) / playbackRate) * 1000,
      )

      const advanceFrame = (now: number) => {
        if (practiceRef.current?.runId !== runningSession.runId) {
          return
        }

        const progress = Math.min(Math.max((now - startedAt) / durationMs, 0), 1)
        const nextTime = segmentStart + (segmentEnd - segmentStart) * progress

        currentTimeRef.current = nextTime

        if (
          progress >= 1 ||
          now - lastPracticeUiUpdateRef.current >= 100
        ) {
          lastPracticeUiUpdateRef.current = now
          setCurrentTime(nextTime)
        }

        if (progress < 1) {
          practiceFrameRef.current = window.requestAnimationFrame(advanceFrame)
          return
        }

        practiceFrameRef.current = null
        const activeSession = practiceRef.current

        if (!activeSession) {
          return
        }

        const nextSession: PracticeSession = nextEvent
          ? {
              ...activeSession,
              gateIndex: activeSession.gateIndex + 1,
              status: 'waiting',
            }
          : {
              ...activeSession,
              gateIndex: activeSession.events.length,
              status: 'complete',
            }

        practiceRef.current = nextSession
        practiceMatchedPitchesRef.current.clear()

        if (
          nextSession.status === 'waiting' &&
          practicePieces[nextSession.piece].automaticallySwitchOctaves
        ) {
          applyKeyboardOctave(
            nextSession.octaveLevels[nextSession.gateIndex] ??
              keyboardOctaveLevelRef.current,
          )
        }

        if (nextSession.status === 'waiting') {
          const nextPracticeEvent =
            nextSession.events[nextSession.gateIndex]

          nextPracticeEvent?.notes.forEach((note) => {
            if (heldKeyboardPitchesRef.current.has(note.pitch)) {
              practiceMatchedPitchesRef.current.add(note.pitch)
            }
          })
        }

        setPracticeSession(nextSession)

        if (nextSession.status === 'waiting') {
          window.setTimeout(advancePractice, 0)
        }
      }

      practiceFrameRef.current = window.requestAnimationFrame(advanceFrame)
    })()
  }, [applyKeyboardOctave, clearPracticeSession, playbackRate])

  useEffect(() => {
    if (!demonstrationPiece || !sourceMidi) {
      return
    }

    const piece = practicePieces[demonstrationPiece]
    const tracks = practiceTracksForPiece(piece, sourceMidi)

    if (!tracks) {
      return
    }

    const events = createPracticeEvents(
      sourceMidi.notes.filter((note) => note.track === tracks.upper),
    )
    const demonstrationVoice: PracticeVoice =
      piece.trackLayout === 'all' ? 'sound1' : 'upper'
    const initialOctaveLevel = defaultOctaveLevelForVoice(
      piece,
      demonstrationVoice,
    )
    if (!piece.automaticallySwitchOctaves) {
      return
    }

    const octaveLevels = choosePracticeOctaveLevels(
      events,
      initialOctaveLevel,
    )
    const eventIndex = events.findLastIndex(
      (event) => event.start <= currentTime + 0.0001,
    )

    if (eventIndex >= 0) {
      applyKeyboardOctave(
        octaveLevels[eventIndex] ?? initialOctaveLevel,
        false,
      )
    }
  }, [applyKeyboardOctave, currentTime, demonstrationPiece, sourceMidi])

  const demonstrationPressedKeyboardCodes = useMemo(() => {
    if (!demonstrationPiece || !sourceMidi) {
      return new Set<string>()
    }

    const tracks = practiceTracksForPiece(
      practicePieces[demonstrationPiece],
      sourceMidi,
    )

    if (!tracks) {
      return new Set<string>()
    }

    const bindings = keyboardBindingsForOctaveLevel(keyboardOctaveLevel)

    return new Set(
      sourceMidi.notes
        .filter(
          (note) =>
            note.track === tracks.upper &&
            note.start <= currentTime + 0.0001 &&
            note.end > currentTime - 0.0001,
        )
        .flatMap((note) => {
        const binding = bindings.find((item) => item.pitch === note.pitch)

        return binding ? [binding.code] : []
        }),
    )
  }, [currentTime, demonstrationPiece, keyboardOctaveLevel, sourceMidi])

  useEffect(() => {
    const transport = transportRef.current

    if (!midi || isPlaying || isPreparing) {
      transport?.releaseKeyboardNotes()
      heldKeyboardPitchesRef.current.clear()
      practiceMatchedPitchesRef.current.clear()
      setPressedKeyboardPitches(new Set())
      setPressedKeyboardCodes(new Set())
      return
    }

    const releaseAll = () => {
      transport?.releaseKeyboardNotes()
      heldKeyboardPitchesRef.current.clear()
      practiceMatchedPitchesRef.current.clear()
      setPressedKeyboardPitches(new Set())
      setPressedKeyboardCodes(new Set())
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        isEditableKeyboardTarget(event.target)
      ) {
        return
      }

      const activeOctaveLevel = keyboardOctaveLevelRef.current

      const octaveStep = keyboardOctaveStepForCode(event.code)

      if (octaveStep !== undefined) {
        event.preventDefault()

        if (event.repeat) {
          return
        }

        if (practiceRef.current) {
          return
        }

        const nextOctaveLevel = clampKeyboardOctaveLevel(
          activeOctaveLevel + octaveStep,
        )

        if (nextOctaveLevel !== activeOctaveLevel) {
          releaseAll()
          keyboardOctaveLevelRef.current = nextOctaveLevel
          setKeyboardOctaveLevel(nextOctaveLevel)
          void transport?.prepareKeyboardOctave(nextOctaveLevel)
        }

        return
      }

      const octaveLevel = keyboardOctaveLevelForCode(event.code)

      if (octaveLevel !== undefined) {
        event.preventDefault()

        if (event.repeat) {
          return
        }

        if (practiceRef.current) {
          return
        }

        if (octaveLevel !== activeOctaveLevel) {
          releaseAll()
          keyboardOctaveLevelRef.current = octaveLevel
          setKeyboardOctaveLevel(octaveLevel)
          void transport?.prepareKeyboardOctave(octaveLevel)
        }

        return
      }

      const pitch = keyboardPitchForCode(event.code, activeOctaveLevel)

      if (pitch === undefined) {
        return
      }

      event.preventDefault()

      if (event.repeat) {
        return
      }

      const activePractice = practiceRef.current

      if (
        activePractice && duetTwoLeadInRef.current
      ) {
        return
      }

      heldKeyboardPitchesRef.current.add(pitch)

      if (activePractice?.status === 'waiting') {
        const activeEvent = activePractice.events[activePractice.gateIndex]

        if (activeEvent?.notes.some((note) => note.pitch === pitch)) {
          practiceMatchedPitchesRef.current.add(pitch)
        }
      }
      setPressedKeyboardPitches((current) => {
        if (current.has(pitch)) {
          return current
        }

        return new Set(current).add(pitch)
      })
      setPressedKeyboardCodes((current) => {
        if (current.has(event.code)) {
          return current
        }

        return new Set(current).add(event.code)
      })
      const isDuetThree = activePractice?.piece === 'contrapunctus'

      void transport?.previewKeyDown(
        pitch,
        activeOctaveLevel,
        isDuetThree
          ? {
              velocity: 0.93,
              useFullPiano: true,
            }
          : undefined,
      )
      advancePractice()
    }

    const handleKeyUp = (event: KeyboardEvent) => {
      const pitch = keyboardPitchForCode(
        event.code,
        keyboardOctaveLevelRef.current,
      )

      if (pitch === undefined) {
        return
      }

      event.preventDefault()
      transport?.previewKeyUp(pitch)
      heldKeyboardPitchesRef.current.delete(pitch)
      setPressedKeyboardPitches((current) => {
        if (!current.has(pitch)) {
          return current
        }

        const next = new Set(current)
        next.delete(pitch)
        return next
      })
      setPressedKeyboardCodes((current) => {
        if (!current.has(event.code)) {
          return current
        }

        const next = new Set(current)
        next.delete(event.code)
        return next
      })
    }

    const handleVisibilityChange = () => {
      if (document.hidden) {
        releaseAll()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    window.addEventListener('blur', releaseAll)
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
      window.removeEventListener('blur', releaseAll)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      transport?.releaseKeyboardNotes()
      heldKeyboardPitchesRef.current.clear()
      practiceMatchedPitchesRef.current.clear()
    }
  }, [advancePractice, isPlaying, isPreparing, keyboardOctaveLevel, midi])

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsZen(Boolean(document.fullscreenElement))
    }

    document.addEventListener('fullscreenchange', handleFullscreenChange)
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange)
    }
  }, [])

  const handleMidiFile = useCallback(async (file: File) => {
    const requestId = ++loadRequestIdRef.current

    setError(null)

    try {
      const parsed = await parseMidi(file.name, await file.arrayBuffer())

      if (requestId !== loadRequestIdRef.current) {
        return
      }

      loadParsedMidi(parsed, 'midi')
    } catch (caughtError) {
      if (requestId !== loadRequestIdRef.current) {
        return
      }

      setError(
        caughtError instanceof Error
          ? caughtError.message
          : 'Could not parse this MIDI file.',
      )
    }
  }, [loadParsedMidi])

  const handleCsvFile = useCallback(async (file: File) => {
    const requestId = ++loadRequestIdRef.current

    setError(null)

    try {
      const parsed = parseGwCsv(file.name, await file.text())

      if (requestId !== loadRequestIdRef.current) {
        return
      }

      loadParsedMidi(parsed, 'csv')
    } catch (caughtError) {
      if (requestId !== loadRequestIdRef.current) {
        return
      }

      setError(
        caughtError instanceof Error
          ? caughtError.message
          : 'Could not parse this CSV file.',
      )
    }
  }, [loadParsedMidi])

  const handleGameButton = useCallback((pieceId: PracticePieceId) => {
    if (practiceRef.current) {
      clearPracticeSession()
      setCurrentTime(0)
      setIsPreparing(false)
      setIsOverview(false)
      return
    }

    setError(null)
    setActiveGameMenu((current) => (current === pieceId ? null : pieceId))
  }, [clearPracticeSession])

  const handleStartGame = useCallback(
    async (
      pieceId: PracticePieceId,
      voice: PracticeVoice,
      parsedOverride?: ParsedMidi,
    ) => {
      const piece = practicePieces[pieceId]
      const parsed = parsedOverride ?? sourceMidi
      const transport = transportRef.current

      if (
        !parsed ||
        !transport ||
        (!parsedOverride && sourceKind !== 'midi') ||
        practicePieceForFileName(parsed.fileName)?.id !== piece.id ||
        (!parsedOverride && isPreparing)
      ) {
        return
      }

      const tracks = practiceTracksForPiece(piece, parsed)

      if (!tracks) {
        setError(
          `${piece.label} requires a ${piece.trackLayout === 'all' ? 'four' : 'two'}-voice MIDI file.`,
        )
        return
      }

      setDemonstrationPiece(null)

      const playerTrack = trackForPracticeVoice(piece, parsed, voice, tracks)

      if (playerTrack === undefined) {
        setError(`Could not find ${practiceVoiceLabel(voice)}.`)
        return
      }

      const companionTrack = voice === 'upper' ? tracks.lower : tracks.upper
      const companionTracks =
        piece.trackLayout === 'all'
          ? parsed.tracks
              .map((track) => track.track)
              .filter((track) => track !== playerTrack)
          : [companionTrack]
      const events = createPracticeEvents(
        parsed.notes.filter((note) => note.track === playerTrack),
      )
      const initialOctaveLevel = defaultOctaveLevelForVoice(piece, voice)
      const fixedOctaveLevel = piece.automaticallySwitchOctaves
        ? null
        : initialOctaveLevel
      const octaveLevels = piece.automaticallySwitchOctaves
        ? choosePracticeOctaveLevels(events, initialOctaveLevel)
        : []

      if (events.length === 0) {
        setError('No playable notes were found for this voice.')
        return
      }

      const firstEvent = events[0]
      const needsDuetTwoLeadIn =
        (piece.id === 'prelude' || piece.id === 'contrapunctus') &&
        firstEvent !== undefined &&
        firstEvent.start > 0
      const runId = ++practiceRunIdRef.current
      const nextVisibleTracks = new Set(parsed.tracks.map((track) => track.track))
      const nextOctaveLevel = octaveLevels[0] ?? initialOctaveLevel
      const session: PracticeSession = {
        runId,
        piece: piece.id,
        voice,
        events,
        fixedOctaveLevel,
        octaveLevels,
        companionNotes: parsed.notes.filter((note) =>
          companionTracks.includes(note.track),
        ),
        duration: parsed.duration,
        gateIndex: 0,
        status: 'preparing',
      }

      if (practiceFrameRef.current !== null) {
        window.cancelAnimationFrame(practiceFrameRef.current)
        practiceFrameRef.current = null
      }

      playRequestIdRef.current += 1
      transport.stop()
      transport.setPieceGain(
        piece.id === 'contrapunctus' ? CONTRAPUNCTUS_PLAYBACK_GAIN : 1,
      )
      transport.setTrackSoundOverrides(trackSoundOverridesForMidi(parsed))
      transport.load(parsed.notes, parsed.duration, nextVisibleTracks)
      transport.setVisibleTracks(nextVisibleTracks)
      practiceRef.current = session
      heldKeyboardPitchesRef.current.clear()
      practiceMatchedPitchesRef.current.clear()
      setPracticeSession(session)
      setActiveGameMenu(null)
      setError(null)
      setTransposeSemitones(0)
      setReversePlayback(false)
      setVisibleTracks(nextVisibleTracks)
      setCurrentTime(needsDuetTwoLeadIn ? 0 : (firstEvent?.start ?? 0))
      setIsPlaying(false)
      setIsPreparing(true)
      setIsOverview(false)
      setKeyName(null)
      keyboardOctaveLevelRef.current = nextOctaveLevel
      setKeyboardOctaveLevel(nextOctaveLevel)
      setPressedKeyboardPitches(new Set())
      setPressedKeyboardCodes(new Set())

      try {
        await Promise.all([
          transport.preparePractice(),
          piece.automaticallySwitchOctaves
            ? transport.prepareKeyboardOctaves(octaveLevels)
            : transport.prepareKeyboardOctave(nextOctaveLevel),
        ])

        if (practiceRef.current?.runId !== runId) {
          return
        }

        if (needsDuetTwoLeadIn && firstEvent) {
          duetTwoLeadInRef.current = true
          setIsDuetTwoLeadIn(true)
          await transport.playPracticeNotes(
            session.companionNotes,
            0,
            firstEvent.start,
          )

          if (practiceRef.current?.runId !== runId) {
            return
          }

          const startedAt = performance.now()
          const durationMs = Math.max(
            1,
            (firstEvent.start / playbackRate) * 1000,
          )

          const advanceDuetTwoLeadIn = (now: number) => {
            if (
              practiceRef.current?.runId !== runId ||
              !duetTwoLeadInRef.current
            ) {
              return
            }

            const progress = Math.min(
              Math.max((now - startedAt) / durationMs, 0),
              1,
            )
            const nextTime = firstEvent.start * progress
            currentTimeRef.current = nextTime

            if (
              progress >= 1 ||
              now - lastPracticeUiUpdateRef.current >= 100
            ) {
              lastPracticeUiUpdateRef.current = now
              setCurrentTime(nextTime)
            }

            if (progress < 1) {
              duetTwoLeadInFrameRef.current = window.requestAnimationFrame(
                advanceDuetTwoLeadIn,
              )
              return
            }

            duetTwoLeadInFrameRef.current = null
            duetTwoLeadInRef.current = false
            setIsDuetTwoLeadIn(false)
            const readySession: PracticeSession = {
              ...session,
              status: 'waiting',
            }
            practiceRef.current = readySession
            setPracticeSession(readySession)
          }

          currentTimeRef.current = 0
          lastPracticeUiUpdateRef.current = startedAt
          duetTwoLeadInFrameRef.current = window.requestAnimationFrame(
            advanceDuetTwoLeadIn,
          )
          return
        }

        const readySession: PracticeSession = {
          ...session,
          status: 'waiting',
        }

        practiceRef.current = readySession
        setPracticeSession(readySession)
      } catch (caughtError) {
        if (practiceRef.current?.runId === runId) {
          transport.stop()
          practiceRef.current = null
          setPracticeSession(null)
          setError(
            caughtError instanceof Error
              ? caughtError.message
              : 'Could not start Duet.',
          )
        }
      } finally {
        if (!practiceRef.current || practiceRef.current.runId === runId) {
          setIsPreparing(false)
        }
      }
    },
    [isPreparing, playbackRate, sourceKind, sourceMidi],
  )

  const handlePlay = useCallback(async (
    forcedStartAt?: number,
    midiOverride?: ParsedMidi,
  ) => {
    const transport = transportRef.current
    const playableMidi = midiOverride ?? midi

    if (
      !playableMidi ||
      !transport ||
      (!midiOverride && isPreparing) ||
      practiceRef.current
    ) {
      return
    }

    const startAt =
      forcedStartAt ??
      (isOverview || currentTime >= playableMidi.duration ? 0 : currentTime)

    const requestId = ++playRequestIdRef.current
    const nextVisibleTracks = new Set(
      playableMidi.tracks.map((track) => track.track),
    )

    if (midiOverride) {
      transport.stop()
      transport.load(
        playableMidi.notes,
        playableMidi.duration,
        nextVisibleTracks,
      )
      transport.setVisibleTracks(nextVisibleTracks)
      setVisibleTracks(nextVisibleTracks)
    }

    setIsPreparing(true)
    setIsOverview(false)
    setKeyName(null)
    setCurrentTime(startAt)

    try {
      await transport.play(startAt)

      if (requestId !== playRequestIdRef.current) {
        transport.stop()
        return
      }

      setIsPlaying(true)
    } catch (caughtError) {
      if (requestId === playRequestIdRef.current) {
        setError(
          caughtError instanceof Error
            ? caughtError.message
            : 'Could not start playback.',
        )
      }
    } finally {
      if (requestId === playRequestIdRef.current) {
        setIsPreparing(false)
      }
    }
  }, [currentTime, isOverview, isPreparing, midi])

  const handleStartDemonstration = useCallback((
    pieceId: PracticePieceId,
    parsed?: ParsedMidi,
  ) => {
    const piece = practicePieces[pieceId]
    const demonstrationMidi = parsed ?? sourceMidi
    const tracks = demonstrationMidi
      ? practiceTracksForPiece(piece, demonstrationMidi)
      : null
    const events = tracks && demonstrationMidi
      ? createPracticeEvents(
          demonstrationMidi.notes.filter((note) => note.track === tracks.upper),
        )
      : []
    const demonstrationVoice: PracticeVoice =
      piece.trackLayout === 'all' ? 'sound1' : 'upper'
    const initialOctaveLevel = defaultOctaveLevelForVoice(
      piece,
      demonstrationVoice,
    )
    const octaveLevels = piece.automaticallySwitchOctaves
      ? choosePracticeOctaveLevels(events, initialOctaveLevel)
      : []
    const nextOctaveLevel = piece.automaticallySwitchOctaves
      ? (octaveLevels[0] ?? initialOctaveLevel)
      : initialOctaveLevel

    setActiveGameMenu(null)
    setDemonstrationPiece(piece.id)
    transportRef.current?.setPieceGain(
      piece.id === 'contrapunctus' ? CONTRAPUNCTUS_PLAYBACK_GAIN : 1,
    )
    if (demonstrationMidi) {
      transportRef.current?.setTrackSoundOverrides(
        trackSoundOverridesForMidi(demonstrationMidi),
      )
    }
    keyboardOctaveLevelRef.current = nextOctaveLevel
    setKeyboardOctaveLevel(nextOctaveLevel)
    void handlePlay(0, parsed)
  }, [handlePlay, sourceMidi])

  const handleDuetChoice = useCallback(
    async (pieceId: PracticePieceId, mode: DuetMode) => {
      if (isPreparing) {
        return
      }

      const piece = practicePieces[pieceId]
      setActiveGameMenu(null)
      const currentPiece =
        sourceKind === 'midi' &&
        sourceMidi &&
        practicePieceForFileName(sourceMidi.fileName)?.id === piece.id

      if (currentPiece) {
        if (mode === 'demonstration') {
          handleStartDemonstration(piece.id)
        } else {
          void handleStartGame(piece.id, mode)
        }
        return
      }

      setError(null)
      setIsPreparing(true)
      const requestId = ++loadRequestIdRef.current
      let startedMode = false

      try {
        const response = await fetch(
          `${import.meta.env.BASE_URL}${piece.fileName}`,
        )

        if (!response.ok) {
          throw new Error(`Could not load ${piece.fileName}.`)
        }

        const parsed = await parseMidi(
          piece.fileName,
          await response.arrayBuffer(),
        )

        if (requestId !== loadRequestIdRef.current) {
          return
        }

        loadParsedMidi(parsed, 'midi', {
          preloadKeyboard: mode !== 'demonstration',
        })

        if (mode === 'demonstration') {
          startedMode = true
          handleStartDemonstration(piece.id, parsed)
        } else {
          startedMode = true
          void handleStartGame(piece.id, mode, parsed)
        }
      } catch (caughtError) {
        if (requestId === loadRequestIdRef.current) {
          setError(
              caughtError instanceof Error
              ? caughtError.message
              : `Could not load ${piece.fileName}.`,
          )
        }
      } finally {
        if (requestId === loadRequestIdRef.current && !startedMode) {
          setIsPreparing(false)
        }
      }
    },
    [
      handleStartDemonstration,
      handleStartGame,
      isPreparing,
      loadParsedMidi,
      sourceKind,
      sourceMidi,
    ],
  )

  const handlePause = useCallback(() => {
    const transport = transportRef.current

    if (practiceRef.current) {
      clearPracticeSession()
      setCurrentTime(0)
      setIsPreparing(false)
      setIsOverview(false)
      return
    }

    if (!transport) {
      return
    }

    playRequestIdRef.current += 1
    transport.pause()
    setCurrentTime(transport.getCurrentTime())
    setIsPlaying(false)
    setIsPreparing(false)
  }, [clearPracticeSession])

  const handleStop = useCallback(() => {
    if (practiceRef.current) {
      clearPracticeSession()
      setCurrentTime(0)
      setIsPlaying(false)
      setIsPreparing(false)
      setIsOverview(false)
      return
    }

    playRequestIdRef.current += 1
    if (demonstrationPiece === 'contrapunctus') {
      transportRef.current?.stopDuetThree()
    } else {
      transportRef.current?.stop()
    }
    setCurrentTime(0)
    setIsPlaying(false)
    setIsPreparing(false)
    setIsOverview(false)
    setDemonstrationPiece(null)
  }, [clearPracticeSession, demonstrationPiece])

  const handleSeek = useCallback((time: number) => {
    if (practiceRef.current) {
      return
    }

    transportRef.current?.seek(time)
    setCurrentTime(time)
    setIsOverview(false)
  }, [])

  const handlePlaybackRateChange = useCallback((rate: PlaybackRate) => {
    if (practiceRef.current?.status === 'running') {
      return
    }

    const nextRate = normalizePlaybackRate(rate)
    setPlaybackRate(nextRate)
    transportRef.current?.setPlaybackRate(nextRate)
  }, [])

  const handleToggleReversePlayback = useCallback(() => {
    if (!sourceMidi || isPlaying || isPreparing || practiceRef.current) {
      return
    }

    const nextReversePlayback = !reversePlayback
    const transposed = transposeMidi(sourceMidi, transposeSemitones)
    const nextMidi = nextReversePlayback ? reverseMidi(transposed) : transposed

    playRequestIdRef.current += 1
    transportRef.current?.load(nextMidi.notes, nextMidi.duration, visibleTracks)
    transportRef.current?.preloadCurrentSound()
    transportRef.current?.seek(0)
    setReversePlayback(nextReversePlayback)
    setCurrentTime(0)
    setIsPlaying(false)
    setIsPreparing(false)
    setIsOverview(false)
    setKeyName(null)
  }, [
    isPlaying,
    isPreparing,
    reversePlayback,
    sourceMidi,
    transposeSemitones,
    visibleTracks,
  ])

  const handleTransposeChange = useCallback(
    (semitones: number) => {
      const nextTranspose = clampTranspose(semitones)
      setTransposeSemitones(nextTranspose)
      setKeyName(null)

      if (!sourceMidi) {
        return
      }

      if (practiceRef.current) {
        return
      }

      const transposed = transposeMidi(sourceMidi, nextTranspose)
      const nextMidi = reversePlayback ? reverseMidi(transposed) : transposed
      const transport = transportRef.current
      const wasOverview = isOverview && !isPlaying
      const transportTime = transport?.getCurrentTime() ?? currentTime
      const nextTime = wasOverview
        ? nextMidi.duration
        : Math.min(Math.max(transportTime, 0), nextMidi.duration)

      transport?.load(nextMidi.notes, nextMidi.duration, visibleTracks)
      transport?.preloadCurrentSound()
      transport?.seek(nextTime)

      if (isPlaying) {
        setIsOverview(false)
        void transport?.play(nextTime)
      } else {
        setIsOverview(wasOverview)
      }

      setCurrentTime(nextTime)
    },
    [
      currentTime,
      isOverview,
      isPlaying,
      reversePlayback,
      sourceMidi,
      visibleTracks,
    ],
  )

  const handleToggleTrack = useCallback((track: number) => {
    if (practiceRef.current) {
      return
    }

    setVisibleTracks((previous) => {
      const next = new Set(previous)

      if (next.has(track)) {
        next.delete(track)
      } else {
        next.add(track)
      }

      return next
    })
  }, [])

  const handleToggleZen = useCallback(() => {
    const app = appRef.current

    if (!app) {
      return
    }

    if (document.fullscreenElement) {
      void document.exitFullscreen().finally(() => setIsZen(false))
      return
    }

    void app.requestFullscreen().catch(() => setIsZen(false))
  }, [])

  const handleToggleKeyAnalysis = useCallback(() => {
    if (!midi || isPlaying || isPreparing || practiceRef.current) {
      return
    }

    setKeyName((current) => {
      if (current) {
        return null
      }

      return analyzeLocalKey(midi.notes, currentTime, midi.duration)?.label ?? null
    })
  }, [currentTime, isPlaying, isPreparing, midi])

  const getTransportTime = useCallback(() => {
    if (
      practiceRef.current?.status === 'running' ||
      duetTwoLeadInRef.current
    ) {
      return currentTimeRef.current
    }

    return transportRef.current?.getCurrentTime() ?? 0
  }, [])

  return (
    <main className={isZen ? 'app-shell is-zen' : 'app-shell'} ref={appRef}>
      <header className="topbar">
        <div className="game-controls">
          {Object.values(practicePieces).map((piece) => (
            <div className="game-control" key={piece.id}>
              <button
                className={
                  practiceSession?.piece === piece.id ||
                  demonstrationPiece === piece.id ||
                  activeGameMenu === piece.id
                    ? 'game-button is-active'
                    : 'game-button'
                }
                type="button"
                title={
                  practiceSession?.piece === piece.id
                    ? `End ${piece.label}`
                    : `Play ${piece.fileName}`
                }
                aria-label={
                  practiceSession?.piece === piece.id
                    ? `End ${piece.label}`
                    : `Play ${piece.fileName}`
                }
                onClick={() => handleGameButton(piece.id)}
              >
                {piece.label}
              </button>
              {activeGameMenu === piece.id ? (
                <div className="game-menu" role="menu" aria-label={`${piece.label} voice`}>
                  {practiceVoiceOptions(piece).map((voice) => (
                    <button
                      key={voice}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        void handleDuetChoice(piece.id, voice)
                      }}
                    >
                      {practiceVoiceLabel(voice)}
                    </button>
                  ))}
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      void handleDuetChoice(piece.id, 'demonstration')
                    }}
                  >
                    Demonstration
                  </button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
        <div className="topbar__sources">
        <MidiDropzone
          accept=".mid,.midi"
          defaultFileName={defaultMidiFileName}
          emptyHint=".mid / .midi"
          emptyLabel="MIDI"
          fileName={sourceKind === 'midi' ? sourceMidi?.fileName ?? null : null}
          isActive={sourceKind === 'midi'}
          isSupportedFile={isMidiFile}
          kind="midi"
          noteCount={sourceKind === 'midi' ? sourceMidi?.notes.length ?? 0 : 0}
          onFile={handleMidiFile}
          onLoadDefault={() => {
            void loadDefaultMidi()
          }}
        />
        <MidiDropzone
          accept=".csv"
          defaultFileName={defaultCsvFileName}
          emptyHint={
            <>
              .csv (h = h<sub>+</sub> − i h<sub>×</sub>)
            </>
          }
          emptyLabel="GW CSV"
          fileName={sourceKind === 'csv' ? sourceMidi?.fileName ?? null : null}
          isActive={sourceKind === 'csv'}
          isSupportedFile={isCsvFile}
          kind="csv"
          noteCount={sourceKind === 'csv' ? sourceMidi?.notes.length ?? 0 : 0}
          onFile={handleCsvFile}
          onLoadDefault={() => {
            void loadDefaultCsv()
          }}
        />
        </div>
      </header>

      <CanvasView
            midi={midi}
            currentTime={currentTime}
            isAnimating={isPlaying || isPracticeAnimating}
            isOverview={isOverview}
            getCurrentTime={getTransportTime}
            visibleTracks={visibleTracks}
            motifGroups={motifGroups}
            motifTraceEnabled={motifTraceEnabled && sourceKind === 'midi'}
            subjectTraces={duetThreeSubjectTraces}
            symmetryGroups={symmetryGroups}
            axisSymmetryEnabled={axisSymmetryEnabled && sourceKind === 'midi'}
            centerSymmetryEnabled={centerSymmetryEnabled && sourceKind === 'midi'}
            showChromaticLines={showChromaticLines}
            showStaffLines={showStaffLines}
            highlightedPitches={pressedKeyboardPitches}
            keyboardOctaveLevel={keyboardOctaveLevel}
            pressedKeyboardCodes={
              isDemonstration
                ? demonstrationPressedKeyboardCodes
                : pressedKeyboardCodes
            }
            keyboardIndexVisible={
              Boolean(midi) && (!isPlaying || isDemonstration) && !isPreparing
            }
            keyName={keyName}
            cutoffTime={
              practicePieceForFileName(midi?.fileName ?? '')?.id ===
              'contrapunctus'
                ? BACH_CUTOFF_SECONDS
                : null
            }
      />

      {error ? <p className="error-line">{error}</p> : null}

      <div className="controls-anchor" ref={controlsAnchorRef}>
        <Controls
            disabled={!midi}
            practiceActive={Boolean(practiceSession)}
            demonstrationActive={isDemonstration}
            practiceRateLocked={isPracticeAnimating}
            isPlaying={isPlaying}
            isPreparing={isPreparing}
            keyAnalysisVisible={Boolean(keyName)}
            isZen={isZen}
            currentTime={currentTime}
            duration={midi?.duration ?? 0}
            soundPreset={soundPreset}
            reversePlayback={reversePlayback}
            playbackRate={playbackRate}
            volume={volume}
            transposeSemitones={transposeSemitones}
            motifTraceEnabled={motifTraceEnabled}
            motifOccurrenceCount={motifOccurrenceCount}
            symmetryAvailable={sourceKind === 'midi'}
            axisSymmetryEnabled={axisSymmetryEnabled}
            centerSymmetryEnabled={centerSymmetryEnabled}
            showChromaticLines={showChromaticLines}
            showStaffLines={showStaffLines}
            tracks={midi?.tracks ?? []}
            visibleTracks={visibleTracks}
            onPlay={handlePlay}
            onPause={handlePause}
            onStop={handleStop}
            onToggleReversePlayback={handleToggleReversePlayback}
            onSeek={handleSeek}
            onSoundPresetChange={setSoundPreset}
            onPlaybackRateChange={handlePlaybackRateChange}
            onVolumeChange={setVolume}
            onTransposeChange={handleTransposeChange}
            onToggleMotifTrace={() =>
              setMotifTraceEnabled((enabled) => !enabled)
            }
            onToggleAxisSymmetry={() =>
              setAxisSymmetryEnabled((enabled) => !enabled)
            }
            onToggleCenterSymmetry={() =>
              setCenterSymmetryEnabled((enabled) => !enabled)
            }
            onToggleChromaticLines={() =>
              setShowChromaticLines((enabled) => !enabled)
            }
            onToggleStaffLines={() => setShowStaffLines((enabled) => !enabled)}
            onToggleKeyAnalysis={handleToggleKeyAnalysis}
            onToggleTrack={handleToggleTrack}
            onToggleZen={handleToggleZen}
        />
        {activeSequence && practiceSequencePosition ? (
          <PracticeSequence
            sequence={activeSequence}
            position={practiceSequencePosition}
          />
        ) : null}
      </div>
    </main>
  )
}

export default App
