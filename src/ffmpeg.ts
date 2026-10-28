import { FFmpeg, FFFSType } from '@ffmpeg/ffmpeg'
import coreURL from '@ffmpeg/core?url'
import wasmURL from '@ffmpeg/core/wasm?url'
import { ClipError, EngineLoadError, abortError, fillsFrame, type OnProgress, type SizedJob } from './render'

// Fallback renderer for browsers without hardware encoding (WebCodecs), or for
// files the browser itself can't decode. Software encoding on one thread, so
// it is much slower than the fast path.

// Size of ffmpeg-core.wasm once decompressed, for download progress.
const WASM_BYTES = 32_129_114

let engine: Promise<FFmpeg> | null = null
let onDownload: ((fraction: number) => void) | null = null
let runCounter = 0

export function loadEngine(progress?: (fraction: number) => void): Promise<FFmpeg> {
  if (progress) onDownload = progress
  if (!engine) {
    engine = (async () => {
      let wasmBlobURL = ''
      try {
        // Fetch the 10 MB engine ourselves so the user sees download progress.
        const res = await fetch(wasmURL)
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
        const reader = res.body.getReader()
        const chunks: Uint8Array<ArrayBuffer>[] = []
        let received = 0
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          chunks.push(value)
          received += value.length
          onDownload?.(Math.min(0.99, received / WASM_BYTES))
        }
        wasmBlobURL = URL.createObjectURL(new Blob(chunks, { type: 'application/wasm' }))
        const ff = new FFmpeg()
        if (import.meta.env.DEV) ff.on('log', ({ message }) => console.log('[ffmpeg]', message))
        await ff.load({ coreURL, wasmURL: wasmBlobURL })
        onDownload?.(1)
        return ff
      } catch (err) {
        engine = null
        throw new EngineLoadError('Could not load the video engine', { cause: err })
      } finally {
        if (wasmBlobURL) URL.revokeObjectURL(wasmBlobURL)
      }
    })()
  }
  return engine
}

// After a failure or a cancel the engine may be stuck mid command or out of
// memory. Throw it away so the next try starts clean.
function resetEngine() {
  const current = engine
  engine = null
  current?.then((ff) => ff.terminate()).catch(() => {})
}

// Clips are mounted read only: ffmpeg reads them from disk as it goes
// instead of holding a full copy of every file in memory.
async function mountFiles(ff: FFmpeg, blobs: { name: string; data: Blob }[]): Promise<string> {
  const dir = `/in${++runCounter}`
  await ff.createDir(dir)
  await ff.mount(FFFSType.WORKERFS, { blobs }, dir)
  return dir
}

async function unmountFiles(ff: FFmpeg, dir: string) {
  try {
    await ff.unmount(dir)
    await ff.deleteDir(dir)
  } catch { /* engine already reset */ }
}

// Reads how many seconds long a video/audio file is.
export async function getDuration(file: File): Promise<number> {
  const ff = await loadEngine()
  const dir = await mountFiles(ff, [{ name: 'probe', data: file }])
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
  try {
    // Exits non zero because there is no output, but still prints the duration.
    await ff.exec(['-hide_banner', '-i', `${dir}/probe`])
  } finally {
    ff.off('log', handler)
    await unmountFiles(ff, dir)
  }
  return duration
}

export async function renderWithFfmpeg(job: SizedJob, onProgress: OnProgress, signal: AbortSignal): Promise<Blob> {
  const { clips, clipSizes, song, plan, width: W, height: H, crossfade } = job
  if (signal.aborted) throw abortError()

  const ff = await loadEngine((fraction) => onProgress({ stage: 'engine', fraction }))
  if (signal.aborted) throw abortError()
  // terminate() rejects the running command, which lands in catch below.
  const onAbort = () => resetEngine()
  signal.addEventListener('abort', onAbort)

  let segDone = 0
  const steps = plan.length + 1
  const onExecProgress = ({ progress }: { progress: number }) => {
    if (progress >= 0 && progress <= 1) onProgress({ stage: 'render', fraction: (segDone + progress) / steps })
  }
  ff.on('progress', onExecProgress)

  const run = async (args: string[], failure: () => Error) => {
    const code = await ff.exec(['-hide_banner', ...args])
    if (code !== 0) throw failure()
  }

  try {
    const dir = await mountFiles(ff, [
      ...clips.map((data, i) => ({ name: `c${i}`, data })),
      { name: 'song', data: song },
    ])

    // Cut and stitch in interleaved batches so memory never holds
    // more than one batch of segments at a time.
    const BATCH = 8
    const chunkFiles: string[] = []
    for (let batchStart = 0; batchStart < plan.length; batchStart += BATCH) {
      const batchSegNames: string[] = []
      for (let i = batchStart; i < Math.min(batchStart + BATCH, plan.length); i++) {
        const seg = plan[i]
        const out = `seg${i}.mp4`
        const size = clipSizes[seg.clipIndex]
        const vf = fillsFrame(size.width, size.height, W, H)
          ? [`scale=${W}:${H}:force_original_aspect_ratio=increase:flags=fast_bilinear`, `crop=${W}:${H}`]
          : [`scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=fast_bilinear`, `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2`]
        vf.push('setsar=1', 'fps=30', 'format=yuv420p')
        if (crossfade) {
          const fadeDur = 0.4
          vf.push(`fade=t=in:st=0:d=${fadeDur}`)
          vf.push(`fade=t=out:st=${Math.max(0, seg.duration - fadeDur).toFixed(2)}:d=${fadeDur}`)
        }
        await run(
          ['-ss', String(seg.start), '-i', `${dir}/c${seg.clipIndex}`, '-t', String(seg.duration),
            '-an', '-vf', vf.join(','), '-c:v', 'libx264', '-preset', 'ultrafast', out],
          () => new ClipError(seg.clipIndex),
        )
        batchSegNames.push(out)
        segDone++
        onProgress({ stage: 'render', fraction: segDone / steps })
      }

      const chunkName = `chunk${chunkFiles.length}.mp4`
      await ff.writeFile('list.txt', batchSegNames.map((f) => `file '${f}'`).join('\n'))
      await run(['-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c', 'copy', chunkName], () => new Error('Stitching failed'))
      chunkFiles.push(chunkName)
      for (const f of [...batchSegNames, 'list.txt']) await ff.deleteFile(f).catch(() => {})
    }

    await ff.writeFile('chunks.txt', chunkFiles.map((f) => `file '${f}'`).join('\n'))
    await run(['-f', 'concat', '-safe', '0', '-i', 'chunks.txt', '-c', 'copy', 'silent.mp4'], () => new Error('Stitching failed'))
    for (const f of [...chunkFiles, 'chunks.txt']) await ff.deleteFile(f).catch(() => {})

    await run(
      ['-i', 'silent.mp4', '-i', `${dir}/song`, '-map', '0:v:0', '-map', '1:a:0',
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', 'final.mp4'],
      () => new Error('Adding the song failed'),
    )
    await ff.deleteFile('silent.mp4').catch(() => {})
    onProgress({ stage: 'finish', fraction: 1 })

    const data = await ff.readFile('final.mp4')
    await ff.deleteFile('final.mp4').catch(() => {})
    await unmountFiles(ff, dir)
    return new Blob([data as Uint8Array<ArrayBuffer>], { type: 'video/mp4' })
  } catch (err) {
    resetEngine()
    if (signal.aborted) throw abortError()
    throw err
  } finally {
    signal.removeEventListener('abort', onAbort)
    ff.off('progress', onExecProgress)
  }
}
