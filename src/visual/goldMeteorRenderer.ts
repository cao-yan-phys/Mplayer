import type { MidiNote, PitchRange } from '../midi/noteTypes'
import { createCoordinateSystem } from './coordinate'

interface GoldMeteorRenderOptions {
  ctx: CanvasRenderingContext2D
  width: number
  height: number
  notes: MidiNote[]
  duration: number
  pitchRange: PitchRange
  currentTime: number
  visibleTracks: ReadonlySet<number>
  isAnimating: boolean
  keyboardPitches: ReadonlySet<number>
}

const MAX_LIFETIME = 3.62
const MAX_WAKE_LIFETIME = 1.45
const MAX_AFTERGLOW_LIFETIME = 0.58
const MAX_RENDER_AGE = MAX_LIFETIME * 0.86 + MAX_AFTERGLOW_LIFETIME
const KEYBOARD_METEOR_MINIMUM_FADE = 0.42
const SPRITE_WIDTH = 256
const TAIL_SPRITE_HEIGHT = 44
const HEAD_SPRITE_WIDTH = 128
const HEAD_SPRITE_HEIGHT = 64

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max)

const lowerBound = (notes: MidiNote[], time: number) => {
  let lower = 0
  let upper = notes.length

  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2)

    if (notes[middle].start < time) {
      lower = middle + 1
    } else {
      upper = middle
    }
  }

  return lower
}

const stableVariation = (note: MidiNote) => {
  const value = Math.sin(
    note.start * 12.9898 + note.pitch * 78.233 + note.track * 37.719,
  ) * 43758.5453

  return value - Math.floor(value)
}

export class GoldMeteorRenderer {
  private sourceNotes: MidiNote[] | null = null
  private sortedNotes: MidiNote[] = []
  private velocityFloor = 0
  private velocityCeiling = 1
  private tailSprites = new Map<number, HTMLCanvasElement>()
  private headSprite: HTMLCanvasElement | null = null
  private sky: HTMLImageElement | null = null
  private skyReady = false
  private skyCallbacks: Array<() => void> = []
  private previousKeyboardPitches = new Set<number>()
  private keyboardMeteors: Array<{
    pitch: number
    startedAt: number
    releasedAt: number | null
  }> = []
  private wasAnimating = false
  private playbackStartTime: number | null = null

  preloadSky(onReady?: () => void) {
    if (this.skyReady) {
      onReady?.()
      return
    }

    if (onReady) {
      this.skyCallbacks.push(onReady)
    }

    if (this.sky) {
      return
    }

    const sky = new Image()
    sky.decoding = 'async'
    sky.addEventListener('load', () => {
      this.skyReady = true
      this.skyCallbacks.splice(0).forEach((callback) => callback())
    })
    sky.src = `${import.meta.env.BASE_URL}sky.jpg`
    this.sky = sky
  }

  render({
    ctx,
    width,
    height,
    notes,
    duration,
    pitchRange,
    currentTime,
    visibleTracks,
    isAnimating,
    keyboardPitches,
  }: GoldMeteorRenderOptions) {
    this.prepare(notes)
    this.drawSky(ctx, width, height)

    if (!isAnimating) {
      this.wasAnimating = false
      this.captureKeyboardPitches(keyboardPitches)
      this.drawKeyboardMeteors(ctx, width, height, pitchRange)
      return
    }

    if (!this.wasAnimating) {
      this.playbackStartTime = currentTime
    }

    this.wasAnimating = true
    this.previousKeyboardPitches.clear()
    this.keyboardMeteors = []

    const headSprite = this.getHeadSprite()
    const coordinates = createCoordinateSystem(
      width,
      height,
      duration,
      currentTime,
      pitchRange,
      Math.max(width / 13.5, 44),
    )
    const startIndex = lowerBound(this.sortedNotes, currentTime - MAX_RENDER_AGE)

    for (let index = startIndex; index < this.sortedNotes.length; index += 1) {
      const note = this.sortedNotes[index]

      if (note.start > currentTime) {
        break
      }

      if (!visibleTracks.has(note.track)) {
        continue
      }

      if (
        this.playbackStartTime !== null &&
        note.start < this.playbackStartTime
      ) {
        continue
      }

      const age = currentTime - note.start
      const lifetime = clamp(
        1.98 + Math.sqrt(Math.max(note.duration, 0)) * 0.84,
        2.1,
        MAX_LIFETIME,
      )
      const variation = stableVariation(note) * 2 - 1
      const tailSprite = this.getTailSprite(variation)
      const velocity = this.normalizeVelocity(note.velocity)
      const burnoutProgress = clamp(
        0.56 + variation * 0.09 + velocity * 0.02,
        0.42,
        0.7,
      )
      const terminalAge = lifetime * burnoutProgress
      const wakeLifetime = clamp(
        note.duration * 0.6,
        0.16,
        MAX_WAKE_LIFETIME,
      )
      const afterglowLifetime = clamp(
        0.22 + note.duration * 0.08,
        0.24,
        MAX_AFTERGLOW_LIFETIME,
      )

      if (age < 0 || age >= terminalAge + afterglowLifetime) {
        continue
      }

      const headActive = age < terminalAge
      const headProgress = Math.min(age / lifetime, burnoutProgress)
      const trailProgress = Math.max(0, headProgress - wakeLifetime / lifetime)
      const travel = width + 132
      const headX = width + 26 - travel * Math.pow(headProgress, 1.17)
      const anchorX = width + 26 - travel * Math.pow(0.5, 1.17)
      const pathAngle = Math.PI - Math.PI / 24
      const slope = Math.tan(Math.PI / 24)
      const anchorY = coordinates.pitchToY(note.pitch, note.role)
      const headY = anchorY + (anchorX - headX) * slope
      const trailX = width + 26 - travel * Math.pow(trailProgress, 1.17)
      const trailY = anchorY + (anchorX - trailX) * slope
      const fadeIn = clamp(age / 0.075, 0, 1)
      const flightFade = 1 - Math.pow(headProgress, 1.15) * 0.68
      const afterglowAge = Math.max(0, age - terminalAge)
      const tailHistoryDuration = (headProgress - trailProgress) * lifetime
      const tailLength = Math.hypot(headX - trailX, headY - trailY)
      const tailAlpha =
        (0.28 + Math.pow(velocity, 2.1) * 0.8) *
        fadeIn *
        flightFade
      const innerTailAlpha =
        (0.22 + Math.pow(velocity, 1.7) * 0.5) *
        fadeIn *
        flightFade
      const tailFlicker =
        0.92 +
        0.08 * Math.sin(age * (7.2 + velocity * 5.4) + variation * 6.1)
      const thickness = 2.3 + Math.pow(velocity, 1.5) * 3.8
      const innerThickness = 1 + Math.pow(velocity, 1.3) * 1.4
      const flareProgress = clamp(
        (headProgress - (burnoutProgress - 0.09)) / 0.09,
        0,
        1,
      )
      const flare =
        1 +
        (0.04 + Math.pow(velocity, 1.7) * 0.12) *
          Math.sin(flareProgress * Math.PI)
      const terminalFade = headActive
        ? clamp((terminalAge - age) / 0.26, 0, 1)
        : 0
      const headThickness =
        (1.5 + Math.pow(velocity, 1.5) * 2.6) *
        (1 + (flare - 1) * 0.12)
      const headLength = headThickness * 1.55
      const headAlpha =
        (0.44 + Math.pow(velocity, 1.65) * 0.56) *
        fadeIn *
        flightFade *
        terminalFade *
        flare
      const headFlicker =
        0.82 +
        0.18 * Math.sin(age * (9.6 + velocity * 6.8) + variation * 9.7)

      if (headX < -tailLength - 40 || headX > width + 44) {
        continue
      }

      ctx.save()
      ctx.globalCompositeOperation = 'lighter'
      ctx.translate(headX, headY)
      ctx.rotate(pathAngle)
      const drawTailSlice = (start: number, end: number, opacity: number) => {
        const sourceX = SPRITE_WIDTH * start
        const sourceWidth = SPRITE_WIDTH * (end - start)
        const outerX = -tailLength + tailLength * start
        const outerWidth = tailLength * (end - start)

        ctx.globalAlpha = tailAlpha * tailFlicker * 0.5 * opacity
        ctx.drawImage(
          tailSprite,
          sourceX,
          0,
          sourceWidth,
          TAIL_SPRITE_HEIGHT,
          outerX,
          -(thickness * 1.5) / 2,
          outerWidth,
          thickness * 1.5,
        )

        const innerLength = tailLength * 0.88
        const innerX = -innerLength + innerLength * start
        const innerWidth = innerLength * (end - start)
        ctx.globalAlpha = innerTailAlpha * tailFlicker * opacity
        ctx.drawImage(
          tailSprite,
          sourceX,
          0,
          sourceWidth,
          TAIL_SPRITE_HEIGHT,
          innerX,
          -innerThickness / 2,
          innerWidth,
          innerThickness,
        )
      }
      if (tailLength > 0) {
        if (headActive) {
          drawTailSlice(0, 1, 1)
        } else {
          const sliceCount = 32

          for (let slice = 0; slice < sliceCount; slice += 1) {
            const start = slice / sliceCount
            const end = (slice + 1) / sliceCount
            const center = (start + end) / 2
            const localAge =
              afterglowAge + (1 - center) * tailHistoryDuration
            const opacity = Math.exp(
              -Math.pow(localAge / afterglowLifetime, 1.05) * 6.2,
            )

            if (opacity > 0.002) {
              drawTailSlice(start, end, opacity)
            }
          }
        }
      }
      if (headActive) {
        ctx.globalAlpha = headAlpha * headFlicker
        ctx.drawImage(
          headSprite,
          -headLength / 2,
          -headThickness / 2,
          headLength,
          headThickness,
        )
      }
      ctx.restore()
    }
  }

  hasActiveKeyboardMeteors() {
    this.pruneKeyboardMeteors(performance.now() / 1000)
    return this.keyboardMeteors.length > 0
  }

  private captureKeyboardPitches(keyboardPitches: ReadonlySet<number>) {
    const now = performance.now() / 1000

    keyboardPitches.forEach((pitch) => {
      if (!this.previousKeyboardPitches.has(pitch)) {
        this.keyboardMeteors.push({
          pitch,
          startedAt: now,
          releasedAt: null,
        })
      }
    })

    this.previousKeyboardPitches.forEach((pitch) => {
      if (keyboardPitches.has(pitch)) {
        return
      }

      for (let index = this.keyboardMeteors.length - 1; index >= 0; index -= 1) {
        const meteor = this.keyboardMeteors[index]

        if (meteor.pitch === pitch && meteor.releasedAt === null) {
          meteor.releasedAt = now
          break
        }
      }
    })

    this.previousKeyboardPitches = new Set(keyboardPitches)
    this.pruneKeyboardMeteors(now)
  }

  private pruneKeyboardMeteors(now: number) {
    this.keyboardMeteors = this.keyboardMeteors.filter(
      (meteor) => {
        if (meteor.releasedAt === null) {
          return true
        }

        const heldDuration = Math.max(meteor.releasedAt - meteor.startedAt, 0)
        const fadeDuration = clamp(
          KEYBOARD_METEOR_MINIMUM_FADE + heldDuration * 0.58,
          KEYBOARD_METEOR_MINIMUM_FADE,
          1.6,
        )

        return now - meteor.releasedAt < fadeDuration
      },
    )
  }

  private drawKeyboardMeteors(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    pitchRange: PitchRange,
  ) {
    const now = performance.now() / 1000
    const pitchSpan = Math.max(pitchRange.max - pitchRange.min, 1)
    const pathAngle = Math.PI - Math.PI / 24
    const slope = Math.tan(Math.PI / 24)
    const headSprite = this.getHeadSprite()

    this.keyboardMeteors.forEach((meteor) => {
      const age = now - meteor.startedAt
      const heldDuration = Math.max(
        (meteor.releasedAt ?? now) - meteor.startedAt,
        0,
      )
      const fadeDuration = clamp(
        KEYBOARD_METEOR_MINIMUM_FADE + heldDuration * 0.58,
        KEYBOARD_METEOR_MINIMUM_FADE,
        1.6,
      )
      const releaseAge =
        meteor.releasedAt === null ? 0 : Math.max(now - meteor.releasedAt, 0)
      const fade =
        meteor.releasedAt === null
          ? 1
          : Math.pow(1 - clamp(releaseAge / fadeDuration, 0, 1), 1.22)
      const travelAge = Math.min(
        age,
        heldDuration + fadeDuration * 0.34,
      )
      const variation = Math.sin(meteor.pitch * 19.41)
      const tailSprite = this.getTailSprite(variation)
      const baseY =
        16 +
        (1 -
          clamp(
            (meteor.pitch - pitchRange.min) / pitchSpan,
            0,
            1,
          )) *
          Math.max(height - 32, 1)
      const headX = width - 8 - Math.min(width * 0.54, travelAge * width * 0.2)
      const headY = baseY + (width - 8 - headX) * slope
      const tailLength = clamp(
        20 + heldDuration * width * 0.24,
        20,
        Math.min(width * 0.46, 226),
      )
      const thickness = 2.4
      const headThickness = 2.2

      ctx.save()
      ctx.globalCompositeOperation = 'lighter'
      ctx.translate(headX, headY)
      ctx.rotate(pathAngle)
      ctx.globalAlpha = 0.18 * fade
      ctx.drawImage(
        tailSprite,
        0,
        0,
        SPRITE_WIDTH,
        TAIL_SPRITE_HEIGHT,
        -tailLength,
        -(thickness * 1.5) / 2,
        tailLength,
        thickness * 1.5,
      )
      ctx.globalAlpha = 0.52 * fade
      ctx.drawImage(
        tailSprite,
        0,
        0,
        SPRITE_WIDTH,
        TAIL_SPRITE_HEIGHT,
        -tailLength * 0.88,
        -thickness * 0.22,
        tailLength * 0.88,
        thickness * 0.44,
      )
      ctx.globalAlpha = 0.76 * fade
      ctx.drawImage(
        headSprite,
        -(headThickness * 1.55) / 2,
        -headThickness / 2,
        headThickness * 1.55,
        headThickness,
      )
      ctx.restore()
    })
  }

  private prepare(notes: MidiNote[]) {
    if (this.sourceNotes === notes) {
      return
    }

    this.sourceNotes = notes
    this.sortedNotes = [...notes].sort(
      (left, right) => left.start - right.start || left.pitch - right.pitch,
    )
    const velocities = notes
      .map((note) => clamp(note.velocity, 0, 1))
      .sort((left, right) => left - right)

    if (velocities.length === 0) {
      this.velocityFloor = 0
      this.velocityCeiling = 1
      return
    }

    const lowerIndex = Math.floor((velocities.length - 1) * 0.1)
    const upperIndex = Math.ceil((velocities.length - 1) * 0.9)
    const lower = velocities[lowerIndex]
    const upper = velocities[upperIndex]

    if (upper - lower < 0.08) {
      this.velocityFloor = 0
      this.velocityCeiling = 1
      return
    }

    this.velocityFloor = lower
    this.velocityCeiling = upper
  }

  private normalizeVelocity(velocity: number) {
    return clamp(
      (clamp(velocity, 0, 1) - this.velocityFloor) /
        (this.velocityCeiling - this.velocityFloor),
      0,
      1,
    )
  }

  private getTailSprite(variation: number) {
    const phaseIndex = Math.round(
      clamp((variation + 1) * 0.5, 0, 1) * 15,
    )
    const cachedSprite = this.tailSprites.get(phaseIndex)

    if (cachedSprite) {
      return cachedSprite
    }

    const sprite = document.createElement('canvas')
    sprite.width = SPRITE_WIDTH
    sprite.height = TAIL_SPRITE_HEIGHT
    const spriteContext = sprite.getContext('2d')

    if (!spriteContext) {
      this.tailSprites.set(phaseIndex, sprite)
      return sprite
    }

    const phase = (phaseIndex / 16) * Math.PI * 2
    const pixels = spriteContext.createImageData(
      SPRITE_WIDTH,
      TAIL_SPRITE_HEIGHT,
    )
    const centerY = (TAIL_SPRITE_HEIGHT - 1) / 2

    for (let x = 0; x < SPRITE_WIDTH; x += 1) {
      const progress = x / (SPRITE_WIDTH - 1)
      const distanceFromHead = 1 - progress
      const spread = 3.2 + Math.pow(progress, 0.8) * 7.5
      const longitudinal =
        0.018 +
        0.11 * Math.exp(-distanceFromHead / 0.5) +
        0.6 * Math.exp(-distanceFromHead / 0.11)
      const texture =
        1 +
        Math.sin(progress * 12.4 + phase) * 0.055 +
        Math.sin(progress * 31.7 - phase * 1.7) * 0.025

      for (let y = 0; y < TAIL_SPRITE_HEIGHT; y += 1) {
        const distance = (y - centerY) / spread
        const crossSection = Math.exp(-distance * distance * 1.7)
        const alpha = Math.round(
          longitudinal * texture * crossSection * 255,
        )
        const offset = (y * SPRITE_WIDTH + x) * 4

        pixels.data[offset] = 255
        pixels.data[offset + 1] = 255
        pixels.data[offset + 2] = 255
        pixels.data[offset + 3] = alpha
      }
    }

    spriteContext.putImageData(pixels, 0, 0)
    this.tailSprites.set(phaseIndex, sprite)
    return sprite
  }

  private getHeadSprite() {
    if (this.headSprite) {
      return this.headSprite
    }

    const sprite = document.createElement('canvas')
    sprite.width = HEAD_SPRITE_WIDTH
    sprite.height = HEAD_SPRITE_HEIGHT
    const spriteContext = sprite.getContext('2d')

    if (!spriteContext) {
      this.headSprite = sprite
      return sprite
    }

    const centerX = HEAD_SPRITE_WIDTH * 0.6
    const centerY = HEAD_SPRITE_HEIGHT / 2
    const halo = spriteContext.createRadialGradient(
      centerX,
      centerY,
      0,
      centerX,
      centerY,
      HEAD_SPRITE_HEIGHT * 0.48,
    )
    halo.addColorStop(0, 'rgba(255, 255, 255, 1)')
    halo.addColorStop(0.08, 'rgba(255, 255, 255, 0.98)')
    halo.addColorStop(0.22, 'rgba(244, 248, 255, 0.74)')
    halo.addColorStop(0.46, 'rgba(226, 237, 255, 0.24)')
    halo.addColorStop(1, 'rgba(220, 234, 255, 0)')
    spriteContext.fillStyle = halo
    spriteContext.fillRect(0, 0, HEAD_SPRITE_WIDTH, HEAD_SPRITE_HEIGHT)

    const core = spriteContext.createRadialGradient(
      centerX,
      centerY,
      0,
      centerX,
      centerY,
      HEAD_SPRITE_HEIGHT * 0.17,
    )
    core.addColorStop(0, 'rgba(255, 255, 252, 1)')
    core.addColorStop(0.42, 'rgba(255, 255, 255, 1)')
    core.addColorStop(1, 'rgba(235, 244, 255, 0)')
    spriteContext.fillStyle = core
    spriteContext.fillRect(0, 0, HEAD_SPRITE_WIDTH, HEAD_SPRITE_HEIGHT)

    this.headSprite = sprite
    return sprite
  }

  private drawSky(ctx: CanvasRenderingContext2D, width: number, height: number) {
    this.preloadSky()

    if (!this.skyReady || !this.sky) {
      ctx.fillStyle = '#000000'
      ctx.fillRect(0, 0, width, height)
      return
    }

    const scale = Math.max(width / this.sky.width, height / this.sky.height)
    const drawWidth = this.sky.width * scale
    const drawHeight = this.sky.height * scale

    ctx.drawImage(
      this.sky,
      (width - drawWidth) / 2,
      (height - drawHeight) / 2,
      drawWidth,
      drawHeight,
    )
  }

}
