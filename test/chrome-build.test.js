"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { build, chromeManifest, merge, referencedFiles } = require("../scripts/build-chrome.js");

const ROOT = path.join(__dirname, "..");
const FIREFOX = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));

test("merge: objects merge, other values replace, null removes", () => {
  const out = merge(
    { a: { x: 1, y: 2 }, list: [1, 2], keep: true, drop: "me" },
    { a: { y: 3, z: 4 }, list: [5], drop: null },
  );
  assert.deepEqual(out, { a: { x: 1, y: 3, z: 4 }, list: [5], keep: true });
});

test("Chrome manifest: service worker, Chrome names and limits", () => {
  const m = chromeManifest();
  assert.equal(m.manifest_version, 3);
  assert.equal(m.version, FIREFOX.version);
  assert.equal(m.name, FIREFOX.name);
  assert.deepEqual(m.background, { service_worker: "service-worker.js" });
  assert.equal(m.browser_specific_settings, undefined);
  assert.equal(m.minimum_chrome_version, "148");
  assert.equal(m.incognito, "split");
  assert.equal(m.message_serialization, "structured_clone");
  assert.ok(m.description.length <= 132, `description is ${m.description.length} characters`);

  assert.ok(m.permissions.includes("contextMenus"));
  assert.ok(!m.permissions.includes("menus"));
  // Everything else is shared with Firefox.
  assert.deepEqual(
    m.permissions.filter((p) => p !== "contextMenus"),
    FIREFOX.permissions.filter((p) => p !== "menus"),
  );
  assert.deepEqual(m.host_permissions, FIREFOX.host_permissions);
  assert.deepEqual(m.content_scripts, FIREFOX.content_scripts);
  assert.deepEqual(m.commands, FIREFOX.commands);
  assert.equal(m.action.default_popup, FIREFOX.action.default_popup);

  // Chrome doesn't show SVG manifest icons.
  for (const icon of [...Object.values(m.icons), ...Object.values(m.action.default_icon)]) {
    assert.match(icon, /\.png$/);
  }
});

test("build writes a complete Chrome package", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "synthid-chrome-"));
  try {
    const { manifest } = build(out);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8")), manifest);
    for (const f of referencedFiles(manifest)) assert.ok(fs.existsSync(path.join(out, f)), f);
    // The popup links the SVG logo.
    assert.ok(fs.existsSync(path.join(out, "icons", "icon.svg")));

    const sw = fs.readFileSync(path.join(out, "service-worker.js"), "utf8");
    const imported = [];
    new Function("importScripts", sw)((...files) => imported.push(...files));
    assert.deepEqual(imported, FIREFOX.background.scripts);
    for (const f of imported) assert.ok(fs.existsSync(path.join(out, f)), f);

    // Only the extension goes in the package.
    assert.deepEqual(fs.readdirSync(out).sort(), ["LICENSE", "icons", "manifest.json", "service-worker.js", "src"]);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
