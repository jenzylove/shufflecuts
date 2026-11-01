import { FFmpeg, FFFSType } from '@ffmpeg/ffmpeg'
import coreURL from '@ffmpeg/core?url'
import wasmURL from '@ffmpeg/core/wasm?url'
import { ClipError, EngineLoadError, abortError, fillsFrame, type OnProgress, type SizedJob } from './render'
import { CAPTION_FONT_URL, layoutCaption, loadCaptionFont } from './captions'

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

// The engine leaks a little memory on every command, and a long song runs
// over a hundred of them, so it is restarted every few batches. The engine
// itself stays in the browser cache, so a restart takes about a second.
const BATCH = 8
const BATCHES_PER_ENGINE = 4

export async function renderWithFfmpeg(job: SizedJob, onProgress: OnProgress, signal: AbortSignal): Promise<Blob> {
  const { clips, clipSizes, song, plan, width: W, height: H, crossfade, captions } = job
  if (signal.aborted) throw abortError()

  let ff = await loadEngine((fraction) => onProgress({ stage: 'engine', fraction }))
  if (signal.aborted) throw abortError()
  // terminate() rejects the running command, which lands in catch below.
  const onAbort = () => resetEngine()
  signal.addEventListener('abort', onAbort)

  let segDone = 0
  const steps = plan.length + 1
  const onExecProgress = ({ progress }: { progress: number }) => {
    if (progress >= 0 && progress <= 1) onProgress({ stage: 'render', fraction: (segDone + progress) / steps })
  }

  const run = async (args: string[], failure: () => Error) => {
    const code = await ff.exec(['-hide_banner', ...args])
    if (code !== 0) throw failure()
  }

  // Each caption row becomes its own drawtext so every row is centred.
  // Text goes through files, which avoids escaping lyrics inside the filter.
  const captionRows: { start: number; end: number; file: string; text: string; size: number; y: number }[] = []
  let font: Uint8Array | null = null
  if (captions) {
    await loadCaptionFont()
    font = new Uint8Array(await (await fetch(CAPTION_FONT_URL)).arrayBuffer())
    for (const [i, line] of captions.entries()) {
      const layout = layoutCaption(line.text, W, H)
      for (const [r, row] of layout.rows.entries()) {
        const y = layout.bottom - (layout.rows.length - 1 - r) * layout.lineHeight
        captionRows.push({ start: line.start, end: line.end, file: `cap${i}_${r}.txt`, text: row, size: layout.fontSize, y })
      }
    }
  }

  // Mounts the clips and writes the caption files into a (fresh) engine.
  let dir = ''
  const prepare = async () => {
    ff.on('progress', onExecProgress)
    dir = await mountFiles(ff, [
      ...clips.map((data, i) => ({ name: `c${i}`, data })),
      { name: 'song', data: song },
    ])
    if (font) {
      await ff.writeFile('caption.ttf', font.slice())
      for (const c of captionRows) await ff.writeFile(c.file, c.text)
    }
  }
  const restart = async () => {
    ff.off('progress', onExecProgress)
    resetEngine()
    ff = await loadEngine()
    if (signal.aborted) throw abortError()
    await prepare()
  }

  try {
    await prepare()

    // Cut in batches of 8 shots and stitch each batch into a chunk. Finished
    // chunks move out of the engine's memory into the page's.
    const chunks: Uint8Array[] = []
    let segStart = 0
    for (let batchStart = 0; batchStart < plan.length; batchStart += BATCH) {
      if (batchStart > 0 && (batchStart / BATCH) % BATCHES_PER_ENGINE === 0) await restart()
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
        // Segment time starts at 0, so shift each caption by where the segment sits in the song.
        for (const c of captionRows) {
          const a = c.start - segStart
          const b = c.end - segStart
          if (b <= 0 || a >= seg.duration) continue
          vf.push(`drawtext=fontfile=caption.ttf:textfile=${c.file}:fontsize=${c.size}:fontcolor=white` +
            `:borderw=${Math.max(3, Math.round(c.size * 0.07))}:bordercolor=black@0.85` +
            `:x=(w-text_w)/2:y=${c.y}-ascent:enable='between(t,${a.toFixed(3)},${b.toFixed(3)})'`)
        }
        segStart += seg.duration
        await run(
          ['-ss', String(seg.start), '-i', `${dir}/c${seg.clipIndex}`, '-t', String(seg.duration),
            '-an', '-vf', vf.join(','), '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '26',
            '-maxrate', '3M', '-bufsize', '6M', out],
          () => new ClipError(seg.clipIndex),
        )
        batchSegNames.push(out)
        segDone++
        onProgress({ stage: 'render', fraction: segDone / steps })
      }

      await ff.writeFile('list.txt', batchSegNames.map((f) => `file '${f}'`).join('\n'))
      await run(['-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c', 'copy', 'chunk.mp4'], () => new Error('Stitching failed'))
      chunks.push((await ff.readFile('chunk.mp4')) as Uint8Array)
      for (const f of [...batchSegNames, 'list.txt', 'chunk.mp4']) await ff.deleteFile(f).catch(() => {})
    }

    // A fresh engine joins the chunks and adds the song in one pass.
    await restart()
    const names = chunks.map((_, i) => `chunk${i}.mp4`)
    for (const [i, data] of chunks.entries()) await ff.writeFile(names[i], data)
    chunks.length = 0
    await ff.writeFile('chunks.txt', names.map((f) => `file '${f}'`).join('\n'))
    await run(
      ['-f', 'concat', '-safe', '0', '-i', 'chunks.txt', '-i', `${dir}/song`, '-map', '0:v:0', '-map', '1:a:0',
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', 'final.mp4'],
      () => new Error('Adding the song failed'),
    )
    for (const f of [...names, 'chunks.txt']) await ff.deleteFile(f).catch(() => {})
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
