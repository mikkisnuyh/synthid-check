"use strict";

/* Chrome only (Firefox has menus.getTargetElement). Remembers which element the last real
 * right-click in this frame was on, so "Find media under the cursor" can start from it.
 * It keeps a weak reference, reads nothing from the page and sends nothing. */
(function () {
  if (typeof globalThis.SynthIDContextTarget?.take === "function") return;

  let last = null;

  window.addEventListener(
    "contextmenu",
    (e) => {
      // Pages can dispatch synthetic events; only a real right-click counts.
      if (!e.isTrusted) return;
      // composedPath reaches an element inside the page's own (open) shadow roots.
      const path = typeof e.composedPath === "function" ? e.composedPath() : [];
      const target = path[0] && path[0].nodeType === 1 ? path[0] : e.target;
      last = target && target.nodeType === 1 ? new WeakRef(target) : null;
    },
    true,
  );

  globalThis.SynthIDContextTarget = {
    // The element, once: a later menu click must not reuse an old right-click.
    take() {
      const el = last && last.deref();
      last = null;
      return el && el.isConnected ? el : null;
    },
  };
})();
