<p align="center">
  <img src="docs/screenshot.png" alt="ShuffleCuts" width="560">
</p>

<h1 align="center">ShuffleCuts</h1>

<p align="center">
  <b>Drop your clips and a song. Get a music video.</b><br>
  <a href="https://shufflecuts.vercel.app">shufflecuts.vercel.app</a>
</p>

---

Got a folder of clips from a trip, a party or a match, and a song you want them set to? ShuffleCuts cuts them into a music video that lasts exactly as long as the song. No editing timeline, no account, no upload.

## How to use it

1. **Drop your clips.** Any video files, as many as you like.
2. **Add your track.** The song sets the length of the video.
3. **Pick a cut length** (2 to 10 seconds per shot) and choose whether you want smooth transitions.
4. **Generate.** Watch it right away and download it.

## How it works

- **Every clip gets its turn.** Shots rotate through your clips in order, so no single clip takes over the video.
- **No repeats of the same moment.** Each clip keeps its own place and moves forward through its footage, and each one starts at a different point.
- **It all happens on your device.** The video is put together in your browser with ffmpeg compiled for the web. Your clips never leave your computer or phone.

## Run it yourself

```bash
npm install
npm run dev
```

Built with React, TypeScript, Vite, Tailwind and ffmpeg.wasm.

## Good to know

Very long or very many clips can be too much for a browser's memory. If a video fails, try fewer or shorter clips, or turn off smooth transitions.
