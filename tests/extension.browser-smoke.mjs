// Optional real-Chrome check. Isolated profile; auto-sync is never enabled.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const workspace = resolve(fileURLToPath(new URL("../", import.meta.url)));
const profile = await mkdtemp(join(tmpdir(), "mal-tracker-extension-"));
const executable = process.env.CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
let child, cdp, apiChild;
try {
  if (process.argv.includes("--start-api")) {
    apiChild = spawn(process.execPath, ["dist/tracker.js"], {
      cwd: workspace, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error("Temporary Tracker API did not start")), 10000);
      apiChild.once("error", (error) => { clearTimeout(timer); reject(error); });
      apiChild.once("exit", () => { clearTimeout(timer); reject(new Error("Temporary Tracker API exited; check whether port 3000 is already in use")); });
      apiChild.stdout.once("data", () => { clearTimeout(timer); resolveReady(); });
    });
  }
  // Branded Chrome uses the pipe-only Extensions DevTools domain to load
  // unpacked extensions for automation; it ignores --load-extension.
  child = spawn(executable, ["--headless=new", "--no-first-run", "--no-default-browser-check",
    "--disable-background-networking", "--disable-component-update", "--disable-sync",
    "--remote-debugging-pipe", "--enable-unsafe-extension-debugging", `--user-data-dir=${profile}`, "about:blank"],
  { windowsHide: true, stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  let sequence = 0, buffer = "";
  const pending = new Map();
  const rejectPending = (error) => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
  };
  child.once("error", rejectPending);
  child.once("exit", () => rejectPending(new Error("Chrome exited")));
  child.stdio[4].setEncoding("utf8");
  child.stdio[4].on("data", (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\0")) >= 0) {
      const raw = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!raw) continue;
      const message = JSON.parse(raw);
      const entry = pending.get(message.id);
      if (!entry) continue;
      pending.delete(message.id); clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(message.error.message)); else entry.resolve(message.result);
    }
  });
  cdp = (method, params = {}, sessionId) => new Promise((resolveCall, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Chrome command timed out: ${method}`)); }, 15000);
    pending.set(id, { resolve: resolveCall, reject, timer });
    child.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + "\0");
  });
  await cdp("Browser.getVersion");
  const { id } = await cdp("Extensions.loadUnpacked", { path: workspace });
  const { targetId } = await cdp("Target.createTarget", { url: `chrome-extension://${id}/popup.html` });
  const { sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true });
  let page;
  const popupDeadline = Date.now() + 15000;
  do {
    const result = await cdp("Runtime.evaluate", { expression: `JSON.stringify({
      ready: Boolean(document.getElementById('account')),
      accounts: [...(document.getElementById('account')?.options ?? [])].map(o => o.text),
      eligibleAccounts: [...(document.getElementById('account')?.options ?? [])].filter(o => o.value && !o.disabled).map(o => o.value),
      selectedAccount: document.getElementById('account')?.value,
      permissionOpen: Boolean(document.getElementById('permission-dialog')?.open),
      autoSaveEnabled: Boolean(document.getElementById('enabled')?.checked),
      correctionOpen: Boolean(document.getElementById('manual-link')?.open),
      detectionAvailable: Boolean(document.getElementById('detect-button')),
      feedback: document.getElementById('feedback')?.textContent,
      title: document.title, href: location.href,
      error: document.getElementById('account') ? null : document.body?.textContent?.slice(0, 600)
    })`, returnByValue: true }, sessionId);
    page = result.result.value ? JSON.parse(result.result.value) : undefined;
    if (page?.ready && page.accounts[0] !== "Loading accounts..." && page.feedback !== "Working...") break;
    await delay(100);
  } while (Date.now() < popupDeadline);
  assert.equal(page?.ready, true, `Popup did not render: ${JSON.stringify(page)}`);
  assert.equal(page.title, "MAL Tracker");
  assert.equal(page.feedback, "", `Popup API connection failed: ${page.feedback}`);
  assert.notEqual(page.accounts[0], "Loading accounts...");
  assert.equal(page.autoSaveEnabled, false, "An isolated profile must not enable writes before consent");
  assert.equal(page.correctionOpen, false, "Manual anime correction should be optional and collapsed by default");
  assert.equal(page.detectionAvailable, true);
  if (page.eligibleAccounts.length === 1) {
    assert.equal(page.selectedAccount, page.eligibleAccounts[0], "The sole connected account should be selected automatically");
    assert.equal(page.permissionOpen, true, "The permission prompt must appear before enabling updates");
    await cdp("Runtime.evaluate", { expression: "document.getElementById('deny-permission').click(); true", returnByValue: true }, sessionId);
    let decision;
    const deadline = Date.now() + 5000;
    do {
      const response = await cdp("Runtime.evaluate", { expression: `(async () => {
        const state = await chrome.storage.local.get(['trackerSettings', 'trackerPermissions']);
        return JSON.stringify({ enabled: state.trackerSettings?.enabled,
          allowed: state.trackerPermissions?.[state.trackerSettings?.malUserId]?.allowed,
          open: document.getElementById('permission-dialog').open });
      })()`, awaitPromise: true, returnByValue: true }, sessionId);
      decision = JSON.parse(response.result.value);
      if (decision.allowed === false && !decision.open) break;
      await delay(50);
    } while (Date.now() < deadline);
    assert.equal(decision.allowed, false);
    assert.equal(decision.enabled, false);
    assert.equal(decision.open, false);
    console.log("Single-account auto-selection, permission prompt, and Not now behavior work in Chrome.");
  } else {
    assert.equal(page.selectedAccount, "");
    assert.equal(page.permissionOpen, false);
  }
  console.log("Chrome loaded the extension service worker and popup; Tracker API account selection works.");
  console.log(`Connected account options: ${Math.max(0, page.accounts.length - 1)}. Auto-sync was not enabled.`);
} finally {
  if (cdp && child.exitCode === null) await cdp("Browser.close").catch(() => {});
  if (child && child.exitCode === null) {
    await Promise.race([new Promise((resolveExit) => child.once("exit", resolveExit)), delay(2000)]);
    if (child.exitCode === null) child.kill();
  }
  if (apiChild && apiChild.exitCode === null) {
    const exited = new Promise((resolveExit) => apiChild.once("exit", resolveExit));
    apiChild.kill();
    await exited;
  }
  const absolute = resolve(profile);
  if (dirname(absolute) !== resolve(tmpdir()) || !basename(absolute).startsWith("mal-tracker-extension-")) throw new Error("Unexpected test profile path");
  await rm(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
