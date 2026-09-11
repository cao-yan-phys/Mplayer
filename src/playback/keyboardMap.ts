export interface KeyboardBinding {
  code: string
  label: string
  basePitch: number
}

const keyboardSemitoneEntries: ReadonlyArray<KeyboardBinding> = [
  { code: 'KeyZ', label: 'Z', basePitch: 36 },
  { code: 'KeyX', label: 'X', basePitch: 38 },
  { code: 'KeyC', label: 'C', basePitch: 40 },
  { code: 'KeyV', label: 'V', basePitch: 41 },
  { code: 'KeyR', label: 'R', basePitch: 42 },
  { code: 'KeyB', label: 'B', basePitch: 43 },
  { code: 'KeyN', label: 'N', basePitch: 45 },
  { code: 'KeyM', label: 'M', basePitch: 47 },
  { code: 'KeyA', label: 'A', basePitch: 48 },
  { code: 'KeyW', label: 'W', basePitch: 49 },
  { code: 'KeyS', label: 'S', basePitch: 50 },
  { code: 'KeyE', label: 'E', basePitch: 51 },
  { code: 'KeyD', label: 'D', basePitch: 52 },
  { code: 'KeyF', label: 'F', basePitch: 53 },
  { code: 'KeyT', label: 'T', basePitch: 54 },
  { code: 'KeyG', label: 'G', basePitch: 55 },
  { code: 'KeyY', label: 'Y', basePitch: 56 },
  { code: 'KeyH', label: 'H', basePitch: 57 },
  { code: 'KeyU', label: 'U', basePitch: 58 },
  { code: 'KeyJ', label: 'J', basePitch: 59 },
  { code: 'KeyK', label: 'K', basePitch: 60 },
  { code: 'KeyO', label: 'O', basePitch: 61 },
  { code: 'KeyL', label: 'L', basePitch: 62 },
  { code: 'KeyP', label: 'P', basePitch: 63 },
  { code: 'Semicolon', label: ';', basePitch: 64 },
  { code: 'Quote', label: "'", basePitch: 65 },
  { code: 'BracketRight', label: ']', basePitch: 66 },
  { code: 'Backslash', label: '\\', basePitch: 67 },
]

const keyboardSemitones = new Map(
  keyboardSemitoneEntries.map(({ code, basePitch }) => [code, basePitch]),
)

export const KEYBOARD_MIN_MIDI = 21
export const KEYBOARD_MAX_MIDI = 108
export const KEYBOARD_OCTAVE_MIN_LEVEL = 1
export const KEYBOARD_OCTAVE_MAX_LEVEL = 5
export const DEFAULT_KEYBOARD_OCTAVE_LEVEL = 3

const KEYBOARD_BASE_MIN_MIDI = 36
const KEYBOARD_BASE_MAX_MIDI = 67

export const clampKeyboardOctaveLevel = (octaveLevel: number) =>
  Math.min(
    Math.max(Math.round(octaveLevel), KEYBOARD_OCTAVE_MIN_LEVEL),
    KEYBOARD_OCTAVE_MAX_LEVEL,
  )

export const keyboardOctaveLevelForCode = (code: string) => {
  if (!/^Digit\d$/.test(code)) {
    return undefined
  }

  const level = Number(code.at(-1))

  return level >= KEYBOARD_OCTAVE_MIN_LEVEL &&
    level <= KEYBOARD_OCTAVE_MAX_LEVEL
    ? level
    : undefined
}

export const keyboardOctaveStepForCode = (code: string) => {
  if (code === 'Equal' || code === 'NumpadAdd') {
    return 1
  }

  if (code === 'Minus' || code === 'NumpadSubtract') {
    return -1
  }

  return undefined
}

const getOctaveShift = (octaveLevel: number) =>
  (clampKeyboardOctaveLevel(octaveLevel) - DEFAULT_KEYBOARD_OCTAVE_LEVEL) * 12

export const keyboardRangeForOctaveLevel = (octaveLevel: number) => {
  const shift = getOctaveShift(octaveLevel)

  return {
    min: Math.max(KEYBOARD_MIN_MIDI, KEYBOARD_BASE_MIN_MIDI + shift),
    max: Math.min(KEYBOARD_MAX_MIDI, KEYBOARD_BASE_MAX_MIDI + shift),
  }
}

export const keyboardPitchForCode = (code: string, octaveLevel = 3) => {
  const pitch = keyboardSemitones.get(code)

  if (pitch === undefined) {
    return undefined
  }

  const shiftedPitch = pitch + getOctaveShift(octaveLevel)

  return shiftedPitch >= KEYBOARD_MIN_MIDI && shiftedPitch <= KEYBOARD_MAX_MIDI
    ? shiftedPitch
    : undefined
}

const pitchClassNames = [
  'C',
  'C#',
  'D',
  'D#',
  'E',
  'F',
  'F#',
  'G',
  'G#',
  'A',
  'A#',
  'B',
]

export const midiPitchName = (pitch: number) =>
  `${pitchClassNames[pitch % 12]}${Math.floor(pitch / 12) - 1}`

export const keyboardBindingsForOctaveLevel = (octaveLevel: number) =>
  keyboardSemitoneEntries.map((binding) => {
    const shiftedPitch = binding.basePitch + getOctaveShift(octaveLevel)
    const pitch = keyboardPitchForCode(binding.code, octaveLevel)

    return {
      ...binding,
      pitch,
      pitchName: midiPitchName(shiftedPitch),
      isPlayable: pitch !== undefined,
    }
  })

export const isEditableKeyboardTarget = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) {
    return false
  }

  return Boolean(
    target.closest('input, select, textarea, [contenteditable="true"]'),
  )
}
