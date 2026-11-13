/**
 * Who owns a keystroke: the document, or the input method?
 *
 * While an IME composition is live, the letters the user presses go into the IME's
 * own buffer and never reach the DOM. By the time such a key arrives at a keydown
 * listener it still carries the composition (isComposing), and on Windows it also
 * reports keyCode 229 because the layout has not committed a character yet. Treating
 * one as an editing key is what strands a composition: preventDefault() keeps the
 * character out of the editor, and a handler that closes or commits the editor leaves
 * the IME holding text with no element to deliver it to — the user sees nothing while
 * typing and then every buffered letter at once.
 *
 * Declared here rather than at each call site so the rule cannot drift between the
 * editor overlay and the global shortcut layer.
 */
export function ownedByComposition(e: Pick<KeyboardEvent, 'isComposing' | 'keyCode'>): boolean {
  return e.isComposing || e.keyCode === 229
}
