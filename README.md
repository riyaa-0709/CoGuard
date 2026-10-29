# SpecForge starter

Level 0 is already built: a React app and an Express server that run together, plus a Settings panel where you paste your own AI key.

## Start (5 minutes)

```bash
npm install
npm run dev
```

Open http://localhost:5173. Press **Settings**, choose Gemini or OpenRouter, paste your key, press **Test key**. If it says the key works, you are ready for Level 1.

Don't have a key yet? Ask at the help desk. It is free.

## Where things are

| Folder | What it is |
| --- | --- |
| `sample-inputs/` | A sample course spec, a blueprint and the PO/PSO reference. Practice here. |
| `templates/` | The two HTML layouts your export must use. |
| `config/` | `po_pso.json` (POs, PSOs, Bloom's levels) and `specforge_output.schema.json` (the format of your output file). |
| `src/`, `server/` | Your app. |
| `outputs/` | Where your exported `specforge_output.json` goes. |

## Working with your AI assistant

This repo has an `AGENTS.md` (also copied as `CLAUDE.md`, `GEMINI.md` and a Cursor rule). Your assistant reads it first. Paste each level's prompt from the handbook, in order.

## Before you submit

With the app running (`npm run dev`), in a second terminal:

```bash
npm run verify -- gemini YOUR_KEY
```

This sends the sample files to your app's `POST /api/v1/generate`, exactly as the organisers will, saves
`outputs/specforge_output.json` and `outputs/spec.html`, and checks the output file. Upload both files on the portal.

Your final score comes from the organisers running your code at your last commit before 15:45, so `npm install` + `npm start`
must work on a fresh copy of your repo. Don't commit your key.
