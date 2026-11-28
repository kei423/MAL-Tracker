import { TrackerBridge, RETRY_ALARM, isSupportedUrl } from "./extension/tracker.js";

const bridge = new TrackerBridge(chrome.storage.local);

async function ensureAlarm() {
  if (!await chrome.alarms.get(RETRY_ALARM)) await chrome.alarms.create(RETRY_ALARM, { periodInMinutes: 0.5 });
}

chrome.runtime.onInstalled.addListener(() => { void ensureAlarm(); });
chrome.runtime.onStartup.addListener(() => { void ensureAlarm(); });
void ensureAlarm();

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== RETRY_ALARM) return;
  void bridge.run(() => bridge.retryDetection()).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !message || typeof message.type !== "string") return false;
  if (message.type === "TRACKER_MEDIA_UPDATE") {
    if (sender.frameId !== 0 || !sender.tab || !isSupportedUrl(sender.url)) return false;
  } else if (sender.url !== chrome.runtime.getURL("popup.html")) return false;

  const operation = async () => {
    switch (message.type) {
      case "TRACKER_MEDIA_UPDATE": return bridge.observe(message.media, sender.url);
      case "TRACKER_STATUS":
        await bridge.refreshStatus().catch(() => {});
        return bridge.state();
      case "TRACKER_STATE": return bridge.state();
      case "TRACKER_INITIALIZE": return bridge.initialize();
      case "TRACKER_PERMISSION":
        if (typeof message.allowed !== "boolean") throw new Error("Choose whether to allow account changes.");
        return bridge.setPermission(message.userId, message.malUserId, message.allowed);
      case "TRACKER_ACCOUNTS": return bridge.accounts();
      case "TRACKER_SETTINGS": return bridge.saveSettings(message.userId, message.enabled);
      case "TRACKER_SEARCH": return bridge.search(message.query);
      case "TRACKER_BIND": return bridge.bind(message.sourceTitle, message.animeId);
      case "TRACKER_RETRY":
        await chrome.storage.local.set({ trackerRetryAt: 0 });
        return bridge.retryDetection(true);
      default: throw new Error("Unknown Tracker operation");
    }
  };
  void bridge.run(operation).then((data) => sendResponse({ ok: true, data }),
    (error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
