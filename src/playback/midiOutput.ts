import type { MidiNote } from '../midi/noteTypes'

export interface MidiOutputPort {
  id: string
  name: string
}

const clampMidiByte = (value: number) =>
  Math.min(127, Math.max(0, Math.round(value)))

export class ExternalMidiOutput {
  private access: MIDIAccess | null = null

  private output: MIDIOutput | null = null

  private scheduledTimers = new Set<number>()

  private generation = 0

  async listPorts(): Promise<MidiOutputPort[]> {
    if (!('requestMIDIAccess' in navigator)) {
      throw new Error('Web MIDI is unavailable.')
    }

    if (!this.access) {
      this.access = await navigator.requestMIDIAccess()
    }

    const ports = [...this.access.outputs.values()].map((output) => ({
      id: output.id,
      name: output.name || 'MIDI output',
    }))

    if (this.output && !this.access.outputs.has(this.output.id)) {
      this.stopAll()
      this.output = null
    }

    return ports
  }

  async selectPort(id: string | null) {
    const ports = await this.listPorts()

    this.stopAll()
    this.output = id ? this.access?.outputs.get(id) ?? null : null

    if (id && !this.output) {
      throw new Error('MIDI output is unavailable.')
    }

    return ports
  }

  hasSelectedPort() {
    return this.output !== null
  }

  scheduleNote(note: MidiNote, playbackTime: number, playbackRate: number) {
    const output = this.output

    if (!output || note.end <= playbackTime) {
      return
    }

    const startDelay =
      (Math.max(note.start, playbackTime) - playbackTime) /
      Math.max(playbackRate, 0.0001)
    const duration =
      (note.end - Math.max(note.start, playbackTime)) /
      Math.max(playbackRate, 0.0001)
    const pitch = clampMidiByte(note.pitch)
    const velocity = Math.max(1, clampMidiByte(note.velocity * 127))
    const generation = this.generation

    this.schedule(output, generation, startDelay * 1000, () => {
      output.send([0x90, pitch, velocity])
    })
    this.schedule(output, generation, (startDelay + duration) * 1000, () => {
      output.send([0x80, pitch, 0])
    })
  }

  noteOn(pitch: number, velocity: number) {
    const output = this.output

    if (!output) {
      return
    }

    try {
      output.send([0x90, clampMidiByte(pitch), Math.max(1, clampMidiByte(velocity * 127))])
    } catch {
    }
  }

  noteOff(pitch: number) {
    const output = this.output

    if (!output) {
      return
    }

    try {
      output.send([0x80, clampMidiByte(pitch), 0])
    } catch {
    }
  }

  stopAll() {
    this.generation += 1
    this.scheduledTimers.forEach((timer) => window.clearTimeout(timer))
    this.scheduledTimers.clear()

    const output = this.output

    if (!output) {
      return
    }

    try {
      for (let channel = 0; channel < 16; channel += 1) {
        output.send([0xb0 + channel, 123, 0])
        output.send([0xb0 + channel, 120, 0])
      }
    } catch {
    }
  }

  private schedule(
    output: MIDIOutput,
    generation: number,
    delay: number,
    send: () => void,
  ) {
    const timer = window.setTimeout(() => {
      this.scheduledTimers.delete(timer)

      if (this.generation !== generation || this.output !== output) {
        return
      }

      try {
        send()
      } catch {
      }
    }, Math.max(0, delay))

    this.scheduledTimers.add(timer)
  }
}
