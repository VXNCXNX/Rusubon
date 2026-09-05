/** Patch rendered views without discarding focused controls, open details, or scroll. */
export function updateMarkup(container, html) {
  const template = container.ownerDocument.createElement("template");
  template.innerHTML = html;
  reconcile(container, template.content);
}

const key = node => node?.nodeType === 1 ? node.id || node.getAttribute("data-key") : null;
const compatible = (a, b) => a && a.nodeType === b.nodeType && a.nodeName === b.nodeName;

function reconcile(parent, next) {
  const keyed = new Map([...parent.childNodes].filter(key).map(node => [key(node), node]));
  let cursor = parent.firstChild;
  for (const desired of [...next.childNodes]) {
    const identity = key(desired);
    let current = identity ? keyed.get(identity) : !key(cursor) && compatible(cursor, desired) ? cursor : null;
    if (!compatible(current, desired)) current = desired.cloneNode(true);
    if (current !== cursor) parent.insertBefore(current, cursor);
    patch(current, desired);
    cursor = current.nextSibling;
  }
  while (cursor) { const nextSibling = cursor.nextSibling; cursor.remove(); cursor = nextSibling; }
}

function patch(current, desired) {
  if (current.nodeType !== 1) {
    if (current.nodeValue !== desired.nodeValue) current.nodeValue = desired.nodeValue;
    return;
  }
  for (const attribute of [...current.attributes]) {
    if (current.localName === "details" && attribute.name === "open") continue;
    if (!desired.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
  }
  for (const attribute of desired.attributes) {
    if (current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value);
  }
  reconcile(current, desired);
  // Native select state is a property, and can differ from its selected attributes.
  if (current.localName === "select" && current.value !== desired.value) current.value = desired.value;
  if (current.localName === "input" && ["checkbox", "radio"].includes(current.type) && current.checked !== desired.checked) current.checked = desired.checked;
}

/** Call only for deliberate navigation. A new navigation cancels the old entrance. */
let entranceTimer;
export function enterPage(section) {
  clearTimeout(entranceTimer);
  for (const page of section.parentElement.querySelectorAll(".entering")) page.classList.remove("entering");
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  section.classList.add("entering");
  entranceTimer = setTimeout(() => section.classList.remove("entering"), 440);
}
