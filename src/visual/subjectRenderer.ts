import type { SubjectTrace } from '../midi/contrapunctusSubjects'
import type { MidiNote } from '../midi/noteTypes'
import type { CoordinateSystem } from './coordinate'

interface RenderSubjectTracesOptions {
  ctx: CanvasRenderingContext2D
  traces: SubjectTrace[]
  notes: MidiNote[]
  currentTime: number
  coordinates: CoordinateSystem
  visibleTracks: ReadonlySet<number>
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max)

const withAlpha = (hex: string, alpha: number) => {
  const value = hex.replace('#', '')
  const red = Number.parseInt(value.slice(0, 2), 16)
  const green = Number.parseInt(value.slice(2, 4), 16)
  const blue = Number.parseInt(value.slice(4, 6), 16)
  return `rgba(${red}, ${green}, ${blue}, ${clamp(alpha, 0, 1)})`
}

const drawTrace = (
  ctx: CanvasRenderingContext2D,
  notes: MidiNote[],
  writtenEnd: number,
  coordinates: CoordinateSystem,
  color: string,
  lineWidth: number,
  alpha: number,
) => {
  let previous: MidiNote | null = null
  let hasPath = false

  ctx.save()
  ctx.strokeStyle = withAlpha(color, alpha)
  ctx.lineWidth = lineWidth
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.beginPath()

  notes.forEach((note) => {
    const end = Math.min(note.end, writtenEnd)

    if (end < note.start) {
      return
    }

    const startX = coordinates.timeToX(note.start)
    const endX = coordinates.timeToX(end)
    const y = coordinates.pitchToY(note.pitch, note.role)
    const gap = previous ? note.start - previous.end : Number.POSITIVE_INFINITY

    if (!previous || gap > 0.45) {
      ctx.moveTo(startX, y)
    } else {
      const previousX = coordinates.timeToX(Math.min(previous.end, writtenEnd))
      const previousY = coordinates.pitchToY(previous.pitch, previous.role)
      const middleX = (previousX + startX) * 0.5
      const middleY = (previousY + y) * 0.5

      ctx.quadraticCurveTo(previousX, previousY, middleX, middleY)
      ctx.quadraticCurveTo(startX, y, startX, y)
    }

    ctx.lineTo(endX, y)
    previous = note
    hasPath = true
  })

  if (hasPath) {
    ctx.stroke()
  }

  ctx.restore()
}

const drawLabel = (
  ctx: CanvasRenderingContext2D,
  label: string,
  note: MidiNote,
  coordinates: CoordinateSystem,
  color: string,
) => {
  const x = coordinates.timeToX(note.start)
  const y = coordinates.pitchToY(note.pitch, note.role)

  if (x < -20 || x > coordinates.width + 20) {
    return
  }

  ctx.save()
  ctx.translate(x, y)
  ctx.fillStyle = 'rgba(255, 253, 247, 0.96)'
  ctx.strokeStyle = withAlpha(color, 1)
  ctx.lineWidth = 2.5
  ctx.beginPath()
  ctx.arc(0, 0, 13, 0, Math.PI * 2)
  ctx.fill()
  ctx.stroke()
  ctx.fillStyle = withAlpha(color, 1)
  ctx.font = '700 17px "Courier New", "Courier Prime", Courier, monospace'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, 0, 0.5)
  ctx.restore()
}

export const renderSubjectTraces = ({
  ctx,
  traces,
  notes,
  currentTime,
  coordinates,
  visibleTracks,
}: RenderSubjectTracesOptions) => {
  const noteById = new Map(notes.map((note) => [note.id, note]))

  traces.forEach((trace) => {
    const subjectNotes = trace.noteIds
      .map((id) => noteById.get(id))
      .filter((note): note is MidiNote => Boolean(note))

    const first = subjectNotes[0]

    if (!first || currentTime < first.start || !visibleTracks.has(first.track)) {
      return
    }

    const writtenEnd = Math.min(currentTime, subjectNotes.at(-1)?.end ?? currentTime)
    const visibleNotes = subjectNotes.filter((note) => note.start <= writtenEnd)

    if (visibleNotes.length === 0) {
      return
    }

    const alpha =
      visibleNotes.reduce(
        (sum, note) => sum + coordinates.alphaForTime(Math.min(note.end, writtenEnd)),
        0,
      ) / visibleNotes.length

    if (alpha <= 0.02) {
      return
    }

    drawTrace(
      ctx,
      visibleNotes,
      writtenEnd,
      coordinates,
      trace.color,
      11,
      Math.max(alpha, 0.48) * 0.28,
    )
    drawTrace(
      ctx,
      visibleNotes,
      writtenEnd,
      coordinates,
      trace.color,
      3.5,
      Math.max(alpha, 0.58),
    )
    if (trace.label) {
      drawLabel(ctx, trace.label, first, coordinates, trace.color)
    }
  })
}
