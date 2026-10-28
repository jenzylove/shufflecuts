import { useEffect, useRef, useState } from 'react'
import { buildShufflePlan } from './shuffle'
import type { MediaInfo } from './probe'
import { ClipError, EngineLoadError, autoShape, isAbort, render, type Progress, type Shape } from './render'

interface ClipItem {
  id: number
  file: File
  info: MediaInfo | null // null while the header is being read
}

interface SongItem {
  file: File
  info: MediaInfo | null
}

interface Result {
  url: string
  seconds: number
}

const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv|avi|3gp|mts|m2ts)$/i
const AUDIO_EXT = /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac)$/i
const SHAPE_LABEL: Record<Shape, string> = { portrait: 'Portrait 9:16', landscape: 'Landscape 16:9', square: 'Square 1:1' }

let nextId = 1

// Clock for timing a render. Kept outside the component so the React purity
// lint knows it only runs in event handlers.
const now = () => performance.now()

// The media reader is a large chunk; load it after the page has painted.
const loadProbe = () => import('./probe')

function track(event: string, props?: Record<string, unknown>) {
  try { window.pendo?.track(event, props) } catch { /* analytics optional */ }
}

function formatTime(seconds: number) {
  const s = Math.max(0, Math.round(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function formatEta(seconds: number) {
  if (seconds < 60) return `About ${Math.max(5, Math.ceil(seconds / 5) * 5)} seconds left`
  const m = Math.round(seconds / 60)
  return `About ${m} minute${m > 1 ? 's' : ''} left`
}

function errorMessage(err: unknown, clips: File[]) {
  if (err instanceof ClipError) {
    const name = clips[err.clipIndex]?.name ?? 'one of your clips'
    return `We couldn't read "${name}". Remove it and generate again.`
  }
  if (err instanceof EngineLoadError) {
    return "We couldn't download the video engine. Check your connection and try again."
  }
  const text = String(err instanceof Error ? `${err.name} ${err.message}` : err)
  if (/memory|OOM|allocation|Aborted\(/i.test(text)) {
    return 'Your browser ran out of memory. Try fewer or shorter clips, then generate again.'
  }
  return 'Something went wrong while making your video. Try again, and if it keeps failing, try fewer clips.'
}

function App() {
  const [clips, setClips] = useState<ClipItem[]>([])
  const [song, setSong] = useState<SongItem | null>(null)
  const [segLength, setSegLength] = useState(4)
  const [crossfade, setCrossfade] = useState(false)
  const [shapeChoice, setShapeChoice] = useState<'auto' | Shape>('auto')
  const [dragging, setDragging] = useState(false)
  const [notice, setNotice] = useState('')
  const [progress, setProgress] = useState<Progress | null>(null)
  const [eta, setEta] = useState('')
  const [result, setResult] = useState<Result | null>(null)
  const [error, setError] = useState('')
  const [waitlistEmail, setWaitlistEmail] = useState('')
  const [waitlist, setWaitlist] = useState<'idle' | 'sending' | 'done' | 'error'>('idle')
  const abortRef = useRef<AbortController | null>(null)
  const resultRef = useRef<HTMLDivElement | null>(null)

  const rendering = progress !== null
  const readyClips = clips.filter((c) => c.info && c.info.duration > 0)
  const reading = clips.some((c) => !c.info) || (song !== null && !song.info)
  const songReady = !!song?.info && song.info.duration > 0
  const shape: Shape = shapeChoice === 'auto' ? autoShape(readyClips.map((c) => c.info!)) : shapeChoice
  const canGenerate = !rendering && !reading && readyClips.length > 0 && songReady

  useEffect(() => {
    const idle = window.requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 1500))
    idle(() => { void loadProbe() })
  }, [])

  // Dropping a file outside the drop zone would make the browser open it
  // and leave the app, losing everything the user picked.
  useEffect(() => {
    const guard = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault()
    }
    window.addEventListener('dragover', guard)
    window.addEventListener('drop', guard)
    return () => {
      window.removeEventListener('dragover', guard)
      window.removeEventListener('drop', guard)
    }
  }, [])

  // Free the previous video when a new one replaces it.
  useEffect(() => () => { if (result) URL.revokeObjectURL(result.url) }, [result])

  const pickSong = async (file: File) => {
    setSong({ file, info: null })
    const { probeSong } = await loadProbe()
    const info = await probeSong(file)
    setSong((cur) => (cur?.file === file ? { file, info } : cur))
  }

  const addFiles = async (files: File[]) => {
    const videos = files.filter((f) => f.type.startsWith('video/') || VIDEO_EXT.test(f.name))
    const audios = files.filter((f) => !videos.includes(f) && (f.type.startsWith('audio/') || AUDIO_EXT.test(f.name)))
    const skipped = files.length - videos.length - audios.length
    setNotice(skipped > 0 ? `Skipped ${skipped} file${skipped > 1 ? 's' : ''} that ${skipped > 1 ? "aren't" : "isn't a"} video${skipped > 1 ? 's' : ''}.` : '')
    if (audios.length > 0) void pickSong(audios[0])

    const items = videos.map((file) => ({ id: nextId++, file, info: null }))
    if (items.length === 0) return
    setClips((prev) => [...prev, ...items])
    // Only the header of each file is read, so this takes moments.
    const { probeVideo } = await loadProbe()
    for (const item of items) {
      const info = await probeVideo(item.file)
      setClips((prev) => prev.map((c) => (c.id === item.id ? { ...c, info } : c)))
    }
  }

  const handleClips = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) void addFiles(Array.from(e.target.files))
    e.target.value = '' // reset so the same file can be re-picked if needed
  }

  const handleSong = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.[0]) void pickSong(e.target.files[0])
    e.target.value = ''
  }

  const handleGenerate = async () => {
    if (!canGenerate || !song?.info) return
    const used = readyClips
    const files = used.map((c) => c.file)
    const songSeconds = song.info.duration
    const controller = new AbortController()
    abortRef.current = controller

    setResult(null)
    setError('')
    setEta('')
    setProgress({ stage: 'render', fraction: 0 })

    let wakeLock: WakeLockSentinel | null = null
    try { wakeLock = (await navigator.wakeLock?.request('screen')) ?? null } catch { /* not supported */ }

    const started = now()
    let renderStarted = 0
    let lastPaint = 0
    const onProgress = (p: Progress) => {
      const t = now()
      if (p.stage === 'render' && !renderStarted) renderStarted = t
      // A frame arrives many times a second; repainting 8 times a second is plenty.
      if (t - lastPaint < 125 && p.stage === 'render' && p.fraction < 1) return
      lastPaint = t
      setProgress(p)
      const elapsed = (t - renderStarted) / 1000
      if (p.stage === 'render' && p.fraction > 0.03 && elapsed > 2) {
        setEta(formatEta((elapsed * (1 - p.fraction)) / p.fraction))
      }
    }

    try {
      const plan = buildShufflePlan({
        clipDurations: used.map((c) => c.info!.duration),
        songDuration: songSeconds,
        segmentLength: segLength,
      })
      const out = await render(
        {
          clips: files,
          clipSizes: used.map((c) => ({ width: c.info!.width, height: c.info!.height })),
          song: song.file,
          plan,
          shape,
          crossfade,
          fastReadable: used.every((c) => c.info!.fast) && song.info.fast,
        },
        onProgress,
        controller.signal,
      )
      const seconds = Math.round((now() - started) / 1000)
      setResult({ url: URL.createObjectURL(out.blob), seconds })
      requestAnimationFrame(() => resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
      track('video_generated', {
        clips: used.length, cutLength: segLength, engine: out.engine, seconds,
        songSeconds: Math.round(songSeconds), shape, crossfade, fallbackReason: out.fallbackReason,
      })
    } catch (err) {
      if (isAbort(err)) {
        track('render_cancelled', { clips: used.length, songSeconds: Math.round(songSeconds) })
      } else {
        console.error(err)
        setError(errorMessage(err, files))
        track('render_failed', { clips: used.length, songSeconds: Math.round(songSeconds), reason: String(err).slice(0, 120) })
      }
    } finally {
      abortRef.current = null
      setProgress(null)
      setEta('')
      wakeLock?.release().catch(() => {})
    }
  }

  const joinWaitlist = async () => {
    if (!/^\S+@\S+\.\S+$/.test(waitlistEmail)) {
      setWaitlist('error')
      return
    }
    setWaitlist('sending')
    try {
      const res = await fetch('https://formspree.io/f/mnjywwyl', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ email: waitlistEmail }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setWaitlist('done')
      track('waitlist_joined')
    } catch {
      setWaitlist('error')
    }
  }

  const pct = progress ? Math.floor(progress.fraction * 100) : 0
  const stageLabel = !progress
    ? ''
    : progress.stage === 'engine'
      ? 'Getting the video engine ready (first time only)'
      : progress.stage === 'finish'
        ? 'Finishing'
        : 'Making your video'

  let hint = ''
  if (!rendering) {
    if (clips.length === 0) hint = 'Add at least one clip to start.'
    else if (reading) hint = 'Reading your files…'
    else if (readyClips.length === 0) hint = "None of these clips can be read. Try MP4 or MOV files."
    else if (!song) hint = 'Now add a song.'
    else if (!songReady) hint = "We can't read that song. Try an MP3 or M4A file."
  }

  return (
    <div className="min-h-screen bg-[#0a0a0f] text-neutral-100 flex flex-col items-center px-4 py-10 sm:py-16">
      <header className="w-full max-w-lg mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">
          Shuffle<span className="text-violet-400">Cuts</span>
        </h1>
        <p className="text-sm text-neutral-500 mt-1">
          Drop your clips and a track. Get a shuffled music video, made right in your browser.
        </p>
      </header>

      <main className="w-full max-w-lg bg-[#12121a] border border-white/5 rounded-2xl p-6 sm:p-8 shadow-2xl shadow-black/40">
        <fieldset disabled={rendering} className={rendering ? 'opacity-50 pointer-events-none' : ''}>
          <label
            onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragging(false)
              if (!rendering) void addFiles(Array.from(e.dataTransfer.files))
            }}
            className={`group block border-2 border-dashed rounded-xl p-10 text-center cursor-pointer transition mb-5 ${
              dragging ? 'border-violet-400 bg-violet-500/10' : 'border-neutral-700 hover:border-violet-500 hover:bg-violet-500/5'
            }`}
          >
            <input type="file" accept="video/*" multiple onChange={handleClips} className="hidden" data-test="clips-input" />
            <div className="text-3xl mb-2 opacity-60 group-hover:opacity-100 transition">⬆</div>
            <p className="text-base font-medium">Drop your clips</p>
            <p className="text-xs text-neutral-500 mt-1">
              {clips.length > 0 ? `${clips.length} clip${clips.length > 1 ? 's' : ''} added` : 'or click to browse · video files'}
            </p>
          </label>

          {notice && <p className="text-xs text-neutral-500 -mt-3 mb-4">{notice}</p>}

          {clips.length > 0 && (
            <ul className="mb-5 space-y-1.5">
              {clips.map((c) => {
                const bad = c.info !== null && c.info.duration <= 0
                return (
                  <li
                    key={c.id}
                    data-test="clip-row"
                    className="text-xs text-neutral-400 bg-white/[0.03] border border-white/5 rounded-lg px-3 py-2.5 flex items-center justify-between gap-2"
                  >
                    <span className={`truncate ${bad ? 'text-neutral-600 line-through' : ''}`}>{c.file.name}</span>
                    <span className="flex items-center gap-3 shrink-0">
                      {c.info === null ? (
                        <span className="text-neutral-600">reading…</span>
                      ) : bad ? (
                        <span className="text-amber-300">Can't read this file</span>
                      ) : (
                        <span className="tabular-nums text-neutral-500">{formatTime(c.info.duration)}</span>
                      )}
                      <button
                        onClick={() => setClips((prev) => prev.filter((x) => x.id !== c.id))}
                        className="text-neutral-600 hover:text-red-400 transition text-sm"
                        aria-label={`Remove ${c.file.name}`}
                      >
                        ✕
                      </button>
                    </span>
                  </li>
                )
              })}
            </ul>
          )}

          <label className="flex items-center gap-3 bg-white/[0.03] border border-white/5 rounded-xl px-4 py-3.5 cursor-pointer hover:bg-white/[0.06] transition mb-6">
            <input type="file" accept="audio/*" onChange={handleSong} className="hidden" data-test="song-input" />
            <span className="text-violet-400 text-lg">♪</span>
            <span className="text-sm truncate text-neutral-300 flex-1">{song ? song.file.name : 'Add your track'}</span>
            {song && (
              <span className="text-xs tabular-nums text-neutral-500 shrink-0">
                {song.info === null ? 'reading…' : songReady ? formatTime(song.info.duration) : <span className="text-amber-300">Can't read this file</span>}
              </span>
            )}
          </label>

          <div className="space-y-4 mb-6">
            <div className="flex justify-between items-center">
              <label htmlFor="shape" className="text-sm text-neutral-400">Shape</label>
              <select
                id="shape"
                data-test="shape"
                value={shapeChoice}
                onChange={(e) => setShapeChoice(e.target.value as 'auto' | Shape)}
                className="bg-[#0a0a0f] border border-neutral-700 rounded-lg px-3 py-1.5 text-sm text-neutral-100 focus:border-violet-500 focus:outline-none cursor-pointer"
              >
                <option value="auto">Auto · {SHAPE_LABEL[autoShape(readyClips.map((c) => c.info!))].split(' ')[0]}</option>
                <option value="portrait">{SHAPE_LABEL.portrait}</option>
                <option value="landscape">{SHAPE_LABEL.landscape}</option>
                <option value="square">{SHAPE_LABEL.square}</option>
              </select>
            </div>
            <div className="flex justify-between items-center">
              <label htmlFor="cut" className="text-sm text-neutral-400">Cut length</label>
              <select
                id="cut"
                data-test="cut"
                value={segLength}
                onChange={(e) => setSegLength(Number(e.target.value))}
                className="bg-[#0a0a0f] border border-neutral-700 rounded-lg px-3 py-1.5 text-sm text-neutral-100 focus:border-violet-500 focus:outline-none cursor-pointer"
              >
                {[2, 3, 4, 5, 6, 8, 10].map((s) => (
                  <option key={s} value={s}>{s}s</option>
                ))}
              </select>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-sm text-neutral-400">Smooth transitions</span>
              <button
                role="switch"
                aria-checked={crossfade}
                aria-label="Smooth transitions"
                onClick={() => setCrossfade(!crossfade)}
                className={`relative w-11 h-6 rounded-full transition ${crossfade ? 'bg-violet-600' : 'bg-neutral-700'}`}
              >
                <span className={`absolute top-1 left-1 w-4 h-4 bg-white rounded-full transition-transform ${crossfade ? 'translate-x-5' : ''}`} />
              </button>
            </div>
          </div>
        </fieldset>

        {rendering ? (
          <div data-test="progress" className="rounded-xl bg-white/[0.03] border border-white/5 px-4 py-4">
            <div className="flex justify-between text-sm mb-2">
              <span className="text-neutral-300">{stageLabel}</span>
              <span className="tabular-nums text-neutral-400" data-test="percent">{pct}%</span>
            </div>
            <div className="h-2 rounded-full bg-white/5 overflow-hidden">
              <div className="h-full bg-violet-500 transition-[width] duration-200" style={{ width: `${Math.max(2, pct)}%` }} />
            </div>
            <div className="flex justify-between items-center mt-3 text-xs text-neutral-500">
              <span>{eta || 'Keep this tab open until it finishes.'}</span>
              <button
                data-test="cancel"
                onClick={() => abortRef.current?.abort()}
                className="text-neutral-400 hover:text-white transition px-2 py-1 -mr-2"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <>
            <button
              data-test="generate"
              onClick={handleGenerate}
              disabled={!canGenerate}
              className="w-full bg-violet-600 hover:bg-violet-500 disabled:opacity-50 disabled:cursor-not-allowed transition rounded-xl py-3 text-sm font-semibold"
            >
              {result ? 'Generate again' : 'Generate my video'}
            </button>
            {hint && <p className="text-xs text-neutral-500 text-center mt-2">{hint}</p>}
          </>
        )}

        {error && (
          <div data-test="error" className="mt-4 text-sm text-amber-300 bg-amber-950/40 border border-amber-900/50 rounded-lg px-4 py-3">
            {error}
          </div>
        )}

        {result && !rendering && (
          <div className="mt-6 scroll-mt-6" ref={resultRef}>
            <video src={`${result.url}#t=0.1`} controls playsInline preload="metadata" className="w-full max-h-[70vh] rounded-xl border border-white/5 bg-black" />
            <a
              href={result.url}
              download="shufflecuts.mp4"
              className="mt-3 block text-center bg-white/5 hover:bg-white/10 transition rounded-xl py-3 text-sm font-medium"
            >
              Download MP4
            </a>
            <p className="text-xs text-neutral-600 text-center mt-2">Made in {result.seconds} seconds.</p>
            <div className="mt-5 pt-5 border-t border-white/5">
              {waitlist === 'done' ? (
                <p className="text-sm text-violet-300 text-center">You're on the list. Thanks! 🎬</p>
              ) : (
                <>
                  <p className="text-sm text-neutral-300 mb-1">Want auto lyrics, longer exports and saved history?</p>
                  <p className="text-xs text-neutral-500 mb-3">Join the Pro waitlist and be first to know.</p>
                  <div className="flex gap-2">
                    <input
                      type="email"
                      value={waitlistEmail}
                      onChange={(e) => { setWaitlistEmail(e.target.value); if (waitlist === 'error') setWaitlist('idle') }}
                      placeholder="your@email.com"
                      className="flex-1 min-w-0 bg-[#0a0a0f] border border-neutral-700 rounded-lg px-3 py-2 text-sm focus:border-violet-500 focus:outline-none"
                    />
                    <button
                      onClick={joinWaitlist}
                      disabled={waitlist === 'sending'}
                      className="bg-violet-600 hover:bg-violet-500 disabled:opacity-50 transition rounded-lg px-4 py-2 text-sm font-medium"
                    >
                      {waitlist === 'sending' ? 'Joining…' : 'Join'}
                    </button>
                  </div>
                  {waitlist === 'error' && (
                    <p className="text-xs text-amber-300 mt-2">That didn't go through. Check the email and try again.</p>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </main>

      <footer className="mt-8 text-xs text-neutral-600">
        Your clips never leave your device. Free and private.
      </footer>
    </div>
  )
}

export default App
