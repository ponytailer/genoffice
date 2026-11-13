/**
 * System-OCR bridge for the pdf viewer (issue #119): recognizes one rendered
 * page image via the platform helper binaries shared with pdf2docx
 * (macOS Vision / Windows.Media.Ocr). Same helper-path resolution as the
 * shell's pdf2docx-local.ts — packaged under Resources/ocr, repo-relative in
 * dev. Linux (or a build without the helper) resolves to no engine and the
 * viewer keeps today's behavior.
 *
 * This bridge uses the ASYNC engine on purpose: the main process shares its
 * event loop with every open window's IPC, and a page takes seconds in Vision,
 * so the sync engine froze the whole app for the length of the pass.
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createVisionOcrEngineAsync,
  createWindowsOcrEngineAsync,
} from '../../../../packages/pdf2docx/src/ocr-vision'
import type { AsyncOcrEngine, OcrRecognition } from '../../../../packages/pdf2docx/src/ocr'
import type { PdfOcrLine } from '../shared/ipc'

let ocrEngine: AsyncOcrEngine | null | undefined

function ensureOcrEngine(): AsyncOcrEngine | null {
  if (ocrEngine !== undefined) return ocrEngine
  const here = dirname(fileURLToPath(import.meta.url))
  const helper = process.platform === 'darwin' ? 'vision-ocr' : 'win-ocr.exe'
  const create =
    process.platform === 'darwin' ? createVisionOcrEngineAsync : createWindowsOcrEngineAsync
  const candidates = [
    ...(process.resourcesPath ? [join(process.resourcesPath, 'ocr', helper)] : []),
    join(here, '../../../../packages/pdf2docx/ocr-helper', helper),
  ]
  ocrEngine = null
  for (const path of candidates) {
    const engine = create(path)
    if (engine) {
      ocrEngine = engine
      break
    }
  }
  return ocrEngine
}

/** Recognition → the IPC shape; exported for the unit tests (the IPC path
    itself cannot be exercised without Electron). */
export function toPdfOcrLines(result: OcrRecognition): PdfOcrLine[] {
  return result.lines.map((l) => ({
    text: l.text,
    confidence: l.confidence,
    box: [l.box.x0, l.box.y0, l.box.x1, l.box.y1],
    ...(l.chars
      ? {
          chars: l.chars.map((c) => ({
            text: c.text,
            box: [c.box.x0, c.box.y0, c.box.x1, c.box.y1] as [number, number, number, number],
          })),
        }
      : {}),
  }))
}

/** PNG (base64) → OCR lines; null only when the platform has no engine (callers
    stop trying), [] when recognition failed for this image (callers move on) */
export async function ocrPagePng(pngBase64: string): Promise<PdfOcrLine[] | null> {
  const engine = ensureOcrEngine()
  if (!engine) return null
  let png: Uint8Array
  try {
    png = Uint8Array.from(Buffer.from(pngBase64, 'base64'))
  } catch {
    return []
  }
  const result = await engine(png)
  if (!result) return []
  return toPdfOcrLines(result)
}
