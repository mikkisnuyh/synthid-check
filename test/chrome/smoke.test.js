"use strict";

/* Loads the Chrome zip (the file that is released) into Chromium and runs the main flows end to end
 * against local pages. synthid.com resolves to a local HTTPS stand-in with a file input
 * (self-signed certificate made with openssl), so this never touches the live site. Run with `npm run test:chrome`; set CHROME_PATH to use
 * a Chromium other than Playwright's own (it must be Chrome 148 or later, and not a branded
 * Google Chrome, which ignores --load-extension). */

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..", "..");
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8")).version;
const ZIP = path.join(ROOT, "web-ext-artifacts", `synthid_check-chrome-${VERSION}.zip`);
let EXT;
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const VIEWPORT = { width: 1000, height: 700 };
// The drop zone's default corner: 240x132, 16px from the top-right of the viewport.
const ZONE_CENTER = { x: VIEWPORT.width - 16 - 120, y: 16 + 66 };

// Stands in for synthid.com: the site's stored Terms state and an upload field that
// records what was attached.
const FAKE_SYNTHID = `<!doctype html><title>synthid stand-in</title>
<script>localStorage.setItem("firstTime", JSON.stringify({ isInitialized: true, termsAccepted: true }));</script>
<input type="file" id="upload">
<script>
  window.attached = null;
  document.getElementById("upload").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    window.attached = f ? { name: f.name, type: f.type, bytes: Array.from(new Uint8Array(await f.arrayBuffer())) } : null;
  });
</script>`;

const SOURCE_PAGE = `<!doctype html><body style="margin:0">
<img id="plain" src="/img.png" style="position:absolute;left:300px;top:300px;width:100px;height:100px">
<a href="/elsewhere" style="position:absolute;left:300px;top:450px"><img id="linked" src="/img.png" style="display:block;width:100px;height:100px"></a>
<div id="covered" style="position:absolute;left:600px;top:300px;width:100px;height:100px">
  <img src="/img.png" style="width:100px;height:100px">
  <div id="overlay" style="position:absolute;inset:0"></div>
</div>
<img id="blobimg" style="position:absolute;left:600px;top:450px;width:100px;height:100px">
<script>
  fetch("/img.png").then((r) => r.blob()).then((b) => { document.getElementById("blobimg").src = URL.createObjectURL(b); });
</script>`;

let server;
let synthidServer;
let origin;
let context;
let profile;
let worker;
let extensionId;

before(async () => {
  assert.ok(fs.existsSync(ZIP), `build ${path.relative(ROOT, ZIP)} first (npm run test:chrome does)`);
  server = http.createServer((req, res) => {
    if (req.url === "/img.png") {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(PNG);
    } else {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(SOURCE_PAGE);
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;

  profile = fs.mkdtempSync(path.join(os.tmpdir(), "synthid-chrome-profile-"));
  // Test the zip, not dist/chrome, so a file left out of the package fails here.
  EXT = path.join(profile, "extension");
  execFileSync("unzip", ["-q", ZIP, "-d", EXT]);
  const key = path.join(profile, "key.pem");
  const cert = path.join(profile, "cert.pem");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=synthid.com",
    "-addext", "subjectAltName=DNS:synthid.com", "-keyout", key, "-out", cert,
  ], { stdio: "ignore" });
  synthidServer = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(FAKE_SYNTHID);
  });
  await new Promise((resolve) => synthidServer.listen(0, "127.0.0.1", resolve));

  context = await chromium.launchPersistentContext(path.join(profile, "chrome"), {
    // Playwright's headless shell can't run extensions; full Chromium's headless mode can.
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chromium" }),
    headless: true,
    viewport: VIEWPORT,
    ignoreHTTPSErrors: true,
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      `--host-resolver-rules=MAP synthid.com:443 127.0.0.1:${synthidServer.address().port}`,
      "--ignore-certificate-errors",
      "--no-proxy-server",
    ],
  });
  [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker");
  extensionId = new URL(worker.url()).host;
});

after(async () => {
  await context?.close();
  server?.close();
  synthidServer?.close();
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

async function closeSynthidTabs() {
  for (const p of context.pages()) if (p.url().startsWith("https://synthid.com/")) await p.close();
}

// The stand-in synthid.com tab the extension opens, once the file is attached to it.
async function attachedFile() {
  const page = await waitForValue(() => context.pages().find((p) => p.url().startsWith("https://synthid.com/")), "synthid.com tab");
  await page.waitForFunction(() => window.attached, null, { timeout: 15000 });
  return page.evaluate(() => window.attached);
}

async function waitForValue(fn, what, timeoutMs = 15000) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) assert.fail(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function sourcePage() {
  const page = await context.newPage();
  await page.goto(origin + "/");
  await page.waitForFunction(() => document.getElementById("blobimg").complete && document.getElementById("blobimg").src);
  return page;
}

// Runs the background's handler for a context menu click (headless Chromium can't open the
// menu itself), with the same info Chrome passes.
async function menuClick(page, info) {
  await worker.evaluate(
    async ({ info, url }) => {
      const [tab] = await browser.tabs.query({ url });
      // Chrome's events can't be fired from script; call what the listener calls.
      if (info.menuItemId === "check-media") onCheckMedia(info, tab, Promise.resolve(true));
      else onFindMedia(info, tab);
    },
    { info: { frameId: 0, pageUrl: page.url(), ...info }, url: page.url() },
  );
}

test("the service worker runs the shared background with Chrome's APIs", async () => {
  await waitForValue(
    () => worker.evaluate(async () => (await browser.scripting.getRegisteredContentScripts()).length > 0),
    "the drop zone script",
  );
  const state = await worker.evaluate(async () => ({
    browser: typeof browser,
    menus: typeof menus.create,
    acquire: typeof acquire,
    dropZone: (await browser.scripting.getRegisteredContentScripts({ ids: ["drop-zone"] })).length,
  }));
  assert.deepEqual(state, { browser: "object", menus: "function", acquire: "function", dropZone: 1 });
});

test("Check with SynthID: the image is downloaded and attached on synthid.com", async () => {
  const page = await sourcePage();
  await menuClick(page, { menuItemId: "check-media", srcUrl: origin + "/img.png", mediaType: "image" });
  const file = await attachedFile();
  assert.equal(file.type, "image/png");
  assert.equal(file.name, "img.png");
  assert.deepEqual(file.bytes, Array.from(PNG));
  await closeSynthidTabs();
  await page.close();
});

test("Find media under the cursor: starts from the element that was right-clicked", async () => {
  const page = await sourcePage();
  // A real right-click, so context-target.js remembers the overlay above the image.
  await page.click("#overlay", { button: "right" });
  await menuClick(page, { menuItemId: "find-media" });
  const file = await attachedFile();
  assert.deepEqual(file.bytes, Array.from(PNG));
  await closeSynthidTabs();
  await page.close();
});

test("Find media without context-target.js: onInstalled loads it into open tabs, else pick mode starts", async () => {
  const page = await sourcePage();
  // As in a tab that was open before an install or update: the content script never ran.
  const contextTarget = (op) =>
    worker.evaluate(
      async ({ url, op }) => {
        const [tab] = await browser.tabs.query({ url });
        if (op === "inject") await injectContextTarget();
        const [r] = await browser.scripting.executeScript({
          target: { tabId: tab.id },
          args: [op],
          func: (o) => {
            if (o === "remove") delete globalThis.SynthIDContextTarget;
            return typeof globalThis.SynthIDContextTarget;
          },
        });
        return r.result;
      },
      { url: page.url(), op },
    );
  assert.equal(await contextTarget("remove"), "undefined");
  assert.equal(await contextTarget("inject"), "object");

  assert.equal(await contextTarget("remove"), "undefined");
  await page.click("#overlay", { button: "right" });
  await menuClick(page, { menuItemId: "find-media" });
  await page.waitForSelector('[data-synthid-picker="hint"]');
  await page.click("#plain");
  const file = await attachedFile();
  assert.deepEqual(file.bytes, Array.from(PNG));
  await closeSynthidTabs();
  await page.close();
});

test("a blob: image is read inside the page and arrives intact", async () => {
  const page = await sourcePage();
  await page.click("#blobimg", { button: "right" });
  const src = await page.evaluate(() => document.getElementById("blobimg").src);
  assert.match(src, /^blob:/);
  await menuClick(page, { menuItemId: "check-media", srcUrl: src, mediaType: "image" });
  const file = await attachedFile();
  assert.equal(file.type, "image/png");
  assert.deepEqual(file.bytes, Array.from(PNG));
  await closeSynthidTabs();
  await page.close();
});

for (const id of ["plain", "linked"]) {
  test(`drag and drop: an image (${id}) dropped on the zone is checked`, async () => {
    const page = await sourcePage();
    const box = await page.locator("#" + id).boundingBox();
    await page.mouse.move(box.x + 50, box.y + 50);
    await page.mouse.down();
    await page.mouse.move(box.x + 120, box.y - 40, { steps: 5 });
    await page.mouse.move(ZONE_CENTER.x, ZONE_CENTER.y, { steps: 10 });
    await page.mouse.up();
    const file = await attachedFile();
    assert.deepEqual(file.bytes, Array.from(PNG));
    await closeSynthidTabs();
    await page.close();
  });
}

test("the toolbar menu works, and Settings sends shortcut changes to Chrome's page", async () => {
  const popup = await context.newPage();
  const errors = [];
  popup.on("pageerror", (e) => errors.push(String(e)));
  await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
  await popup.click("#settings");
  const row = popup.locator(".shortcut-row", { hasText: "Pick media" });
  await row.waitFor();
  assert.equal(await row.locator("button").count(), 1, "no reset or remove buttons in Chrome");
  assert.match(await row.locator("button.keys").innerText(), /S/);

  const opened = context.waitForEvent("page");
  await row.locator("button.keys").click();
  const shortcuts = await opened;
  await waitForValue(() => shortcuts.url().startsWith("chrome://extensions"), "shortcuts page");
  assert.equal(shortcuts.url(), "chrome://extensions/shortcuts");
  assert.deepEqual(errors, []);
  await shortcuts.close();
});
