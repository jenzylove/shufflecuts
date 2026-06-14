import { useState } from 'react'
import { buildShufflePlan } from './shuffle'
import { getDuration, generateVideo } from './ffmpeg'

function App() {
  const [clips, setClips] = useState<File[]>([])
  const [audio, setAudio] = useState<File | null>(null)
const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [status, setStatus] = useState('')
  const [segLength, setSegLength] = useState(3)
  const [crossfade, setCrossfade] = useState(true)
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
    setStatus('Reading durations…')

    // Read real durations of clips + audio
    const clipDurations = []
    for (const c of clips) clipDurations.push(await getDuration(c))
    const songDuration = await getDuration(audio)

    // Build the shuffle plan from REAL numbers
    const plan = buildShufflePlan({
      clipCount: clips.length,
      clipDurations,
      songDuration,
      segmentLength: segLength,
    })

    // Generate the actual video
    const url = await generateVideo(clips, audio, plan, crossfade, (msg) => setStatus(msg))
    setVideoUrl(url)
    setStatus('')
  }
  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 flex flex-col items-center py-12 px-4">
      <div className="w-full max-w-md">
        <h1 className="text-xl font-medium mb-1">ShuffleCuts</h1>
        <p className="text-sm text-neutral-400 mb-8">Shuffle your clips into a music video.</p>

        {/* Clip upload */}
        <label className="block border border-dashed border-neutral-700 rounded-xl p-6 text-center cursor-pointer hover:border-violet-500 transition mb-4">
          <input type="file" accept="video/*" multiple onChange={handleClips} className="hidden" />
          <p className="text-sm font-medium">Drop your clips</p>
          <p className="text-xs text-neutral-500 mt-1">
            {clips.length > 0 ? `${clips.length} clip${clips.length > 1 ? 's' : ''} added` : 'video files'}
          </p>
        </label>

        {/* Clip list */}
        {clips.length > 0 && (
          <ul className="mb-4 space-y-1">
            {clips.map((c, i) => (
              <li key={i} className="text-xs text-neutral-400 bg-neutral-900 rounded px-3 py-2 flex items-center justify-between gap-2">
                <span className="truncate">{c.name}</span>
                <button
                  onClick={() => setClips((prev) => prev.filter((_, idx) => idx !== i))}
                  className="text-neutral-500 hover:text-red-400 transition shrink-0"
                  aria-label="Remove clip"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}

        {/* Audio upload */}
        <label className="flex items-center gap-3 bg-neutral-900 rounded-lg px-4 py-3 cursor-pointer hover:bg-neutral-800 transition">
          <input type="file" accept="audio/*" onChange={handleAudio} className="hidden" />
          <span className="text-sm text-violet-400">♪</span>
          <span className="text-sm truncate">
            {audio ? audio.name : 'Add your track'}
          </span>
        </label>
{/* Cut length selector */}
        <div className="mt-5 flex justify-between items-center">
          <label className="text-sm text-neutral-400">Cut length</label>
          <select
            value={segLength}
            onChange={(e) => setSegLength(Number(e.target.value))}
            className="bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-1.5 text-sm text-neutral-100 focus:border-violet-500 focus:outline-none cursor-pointer"
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
        {/* Crossfade toggle */}
        <div className="mt-3 flex justify-between items-center">
          <label className="text-sm text-neutral-400">Smooth transitions</label>
          <button
            onClick={() => setCrossfade(!crossfade)}
            className={`relative w-11 h-6 rounded-full transition ${crossfade ? 'bg-violet-600' : 'bg-neutral-700'}`}
          >
            <span className={`absolute top-1 left-1 w-4 h-4 bg-white rounded-full transition-transform ${crossfade ? 'translate-x-5' : ''}`} />
          </button>
        </div>
        {/* Test buttons */}
        {/* Generate */}
        <button onClick={handleGenerate} disabled={!!status} className="mt-6 w-full bg-violet-600 hover:bg-violet-500 disabled:opacity-50 transition rounded-lg py-2.5 text-sm font-medium">
          {status ? status : 'Generate my video'}
        </button>

        {/* Result */}
        {videoUrl && (
          <div className="mt-6">
            <video src={videoUrl} controls className="w-full rounded-lg" />
            <a href={videoUrl} download="shufflecuts.mp4" className="mt-3 block text-center bg-neutral-800 hover:bg-neutral-700 transition rounded-lg py-2.5 text-sm font-medium">
              Download MP4
            </a>
          </div>
        )}
      </div>
    </div>
  )
}

export default App