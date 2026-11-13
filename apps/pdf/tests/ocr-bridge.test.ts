/**
 * The main-process OCR bridge's IPC mapping (apps/pdf/src/main/ocr.ts
 * toPdfOcrLines). The renderer's overlay, search index and save-time bake all
 * read these boxes, so the OcrRecognition → PdfOcrLine conversion is asserted
 * directly — the surrounding IPC handler cannot run without Electron.
 */
import { describe, expect, it } from 'vitest'
import { toPdfOcrLines } from '../src/main/ocr'
import type { OcrRecognition } from '../../../packages/pdf2docx/src/ocr'

describe('toPdfOcrLines', () => {
  it('flattens Rect objects into the 4-tuple the renderer expects', () => {
    const recognition: OcrRecognition = {
      lines: [
        {
          text: '算法未备案',
          confidence: 0.91,
          box: { x0: 0.1, y0: 0.8, x1: 0.6, y1: 0.84 },
        },
      ],
    }
    const [line] = toPdfOcrLines(recognition)
    expect(line!.box).toEqual([0.1, 0.8, 0.6, 0.84])
    expect(line!.text).toBe('算法未备案')
    expect(line!.confidence).toBeCloseTo(0.91)
  })

  it('keeps per-char boxes when the engine reports them', () => {
    const recognition: OcrRecognition = {
      lines: [
        {
          text: '扫描',
          confidence: 0.9,
          box: { x0: 0, y0: 0, x1: 1, y1: 1 },
          chars: [
            { text: '扫', box: { x0: 0, y0: 0, x1: 0.5, y1: 1 } },
            { text: '描', box: { x0: 0.5, y0: 0, x1: 1, y1: 1 } },
          ],
        },
      ],
    }
    const [line] = toPdfOcrLines(recognition)
    expect(line!.chars?.map((c) => c.text)).toEqual(['扫', '描'])
    expect(line!.chars?.[1]!.box).toEqual([0.5, 0, 1, 1])
  })

  it('omits chars entirely when the engine gave none', () => {
    const recognition: OcrRecognition = {
      lines: [{ text: 'x', confidence: 1, box: { x0: 0, y0: 0, x1: 1, y1: 1 } }],
    }
    const [line] = toPdfOcrLines(recognition)
    expect(line).not.toHaveProperty('chars')
  })

  it('maps an empty recognition to no lines', () => {
    expect(toPdfOcrLines({ lines: [] })).toEqual([])
  })
})
