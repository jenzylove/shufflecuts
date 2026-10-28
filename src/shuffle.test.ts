import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildShufflePlan } from './shuffle.ts'

const total = (plan: { duration: number }[]) => plan.reduce((s, p) => s + p.duration, 0)

test('video lasts exactly as long as the song', () => {
  const plan = buildShufflePlan({ clipDurations: [20, 20, 15], songDuration: 183.45, segmentLength: 4 })
  assert.ok(Math.abs(total(plan) - 183.45) < 0.002)
})

test('a clip shorter than the cut length does not shorten the video', () => {
  const plan = buildShufflePlan({ clipDurations: [20, 2], songDuration: 30, segmentLength: 4 })
  assert.ok(Math.abs(total(plan) - 30) < 0.002)
  for (const seg of plan) assert.ok(seg.start + seg.duration <= [20, 2][seg.clipIndex] + 1e-9)
})

test('clips stay in strict rotation', () => {
  const plan = buildShufflePlan({ clipDurations: [10, 10, 10], songDuration: 24, segmentLength: 4 })
  assert.deepEqual(plan.map((s) => s.clipIndex), [0, 1, 2, 0, 1, 2])
})

test('unreadable clips are skipped instead of breaking the plan', () => {
  const plan = buildShufflePlan({ clipDurations: [0, 12], songDuration: 10, segmentLength: 4 })
  assert.ok(plan.every((s) => s.clipIndex === 1))
  assert.ok(Math.abs(total(plan) - 10) < 0.002)
})

test('nothing to plan when there are no usable clips or no song', () => {
  assert.equal(buildShufflePlan({ clipDurations: [0], songDuration: 30, segmentLength: 4 }).length, 0)
  assert.equal(buildShufflePlan({ clipDurations: [10], songDuration: 0, segmentLength: 4 }).length, 0)
})

test('every segment stays inside its clip', () => {
  const lens = [7.3, 3.1, 61, 0.9]
  const plan = buildShufflePlan({ clipDurations: lens, songDuration: 240, segmentLength: 3 })
  for (const seg of plan) {
    assert.ok(seg.start >= 0)
    assert.ok(seg.start + seg.duration <= lens[seg.clipIndex] + 1e-9)
  }
})
