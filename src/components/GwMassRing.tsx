import { useEffect, useMemo, useRef } from 'react'
import type { GwWaveform } from '../midi/noteTypes'

interface GwMassRingProps {
  waveform: GwWaveform
  duration: number
  width: number
  height: number
  waveformHeight: number
  centerX: number
  visibleTracks: ReadonlySet<number>
  currentTime: number
  isAnimating: boolean
  getCurrentTime: () => number
}

export function GwMassRing({
  waveform,
  duration,
  width,
  height,
  waveformHeight,
  centerX,
  visibleTracks,
  currentTime,
  isAnimating,
  getCurrentTime,
}: GwMassRingProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stationaryTime = isAnimating ? null : currentTime
  const polarizations = useMemo(() => {
    const plus = waveform.series.find((series) => series.name === 'h_plus')?.values ?? []
    const cross = waveform.series.find((series) => series.name === 'h_cross')?.values ?? []
    let peak = 0

    for (let index = 0; index < Math.max(plus.length, cross.length); index += 1) {
      peak = Math.max(peak, Math.hypot(plus[index] ?? 0, cross[index] ?? 0))
    }

    return { plus, cross, scale: peak > 0 ? 0.70 / peak : 0 }
  }, [waveform])

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')

    if (!canvas || !ctx || width <= 0 || height <= 0) {
      return
    }

    const ratio = window.devicePixelRatio || 1
    canvas.width = Math.round(width * ratio)
    canvas.height = Math.round(height * ratio)
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    let frameId = 0
    const radius = Math.min(width, waveformHeight) * 0.30
    const valueSpan = Math.max(waveform.valueMax - waveform.valueMin, Number.EPSILON)
    const centerY = height - waveformHeight + 6 + waveform.valueMax / valueSpan * Math.max(1, waveformHeight - 14)
    const sample = (values: number[], time: number) => {
      const position = Math.max(0, Math.min(1, duration > 0 ? time / duration : 0)) * Math.max(0, values.length - 1)
      const index = Math.floor(position)
      const fraction = position - index
      return (values[index] ?? 0) * (1 - fraction) + (values[Math.min(index + 1, values.length - 1)] ?? 0) * fraction
    }
    const draw = (time: number) => {
      ctx.clearRect(0, 0, width, height)
      ctx.strokeStyle = 'rgba(100, 100, 100, 0.5)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.arc(centerX, centerY, radius, 0, Math.PI * 2)
      ctx.stroke()
      ctx.beginPath()

      for (let axis = 0; axis < 4; axis += 1) {
        const angle = axis * Math.PI / 4
        const dx = Math.cos(angle) * radius * 1.2
        const dy = Math.sin(angle) * radius * 1.2
        ctx.moveTo(centerX - dx, centerY - dy)
        ctx.lineTo(centerX + dx, centerY + dy)
      }

      ctx.stroke()
      const plusTrack = waveform.series.find((series) => series.name === 'h_plus')?.track
      const crossTrack = waveform.series.find((series) => series.name === 'h_cross')?.track
      const plus = plusTrack !== undefined && visibleTracks.has(plusTrack)
        ? sample(polarizations.plus, time) * polarizations.scale
        : 0
      const cross = crossTrack !== undefined && visibleTracks.has(crossTrack)
        ? sample(polarizations.cross, time) * polarizations.scale
        : 0
      ctx.fillStyle = 'rgba(76, 76, 76, 0.9)'

      for (let index = 0; index < 24; index += 1) {
        const angle = index * Math.PI * 2 / 24
        const x = radius * Math.cos(angle)
        const y = radius * Math.sin(angle)
        ctx.beginPath()
        ctx.arc(centerX + (1 + plus) * x + cross * y, centerY - cross * x - (1 - plus) * y, 2.4, 0, Math.PI * 2)
        ctx.fill()
      }
    }

    draw(stationaryTime ?? getCurrentTime())

    if (isAnimating) {
      const animate = () => {
        draw(getCurrentTime())
        frameId = window.requestAnimationFrame(animate)
      }

      frameId = window.requestAnimationFrame(animate)
    }

    return () => window.cancelAnimationFrame(frameId)
  }, [centerX, duration, getCurrentTime, height, isAnimating, polarizations, stationaryTime, visibleTracks, waveform, waveformHeight, width])

  return <canvas ref={canvasRef} aria-label="Gravitational-wave test masses" style={{ position: 'absolute', top: 'auto', right: 'auto', bottom: 0, left: 0, width, height, pointerEvents: 'none' }} />
}
