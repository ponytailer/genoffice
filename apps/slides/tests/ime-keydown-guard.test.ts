/**
 * An IME composition owns the keys it is consuming. The global shortcut layer used
 * to act on them anyway: Escape dropped the selection, Delete removed the shape,
 * ⌘Z undid the deck — all while the user was only closing a candidate list. Worse,
 * preventDefault() on such a key stops the character reaching the editor, which is
 * how typing Latin letters appeared to do nothing at all.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { handleGlobalKeydown } from '../src/renderer/keyboard-actions'
import { ownedByComposition } from '../src/renderer/ime'
import * as clipboardActions from '../src/renderer/clipboard-actions'
import type { ActionCtx } from '../src/renderer/action-context'

vi.mock('../src/renderer/clipboard-actions', () => ({ deleteSelected: vi.fn() }))
vi.mock('../src/renderer/slide-actions', () => ({}))
vi.mock('../src/renderer/file-actions', () => ({}))
vi.mock('../src/renderer/arrange-actions', () => ({}))
vi.mock('../src/renderer/show-actions', () => ({}))
vi.mock('../src/renderer/style-actions', () => ({}))

function makeCtx(over: Record<string, unknown> = {}): ActionCtx {
  return {
    slideShow: false,
    presenter: false,
    editing: null,
    selectedIds: ['s'],
    slide: { nodes: [] },
    slides: [{}],
    current: 0,
    selectedSlides: [0],
    masterItems: null,
    inkTool: 'select',
    viewMode: 'normal',
    brushMode: null,
    enteredGroupId: null,
    overlayOpen: false,
    inkTool2: undefined,
    findNodeCtx: () => null,
    setSelectedIds: vi.fn(),
    setZoom: vi.fn(),
    setFindOpen: vi.fn(),
    setPrintDlgOpen: vi.fn(),
    setInkTool: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    ...over,
  } as unknown as ActionCtx
}

/** A keydown as it arrives while the IME owns the keystroke */
const composing = (key: string, keyCode?: number) => {
  const e = new KeyboardEvent('keydown', { key, cancelable: true, bubbles: true })
  Object.defineProperty(e, 'isComposing', { value: true })
  if (keyCode != null) Object.defineProperty(e, 'keyCode', { value: keyCode })
  return e
}

describe('ownedByComposition', () => {
  const ev = (isComposing: boolean, keyCode: number) =>
    ({ isComposing, keyCode }) as Pick<KeyboardEvent, 'isComposing' | 'keyCode'>

  it('a live composition owns the key', () => {
    expect(ownedByComposition(ev(true, 65))).toBe(true)
  })

  it('keyCode 229 owns it even when isComposing is unset (Windows)', () => {
    expect(ownedByComposition(ev(false, 229))).toBe(true)
  })

  it('an ordinary keystroke does not', () => {
    expect(ownedByComposition(ev(false, 65))).toBe(false)
    expect(ownedByComposition(ev(false, 27))).toBe(false)
  })
})

describe('keys the IME is consuming', () => {
  beforeEach(() => vi.clearAllMocks())

  it('Escape does not drop the selection', () => {
    const ctx = makeCtx({ selectedIds: ['s'] })
    const e = composing('Escape')
    handleGlobalKeydown(ctx, e)
    expect(ctx.setSelectedIds).not.toHaveBeenCalled()
    expect(e.defaultPrevented).toBe(false)
  })

  it('Delete does not remove the element', () => {
    const ctx = makeCtx()
    const e = composing('Delete')
    handleGlobalKeydown(ctx, e)
    expect(clipboardActions.deleteSelected).not.toHaveBeenCalled()
    expect(e.defaultPrevented).toBe(false)
  })

  it('⌘Z does not undo the deck', () => {
    const ctx = makeCtx()
    const e = new KeyboardEvent('keydown', { key: 'z', metaKey: true, cancelable: true })
    Object.defineProperty(e, 'isComposing', { value: true })
    handleGlobalKeydown(ctx, e)
    expect(ctx.undo).not.toHaveBeenCalled()
  })

  it('F5 does not start the show', () => {
    const ctx = makeCtx()
    const e = composing('F5')
    handleGlobalKeydown(ctx, e)
    expect(e.defaultPrevented).toBe(false)
  })

  it('a printable letter is left alone so it can reach the editor', () => {
    const ctx = makeCtx()
    const e = composing('a')
    handleGlobalKeydown(ctx, e)
    expect(e.defaultPrevented).toBe(false)
  })

  it('keyCode 229 is treated the same even without isComposing (Windows)', () => {
    const ctx = makeCtx({ selectedIds: ['s'] })
    const e = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    Object.defineProperty(e, 'keyCode', { value: 229 })
    handleGlobalKeydown(ctx, e)
    expect(ctx.setSelectedIds).not.toHaveBeenCalled()
    expect(e.defaultPrevented).toBe(false)
  })

  it('still acts once the composition has ended', () => {
    const ctx = makeCtx({ selectedIds: ['s'] })
    const e = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    handleGlobalKeydown(ctx, e)
    expect(ctx.setSelectedIds).toHaveBeenCalledWith([])
    expect(e.defaultPrevented).toBe(true)
  })
})
