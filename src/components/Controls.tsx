import {
  Eye,
  EyeOff,
  ChevronDown,
  FlipHorizontal2,
  LoaderCircle,
  Maximize2,
  Minimize2,
  Minus,
  Music2,
  Pause,
  Play,
  Plus,
  RotateCcw,
  ScanSearch,
  Square,
  Undo2,
  Volume2,
  VolumeX,
} from 'lucide-react'
import type { TrackSummary } from '../midi/noteTypes'
import { MAX_TRANSPOSE, MIN_TRANSPOSE } from '../midi/transposeMidi'
import {
  DEFAULT_VOLUME,
  MAX_VOLUME,
  PLAYBACK_RATES,
  type PlaybackRate,
  type SoundPreset,
} from '../playback/transport'

interface ControlsProps {
  disabled: boolean
  practiceActive: boolean
  demonstrationActive: boolean
  practiceRateLocked: boolean
  isPlaying: boolean
  isPreparing: boolean
  keyAnalysisVisible: boolean
  isZen: boolean
  currentTime: number
  duration: number
  soundPreset: SoundPreset
  reversePlayback: boolean
  playbackRate: PlaybackRate
  volume: number
  transposeSemitones: number
  motifTraceEnabled: boolean
  motifOccurrenceCount: number
  symmetryAvailable: boolean
  axisSymmetryEnabled: boolean
  centerSymmetryEnabled: boolean
  showChromaticLines: boolean
  showStaffLines: boolean
  tracks: TrackSummary[]
  visibleTracks: ReadonlySet<number>
  onPlay: () => void
  onPause: () => void
  onStop: () => void
  onToggleReversePlayback: () => void
  onSeek: (time: number) => void
  onSoundPresetChange: (soundPreset: SoundPreset) => void
  onPlaybackRateChange: (playbackRate: PlaybackRate) => void
  onVolumeChange: (volume: number) => void
  onTransposeChange: (semitones: number) => void
  onToggleMotifTrace: () => void
  onToggleAxisSymmetry: () => void
  onToggleCenterSymmetry: () => void
  onToggleChromaticLines: () => void
  onToggleStaffLines: () => void
  onToggleKeyAnalysis: () => void
  onToggleTrack: (track: number) => void
  onToggleZen: () => void
}

const formatTime = (seconds: number) => {
  const safeSeconds = Math.max(0, seconds)
  const minutes = Math.floor(safeSeconds / 60)
  const remainingSeconds = Math.floor(safeSeconds % 60)
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`
}

const formatTranspose = (semitones: number) =>
  semitones > 0 ? `+${semitones} st` : `${semitones} st`

const formatPlaybackRate = (playbackRate: PlaybackRate) => {
  if (playbackRate === 0.25) {
    return '1/4 ×'
  }

  if (playbackRate === 0.5) {
    return '1/2 ×'
  }

  if (playbackRate === 0.6666666666666666) {
    return '2/3 ×'
  }

  if (playbackRate === 0.75) {
    return '3/4 ×'
  }

  if (playbackRate === 1.3333333333333333) {
    return '4/3 ×'
  }

  if (playbackRate === 1.5) {
    return '3/2 ×'
  }

  return `${playbackRate} ×`
}

export function Controls({
  disabled,
  practiceActive,
  demonstrationActive,
  practiceRateLocked,
  isPlaying,
  isPreparing,
  keyAnalysisVisible,
  isZen,
  currentTime,
  duration,
  soundPreset,
  reversePlayback,
  playbackRate,
  volume,
  transposeSemitones,
  motifTraceEnabled,
  motifOccurrenceCount,
  symmetryAvailable,
  axisSymmetryEnabled,
  centerSymmetryEnabled,
  showChromaticLines,
  showStaffLines,
  tracks,
  visibleTracks,
  onPlay,
  onPause,
  onStop,
  onToggleReversePlayback,
  onSeek,
  onSoundPresetChange,
  onPlaybackRateChange,
  onVolumeChange,
  onTransposeChange,
  onToggleMotifTrace,
  onToggleAxisSymmetry,
  onToggleCenterSymmetry,
  onToggleChromaticLines,
  onToggleStaffLines,
  onToggleKeyAnalysis,
  onToggleTrack,
  onToggleZen,
}: ControlsProps) {
  const controlsLocked = disabled || practiceActive || demonstrationActive

  return (
    <section className="controls" aria-label="Playback controls">
      <div className="transport-row">
        <button
          className="icon-button"
          type="button"
          disabled={disabled || practiceActive || isPreparing}
          title={isPreparing ? 'Loading instrument' : isPlaying ? 'Pause' : 'Play'}
          aria-label={isPreparing ? 'Loading instrument' : isPlaying ? 'Pause' : 'Play'}
          onClick={isPlaying ? onPause : () => void onPlay()}
        >
          {isPreparing ? (
            <LoaderCircle className="loading-icon" size={17} />
          ) : isPlaying ? (
            <Pause size={17} />
          ) : (
            <Play size={17} />
          )}
        </button>
        <button
          className="icon-button"
          type="button"
          disabled={disabled}
          title={practiceActive ? 'End Duet' : 'Stop'}
          aria-label={practiceActive ? 'End Duet' : 'Stop'}
          onClick={onStop}
        >
          <Square size={15} />
        </button>
        <button
          className={
            reversePlayback
              ? 'icon-button reverse-toggle is-active'
              : 'icon-button reverse-toggle'
          }
          type="button"
          disabled={controlsLocked || isPlaying || isPreparing}
          title={
            isPlaying || isPreparing
              ? 'Pause playback to change direction'
              : reversePlayback
                ? 'Play forward'
                : 'Play in reverse'
          }
          aria-label={reversePlayback ? 'Play forward' : 'Play in reverse'}
          onClick={onToggleReversePlayback}
        >
          <Undo2 size={15} />
        </button>
        <div className="sound-select-wrap">
          <select
            className="sound-select"
            value={soundPreset}
            disabled={controlsLocked}
            aria-label="Sound preset"
            onChange={(event) =>
              onSoundPresetChange(event.currentTarget.value as SoundPreset)
            }
          >
            <option value="grandPiano">Grand Piano</option>
            <option value="harmonicPiano">Small Piano</option>
            <option value="ocarina">Ocarina</option>
            <option value="musicBox">Music Box</option>
          </select>
          <ChevronDown className="sound-select-arrow" size={15} aria-hidden="true" />
        </div>
        <select
          className="speed-select"
          value={playbackRate}
          disabled={disabled || practiceRateLocked}
          aria-label="Playback speed"
          onChange={(event) =>
            onPlaybackRateChange(Number(event.currentTarget.value) as PlaybackRate)
          }
        >
          {PLAYBACK_RATES.map((rate) => (
            <option key={rate} value={rate}>
              {formatPlaybackRate(rate)}
            </option>
          ))}
        </select>
        <div className="volume-control" aria-label="Volume">
          {volume <= 0.01 ? (
            <VolumeX size={15} aria-hidden="true" />
          ) : (
            <Volume2 size={15} aria-hidden="true" />
          )}
          <input
            className="volume-range"
            type="range"
            min={0}
            max={MAX_VOLUME}
            step={0.01}
            value={volume}
            disabled={controlsLocked}
            aria-label="Volume"
            onChange={(event) =>
              onVolumeChange(Number(event.currentTarget.value))
            }
          />
          <button
            className="icon-button compact-button"
            type="button"
            disabled={
              controlsLocked || Math.abs(volume - DEFAULT_VOLUME) < 0.005
            }
            title="Reset volume"
            aria-label="Reset volume"
            onClick={() => onVolumeChange(DEFAULT_VOLUME)}
          >
            <RotateCcw size={13} />
          </button>
        </div>
        <div className="transpose-control" aria-label="Transpose">
          <button
            className="icon-button compact-button"
            type="button"
            disabled={controlsLocked || transposeSemitones <= MIN_TRANSPOSE}
            title="Transpose down"
            aria-label="Transpose down"
            onClick={() => onTransposeChange(transposeSemitones - 1)}
          >
            <Minus size={14} />
          </button>
          <input
            className="transpose-range"
            type="range"
            min={MIN_TRANSPOSE}
            max={MAX_TRANSPOSE}
            step={1}
            value={transposeSemitones}
            disabled={controlsLocked}
            aria-label="Transpose semitones"
            onChange={(event) =>
              onTransposeChange(Number(event.currentTarget.value))
            }
          />
          <span className="transpose-readout">
            {formatTranspose(transposeSemitones)}
          </span>
          <button
            className="icon-button compact-button"
            type="button"
            disabled={controlsLocked || transposeSemitones >= MAX_TRANSPOSE}
            title="Transpose up"
            aria-label="Transpose up"
            onClick={() => onTransposeChange(transposeSemitones + 1)}
          >
            <Plus size={14} />
          </button>
          <button
            className="icon-button compact-button"
            type="button"
            disabled={controlsLocked || transposeSemitones === 0}
            title="Reset transpose"
            aria-label="Reset transpose"
            onClick={() => onTransposeChange(0)}
          >
            <RotateCcw size={13} />
          </button>
        </div>
        {motifOccurrenceCount > 0 ? (
          <button
            className={
              motifTraceEnabled
                ? 'icon-button motif-toggle is-active'
                : 'icon-button motif-toggle'
            }
            type="button"
            title={
              motifTraceEnabled
                ? `Hide motif traces (${motifOccurrenceCount} entries)`
                : `Show motif traces (${motifOccurrenceCount} entries)`
            }
            aria-label={
              motifTraceEnabled
                ? `Hide motif traces (${motifOccurrenceCount} entries)`
                : `Show motif traces (${motifOccurrenceCount} entries)`
            }
            onClick={onToggleMotifTrace}
          >
            <ScanSearch size={16} />
            <span className="motif-count">{motifOccurrenceCount}</span>
          </button>
        ) : null}
        <div className="progress-group">
          <input
            className="progress"
            type="range"
            min={0}
            max={Math.max(duration, 0.01)}
            step={0.01}
            value={Math.min(currentTime, duration)}
            disabled={disabled || practiceActive || isPreparing}
            aria-label="Playback progress"
            onChange={(event) => onSeek(Number(event.currentTarget.value))}
          />
          <span className="time-readout">
            {formatTime(currentTime)} / {formatTime(duration)}
          </span>
        </div>
        <button
          className="icon-button"
          type="button"
          title={isZen ? 'Exit Zen Mode' : 'Zen Mode'}
          aria-label={isZen ? 'Exit Zen Mode' : 'Zen Mode'}
          onClick={onToggleZen}
        >
          {isZen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
      </div>

      <div className="track-row" aria-label="Tracks">
        <button
          className={
            keyAnalysisVisible
              ? 'icon-button key-analysis-toggle is-active'
              : 'icon-button key-analysis-toggle'
          }
          type="button"
          disabled={controlsLocked || isPlaying || isPreparing}
          title={
            isPlaying || isPreparing
              ? 'Pause playback to analyze local key'
              : keyAnalysisVisible
                ? 'Hide local key analysis'
                : 'Analyze local key at the current time'
          }
          aria-label={
            isPlaying || isPreparing
              ? 'Pause playback to analyze local key'
              : keyAnalysisVisible
                ? 'Hide local key analysis'
                : 'Analyze local key at the current time'
          }
          onClick={onToggleKeyAnalysis}
        >
          <Music2 size={16} />
        </button>
        {symmetryAvailable ? (
          <div className="symmetry-toggle-group" aria-label="Symmetry traces">
            <button
              className={
                axisSymmetryEnabled
                  ? 'icon-button symmetry-toggle axis-symmetry-toggle is-active'
                  : 'icon-button symmetry-toggle axis-symmetry-toggle'
              }
              type="button"
              disabled={controlsLocked}
              title={
                axisSymmetryEnabled
                  ? 'Hide axial pitch symmetry'
                  : 'Show axial pitch symmetry'
              }
              aria-label={
                axisSymmetryEnabled
                  ? 'Hide axial pitch symmetry'
                  : 'Show axial pitch symmetry'
              }
              onClick={onToggleAxisSymmetry}
            >
              <FlipHorizontal2 size={16} />
            </button>
            <button
              className={
                centerSymmetryEnabled
                  ? 'icon-button symmetry-toggle center-symmetry-toggle is-active'
                  : 'icon-button symmetry-toggle center-symmetry-toggle'
              }
              type="button"
              disabled={controlsLocked}
              title={
                centerSymmetryEnabled
                  ? 'Hide central pitch symmetry'
                  : 'Show central pitch symmetry'
              }
              aria-label={
                centerSymmetryEnabled
                  ? 'Hide central pitch symmetry'
                  : 'Show central pitch symmetry'
              }
              onClick={onToggleCenterSymmetry}
            >
              <span className="center-symmetry-icon" aria-hidden="true">
                <span />
              </span>
            </button>
          </div>
        ) : null}
        <div className="display-toggle-group" aria-label="Score overlay">
          <label className="display-toggle">
            <span>Semitone</span>
            <input
              type="checkbox"
              checked={showChromaticLines}
              disabled={controlsLocked}
              aria-label="Show semitone lines"
              onChange={onToggleChromaticLines}
            />
            <span className="toggle-track" aria-hidden="true" />
          </label>
          <label className="display-toggle">
            <span>Staff</span>
            <input
              type="checkbox"
              checked={showStaffLines}
              disabled={controlsLocked}
              aria-label="Show staff lines"
              onChange={onToggleStaffLines}
            />
            <span className="toggle-track" aria-hidden="true" />
          </label>
        </div>
        {tracks.map((track) => {
          const isVisible = visibleTracks.has(track.track)

          return (
            <button
              key={track.track}
              className={isVisible ? 'track-chip is-visible' : 'track-chip'}
              type="button"
              disabled={controlsLocked}
              title={`${isVisible ? 'Hide' : 'Show'} ${track.name}`}
              onClick={() => onToggleTrack(track.track)}
            >
              {isVisible ? <Eye size={14} /> : <EyeOff size={14} />}
              <span>{track.name}</span>
            </button>
          )
        })}
      </div>
    </section>
  )
}
