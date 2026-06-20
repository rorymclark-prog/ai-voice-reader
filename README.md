# AI Voice Reader

Standalone Gemini-powered voice reader for pasted text, PDFs, images, and plain-text files.

## Run Locally

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create `.env.local` from `.env.example` and set `GEMINI_API_KEY`.

3. Start the app:

   ```bash
   npm run dev
   ```

The local dev server runs on `http://localhost:3001/`.

## Shortcut

Highlight text anywhere in the app and press `Option+L` on Mac, or `Alt+L` elsewhere, to read it aloud.

## Checks

```bash
npm run lint
npm run build
```
