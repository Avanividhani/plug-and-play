import { useEffect, useRef, useState } from 'react'
import { builtInTestContent, renderGenerativeFrame, renderLivingArtFrame, type GenRecipe } from '../lib/aiContent'
import type { MediaItem } from '../lib/types'

type TargetOption = {
  id: string
  label: string
  mediaId?: string | null
  mediaName?: string | null
}

type Props = {
  items: MediaItem[]
  selectedId: string | null
  onSelect: (id: string) => void
  onAdd: (item: MediaItem) => void
  onDeleteMedia?: (id: string) => void
  onProject: () => void
  selectedTargetLabel?: string | null
  onProjectMedia?: (item: MediaItem) => void
  targetOptions?: TargetOption[]
  selectedTargetId?: string | null
  onSelectTarget?: (id: string) => void
  onDeleteTarget?: (id: string) => void
  onAssignTargetMedia?: (targetId: string, mediaId: string) => void
}

function isProtectedLibraryItem(item: MediaItem) {
  return item.source === 'test' || item.id.startsWith('test-white')
}

/** Turn a File into an http://127.0.0.1 media URL that projector windows can load (blob: cannot cross windows). */
function isVideoFile(file: File): boolean {
  if (file.type.startsWith('video/')) return true
  return /\.(mp4|webm|mov|mkv|m4v|avi)$/i.test(file.name)
}

function isLocalMediaHttpUrl(url: string): boolean {
  return /^http:\/\/(127\.0\.0\.1|localhost):\d+\/m\//i.test(url)
}

async function fileToSharedMediaUrl(file: File): Promise<string> {
  const localPath = window.lumen.getPathForFile?.(file)
  if (localPath) {
    const res = await window.lumen.mediaUrlFromPath(localPath)
    if (res.ok && res.url && isLocalMediaHttpUrl(res.url)) return res.url
    if (res.ok && res.url) {
      console.warn('[upload] mediaUrlFromPath returned non-http URL', res.url)
    }
  }
  // Fallback: copy bytes into userData via base64 (more reliable over IPC than ArrayBuffer).
  const buffer = await file.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  const base64 = btoa(binary)
  const res = await window.lumen.persistMedia({
    base64,
    mimeType: file.type || (isVideoFile(file) ? 'video/mp4' : 'application/octet-stream'),
    fileName: file.name,
  })
  if (!res.ok || !res.url) throw new Error(res.error || 'Failed to save media')
  if (!isLocalMediaHttpUrl(res.url)) {
    throw new Error(`Media server returned a bad URL (${res.url.slice(0, 60)}). Restart the app.`)
  }
  return res.url
}

function clipToMedia(clip: ReturnType<typeof builtInTestContent>[number]): MediaItem {
  return {
    id: clip.id,
    name: clip.title,
    type: 'ai',
    url: clip.thumbnail,
    thumbnail: clip.thumbnail,
    recipe: clip.recipe,
    source: 'test',
  }
}

function MotionTilePreview({
  recipe,
  stillUrl,
  label,
}: {
  recipe: GenRecipe
  stillUrl: string
  label: string
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)

  useEffect(() => {
    if (!stillUrl) {
      imgRef.current = null
      return
    }
    const im = new Image()
    im.src = stillUrl
    imgRef.current = im
  }, [stillUrl])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    let raf = 0
    const start = performance.now()
    const tick = (now: number) => {
      const t = (now - start) / 1000
      canvas.width = 240
      canvas.height = 240
      const im = imgRef.current
      if (
        (recipe.mode === 'livingArt' || recipe.mode === 'photoMotion') &&
        im &&
        im.complete &&
        im.naturalWidth > 0
      ) {
        renderLivingArtFrame(ctx, canvas.width, canvas.height, recipe, t, im)
      } else {
        renderGenerativeFrame(ctx, canvas.width, canvas.height, recipe, t)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [recipe])

  return (
    <div className="content-tile-motion">
      <canvas ref={canvasRef} aria-label={label} />
    </div>
  )
}

export function ContentPanel({
  items,
  selectedId,
  onSelect,
  onAdd,
  onDeleteMedia,
  onProject,
  selectedTargetLabel,
  onProjectMedia,
  targetOptions = [],
  selectedTargetId = null,
  onSelectTarget,
  onDeleteTarget,
  onAssignTargetMedia,
}: Props) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [prompt, setPrompt] = useState('Neon ocean waves washing over stone architecture')
  const [kind, setKind] = useState<'live' | 'still' | 'motion'>('motion')
  const [generating, setGenerating] = useState(false)
  const [genError, setGenError] = useState<string | null>(null)
  const [showLibrary, setShowLibrary] = useState(true)
  const [status, setStatus] = useState<string>('')
  const [uploading, setUploading] = useState(false)

  useEffect(() => {
    const tests = builtInTestContent().map(clipToMedia)
    for (const t of [...tests].reverse()) {
      if (!items.some((i) => i.id === t.id)) onAdd(t)
    }
    if (!selectedId && tests[1]) onSelect(tests[1].id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const addAndProject = (item: MediaItem, projectNow: boolean) => {
    onAdd(item)
    onSelect(item.id)
    if (projectNow && onProjectMedia) onProjectMedia(item)
    else if (projectNow) onProject()
  }

  const renderTileMedia = (item: MediaItem) => {
    if (item.type === 'video' && item.url) {
      return (
        <video
          src={item.url}
          muted
          loop
          playsInline
          autoPlay
          preload="auto"
          onLoadedData={(e) => {
            const v = e.currentTarget
            v.muted = true
            v.volume = 0
            void v.play().catch(() => {})
          }}
          onError={(e) => {
            console.warn('[library] video error', item.url, e.currentTarget.error)
            setGenError(
              `Library video failed to load (${item.name}). URL must be http://127.0.0.1…/m/… — re-upload after full Electron restart.`,
            )
          }}
        />
      )
    }
    if ((item.thumbnail || item.url) && item.type !== 'ai') {
      return <img src={item.thumbnail || item.url} alt={item.name} />
    }
    if (item.type === 'ai' && item.recipe) {
      return (
        <MotionTilePreview
          recipe={item.recipe}
          stillUrl={item.url || item.thumbnail || ''}
          label={item.name}
        />
      )
    }
    if (item.thumbnail || item.url) {
      return <img src={item.thumbnail || item.url} alt={item.name} />
    }
    return <div className="content-tile-fallback">Motion</div>
  }

  const onFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    setUploading(true)
    setGenError(null)
    setStatus('Saving media for projection…')
    try {
      for (const file of Array.from(files)) {
        const url = await fileToSharedMediaUrl(file)
        const type = isVideoFile(file) ? 'video' : 'image'
        if (type === 'video' && !isLocalMediaHttpUrl(url)) {
          throw new Error('Upload did not produce a playable http://127.0.0.1 media URL')
        }
        onAdd({
          id: `media-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          name: file.name,
          type,
          url,
          thumbnail: url,
          source: 'upload',
        })
      }
      setStatus('Uploaded — pick a face/shape above, then Put selected media on shape.')
      setShowLibrary(true)
    } catch (e) {
      setGenError(e instanceof Error ? e.message : 'Upload failed')
      setStatus('')
    } finally {
      setUploading(false)
    }
  }

  const onGenerate = async () => {
    setGenerating(true)
    setGenError(null)
    setStatus(
      kind === 'motion'
        ? 'Requesting cloud video… this can take 1–2 minutes'
        : 'Sending prompt to backend…',
    )
    try {
      const res = await window.lumen.generateAi({ prompt, kind })
      if (!res.ok || !res.item) throw new Error(res.error || 'Generation failed')
      const item = res.item as MediaItem
      if (kind === 'motion' && item.type !== 'video') {
        throw new Error(
          'Cloud did not return a real video. Try again in a minute.',
        )
      }
      if (item.type === 'video' && !isLocalMediaHttpUrl(item.url || '')) {
        throw new Error(
          'Cloud returned a video without a local http://127.0.0.1 media URL. Restart Electron and try again.',
        )
      }
      addAndProject(item, true)
      if (res.warning) {
        setGenError(res.warning)
        setStatus('Generated with warnings — see message above.')
      } else {
        setStatus(
          item.type === 'video'
            ? 'AI video generated and projected onto the selected face/shape.'
            : 'Generated and projected onto the selected face/shape.',
        )
      }
      setShowLibrary(true)
    } catch (e) {
      const raw = e instanceof Error ? e.message : 'Generation failed'
      setGenError(raw.replace(/\s+/g, ' ').trim().slice(0, 120))
      setStatus('')
    } finally {
      setGenerating(false)
    }
  }

  return (
    <div className="card content-card">
      <h2>3 · Make it look like something</h2>
      <p className="sub">
        Pick a face/shape below, then generate or assign different content to each one.
      </p>

      <div className="target-pick-block">
        <div className="target-pick-head">
          <strong>Your faces & shapes</strong>
          <span className="empty-hint" style={{ margin: 0 }}>
            {targetOptions.length === 0
              ? 'None yet — draw one in step 2'
              : `${targetOptions.length} available`}
          </span>
        </div>

        {targetOptions.length === 0 ? (
          <p className="empty-hint" style={{ margin: '8px 0 0' }}>
            Outline a face or draw a shape first, then come back here to put content on it.
          </p>
        ) : (
          <div className="target-pick-list">
            {targetOptions.map((t) => {
              const active = t.id === selectedTargetId
              return (
                <div key={t.id} className={`target-pick-row ${active ? 'selected' : ''}`}>
                  <button
                    type="button"
                    className="target-pick-main"
                    onClick={() => onSelectTarget?.(t.id)}
                  >
                    <strong>{t.label}</strong>
                    <span>{t.mediaName || 'No content yet'}</span>
                  </button>
                  {onAssignTargetMedia && items.length > 0 && (
                    <select
                      value={t.mediaId ?? ''}
                      onChange={(e) => {
                        if (!e.target.value) return
                        onSelectTarget?.(t.id)
                        onAssignTargetMedia(t.id, e.target.value)
                      }}
                      onClick={(e) => e.stopPropagation()}
                      title={`Content for ${t.label}`}
                    >
                      <option value="" disabled>
                        Content…
                      </option>
                      {items.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </select>
                  )}
                  {onDeleteTarget && (
                    <button
                      type="button"
                      className="btn btn-ghost"
                      style={{ padding: '4px 8px', fontSize: 12 }}
                      onClick={() => onDeleteTarget(t.id)}
                      title={`Delete ${t.label}`}
                    >
                      Delete
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {selectedTargetLabel && (
          <p className="empty-hint" style={{ marginTop: 8, marginBottom: 0 }}>
            Selected for generate: <strong>{selectedTargetLabel}</strong>
          </p>
        )}
      </div>

      <div className="gen-kind-row" role="group" aria-label="Generation type">
        <button
          type="button"
          className={`btn ${kind === 'live' ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => setKind('live')}
        >
          Living AI
        </button>
        <button
          type="button"
          className={`btn ${kind === 'motion' ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => setKind('motion')}
        >
          Motion graphic
        </button>
        <button
          type="button"
          className={`btn ${kind === 'still' ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => setKind('still')}
        >
          Still image
        </button>
      </div>
      <div className="btn-row" style={{ marginBottom: 8 }}>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
        >
          {uploading ? 'Uploading…' : 'Upload your media (photo/video)'}
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => setShowLibrary((v) => !v)}
        >
          {showLibrary ? 'Hide media library' : 'Show media library'}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*,video/*"
          multiple
          hidden
          onChange={(e) => {
            void onFiles(e.target.files)
            e.target.value = ''
          }}
        />
      </div>

      <p className="empty-hint" style={{ marginTop: 0, marginBottom: 10 }}>
        {kind === 'live'
          ? 'AI picture + moving light / particles / waves over it (not a zoom).'
          : kind === 'motion'
            ? 'Cloud MP4 via built-in Pollinations (or Gemini if configured). Takes 1–2 min.'
            : 'One fixed AI image on the shape.'}
      </p>

      <div className="ai-form">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="e.g. soft aurora over dark marble, glowing ocean, neon fireflies…"
          rows={3}
        />
        <div className="btn-row" style={{ marginTop: 10 }}>
          <button
            className="btn btn-primary"
            style={{ flex: 1 }}
            onClick={() => void onGenerate()}
            disabled={generating || !prompt.trim() || !selectedTargetLabel}
            title={
              selectedTargetLabel
                ? `Generate onto ${selectedTargetLabel}`
                : 'Select or outline a shape first'
            }
          >
            {generating
              ? kind === 'motion'
                ? 'Generating AI video…'
                : 'Creating…'
              : selectedTargetLabel
                ? `Generate onto “${selectedTargetLabel}”`
                : 'Select a shape first'}
          </button>
        </div>
        {genError && <p className="error">{genError}</p>}
      </div>

      {status && <p className="empty-hint">{status}</p>}

      {showLibrary && (
        <>
          <div className="content-grid" style={{ marginBottom: 10 }}>
            {items.length === 0 && <p className="empty-hint">No media yet</p>}
            {items.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`content-tile ${selectedId === item.id ? 'selected' : ''}`}
                onClick={() => onSelect(item.id)}
              >
                {renderTileMedia(item)}
                <span className="tag">
                  {item.id.startsWith('test-white')
                    ? 'Test'
                    : item.type === 'video'
                      ? 'Video'
                      : item.source === 'procedural'
                        ? 'Loop'
                        : item.source === 'stable-diffusion'
                          ? 'AI'
                          : item.source === 'upload'
                            ? item.type
                            : 'AI'}
                </span>
                {onDeleteMedia && !isProtectedLibraryItem(item) && (
                  <span
                    role="button"
                    tabIndex={0}
                    className="content-tile-delete"
                    title="Remove from library"
                    aria-label={`Delete ${item.name}`}
                    onClick={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      onDeleteMedia(item.id)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        e.stopPropagation()
                        onDeleteMedia(item.id)
                      }
                    }}
                  >
                    ×
                  </span>
                )}
              </button>
            ))}
          </div>
          <button
            className="btn btn-ghost"
            onClick={() => {
              if (selectedTargetLabel && selectedId && onProjectMedia) {
                const item = items.find((i) => i.id === selectedId)
                if (item) onProjectMedia(item)
              } else onProject()
            }}
            disabled={!selectedId || !selectedTargetLabel}
          >
            Put selected media on shape
          </button>
        </>
      )}
    </div>
  )
}
