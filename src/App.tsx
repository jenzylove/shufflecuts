import { useState } from 'react'
import { buildShufflePlan } from './shuffle'
import { getDuration, generateVideo } from './ffmpeg'

function App() {
  const [clips, setClips] = useState<File[]>([])
  const [audio, setAudio] = useState<File | null>(null)
const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [status, setStatus] = useState('')
  const [segLength, setSegLength] = useState(3)
  const [crossfade, setCrossfade] = useState(false)
  const [error, setError] = useState('')
  const handleClips = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const newClips = Array.from(e.target.files)
      setClips((prev) => [...prev, ...newClips])
    }
    e.target.value = '' // reset so the same file can be re-picked if needed
  }

  const handleAudio = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.[0]) setAudio(e.target.files[0])
  }
  const handleGenerate = async () => {
    if (clips.length === 0 || !audio) {
      alert('Add clips and a track first!')
      return
    }
    setVideoUrl(null)
    setError('')
    setStatus('Reading durations…')

    try {
      const clipDurations = []
      for (const c of clips) clipDurations.push(await getDuration(c))
      const songDuration = await getDuration(audio)

      const plan = buildShufflePlan({
        clipCount: clips.length,
        clipDurations,
        songDuration,
        segmentLength: segLength,
      })

      const url = await generateVideo(clips, audio, plan, crossfade, (msg) => setStatus(msg))
      setVideoUrl(url)
      setStatus('')
    } catch (err) {
      console.error(err)
      setStatus('')
      setError(
        'That was a lot of footage for your browser to handle. Try fewer clips, shorter clips, or turn off smooth transitions, then generate again.'
      )
    }
  }
  return (
    <div className="min-h-screen bg-[#0a0a0f] text-neutral-100 flex flex-col items-center px-4 py-10 sm:py-16">
      <header className="w-full max-w-lg mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">
          Shuffle<span className="text-violet-400">Cuts</span>
        </h1>
        <p className="text-sm text-neutral-500 mt-1">
          Drop your clips and a track. Get a shuffled music video — right in your browser.
        </p>
      </header>

      <main className="w-full max-w-lg bg-[#12121a] border border-white/5 rounded-2xl p-6 sm:p-8 shadow-2xl shadow-black/40">
        <label className="group block border-2 border-dashed border-neutral-700 rounded-xl p-10 text-center cursor-pointer hover:border-violet-500 hover:bg-violet-500/5 transition mb-5">
          <input type="file" accept="video/*" multiple onChange={handleClips} className="hidden" />
          <div className="text-3xl mb-2 opacity-60 group-hover:opacity-100 transition">⬆</div>
          <p className="text-base font-medium">Drop your clips</p>
          <p className="text-xs text-neutral-500 mt-1">
            {clips.length > 0 ? `${clips.length} clip${clips.length > 1 ? 's' : ''} ready` : 'or click to browse · video files'}
          </p>
        </label>

        {clips.length > 0 && (
          <ul className="mb-5 space-y-1.5">
            {clips.map((c, i) => (
              <li key={i} className="text-xs text-neutral-400 bg-white/[0.03] border border-white/5 rounded-lg px-3 py-2.5 flex items-center justify-between gap-2">
                <span className="truncate">{c.name}</span>
                <button
                  onClick={() => setClips((prev) => prev.filter((_, idx) => idx !== i))}
                  className="text-neutral-600 hover:text-red-400 transition shrink-0 text-sm"
                  aria-label="Remove clip"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}

        <label className="flex items-center gap-3 bg-white/[0.03] border border-white/5 rounded-xl px-4 py-3.5 cursor-pointer hover:bg-white/[0.06] transition mb-6">
          <input type="file" accept="audio/*" onChange={handleAudio} className="hidden" />
          <span className="text-violet-400 text-lg">♪</span>
          <span className="text-sm truncate text-neutral-300">{audio ? audio.name : 'Add your track'}</span>
        </label>

        <div className="space-y-4 mb-6">
          <div className="flex justify-between items-center">
            <label className="text-sm text-neutral-400">Cut length</label>
            <select
              value={segLength}
              onChange={(e) => setSegLength(Number(e.target.value))}
              className="bg-[#0a0a0f] border border-neutral-700 rounded-lg px-3 py-1.5 text-sm text-neutral-100 focus:border-violet-500 focus:outline-none cursor-pointer"
            >
              <option value={2}>2s</option>
              <option value={3}>3s</option>
              <option value={4}>4s</option>
              <option value={5}>5s</option>
              <option value={6}>6s</option>
              <option value={8}>8s</option>
              <option value={10}>10s</option>
            </select>
          </div>
          <div className="flex justify-between items-center">
            <label className="text-sm text-neutral-400">Smooth transitions</label>
            <button
              onClick={() => setCrossfade(!crossfade)}
              className={`relative w-11 h-6 rounded-full transition ${crossfade ? 'bg-violet-600' : 'bg-neutral-700'}`}
            >
              <span className={`absolute top-1 left-1 w-4 h-4 bg-white rounded-full transition-transform ${crossfade ? 'translate-x-5' : ''}`} />
            </button>
          </div>
        </div>

        <button
          onClick={handleGenerate}
          disabled={!!status}
          className="w-full bg-violet-600 hover:bg-violet-500 disabled:opacity-50 disabled:cursor-not-allowed transition rounded-xl py-3 text-sm font-semibold"
        >
          {status ? status : 'Generate my video'}
        </button>

        {error && (
          <div className="mt-4 text-sm text-amber-300 bg-amber-950/40 border border-amber-900/50 rounded-lg px-4 py-3">
            {error}
          </div>
        )}

        {videoUrl && (
          <div className="mt-6">
            <video src={videoUrl} controls className="w-full rounded-xl border border-white/5" />
            <a
              href={videoUrl}
              download="shufflecuts.mp4"
              className="mt-3 block text-center bg-white/5 hover:bg-white/10 transition rounded-xl py-3 text-sm font-medium"
            >
              Download MP4
            </a>
          </div>
        )}
      </main>

      <footer className="mt-8 text-xs text-neutral-600">
        Your clips never leave your device. free and private.
      </footer>
    </div>
  )
}

export default App