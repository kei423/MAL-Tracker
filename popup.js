import { normalizeTitle, accountDecision, hasAccountPermission } from "./extension/tracker.js";

const element = (id) => document.getElementById(id);
let currentMedia, searchTitle, permissionAccount;
let initialized = false;
let lastSettings = "";

async function message(type, values = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...values });
  if (!response?.ok) throw new Error(response?.error ?? "Tracker background worker is unavailable. Reload the extension.");
  return response.data;
}

function render(state) {
  const { lastWatchedAnime: media, trackerSettings: settings, trackerPermissions: permissions = {}, trackerMappings: mappings = {}, trackerSyncStatus: sync } = state;
  const allowed = hasAccountPermission(settings, permissions);
  currentMedia = media;
  element("anime-title").textContent = media?.title ?? "No anime playing";
  element("anime-episode").textContent = media?.episode ?? "-";
  element("anime-progress").textContent = media?.progress ?? "0%";
  element("status-badge").textContent = media?.isIdle ? "Browsing" : media?.isBroken ? "Stream error" : media?.isFinished ? "Episode watched" : "Watching";
  element("sync-message").textContent = sync?.sourceTitle && normalizeTitle(sync.sourceTitle) !== normalizeTitle(media?.title)
    ? `Last update (${sync.sourceTitle}): ${sync.message}`
    : sync?.message ?? "Allow account updates to start automatic anime detection and syncing.";
  const mapping = settings && media && mappings[`${settings.malUserId}:${normalizeTitle(media.title)}`];
  element("mapping").textContent = mapping
    ? `${mapping.source === "automatic" ? "Automatically detected" : "Confirmed correction"}: ${mapping.title} (MAL ${mapping.malAnimeId})`
    : !allowed ? "Anime detection starts after account permission is granted."
      : "Identifying the playing anime automatically...";
  if (!mapping && sync?.phase === "needs_mapping" && normalizeTitle(sync.sourceTitle) === normalizeTitle(media?.title)) {
    element("mapping").textContent = sync.message;
    element("manual-link").open = true;
  }
  element("permission-status").textContent = allowed
    ? `Account changes allowed for MAL ${settings.malUserId}.`
    : "Account changes are not allowed. No new episode updates will be submitted.";
  element("permission-button").textContent = allowed ? "Revoke account permission" : "Allow account changes";
  element("permission-button").disabled = !settings?.userId;
  element("enabled").disabled = !allowed;
  const signature = JSON.stringify([settings, allowed]);
  if (lastSettings !== signature) {
    element("enabled").checked = allowed && Boolean(settings?.enabled);
    lastSettings = signature;
  }
  if (!initialized) {
    element("search").value = media && !media.isIdle ? media.title.slice(0, 100) : "";
    initialized = true;
  }
}

function promptForPermission(state, force = false) {
  const settings = state.trackerSettings;
  if (!settings || (!force && accountDecision(settings, state.trackerPermissions))) return;
  permissionAccount = { userId: settings.userId, malUserId: settings.malUserId };
  element("permission-account").textContent = `Selected MAL account: ${settings.malUserId}`;
  element("permission-error").textContent = "";
  if (!element("permission-dialog").open) element("permission-dialog").showModal();
}

async function action(run) {
  element("feedback").textContent = "Working...";
  try { await run(); element("feedback").textContent = ""; }
  catch (error) { element("feedback").textContent = error.message; }
}

async function decidePermission(allowed, account = permissionAccount) {
  if (!account) return;
  element("allow-permission").disabled = true;
  element("deny-permission").disabled = true;
  try {
    const state = await message("TRACKER_PERMISSION", { ...account, allowed });
    render(state);
    if (element("permission-dialog").open) element("permission-dialog").close();
    permissionAccount = undefined;
  } catch (error) {
    if (element("permission-dialog").open) element("permission-error").textContent = error.message;
    else throw error;
  } finally {
    element("allow-permission").disabled = false;
    element("deny-permission").disabled = false;
  }
}

element("allow-permission").addEventListener("click", () => { void decidePermission(true); });
element("deny-permission").addEventListener("click", () => { void decidePermission(false); });
element("permission-dialog").addEventListener("cancel", (event) => { event.preventDefault(); void decidePermission(false); });
element("permission-button").addEventListener("click", () => action(async () => {
  const state = await message("TRACKER_STATE");
  if (hasAccountPermission(state.trackerSettings, state.trackerPermissions)) {
    await decidePermission(false, state.trackerSettings);
  } else promptForPermission(state, true);
}));

element("account").addEventListener("change", () => action(async () => {
  const userId = element("account").value;
  if (!userId) return;
  await message("TRACKER_SETTINGS", { userId, enabled: false });
  const state = await message("TRACKER_STATE");
  render(state);
  element("account").options[0].disabled = true;
  element("account-note").textContent = "Using your selected account.";
  promptForPermission(state);
}));

element("save-settings").addEventListener("click", () => action(async () => {
  await message("TRACKER_SETTINGS", { userId: element("account").value, enabled: element("enabled").checked });
  render(await message("TRACKER_STATE"));
}));

element("search-button").addEventListener("click", () => action(async () => {
  const candidates = await message("TRACKER_SEARCH", { query: element("search").value });
  searchTitle = currentMedia?.title;
  const select = element("results");
  select.replaceChildren(new Option(candidates.length ? "Select the matching show / season" : "No results. Try a MAL anime ID.", ""));
  for (const anime of candidates) select.add(new Option(`${anime.title} · MAL ${anime.id} · ${anime.num_episodes || "?"} episodes`, String(anime.id)));
  element("link-button").disabled = true;
}));
element("results").addEventListener("change", () => { element("link-button").disabled = !element("results").value; });
element("link-button").addEventListener("click", () => action(async () => {
  await message("TRACKER_BIND", { sourceTitle: searchTitle, animeId: element("results").value });
  render(await message("TRACKER_STATE"));
}));
element("retry-button").addEventListener("click", () => action(async () => { render(await message("TRACKER_RETRY")); }));
element("detect-button").addEventListener("click", () => action(async () => { render(await message("TRACKER_RETRY")); }));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && ["lastWatchedAnime", "trackerSyncStatus", "trackerMappings", "trackerSettings", "trackerPermissions"].some((key) => changes[key])) {
    void message("TRACKER_STATE").then(render).catch(() => {});
  }
});

void action(async () => {
  render(await message("TRACKER_STATUS"));
  const state = await message("TRACKER_INITIALIZE");
  render(state);
  const select = element("account");
  const placeholder = new Option(state.accounts.length ? "Select your account" : "No connected MAL accounts", "");
  placeholder.disabled = Boolean(state.trackerSettings);
  select.replaceChildren(placeholder);
  for (const account of state.accounts) {
    const option = new Option(`MAL ${account.malUserId} · local user ${account.userId}${account.reauthRequired ? " · reconnect required" : ""}`, account.userId);
    option.disabled = account.reauthRequired;
    select.add(option);
  }
  select.value = state.trackerSettings?.userId ?? "";
  const available = state.accounts.filter((account) => !account.reauthRequired);
  element("account-note").textContent = available.length === 1
    ? "Your connected MAL account was selected automatically."
    : available.length === 0 ? "Connect a MAL account to continue."
      : state.trackerSettings ? "Using your saved account." : "Multiple accounts are connected. Choose the account you want to manage.";
  promptForPermission(state);
});

setInterval(() => { void message("TRACKER_STATUS").then(render).catch(() => {}); }, 5000);
