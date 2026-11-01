import {
  ALL_FORMATS,
  AudioBufferSink,
  AudioBufferSource,
  BlobSource,
  BufferTarget,
  CanvasSink,
  CanvasSource,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_MEDIUM,
  canEncodeAudio,
  canEncodeVideo,
} from 'mediabunny'
import { ClipError, abortError, fillsFrame, type OnProgress, type SizedJob } from './render'
import { CaptionPainter, loadCaptionFont } from './captions'

// Renders with the browser's own decoders and the device's hardware video
// encoder (WebCodecs). Clips are read straight from disk, never copied whole
// into memory.

const FPS = 30
const FADE = 0.4

export async function canRenderFast(width: number, height: number): Promise<boolean> {
  if (typeof VideoEncoder === 'undefined' || typeof VideoDecoder === 'undefined' || typeof AudioBuffer === 'undefined') {
    return false
  }
  try {
    return await canEncodeVideo('avc', { width, height, bitrate: QUALITY_MEDIUM, frameRate: FPS })
  } catch {
    return false
  }
}

let aacReady: Promise<void> | null = null
function ensureAac(): Promise<void> {
  aacReady ??= (async () => {
    // Some browsers (Firefox, older Android) have no native AAC encoder.
    if (!(await canEncodeAudio('aac'))) {
      const { registerAacEncoder } = await import('@mediabunny/aac-encoder')
      registerAacEncoder()
    }
  })()
  return aacReady
}

interface ClipSource {
  sink: CanvasSink
  first: number
  fill: boolean
  w: number
  h: number
}

async function openClip(file: File, W: number, H: number, inputs: Input[]): Promise<ClipSource> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS })
  inputs.push(input)
  const track = await input.getPrimaryVideoTrack()
  if (!track || !(await track.canDecode())) throw new Error('No decodable video track')
  const first = await track.getFirstTimestamp()
  const dw = await track.getDisplayWidth()
  const dh = await track.getDisplayHeight()

  if (fillsFrame(dw, dh, W, H)) {
    return { sink: new CanvasSink(track, { width: W, height: H, fit: 'cover', poolSize: 3 }), first, fill: true, w: W, h: H }
  }
  // Fit the whole shot inside the frame; paint() puts a soft blurred copy
  // of it behind, so there are no black bars.
  const scale = Math.min(W / dw, H / dh)
  const w = Math.max(2, Math.round(dw * scale))
  const h = Math.max(2, Math.round(dh * scale))
  return { sink: new CanvasSink(track, { width: w, height: h, fit: 'fill', poolSize: 3 }), first, fill: false, w, h }
}

export async function renderFast(job: SizedJob, onProgress: OnProgress, signal: AbortSignal): Promise<Blob> {
  const { clips, song, plan, width: W, height: H, crossfade, captions } = job
  if (signal.aborted) throw abortError()
  await ensureAac()
  if (captions) await loadCaptionFont()

  const stop = new AbortController()
  const onAbort = () => stop.abort()
  signal.addEventListener('abort', onAbort)
  const inputs: Input[] = []
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() })

  try {
    const canvas = document.createElement('canvas')
    canvas.width = W
    canvas.height = H
    const ctx = canvas.getContext('2d', { alpha: false })!
    // Small canvas for the blurred fill: blurring 64 pixels is nearly free.
    const bg = document.createElement('canvas')
    bg.width = 64
    bg.height = Math.max(1, Math.round((64 * H) / W))
    const bgx = bg.getContext('2d', { alpha: false })!
    bgx.filter = 'blur(2px)'

    const paint = (frame: CanvasImageSource, src: ClipSource) => {
      if (src.fill) {
        ctx.drawImage(frame, 0, 0, W, H)
        return
      }
      const s = Math.max(bg.width / src.w, bg.height / src.h) * 1.15
      bgx.drawImage(frame, (bg.width - src.w * s) / 2, (bg.height - src.h * s) / 2, src.w * s, src.h * s)
      ctx.drawImage(bg, 0, 0, W, H)
      ctx.fillStyle = 'rgba(0,0,0,0.35)'
      ctx.fillRect(0, 0, W, H)
      ctx.drawImage(frame, Math.round((W - src.w) / 2), Math.round((H - src.h) / 2))
    }

    const captionPainter = captions ? new CaptionPainter(captions, W, H) : null

    const videoSource = new CanvasSource(canvas, { codec: 'avc', bitrate: QUALITY_MEDIUM, keyFrameInterval: 2 })
    const audioSource = new AudioBufferSource({ codec: 'aac', bitrate: 192_000 })
    output.addVideoTrack(videoSource)
    output.addAudioTrack(audioSource)
    await output.start()

    const sources = new Map<number, ClipSource>()
    for (const i of new Set(plan.map((s) => s.clipIndex))) {
      try {
        sources.set(i, await openClip(clips[i], W, H, inputs))
      } catch (err) {
        throw new ClipError(i, err)
      }
    }

    const videoEnd = plan.reduce((sum, s) => sum + s.duration, 0)
    const totalFrames = Math.max(1, Math.round(videoEnd * FPS))

    const videoTask = async () => {
      let t = 0
      let done = 0
      for (const seg of plan) {
        const f0 = Math.round(t * FPS)
        t += seg.duration
        const count = Math.round(t * FPS) - f0
        if (count <= 0) continue
        const src = sources.get(seg.clipIndex)!
        const times = Array.from({ length: count }, (_, k) => src.first + seg.start + k / FPS)
        const frames = src.sink.canvasesAtTimestamps(times)
        for (let k = 0; k < count; k++) {
          if (stop.signal.aborted) {
            await frames.return(undefined)
            return
          }
          let next: IteratorResult<{ canvas: CanvasImageSource } | null>
          try {
            next = await frames.next()
          } catch (err) {
            throw new ClipError(seg.clipIndex, err)
          }
          // No frame (or the clip ran short): hold the previous picture.
          if (!next.done && next.value) {
            paint(next.value.canvas, src)
            if (crossfade) {
              const at = k / FPS
              const visible = Math.min(1, at / FADE, (seg.duration - at - 1 / FPS) / FADE)
              if (visible < 1) {
                ctx.fillStyle = `rgba(0,0,0,${(1 - Math.max(0, visible)).toFixed(3)})`
                ctx.fillRect(0, 0, W, H)
              }
            }
            // The video runs in step with the song, so output time is song time.
            captionPainter?.paint(ctx, (f0 + k) / FPS)
          }
          await videoSource.add((f0 + k) / FPS, 1 / FPS)
          done++
          onProgress({ stage: 'render', fraction: done / totalFrames })
        }
        await frames.return(undefined)
      }
    }

    const audioTask = async () => {
      const input = new Input({ source: new BlobSource(song), formats: ALL_FORMATS })
      inputs.push(input)
      const track = await input.getPrimaryAudioTrack()
      if (!track) throw new Error('The song has no audio track')
      const first = await track.getFirstTimestamp()
      let placed = 0
      for await (const { buffer } of new AudioBufferSink(track).buffers(first, first + videoEnd)) {
        if (stop.signal.aborted) return
        await audioSource.add(buffer)
        placed += buffer.duration
        if (placed >= videoEnd) break
      }
    }

    // If either side fails, stop the other one too.
    await Promise.all(
      [videoTask(), audioTask()].map((p) =>
        p.catch((err) => {
          stop.abort()
          throw err
        }),
      ),
    )
    if (signal.aborted) throw abortError()

    videoSource.close()
    audioSource.close()
    onProgress({ stage: 'finish', fraction: 1 })
    await output.finalize()
    return new Blob([output.target.buffer!], { type: 'video/mp4' })
  } catch (err) {
    if (output.state === 'started' || output.state === 'pending') await output.cancel().catch(() => {})
    if (signal.aborted) throw abortError()
    throw err
  } finally {
    signal.removeEventListener('abort', onAbort)
    for (const input of inputs) input.dispose()
  }
}
