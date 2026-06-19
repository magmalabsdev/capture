// Tiny DOM helpers — no framework.

let _idCounter = 0;

/** Generate a short unique id with a prefix. */
export function uid(prefix = 'id') {
  _idCounter += 1;
  return `${prefix}-${_idCounter}-${Date.now().toString(36)}`;
}

/**
 * Create an element.
 * attrs: { class, text, html, dataset, style, onClick, ...props/attributes }
 * children: node | string | array of those
 */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k in node) {
      try { node[k] = v; } catch { node.setAttribute(k, v); }
    } else {
      node.setAttribute(k, v);
    }
  }
  const kids = Array.isArray(children) ? children : [children];
  for (const c of kids) {
    if (c == null || c === false) continue;
    node.appendChild(
      typeof c === 'string' || typeof c === 'number'
        ? document.createTextNode(String(c))
        : c
    );
  }
  return node;
}

/** Font Awesome (free) icon markup. style: 'solid' | 'regular'. */
export function fa(name, style = 'solid') {
  return `<i class="fa-${style} fa-${name}" aria-hidden="true"></i>`;
}

/** Remove all children of a node. */
export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** Build an <option> list and return a <select>. */
export function select(attrs, options, current) {
  const node = el('select', attrs);
  for (const opt of options) {
    const o = el('option', { value: opt.value, text: opt.label });
    if (String(opt.value) === String(current)) o.selected = true;
    node.appendChild(o);
  }
  return node;
}
