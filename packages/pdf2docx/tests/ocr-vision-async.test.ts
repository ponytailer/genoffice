/**
 * Async OCR engine (src/ocr-vision.ts createAsyncOcrEngine): the pdf viewer's
 * auto-OCR pass moved off `spawnSync` so Electron's main process keeps serving
 * IPC while a page is recognized. Two properties matter and neither is visible
 * from the sync engine's own tests:
 *
 *   1. parity — the async path must return exactly what the sync one does,
 *      since the page overlay, search index and the save-time bake all consume
 *      its boxes
 *   2. non-blocking — the caller's event loop must keep running during the call
 *
 * A shell stub stands in for the platform helper so this runs on any OS; the
 * real Vision binary is exercised manually (it needs macOS + the compiled
 * helper).
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createAsyncOcrEngine } from '../src/ocr-vision'

/** shell-quote a string for embedding in a single-quoted printf argument */
const shq = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`

/** helper protocol replay: consume stdin, emit the given stdout, exit */
const stubScript = (stdout: string, exitCode = 0): string =>
  `#!/bin/sh\ncat >/dev/null\nprintf '%s' ${shq(stdout)}\nexit ${exitCode}\n`

/** a helper that blocks for `ms` before answering, to prove the loop keeps running */
const slowStubScript = (stdout: string, ms: number, markerFile: string): string =>
  '#!/bin/sh\n' +
  'cat >/dev/null\n' +
  `sleep ${(ms / 1000).toFixed(2)}\n` +
  // the marker proves the child actually ran to completion
  `printf 'x' >> ${shq(markerFile)}\n` +
  `printf '%s' ${shq(stdout)}\n` +
  'exit 0\n'

const dir = mkdtempSync(join(tmpdir(), 'ocr-async-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function writeHelper(name: string, body: string): string {
  const path = join(dir, name)
  writeFileSync(path, body, { mode: 0o755 })
  return path
}

const GOOD = JSON.stringify({
  paper: 0.91,
  lines: [
    {
      t: '扫描件文字',
      c: 0.93,
      b: [0.1, 0.8, 0.6, 0.84],
      chars: [
        { t: '扫', b: [0.1, 0.8, 0.14, 0.84] },
        { t: '描', b: [0.14, 0.8, 0.18, 0.84] },
      ],
    },
  ],
})

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

describe('createAsyncOcrEngine', () => {
  it('decodes the helper protocol into lines, boxes and chars', async () => {
    const engine = createAsyncOcrEngine(writeHelper('good.sh', stubScript(GOOD)))
    const result = await engine(PNG)
    expect(result).not.toBeNull()
    expect(result!.paperShare).toBeCloseTo(0.91)
    expect(result!.lines).toHaveLength(1)
    const line = result!.lines[0]!
    expect(line.text).toBe('扫描件文字')
    expect(line.confidence).toBeCloseTo(0.93)
    expect(line.box).toEqual({ x0: 0.1, y0: 0.8, x1: 0.6, y1: 0.84 })
    expect(line.chars?.map((c) => c.text)).toEqual(['扫', '描'])
  })

  it('tolerates a UTF-8 BOM in front of the JSON', async () => {
    const engine = createAsyncOcrEngine(
      writeHelper('bom.sh', `#!/bin/sh\ncat >/dev/null\nprintf '\\357\\273\\277%s' ${shq(GOOD)}\n`),
    )
    const result = await engine(PNG)
    expect(result?.lines[0]?.text).toBe('扫描件文字')
  })

  it('returns null — not a throw — when the helper exits non-zero', async () => {
    const engine = createAsyncOcrEngine(writeHelper('fail.sh', stubScript('', 3)))
    await expect(engine(PNG)).resolves.toBeNull()
  })

  it('returns null when the helper prints junk', async () => {
    const engine = createAsyncOcrEngine(writeHelper('junk.sh', stubScript('not json')))
    await expect(engine(PNG)).resolves.toBeNull()
  })

  it('returns null when the helper is missing entirely', async () => {
    const engine = createAsyncOcrEngine(join(dir, 'nope.sh'))
    await expect(engine(PNG)).resolves.toBeNull()
  })

  it('does not block the event loop while the helper runs', async () => {
    const marker = join(dir, 'ticks.txt')
    const engine = createAsyncOcrEngine(writeHelper('slow.sh', slowStubScript(GOOD, 300, marker)))
    let ticks = 0
    const timer = setInterval(() => {
      ticks += 1
    }, 10)
    try {
      const result = await engine(PNG)
      expect(result).not.toBeNull()
    } finally {
      clearInterval(timer)
    }
    // spawnSync would leave ticks at 0-1; a free loop ticks ~30 times in 300ms
    expect(ticks).toBeGreaterThan(5)
    expect(existsSync(marker)).toBe(true)
  })

  it('feeds the helper the png bytes on stdin', async () => {
    const echo = writeHelper(
      'echo.sh',
      '#!/bin/sh\n' +
        'n=$(wc -c | tr -d " ")\n' +
        `printf '{"lines":[{"t":"%s","c":1,"b":[0,0,1,1]}]}' "$n"\n`,
    )
    const result = await createAsyncOcrEngine(echo)(new Uint8Array(1234))
    // 4-byte length prefix is NOT used here: the helper protocol is raw png on stdin
    expect(result?.lines[0]?.text).toBe('1234')
  })
})
