import { FFmpeg } from '@ffmpeg/ffmpeg'
import { fetchFile } from '@ffmpeg/util'
import type { Segment } from './shuffle'
import coreURL from '@ffmpeg/core?url'
import wasmURL from '@ffmpeg/core/wasm?url'

let ffmpeg: FFmpeg | null = null

export async function getFFmpeg(): Promise<FFmpeg> {
  if (ffmpeg) return ffmpeg

  ffmpeg = new FFmpeg()

  ffmpeg.on('log', ({ message }) => {
    console.log('[ffmpeg]', message)
  })

  await ffmpeg.load({ coreURL, wasmURL })

  return ffmpeg
}

// Reads how many seconds long a video/audio file is.
export async function getDuration(file: File): Promise<number> {
  const ff = await getFFmpeg()
  const name = 'probe_' + file.name.replace(/[^a-zA-Z0-9.]/g, '_')

  await ff.writeFile(name, await fetchFile(file))

  let duration = 0
  // ffmpeg prints duration in its logs; we capture it.
  const handler = ({ message }: { message: string }) => {
    const match = message.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/)
    if (match) {
      const [, h, m, s] = match
      duration = (+h) * 3600 + (+m) * 60 + parseFloat(s)
    }
  }
  ff.on('log', handler)

  // Run a harmless command that makes ffmpeg report the file's info
  try {
    await ff.exec(['-i', name])
  } catch {
    // ffmpeg "errors" on -i with no output, but still prints duration — that's fine
  }

  ff.off('log', handler)
  await ff.deleteFile(name)

  return duration
}

// Takes the shuffle plan + real files, produces one stitched MP4 with the audio.
export async function generateVideo(
  clips: File[],
  audio: File,
  plan: Segment[],
  useCrossfade: boolean,
  onProgress?: (msg: string) => void
): Promise<string> {
  const ff = await getFFmpeg()

  // 1. Load all clip files + audio into ffmpeg's memory
  onProgress?.('Loading files…')
  const clipNames: string[] = []
  for (let i = 0; i < clips.length; i++) {
    const name = `clip${i}.mp4`
    await ff.writeFile(name, await fetchFile(clips[i]))
    clipNames.push(name)
  }
  await ff.writeFile('audio.mp3', await fetchFile(audio))

  // 2. Cut each planned segment into its own small file (normalized to 1080p, 30fps)
  onProgress?.('Cutting segments…')
  const segFiles: string[] = []
  for (let i = 0; i < plan.length; i++) {
    const seg = plan[i]
    const out = `seg${i}.mp4`
    const fadeDur = 0.4
    const vf = [
      'scale=1920:1080:force_original_aspect_ratio=decrease',
      'pad=1920:1080:(ow-iw)/2:(oh-ih)/2',
      'setsar=1',
      'fps=30',
    ]
    if (useCrossfade) {
      const fadeOutStart = Math.max(0, seg.duration - fadeDur)
      vf.push(`fade=t=in:st=0:d=${fadeDur}`)
      vf.push(`fade=t=out:st=${fadeOutStart.toFixed(2)}:d=${fadeDur}`)
    }
    await ff.exec([
      '-ss', String(seg.start),
      '-i', clipNames[seg.clipIndex],
      '-t', String(seg.duration),
      '-an',
      '-vf', vf.join(','),
      '-c:v', 'libx264', '-preset', 'ultrafast',
      out,
    ])
    segFiles.push(out)
    onProgress?.(`Cut segment ${i + 1} of ${plan.length}`)
  }

  // 3. Stitch all segments (fades are already baked into each segment)
  onProgress?.('Stitching…')
  const listText = segFiles.map((f) => `file '${f}'`).join('\n')
  await ff.writeFile('list.txt', listText)
  await ff.exec([
    '-f', 'concat', '-safe', '0', '-i', 'list.txt',
    '-c', 'copy', 'silent.mp4',
  ])

  // 4. Add the audio track, trim to whichever ends first
  onProgress?.('Adding music…')
  await ff.exec([
    '-i', 'silent.mp4',
    '-i', 'audio.mp3',
    '-c:v', 'copy', '-c:a', 'aac',
    '-shortest', 'final.mp4',
  ])

  // 5. Read the result back out as a playable URL
  onProgress?.('Finishing…')
  const data = await ff.readFile('final.mp4')
  const bytes = new Uint8Array(data as Uint8Array)
  const blob = new Blob([bytes.buffer], { type: 'video/mp4' })
  return URL.createObjectURL(blob)
}