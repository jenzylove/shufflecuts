import type { LyricLine } from './lyrics'

// Lyric captions, laid out the same way for both renderers.

export const CAPTION_FONT_URL = '/fonts/Anton-Regular.ttf'
const FAMILY = 'ShuffleCutsCaption'
const FADE_IN = 0.12

let fontReady: Promise<void> | null = null
export function loadCaptionFont(): Promise<void> {
  fontReady ??= (async () => {
    const face = new FontFace(FAMILY, `url(${CAPTION_FONT_URL})`)
    await face.load()
    document.fonts.add(face)
  })().catch((err) => {
    fontReady = null
    throw err
  })
  return fontReady
}

export interface CaptionLayout {
  rows: string[]
  fontSize: number
  lineHeight: number
  // y of the baseline of the last row
  bottom: number
}

let measureCtx: CanvasRenderingContext2D | null = null

export function captionFont(fontSize: number) {
  return `${fontSize}px ${FAMILY}, Impact, 'Arial Narrow', sans-serif`
}

// Wraps a lyric line to fit the frame. Sizes scale with the frame, so the
// wrapping is identical at 1080p and 720p.
const MAX_ROWS = 3

function wrap(ctx: CanvasRenderingContext2D, words: string[], maxWidth: number): string[] {
  const rows: string[] = []
  let row = ''
  for (const word of words) {
    const next = row ? `${row} ${word}` : word
    if (row && ctx.measureText(next).width > maxWidth) {
      rows.push(row)
      row = word
    } else {
      row = next
    }
  }
  if (row) rows.push(row)
  return rows
}

export function layoutCaption(text: string, W: number, H: number): CaptionLayout {
  const words = text.toUpperCase().split(/\s+/).filter(Boolean)
  const maxWidth = W * 0.86
  measureCtx ??= document.createElement('canvas').getContext('2d')
  const ctx = measureCtx!

  // Long lines shrink to fit three rows rather than losing words.
  let fontSize = Math.round(Math.min(W, H) * 0.072)
  const minSize = Math.round(fontSize * 0.7)
  ctx.font = captionFont(fontSize)
  let rows = wrap(ctx, words, maxWidth)
  while (rows.length > MAX_ROWS && fontSize > minSize) {
    fontSize = Math.max(minSize, Math.round(fontSize * 0.92))
    ctx.font = captionFont(fontSize)
    rows = wrap(ctx, words, maxWidth)
  }

  // Even out the rows so a single word isn't left alone on the last one.
  if (rows.length > 1) {
    let width = maxWidth
    for (;;) {
      const narrower = wrap(ctx, words, width * 0.95)
      if (narrower.length !== rows.length) break
      rows = narrower
      width *= 0.95
    }
  }

  // Portrait videos keep captions clear of the app buttons on Reels and TikTok.
  const bottom = Math.round(H * (H > W ? 0.8 : 0.88))
  return { rows: rows.slice(0, MAX_ROWS), fontSize, lineHeight: Math.round(fontSize * 1.12), bottom }
}

export class CaptionPainter {
  private lines: LyricLine[]
  private W: number
  private H: number
  private cache = new Map<number, CaptionLayout>()

  constructor(lines: LyricLine[], W: number, H: number) {
    this.lines = lines
    this.W = W
    this.H = H
  }

  // Draws whichever line is sung at time t (seconds into the song).
  paint(ctx: CanvasRenderingContext2D, t: number) {
    const i = this.lines.findIndex((l) => t >= l.start && t < l.end)
    if (i < 0) return
    const line = this.lines[i]
    let layout = this.cache.get(i)
    if (!layout) {
      layout = layoutCaption(line.text, this.W, this.H)
      this.cache.set(i, layout)
    }
    const appear = Math.min(1, (t - line.start) / FADE_IN)
    const lift = Math.round((1 - appear) * layout.fontSize * 0.25)

    ctx.save()
    ctx.globalAlpha = appear
    ctx.font = captionFont(layout.fontSize)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'alphabetic'
    ctx.lineJoin = 'round'
    ctx.lineWidth = Math.max(4, layout.fontSize * 0.14)
    ctx.strokeStyle = 'rgba(0,0,0,0.85)'
    ctx.fillStyle = '#fff'
    layout.rows.forEach((row, r) => {
      const y = layout.bottom - (layout.rows.length - 1 - r) * layout.lineHeight + lift
      ctx.strokeText(row, this.W / 2, y)
      ctx.fillText(row, this.W / 2, y)
    })
    ctx.restore()
  }
}
