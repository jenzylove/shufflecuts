export interface Segment {
  clipIndex: number
  start: number
  duration: number
}

interface ShuffleOptions {
  clipCount: number
  clipDurations: number[]
  songDuration: number
  segmentLength: number
}

export function buildShufflePlan(opts: ShuffleOptions): Segment[] {
  const { clipCount, clipDurations, songDuration, segmentLength } = opts
  const plan: Segment[] = []

  // Each clip has its own playhead that walks FORWARD through its timeline.
  // Start each at a different offset so they don't all begin at 0:00.
  const playhead: number[] = clipDurations.map((len, i) =>
    (len / clipCount) * i % Math.max(len, 1)
  )

  let filled = 0
  let rotation = 0  // strict round-robin pointer

  while (filled < songDuration) {
    // Strict rotation: A, B, C, A, B, C... guarantees even use, no domination
    const chosen = rotation % clipCount
    rotation++

    const remaining = songDuration - filled
    const dur = Math.min(segmentLength, remaining)

    const clipLen = clipDurations[chosen]

    // Take the segment at this clip's current playhead
    let start = playhead[chosen]
    // If we'd run off the end, wrap back toward the start
    if (start + dur > clipLen) start = 0

    plan.push({ clipIndex: chosen, start, duration: dur })

    // Advance THIS clip's playhead forward by a stride bigger than the segment,
    // so next time we see this clip we're at a genuinely different scene
    // (beginning -> middle -> end across the video).
    const stride = Math.max(dur, clipLen / 6)
    playhead[chosen] = (start + stride) % Math.max(clipLen - dur, 1)

    filled += dur
  }

  return plan
}