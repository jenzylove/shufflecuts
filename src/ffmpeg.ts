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

  // 2 + 3. Cut and stitch in interleaved batches so memory never holds
  // more than one batch of segments at a time.
  onProgress?.('Processing…')
  const BATCH = 8
  const chunkFiles: string[] = []
  let segCounter = 0

  for (let batchStart = 0; batchStart < plan.length; batchStart += BATCH) {
    const batchEnd = Math.min(batchStart + BATCH, plan.length)
    const batchSegNames: string[] = []

    // Cut this batch's segments
    for (let i = batchStart; i < batchEnd; i++) {
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
      batchSegNames.push(out)
      segCounter++
      onProgress?.(`Processing segment ${segCounter} of ${plan.length}`)
    }

    // Immediately stitch this batch into a chunk
    const chunkName = `chunk${chunkFiles.length}.mp4`
    const listText = batchSegNames.map((f) => `file '${f}'`).join('\n')
    await ff.writeFile('list.txt', listText)
    await ff.exec([
      '-f', 'concat', '-safe', '0', '-i', 'list.txt',
      '-c', 'copy', chunkName,
    ])
    chunkFiles.push(chunkName)

    // Free this batch's segments right away — keeps memory flat
    for (const f of batchSegNames) {
      try { await ff.deleteFile(f) } catch { /* already gone */ }
    }
    try { await ff.deleteFile('list.txt') } catch { /* ignore */ }
  }

  // Free source clips now that all cutting is done
  for (const name of clipNames) {
    try { await ff.deleteFile(name) } catch { /* already gone */ }
  }

  // Combine all chunks into the final silent video
  onProgress?.('Combining…')
  const chunkList = chunkFiles.map((f) => `file '${f}'`).join('\n')
  await ff.writeFile('chunks.txt', chunkList)
  await ff.exec([
    '-f', 'concat', '-safe', '0', '-i', 'chunks.txt',
    '-c', 'copy', 'silent.mp4',
  ])
  for (const f of chunkFiles) {
    try { await ff.deleteFile(f) } catch { /* ignore */ }
  }
  try { await ff.deleteFile('chunks.txt') } catch { /* ignore */ }

  // 4. Add the audio track, trim to whichever ends first
  onProgress?.('Adding music…')
  await ff.exec([
    '-i', 'silent.mp4',
    '-i', 'audio.mp3',
    '-c:v', 'copy', '-c:a', 'aac',
    '-shortest', 'final.mp4',
  ])
// Free intermediates — final.mp4 already exists, safe to clean
  try { await ff.deleteFile('silent.mp4') } catch { /* ignore */ }
  try { await ff.deleteFile('audio.mp3') } catch { /* ignore */ }
  // 5. Read the result back out as a playable URL
  onProgress?.('Finishing…')
  const data = await ff.readFile('final.mp4')
  const bytes = new Uint8Array(data as Uint8Array)
  const blob = new Blob([bytes.buffer], { type: 'video/mp4' })
  return URL.createObjectURL(blob)
}