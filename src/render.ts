import type { Segment } from './shuffle'
import type { LyricLine } from './lyrics'

export type Shape = 'portrait' | 'landscape' | 'square'

export interface RenderJob {
  clips: File[]
  // Display size of each clip, 0 when unknown.
  clipSizes: { width: number; height: number }[]
  song: File
  plan: Segment[]
  shape: Shape
  crossfade: boolean
  // Timed lyrics to burn in, or null for no captions.
  captions: LyricLine[] | null
  // Every clip and the song can be read by the browser's own decoders.
  fastReadable: boolean
}

export interface SizedJob extends RenderJob {
  width: number
  height: number
}

export type Progress = { stage: 'engine' | 'render' | 'finish'; fraction: number }
export type OnProgress = (p: Progress) => void

// One clip could not be cut. clipIndex points into job.clips.
export class ClipError extends Error {
  readonly clipIndex: number
  constructor(clipIndex: number, cause?: unknown) {
    super(`Clip ${clipIndex} could not be read`, { cause })
    this.clipIndex = clipIndex
  }
}

// The ffmpeg engine could not be downloaded or started.
export class EngineLoadError extends Error {}

export const abortError = () => new DOMException('Cancelled', 'AbortError')
export const isAbort = (err: unknown) => err instanceof DOMException && err.name === 'AbortError'

// Hardware encoding makes full HD cheap. The ffmpeg fallback encodes in
// software on one thread, so it renders smaller to stay bearable.
const FAST_SIZES: Record<Shape, [number, number][]> = {
  portrait: [[1080, 1920], [720, 1280]],
  landscape: [[1920, 1080], [1280, 720]],
  square: [[1080, 1080], [720, 720]],
}
const FALLBACK_SIZES: Record<Shape, [number, number]> = {
  portrait: [720, 1280],
  landscape: [1280, 720],
  square: [720, 720],
}

export interface RenderResult {
  blob: Blob
  engine: 'fast' | 'ffmpeg'
  fallbackReason?: string
}

export async function render(job: RenderJob, onProgress: OnProgress, signal: AbortSignal): Promise<RenderResult> {
  let fallbackReason = 'not_readable_by_browser'

  if (job.fastReadable) {
    fallbackReason = 'no_hardware_encoder'
    const fast = await import('./render-fast')
    sizes: for (const [width, height] of FAST_SIZES[job.shape]) {
      if (!(await fast.canRenderFast(width, height))) continue
      for (const encoder of ['no-preference', 'prefer-software'] as const) {
        if (encoder === 'prefer-software' && !(await fast.canRenderFast(width, height, encoder))) break sizes
        try {
          const blob = await fast.renderFast({ ...job, width, height }, onProgress, signal, encoder)
          return { blob, engine: 'fast', fallbackReason: encoder === 'prefer-software' ? `software_encoder: ${fallbackReason}` : undefined }
        } catch (err) {
          if (isAbort(err)) throw err
          console.warn(`Fast render failed (${encoder})`, err)
          fallbackReason = err instanceof Error ? err.message.slice(0, 120) : 'fast_render_failed'
          // A clip the browser can't decode won't do better on another encoder.
          if (err instanceof ClipError) break sizes
        }
      }
      break
    }
  }

  const { renderWithFfmpeg } = await import('./ffmpeg')
  const [width, height] = FALLBACK_SIZES[job.shape]
  try {
    const blob = await renderWithFfmpeg({ ...job, width, height }, onProgress, signal)
    return { blob, engine: 'ffmpeg', fallbackReason }
  } catch (err) {
    if (err instanceof Error) Object.assign(err, { fallbackReason })
    throw err
  }
}

// The shape most of the clips already have, so most shots fill the frame.
export function autoShape(sizes: { width: number; height: number }[]): Shape {
  let portrait = 0
  let landscape = 0
  let square = 0
  for (const { width, height } of sizes) {
    if (!width || !height) continue
    const r = width / height
    if (r < 0.9) portrait++
    else if (r > 1.1) landscape++
    else square++
  }
  if (portrait > 0 && portrait >= landscape && portrait >= square) return 'portrait'
  if (square > landscape) return 'square'
  return 'landscape'
}

// Close enough to the frame's shape to fill it with a light crop.
export function fillsFrame(width: number, height: number, frameW: number, frameH: number): boolean {
  if (!width || !height) return false
  const ratio = (width / height) / (frameW / frameH)
  return ratio > 0.8 && ratio < 1.25
}
