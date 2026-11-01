import { ALL_FORMATS, BlobSource, Input } from 'mediabunny'

export interface MediaInfo {
  // Seconds of playable media, 0 when nothing could read the file.
  duration: number
  // Display size after rotation. 0 for audio or when unknown.
  width: number
  height: number
  // The browser's own decoder can read it, so the fast path can use it.
  fast: boolean
}

// Reads only the file's header: no full copy into memory, so it is instant
// even for large phone clips.
export async function probeVideo(file: File): Promise<MediaInfo> {
  try {
    const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS })
    try {
      const track = await input.getPrimaryVideoTrack()
      if (track) {
        const first = await track.getFirstTimestamp()
        const end = (await track.getDurationFromMetadata()) ?? (await track.computeDuration())
        const duration = Math.max(0, end - first)
        if (duration > 0) {
          const fast = typeof VideoDecoder !== 'undefined' && (await track.canDecode())
          return { duration, width: await track.getDisplayWidth(), height: await track.getDisplayHeight(), fast }
        }
      }
    } finally {
      input.dispose()
    }
  } catch { /* not a container Mediabunny reads; try the browser's player */ }

  const viaElement = await probeWithElement(file, 'video')
  if (viaElement.duration > 0) return viaElement
  return probeWithEngine(file, 'video')
}

export async function probeSong(file: File): Promise<MediaInfo> {
  try {
    const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS })
    try {
      const track = await input.getPrimaryAudioTrack()
      if (track) {
        const first = await track.getFirstTimestamp()
        const end = (await track.getDurationFromMetadata()) ?? (await track.computeDuration())
        const duration = Math.max(0, end - first)
        if (duration > 0) {
          const fast = typeof AudioDecoder !== 'undefined' && (await track.canDecode())
          return { duration, width: 0, height: 0, fast }
        }
      }
    } finally {
      input.dispose()
    }
  } catch { /* fall through */ }

  const viaElement = await probeWithElement(file, 'audio')
  if (viaElement.duration > 0) return viaElement
  return probeWithEngine(file, 'audio')
}

function probeWithElement(file: File, kind: 'video' | 'audio'): Promise<MediaInfo> {
  return new Promise((resolve) => {
    const el = document.createElement(kind)
    const url = URL.createObjectURL(file)
    let settled = false
    const finish = (info: MediaInfo) => {
      if (settled) return
      settled = true
      URL.revokeObjectURL(url)
      el.removeAttribute('src')
      resolve(info)
    }
    el.preload = 'metadata'
    el.muted = true
    el.onloadedmetadata = () => {
      const d = Number.isFinite(el.duration) ? el.duration : 0
      const v = el as HTMLVideoElement
      finish({ duration: d, width: v.videoWidth || 0, height: v.videoHeight || 0, fast: false })
    }
    el.onerror = () => finish({ duration: 0, width: 0, height: 0, fast: false })
    setTimeout(() => finish({ duration: 0, width: 0, height: 0, fast: false }), 15000)
    el.src = url
  })
}

const UNREADABLE: MediaInfo = { duration: 0, width: 0, height: 0, fast: false }

// Formats the browser reads itself. If both readers above failed on one of
// these, the file is damaged, and ffmpeg won't do better.
const BROWSER_FORMATS = {
  video: /.(mp4|m4v|mov|webm)$/i,
  audio: /.(mp3|m4a|aac|wav|ogg|oga|opus|flac|webm|mp4)$/i,
}

// Last resort for unusual formats (AVI, MKV, WMA...): only these files pay
// for the ffmpeg download.
async function probeWithEngine(file: File, kind: 'video' | 'audio'): Promise<MediaInfo> {
  if (BROWSER_FORMATS[kind].test(file.name)) return UNREADABLE
  try {
    const { getDuration } = await import('./ffmpeg')
    return { duration: await getDuration(file), width: 0, height: 0, fast: false }
  } catch {
    return UNREADABLE
  }
}

// Title and artist from the song's own tags (ID3, MP4 and so on), when present.
export async function readSongTags(file: File): Promise<{ title?: string; artist?: string }> {
  try {
    const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS })
    try {
      const tags = await input.getMetadataTags()
      return { title: tags.title, artist: tags.artist }
    } finally {
      input.dispose()
    }
  } catch {
    return {}
  }
}
