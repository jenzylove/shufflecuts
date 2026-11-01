// Timed lyrics from LRCLIB (lrclib.net), a free open lyrics database.
// Only the song's title and artist are sent; the audio never leaves the device.

export interface LyricLine {
  start: number // seconds into the song
  end: number
  text: string
}

export interface Lyrics {
  title: string
  artist: string
  lines: LyricLine[]
}

export interface SongGuess {
  title: string
  artist: string
}

interface LrclibTrack {
  trackName: string
  artistName: string
  duration: number
  instrumental: boolean
  syncedLyrics: string | null
}

const API = 'https://lrclib.net/api'
// A line stays up at most this long when the next line is far away (an instrumental break).
const MAX_LINE_SECONDS = 7

export function parseLrc(lrc: string, songDuration = Infinity): LyricLine[] {
  const stamped: { start: number; text: string }[] = []
  for (const raw of lrc.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)]
    if (stamps.length === 0) continue
    const text = raw.replace(/\[[^\]]*\]/g, '').trim()
    for (const [, m, s] of stamps) stamped.push({ start: Number(m) * 60 + Number(s), text })
  }
  stamped.sort((a, b) => a.start - b.start)

  const lines: LyricLine[] = []
  for (let i = 0; i < stamped.length; i++) {
    const { start, text } = stamped[i]
    // Empty stamped lines mark where the previous line should clear.
    if (!text || start >= songDuration) continue
    const next = stamped[i + 1]?.start ?? songDuration
    const end = Math.min(next, start + MAX_LINE_SECONDS, songDuration)
    if (end > start) lines.push({ start, end, text })
  }
  return lines
}

const JUNK = /\s*[([](official|audio|video|lyrics?|visuali[sz]er|music video|hd|hq|explicit|clean)[^)\]]*[)\]]\s*/gi

// Best guess at title and artist from the file's tags, else its name
// ("Burna Boy - Last Last (Official Audio).mp3").
export function guessSong(fileName: string, tags?: { title?: string; artist?: string }): SongGuess {
  const tagTitle = tags?.title?.trim()
  const tagArtist = tags?.artist?.trim()
  if (tagTitle) return { title: tagTitle.replace(JUNK, ' ').trim(), artist: tagArtist ?? '' }

  const base = fileName
    .replace(/\.[a-z0-9]{2,4}$/i, '')
    .replace(/_/g, ' ')
    .replace(JUNK, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const parts = base.split(/\s+[-–—]\s+/)
  if (parts.length >= 2) return { artist: parts[0].trim(), title: parts.slice(1).join(' ').trim() }
  return { title: base, artist: tagArtist ?? '' }
}

// The lyrics service could not be reached (down, rate limited or offline),
// as opposed to answering that it has no lyrics for the song.
export class LyricsUnavailableError extends Error {}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function get<T>(path: string): Promise<T | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${API}${path}`, { signal: AbortSignal.timeout(8000) })
      if (res.status === 404) return null
      if (res.ok) return (await res.json()) as T
      if (res.status < 500 && res.status !== 429) return null
    } catch { /* network error or timeout: retry */ }
    // Ride out short blips, then report the outage instead of "not found".
    if (attempt === 2) throw new LyricsUnavailableError('Lyrics service unavailable')
    await wait(800 * 2 ** attempt)
  }
}

function pick(tracks: LrclibTrack[], duration: number): LrclibTrack | null {
  const synced = tracks.filter((t) => t.syncedLyrics && !t.instrumental)
  // Timings only line up when the user's file is the same recording.
  const close = synced.filter((t) => Math.abs(t.duration - duration) <= 4)
  close.sort((a, b) => Math.abs(a.duration - duration) - Math.abs(b.duration - duration))
  return close[0] ?? null
}

// Resolves to null when the service has no timed lyrics for the song.
// Throws LyricsUnavailableError when the service can't be reached.
export async function findLyrics(guess: SongGuess, duration: number): Promise<Lyrics | null> {
  const title = encodeURIComponent(guess.title)
  const artist = encodeURIComponent(guess.artist)
  const tries: (() => Promise<LrclibTrack | null>)[] = []
  if (guess.artist) {
    tries.push(async () => {
      const t = await get<LrclibTrack>(`/get?track_name=${title}&artist_name=${artist}&duration=${Math.round(duration)}`)
      return t ? pick([t], duration) : null
    })
    tries.push(async () => pick((await get<LrclibTrack[]>(`/search?track_name=${title}&artist_name=${artist}`)) ?? [], duration))
  }
  tries.push(async () => pick((await get<LrclibTrack[]>(`/search?q=${encodeURIComponent(`${guess.artist} ${guess.title}`.trim())}`)) ?? [], duration))

  for (const attempt of tries) {
    const track = await attempt()
    if (track?.syncedLyrics) {
      const lines = parseLrc(track.syncedLyrics, duration)
      if (lines.length > 0) return { title: track.trackName, artist: track.artistName, lines }
    }
  }
  return null
}
