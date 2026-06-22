// Keyboard shortcut helpers for per-stream "jump to speaker view" hotkeys.
//
// A binding is a plain object: { code, ctrl, alt, shift, meta }. `code` is the
// physical KeyboardEvent.code (e.g. "KeyD", "Digit1") so bindings are stable
// across keyboard layouts and unaffected by Shift producing a different glyph.

const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta']);
const isMac = typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform || '');

/** Build a binding from a keydown event, or null if only a modifier was pressed. */
export function bindingFromEvent(e) {
  if (MODIFIER_KEYS.has(e.key)) return null;
  return {
    code: e.code,
    ctrl: !!e.ctrlKey,
    alt: !!e.altKey,
    shift: !!e.shiftKey,
    meta: !!e.metaKey,
  };
}

/** Does a keydown event match a stored binding? */
export function hotkeyMatches(binding, e) {
  return (
    !!binding &&
    e.code === binding.code &&
    !!e.ctrlKey === !!binding.ctrl &&
    !!e.altKey === !!binding.alt &&
    !!e.shiftKey === !!binding.shift &&
    !!e.metaKey === !!binding.meta
  );
}

/** True if two bindings are the same chord (used to de-duplicate). */
export function sameBinding(a, b) {
  return (
    !!a && !!b && a.code === b.code &&
    !!a.ctrl === !!b.ctrl && !!a.alt === !!b.alt &&
    !!a.shift === !!b.shift && !!a.meta === !!b.meta
  );
}

function keyName(code) {
  if (!code) return '?';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num${code.slice(6)}`;
  const SPECIAL = {
    Space: 'Space', Enter: 'Enter', Escape: 'Esc', Backquote: '`',
    Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
    Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  };
  return SPECIAL[code] || code;
}

/** Human-readable label for a binding, e.g. "Alt+1" or "⌘⇧D". */
export function hotkeyLabel(binding) {
  if (!binding) return '';
  const parts = [];
  if (binding.ctrl) parts.push('Ctrl');
  if (binding.alt) parts.push(isMac ? '⌥' : 'Alt');
  if (binding.shift) parts.push(isMac ? '⇧' : 'Shift');
  if (binding.meta) parts.push(isMac ? '⌘' : 'Win');
  parts.push(keyName(binding.code));
  return parts.join('+');
}
