import type { ParsedMidi } from '../midi/noteTypes'
import { roleColor } from './coordinate'

interface LiquidScoreRenderOptions {
  ctx: CanvasRenderingContext2D
  width: number
  height: number
  midi: ParsedMidi
  currentTime: number
  visibleTracks: ReadonlySet<number>
  isAnimating: boolean
  keyboardPitches: ReadonlySet<number>
}

interface RgbColor {
  red: number
  green: number
  blue: number
}

const DYE_RESOLUTION = 2
const GRID_WIDTH = 176 * DYE_RESOLUTION
const MIN_GRID_HEIGHT = 84 * DYE_RESOLUTION
const MAX_GRID_HEIGHT = 128 * DYE_RESOLUTION
const HISTORY_SECONDS = 11
const MAX_STEP_SECONDS = 1 / 28
const MANUAL_FLOW_MINIMUM = 0.72
const MANUAL_FLOW_TAIL_SECONDS = HISTORY_SECONDS

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max)

const colorFromHex = (hex: string): RgbColor => {
  const value = hex.replace('#', '')

  return {
    red: Number.parseInt(value.slice(0, 2), 16) / 255,
    green: Number.parseInt(value.slice(2, 4), 16) / 255,
    blue: Number.parseInt(value.slice(4, 6), 16) / 255,
  }
}

const sample = (
  values: Float32Array,
  width: number,
  height: number,
  x: number,
  y: number,
) => {
  const clampedX = clamp(x, 0, width - 1)
  const clampedY = clamp(y, 0, height - 1)
  const left = Math.floor(clampedX)
  const top = Math.floor(clampedY)
  const right = Math.min(left + 1, width - 1)
  const bottom = Math.min(top + 1, height - 1)
  const xBlend = clampedX - left
  const yBlend = clampedY - top
  const topValue =
    values[top * width + left]! * (1 - xBlend) +
    values[top * width + right]! * xBlend
  const bottomValue =
    values[bottom * width + left]! * (1 - xBlend) +
    values[bottom * width + right]! * xBlend

  return topValue * (1 - yBlend) + bottomValue * yBlend
}

const visibleTrackKey = (tracks: ReadonlySet<number>) =>
  [...tracks].sort((left, right) => left - right).join(',')

export class LiquidScoreRenderer {
  private gridWidth = 0

  private gridHeight = 0

  private surface: HTMLCanvasElement | null = null

  private surfaceContext: CanvasRenderingContext2D | null = null

  private imageData: ImageData | null = null

  private density = new Float32Array(0)

  private red = new Float32Array(0)

  private green = new Float32Array(0)

  private blue = new Float32Array(0)

  private nextDensity = new Float32Array(0)

  private nextRed = new Float32Array(0)

  private nextGreen = new Float32Array(0)

  private nextBlue = new Float32Array(0)

  private signature = ''

  private lastMusicTime: number | null = null

  private wasAnimating = false

  private previousKeyboardPitches = new Set<number>()

  private keyboardStartedAt = new Map<number, number>()

  private lastManualFrameTime: number | null = null

  private manualFlowUntil = 0

  private pitchMin = 36

  private pitchMax = 84

  reset() {
    this.signature = ''
    this.lastMusicTime = null
    this.wasAnimating = false
    this.previousKeyboardPitches.clear()
    this.keyboardStartedAt.clear()
    this.lastManualFrameTime = null
    this.manualFlowUntil = 0
    this.density.fill(0)
    this.red.fill(0)
    this.green.fill(0)
    this.blue.fill(0)
  }

  render({
    ctx,
    width,
    height,
    midi,
    currentTime,
    visibleTracks,
    isAnimating,
    keyboardPitches,
  }: LiquidScoreRenderOptions) {
    this.prepare(width, height, midi, visibleTracks)

    if (!isAnimating) {
      const now = performance.now() / 1000

      if (this.wasAnimating) {
        this.clearDye()
        this.previousKeyboardPitches.clear()
        this.keyboardStartedAt.clear()
        this.manualFlowUntil = 0
        this.lastManualFrameTime = now
      }

      const manualStartTime = this.lastManualFrameTime ?? now

      if (now > manualStartTime) {
        this.advanceKeyboardFlow(
          manualStartTime,
          now,
          this.previousKeyboardPitches,
        )
      }

      this.captureKeyboardPitches(keyboardPitches, now)
      this.lastManualFrameTime = now
      this.lastMusicTime = currentTime
      this.wasAnimating = false
      this.paint(ctx, width, height)
      return
    }

    if (!this.wasAnimating) {
      this.clearDye()
      this.lastMusicTime = currentTime
    }

    this.previousKeyboardPitches.clear()
    this.keyboardStartedAt.clear()
    this.lastManualFrameTime = null
    this.manualFlowUntil = 0
    this.wasAnimating = true

    const previousTime = this.lastMusicTime
    const isDiscontinuous =
      previousTime === null ||
      currentTime < previousTime - 0.001 ||
      (!isAnimating && Math.abs(currentTime - previousTime) > 0.001) ||
      currentTime - previousTime > 0.85

    if (isDiscontinuous) {
      this.clearDye()
      this.seedVisibleHistory(midi, currentTime, visibleTracks)
    } else if (currentTime > previousTime) {
      this.advance(midi, previousTime, currentTime, visibleTracks)
    }

    this.lastMusicTime = currentTime
    this.paint(ctx, width, height)
  }

  private prepare(
    width: number,
    height: number,
    midi: ParsedMidi,
    visibleTracks: ReadonlySet<number>,
  ) {
    const nextWidth = GRID_WIDTH
    const nextHeight = clamp(
      Math.round((nextWidth * height) / Math.max(width, 1)),
      MIN_GRID_HEIGHT,
      MAX_GRID_HEIGHT,
    )
    const nextSignature = [
      midi.fileName,
      midi.notes.length,
      midi.pitchRange.min,
      midi.pitchRange.max,
      nextWidth,
      nextHeight,
      visibleTrackKey(visibleTracks),
    ].join(':')

    if (nextSignature === this.signature) {
      return
    }

    this.signature = nextSignature
    this.gridWidth = nextWidth
    this.gridHeight = nextHeight
    this.pitchMin = midi.pitchRange.min - 5
    this.pitchMax = midi.pitchRange.max + 5

    const cellCount = nextWidth * nextHeight
    this.density = new Float32Array(cellCount)
    this.red = new Float32Array(cellCount)
    this.green = new Float32Array(cellCount)
    this.blue = new Float32Array(cellCount)
    this.nextDensity = new Float32Array(cellCount)
    this.nextRed = new Float32Array(cellCount)
    this.nextGreen = new Float32Array(cellCount)
    this.nextBlue = new Float32Array(cellCount)
    this.surface = document.createElement('canvas')
    this.surface.width = nextWidth
    this.surface.height = nextHeight
    this.surfaceContext = this.surface.getContext('2d')
    this.imageData = this.surfaceContext?.createImageData(nextWidth, nextHeight) ?? null
    this.lastMusicTime = null
  }

  private clearDye() {
    this.density.fill(0)
    this.red.fill(0)
    this.green.fill(0)
    this.blue.fill(0)
  }

  private sourceX() {
    return this.gridWidth - 7
  }

  private flowSpeed() {
    return this.sourceX() / HISTORY_SECONDS
  }

  private pitchToY(pitch: number) {
    const span = Math.max(this.pitchMax - this.pitchMin, 1)
    const normalized = clamp((pitch - this.pitchMin) / span, 0, 1)

    return 3 + (1 - normalized) * (this.gridHeight - 7)
  }

  private splat(
    x: number,
    y: number,
    color: RgbColor,
    strength: number,
    radius: number,
  ) {
    const left = Math.max(0, Math.floor(x - radius * 2.2))
    const right = Math.min(this.gridWidth - 1, Math.ceil(x + radius * 2.2))
    const top = Math.max(0, Math.floor(y - radius * 2.2))
    const bottom = Math.min(this.gridHeight - 1, Math.ceil(y + radius * 2.2))
    const falloff = Math.max(radius * radius * 1.25, 0.0001)

    for (let row = top; row <= bottom; row += 1) {
      for (let column = left; column <= right; column += 1) {
        const distanceSquared = (column - x) ** 2 + (row - y) ** 2
        const amount = strength * Math.exp(-distanceSquared / falloff)
        const index = row * this.gridWidth + column

        this.density[index] += amount
        this.red[index] += color.red * amount
        this.green[index] += color.green * amount
        this.blue[index] += color.blue * amount
      }
    }
  }

  private seedVisibleHistory(
    midi: ParsedMidi,
    currentTime: number,
    visibleTracks: ReadonlySet<number>,
  ) {
    const earliestTime = currentTime - HISTORY_SECONDS

    midi.notes.forEach((note) => {
      if (
        !visibleTracks.has(note.track) ||
        note.end <= earliestTime ||
        note.start >= currentTime
      ) {
        return
      }

      const start = Math.max(note.start, earliestTime)
      const end = Math.min(note.end, currentTime)
      const count = Math.max(1, Math.ceil((end - start) * 9 * DYE_RESOLUTION))
      const color = colorFromHex(roleColor(note.role, note.track))
      const radius = (0.36 + note.velocity * 0.41) * DYE_RESOLUTION

      for (let index = 0; index <= count; index += 1) {
        const time = start + ((end - start) * index) / count
        const x = this.sourceX() - (currentTime - time) * this.flowSpeed()
        const y = this.pitchToY(note.pitch)
        this.splat(x, y, color, 0.24 + note.velocity * 0.18, radius)
      }
    })
  }

  private injectActiveNotes(
    midi: ParsedMidi,
    time: number,
    visibleTracks: ReadonlySet<number>,
    deltaTime: number,
  ) {
    midi.notes.forEach((note) => {
      if (
        !visibleTracks.has(note.track) ||
        note.start > time ||
        note.end <= time
      ) {
        return
      }

      const color = colorFromHex(roleColor(note.role, note.track))
      const radius = (0.36 + note.velocity * 0.41) * DYE_RESOLUTION
      const turbulence =
        Math.sin(time * 2.3 + note.pitch * 0.41) * 0.85 * DYE_RESOLUTION
      this.splat(
        this.sourceX() + turbulence * 0.35,
        this.pitchToY(note.pitch) + turbulence,
        color,
        deltaTime * (4.4 + note.velocity * 2),
        radius,
      )
    })
  }

  hasActiveKeyboardFlow() {
    return performance.now() / 1000 < this.manualFlowUntil
  }

  private captureKeyboardPitches(
    keyboardPitches: ReadonlySet<number>,
    now: number,
  ) {
    const color = colorFromHex(roleColor('melody', 0))
    const radius = 0.72 * DYE_RESOLUTION

    keyboardPitches.forEach((pitch) => {
      if (this.previousKeyboardPitches.has(pitch)) {
        return
      }

      this.keyboardStartedAt.set(pitch, now)
      this.manualFlowUntil = Math.max(
        this.manualFlowUntil,
        now + MANUAL_FLOW_MINIMUM,
      )
      this.splat(
        this.sourceX(),
        this.pitchToY(pitch),
        color,
        1.12,
        radius,
      )
    })

    this.previousKeyboardPitches.forEach((pitch) => {
      if (keyboardPitches.has(pitch)) {
        return
      }

      this.keyboardStartedAt.delete(pitch)
      this.manualFlowUntil = Math.max(
        this.manualFlowUntil,
        now + MANUAL_FLOW_TAIL_SECONDS,
      )
    })

    if (keyboardPitches.size > 0) {
      this.manualFlowUntil = Math.max(
        this.manualFlowUntil,
        now + MANUAL_FLOW_MINIMUM,
      )
    }

    this.previousKeyboardPitches = new Set(keyboardPitches)
  }

  private injectKeyboardPitches(
    keyboardPitches: ReadonlySet<number>,
    time: number,
    deltaTime: number,
  ) {
    const color = colorFromHex(roleColor('melody', 0))
    const radius = 0.72 * DYE_RESOLUTION

    keyboardPitches.forEach((pitch) => {
      const turbulence =
        Math.sin(time * 2.3 + pitch * 0.41) * 0.85 * DYE_RESOLUTION

      this.splat(
        this.sourceX() + turbulence * 0.35,
        this.pitchToY(pitch) + turbulence,
        color,
        deltaTime * 7.2,
        radius,
      )
    })
  }

  private velocityAt(x: number, y: number, time: number) {
    const horizontal = x / Math.max(this.gridWidth - 1, 1)
    const vertical = y / Math.max(this.gridHeight - 1, 1)
    const phase = time * 1.85
    const longWave = Math.sin(vertical * 13 + phase)
    const crossWave = Math.cos(horizontal * 17 - vertical * 9 - phase * 0.72)
    const whirl = Math.sin(horizontal * 27 + vertical * 19 + phase * 1.31)

    return {
      x:
        -this.flowSpeed() +
        (longWave * 2.45 + crossWave * 1.25) * DYE_RESOLUTION,
      y: (crossWave * 2.9 + whirl * 2.15) * DYE_RESOLUTION,
    }
  }

  private advance(
    midi: ParsedMidi,
    startTime: number,
    endTime: number,
    visibleTracks: ReadonlySet<number>,
  ) {
    this.evolve(startTime, endTime, (time, deltaTime) => {
      this.injectActiveNotes(midi, time, visibleTracks, deltaTime)
    })
  }

  private advanceKeyboardFlow(
    startTime: number,
    endTime: number,
    keyboardPitches: ReadonlySet<number>,
  ) {
    this.evolve(startTime, endTime, (time, deltaTime) => {
      this.injectKeyboardPitches(keyboardPitches, time, deltaTime)
    })
  }

  private evolve(
    startTime: number,
    endTime: number,
    inject: (time: number, deltaTime: number) => void,
  ) {
    const delta = endTime - startTime
    const steps = Math.max(1, Math.ceil(delta / MAX_STEP_SECONDS))
    const stepDuration = delta / steps

    for (let step = 0; step < steps; step += 1) {
      const time = startTime + stepDuration * (step + 1)
      const diffusion = clamp(stepDuration * 1.15, 0, 0.065)
      const fade = Math.pow(0.875, stepDuration)

      for (let row = 0; row < this.gridHeight; row += 1) {
        for (let column = 0; column < this.gridWidth; column += 1) {
          const index = row * this.gridWidth + column
          const velocity = this.velocityAt(column, row, time)
          const sourceX = column - velocity.x * stepDuration
          const sourceY = row - velocity.y * stepDuration
          const left = row * this.gridWidth + Math.max(column - 1, 0)
          const right = row * this.gridWidth + Math.min(column + 1, this.gridWidth - 1)
          const top = Math.max(row - 1, 0) * this.gridWidth + column
          const bottom = Math.min(row + 1, this.gridHeight - 1) * this.gridWidth + column

          const advectedDensity = sample(
            this.density,
            this.gridWidth,
            this.gridHeight,
            sourceX,
            sourceY,
          )
          const advectedRed = sample(
            this.red,
            this.gridWidth,
            this.gridHeight,
            sourceX,
            sourceY,
          )
          const advectedGreen = sample(
            this.green,
            this.gridWidth,
            this.gridHeight,
            sourceX,
            sourceY,
          )
          const advectedBlue = sample(
            this.blue,
            this.gridWidth,
            this.gridHeight,
            sourceX,
            sourceY,
          )
          const neighborDensity =
            (this.density[left]! +
              this.density[right]! +
              this.density[top]! +
              this.density[bottom]!) /
            4
          const neighborRed =
            (this.red[left]! + this.red[right]! + this.red[top]! + this.red[bottom]!) /
            4
          const neighborGreen =
            (this.green[left]! +
              this.green[right]! +
              this.green[top]! +
              this.green[bottom]!) /
            4
          const neighborBlue =
            (this.blue[left]! + this.blue[right]! + this.blue[top]! + this.blue[bottom]!) /
            4

          this.nextDensity[index] =
            (advectedDensity * (1 - diffusion) + neighborDensity * diffusion) * fade
          this.nextRed[index] =
            (advectedRed * (1 - diffusion) + neighborRed * diffusion) * fade
          this.nextGreen[index] =
            (advectedGreen * (1 - diffusion) + neighborGreen * diffusion) * fade
          this.nextBlue[index] =
            (advectedBlue * (1 - diffusion) + neighborBlue * diffusion) * fade
        }
      }

      ;[
        this.density,
        this.nextDensity,
      ] = [this.nextDensity, this.density]
      ;[this.red, this.nextRed] = [this.nextRed, this.red]
      ;[this.green, this.nextGreen] = [this.nextGreen, this.green]
      ;[this.blue, this.nextBlue] = [this.nextBlue, this.blue]
      inject(time, stepDuration)
    }
  }

  private paint(ctx: CanvasRenderingContext2D, width: number, height: number) {
    if (!this.surface || !this.surfaceContext || !this.imageData) {
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, width, height)
      return
    }

    const pixels = this.imageData.data

    for (let index = 0; index < this.density.length; index += 1) {
      const density = this.density[index]!
      const pixel = index * 4
      const alpha = (1 - Math.exp(-density * 3.4)) ** 0.42
      const pigment = Math.max(density, 0.0001)
      const red = clamp((this.red[index]! / pigment) * 255, 0, 255)
      const green = clamp((this.green[index]! / pigment) * 255, 0, 255)
      const blue = clamp((this.blue[index]! / pigment) * 255, 0, 255)

      pixels[pixel] = Math.round(255 + (red - 255) * alpha)
      pixels[pixel + 1] = Math.round(255 + (green - 255) * alpha)
      pixels[pixel + 2] = Math.round(255 + (blue - 255) * alpha)
      pixels[pixel + 3] = 255
    }

    this.surfaceContext.putImageData(this.imageData, 0, 0)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, width, height)
    ctx.save()
    ctx.imageSmoothingEnabled = true
    ctx.drawImage(this.surface, 0, 0, width, height)
    ctx.restore()
  }
}
