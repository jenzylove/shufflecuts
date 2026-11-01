import { test } from 'node:test'
import assert from 'node:assert/strict'
import { guessSong, parseLrc } from './lyrics.ts'

test('parses LRC into timed lines', () => {
  const lines = parseLrc('[00:12.50] First line\n[00:15.00] Second line\n[00:18.25]\n[00:30.00] Third', 40)
  assert.deepEqual(lines.map((l) => l.text), ['First line', 'Second line', 'Third'])
  assert.equal(lines[0].start, 12.5)
  assert.equal(lines[0].end, 15)
  // an empty stamp clears the line before it
  assert.equal(lines[1].end, 18.25)
  // the last line ends with the song
  assert.equal(lines[2].end, 37)
})

test('a line never lingers through a long instrumental break', () => {
  const lines = parseLrc('[00:10.00] Hook\n[01:00.00] Verse', 120)
  assert.equal(lines[0].end, 17)
})

test('handles repeated stamps and metadata tags', () => {
  const lines = parseLrc('[ar:Someone]\n[00:05.00][00:25.00] Chorus\n[00:10.00] Verse', 60)
  assert.deepEqual(lines.map((l) => [l.start, l.text]), [[5, 'Chorus'], [10, 'Verse'], [25, 'Chorus']])
})

test('drops lines after the song ends', () => {
  assert.equal(parseLrc('[00:05.00] In\n[02:00.00] Out', 60).length, 1)
})

test('guesses title and artist from tags first, then the file name', () => {
  assert.deepEqual(guessSong('x.mp3', { title: 'Last Last', artist: 'Burna Boy' }), { title: 'Last Last', artist: 'Burna Boy' })
  assert.deepEqual(guessSong('Burna Boy - Last Last (Official Audio).mp3'), { artist: 'Burna Boy', title: 'Last Last' })
  assert.deepEqual(guessSong('Rema_-_Calm_Down.m4a'), { artist: 'Rema', title: 'Calm Down' })
  assert.deepEqual(guessSong('calm down.mp3'), { title: 'calm down', artist: '' })
})
