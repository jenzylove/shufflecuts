export interface Segment {
  clipIndex: number
  start: number
  duration: number
}

interface ShuffleOptions {
  clipDurations: number[]
  songDuration: number
  segmentLength: number
}

// Clips shorter than this are left out of the rotation.
const MIN_CLIP_SECONDS = 0.1

export function buildShufflePlan(opts: ShuffleOptions): Segment[] {
  const { clipDurations, songDuration, segmentLength } = opts
  const plan: Segment[] = []

  const usable = clipDurations
    .map((_, i) => i)
    .filter((i) => clipDurations[i] >= MIN_CLIP_SECONDS)
  if (usable.length === 0 || !(songDuration > 0) || !(segmentLength > 0)) return plan

  // Each clip has its own playhead that walks FORWARD through its timeline.
  // Start each at a different offset so they don't all begin at 0:00.
  const playhead: number[] = clipDurations.map(() => 0)
  usable.forEach((clip, i) => {
    const len = clipDurations[clip]
    playhead[clip] = (len / usable.length) * i % Math.max(len, 1)
  })

  let filled = 0
  let rotation = 0  // strict round-robin pointer

  while (songDuration - filled > 0.001) {
    // Strict rotation: A, B, C, A, B, C... guarantees even use, no domination
    const chosen = usable[rotation % usable.length]
    rotation++

    const clipLen = clipDurations[chosen]
    // A clip shorter than the cut plays whole, and the next clip picks up the
    // rest, so the video always lasts exactly as long as the song.
    const dur = Math.min(segmentLength, songDuration - filled, clipLen)

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
