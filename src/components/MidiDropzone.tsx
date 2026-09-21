import { FileText, Music2, RotateCcw, Upload } from 'lucide-react'
import { useRef, type ReactNode } from 'react'

type FilePickerHandle = {
  getFile: () => Promise<File>
}

type FilePickerOptions = {
  multiple: boolean
  types: Array<{
    description: string
    accept: Record<string, string[]>
  }>
}

type FilePickerWindow = Window & {
  showOpenFilePicker?: (options: FilePickerOptions) => Promise<FilePickerHandle[]>
}

interface MidiDropzoneProps {
  accept: string
  defaultFileName?: string
  emptyHint: ReactNode
  emptyLabel: string
  fileName: string | null
  isActive: boolean
  isSupportedFile: (file: File) => boolean
  kind: 'midi' | 'csv'
  noteCount: number
  onFile: (file: File) => void
  onLoadDefault?: () => void
}

export function MidiDropzone({
  accept,
  defaultFileName,
  emptyHint,
  emptyLabel,
  fileName,
  isActive,
  isSupportedFile,
  kind,
  noteCount,
  onFile,
  onLoadDefault,
}: MidiDropzoneProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleFile = (file: File | undefined) => {
    if (file && isSupportedFile(file)) {
      onFile(file)
    }
  }

  const handleFiles = (files: FileList | null) => {
    handleFile(files?.[0])
  }

  const openFilePicker = async () => {
    const showOpenFilePicker = (window as FilePickerWindow).showOpenFilePicker

    if (!showOpenFilePicker) {
      fileInputRef.current?.click()
      return
    }

    try {
      const pickerType: FilePickerOptions['types'][number] =
        kind === 'csv'
          ? {
              description: 'csv',
              accept: { 'text/csv': ['.csv'] },
            }
          : {
              description: 'midi',
              accept: { 'audio/midi': ['.mid', '.midi'] },
            }
      const [handle] = await showOpenFilePicker({
        multiple: false,
        types: [pickerType],
      })
      handleFile(await handle.getFile())
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        fileInputRef.current?.click()
      }
    }
  }

  const LoadedIcon = kind === 'csv' ? FileText : Music2
  const displayName = fileName ?? defaultFileName ?? emptyLabel
  const showLoadedIcon = Boolean(fileName ?? defaultFileName)

  return (
    <div className="dropzone-wrap">
      <label
        className={isActive ? 'dropzone is-active' : 'dropzone'}
        onClick={(event) => {
          event.preventDefault()
          void openFilePicker()
        }}
        onDragOver={(event) => {
          event.preventDefault()
        }}
        onDrop={(event) => {
          event.preventDefault()
          handleFiles(event.dataTransfer.files)
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept={accept}
          onChange={(event) => handleFiles(event.currentTarget.files)}
        />
        <span className="dropzone__icon" aria-hidden="true">
          {showLoadedIcon ? <LoadedIcon size={18} /> : <Upload size={18} />}
        </span>
        <span className="dropzone__text">
          <strong>{displayName}</strong>
          <small>{fileName ? `${noteCount} notes` : emptyHint}</small>
        </span>
      </label>
      {defaultFileName && onLoadDefault ? (
        <button
          className="icon-button compact-button dropzone-reset"
          type="button"
          title={`Load ${defaultFileName}`}
          aria-label={`Load ${defaultFileName}`}
          onClick={onLoadDefault}
        >
          <RotateCcw size={13} />
        </button>
      ) : null}
    </div>
  )
}
