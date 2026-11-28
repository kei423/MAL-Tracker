export const API_BASE = "http://127.0.0.1:3000";
export const RETRY_ALARM = "tracker-api-retry";

export function accountDecision(settings, permissions = {}) {
  const decision = settings && permissions[settings.malUserId];
  return decision?.version === 1 && decision.userId === settings.userId && decision.malUserId === settings.malUserId
    ? decision : null;
}

export function hasAccountPermission(settings, permissions = {}) {
  return accountDecision(settings, permissions)?.allowed === true;
}

export function chooseConnectedAccount(accounts, previous) {
  const available = accounts.filter((account) => !account.reauthRequired);
  const saved = available.find((account) => String(account.userId) === previous?.userId && String(account.malUserId) === previous?.malUserId);
  return saved ?? (available.length === 1 ? available[0] : null);
}

export function isSupportedUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) &&
      (url.hostname === "anikototv.bz" || url.hostname.endsWith(".anikototv.bz"));
  } catch { return false; }
}

export function normalizeTitle(title) {
  return typeof title === "string" ? title.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ") : "";
}

export function normalizeAnimeTitle(title) {
  return normalizeTitle(title)
    .replace(/\s*[\[(]\s*(?:english\s+)?(?:dub(?:bed)?|sub(?:bed)?)\s*[\])]\s*$/i, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

export function exactAnimeMatches(title, candidates) {
  const target = normalizeAnimeTitle(title);
  if (!target) return [];
  const matches = candidates.filter((node) => {
    const aliases = node.alternative_titles;
    return [node.title, aliases?.en, aliases?.ja, ...(aliases?.synonyms ?? [])]
      .some((alias) => typeof alias === "string" && normalizeAnimeTitle(alias) === target);
  });
  return [...new Map(matches.map((node) => [node.id, node])).values()];
}

export function parseEpisode(value) {
  if (Number.isSafeInteger(value) && value > 0 && value <= 2147483647) return value;
  const match = typeof value === "string" && value.match(/^(?:(?:episode|ep\.?)\s*)?(\d+)\s*$/i);
  const episode = match ? Number(match[1]) : 0;
  return Number.isSafeInteger(episode) && episode > 0 && episode <= 2147483647 ? episode : null;
}

class ApiError extends Error {
  constructor(message, status = 0) { super(message); this.status = status; }
}

export class TrackerBridge {
  constructor(storage, fetcher = fetch, apiBase = API_BASE) {
    this.storage = storage;
    // Chrome's native WorkerGlobalScope.fetch requires the worker as receiver.
    this.fetcher = fetcher.bind(globalThis);
    this.apiBase = apiBase;
    this.work = Promise.resolve();
  }

  // Chrome can deliver several messages while an API request is in flight.
  run(operation) {
    const next = this.work.then(operation);
    this.work = next.catch(() => {});
    return next;
  }

  async request(path, options = {}) {
    let response;
    try {
      response = await this.fetcher(this.apiBase + path, {
        ...options, credentials: "omit", redirect: "error", signal: AbortSignal.timeout(10000),
        headers: { "Content-Type": "application/json", ...options.headers },
      });
    } catch { throw new ApiError("Tracker API unavailable. Start npm run dev; the extension will retry."); }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new ApiError(body.error ?? `Tracker API HTTP ${response.status}`, response.status);
    return body;
  }

  async status(phase, message, extra = {}) {
    const value = { phase, message, ...extra, updatedAt: new Date().toISOString() };
    await this.storage.set({ trackerSyncStatus: value });
    return value;
  }

  async accounts() { return (await this.request("/api/extension/accounts")).accounts; }

  async initialize() {
    const accounts = await this.accounts();
    const { trackerSettings: previous, trackerPermissions: permissions = {} } =
      await this.storage.get(["trackerSettings", "trackerPermissions"]);
    const account = chooseConnectedAccount(accounts, previous);
    if (account) {
      const sameAccount = String(account.userId) === previous?.userId && String(account.malUserId) === previous?.malUserId;
      await this.applySettings(account, sameAccount && previous.enabled && hasAccountPermission(previous, permissions));
    } else {
      await this.storage.set({ trackerSettings: null, trackerOutbox: {}, trackerRetryAt: 0 });
    }
    const state = await this.state();
    return { ...state, accounts, needsPermission: Boolean(account && !accountDecision(state.trackerSettings, permissions)) };
  }

  async saveSettings(userId, enabled) {
    const account = (await this.accounts()).find((a) => String(a.userId) === String(userId));
    if (!account || account.reauthRequired) throw new Error("Connect this account with npm run mal:connect first.");
    return this.applySettings(account, enabled);
  }

  async applySettings(account, enabled) {
    const { trackerSettings: previous } = await this.storage.get("trackerSettings");
    const settings = { userId: String(account.userId), malUserId: String(account.malUserId), enabled: Boolean(enabled) };
    const { trackerPermissions: permissions = {} } = await this.storage.get("trackerPermissions");
    if (settings.enabled && !hasAccountPermission(settings, permissions)) {
      throw new Error("Allow this extension to update the selected MAL account before enabling automatic saving.");
    }
    await this.storage.set({ trackerSettings: settings });
    if (previous?.userId !== settings.userId || previous?.malUserId !== settings.malUserId) {
      await this.storage.set({ trackerOutbox: {}, trackerSyncStatus: null, trackerRetryAt: 0 });
    }
    const { lastWatchedAnime } = await this.storage.get("lastWatchedAnime");
    await this.ensureMapping(lastWatchedAnime);
    await this.queueCompleted(lastWatchedAnime);
    await this.flush();
    return settings;
  }

  async setPermission(userId, malUserId, allowed) {
    const { trackerSettings: settings, trackerPermissions: permissions = {} } =
      await this.storage.get(["trackerSettings", "trackerPermissions"]);
    if (!settings || settings.userId !== String(userId) || settings.malUserId !== String(malUserId)) {
      throw new Error("The selected account changed. Reopen the popup and try again.");
    }
    if (allowed) {
      const account = (await this.accounts()).find((item) => String(item.userId) === settings.userId && String(item.malUserId) === settings.malUserId);
      if (!account || account.reauthRequired) throw new Error("Connect this account with npm run mal:connect first.");
    }
    // Denial/revocation works offline too, so a queued browser request cannot
    // leave the extension after the user removes permission.
    permissions[settings.malUserId] = { version: 1, userId: settings.userId, malUserId: settings.malUserId,
      allowed: allowed === true, decidedAt: new Date().toISOString() };
    await this.storage.set({ trackerPermissions: permissions, trackerSettings: { ...settings, enabled: allowed === true } });
    if (!allowed) {
      await this.storage.set({ trackerOutbox: {}, trackerRetryAt: 0 });
      await this.status("permission_denied", "Account changes are not allowed. You can allow them in the extension popup.");
    } else {
      await this.status("permission_granted", "Account changes allowed. Automatically detected episodes will save at 90% watched.");
      const { lastWatchedAnime } = await this.storage.get("lastWatchedAnime");
      await this.ensureMapping(lastWatchedAnime);
      await this.queueCompleted(lastWatchedAnime);
      await this.flush();
    }
    return this.state();
  }

  async search(query) {
    const { trackerSettings: settings } = await this.storage.get("trackerSettings");
    if (!settings?.userId) throw new Error("Select and save your MAL account first.");
    const text = String(query ?? "").trim();
    const id = text.match(/^\d+$/)?.[0] ?? text.match(/^https:\/\/myanimelist\.net\/anime\/(\d+)(?:\/|$)/)?.[1];
    if (id) return [(await this.request(`/api/extension/anime/${id}?userId=${settings.userId}`)).node];
    if (text.length < 2 || text.length > 100) throw new Error("Search with 2–100 characters or enter a MAL anime ID.");
    return (await this.request(`/api/extension/anime/search?${new URLSearchParams({ userId: settings.userId, q: text })}`)).data.map((e) => e.node);
  }

  async bind(sourceTitle, animeId) {
    const { trackerSettings: settings, lastWatchedAnime: media, trackerMappings: mappings = {} } =
      await this.storage.get(["trackerSettings", "lastWatchedAnime", "trackerMappings"]);
    if (!settings?.userId) throw new Error("Select and save your MAL account first.");
    if (!media || media.isIdle || /^(unknown anime|browsing anikoto)$/i.test(media.title)) throw new Error("Open an AniKoto episode and wait for its title to appear first.");
    if (normalizeTitle(sourceTitle) !== normalizeTitle(media.title)) throw new Error("The playing show changed. Reopen the popup and try again.");
    if (!Number.isSafeInteger(Number(animeId)) || Number(animeId) <= 0) throw new Error("Select a MAL search result first.");
    const { node } = await this.request(`/api/extension/anime/${Number(animeId)}?userId=${settings.userId}`);
    mappings[`${settings.malUserId}:${normalizeTitle(sourceTitle)}`] = { malAnimeId: node.id, title: node.title, numEpisodes: node.num_episodes, source: "manual" };
    await this.storage.set({ trackerMappings: mappings });
    await this.status("linked", `Linked to ${node.title}. Episodes save automatically at 90%.`);
    await this.queueCompleted(media);
    await this.flush();
    return node;
  }

  async ensureMapping(media, force = false) {
    if (!media || media.isIdle || media.isBroken || !normalizeTitle(media.title) || /^(unknown anime|browsing anikoto)$/i.test(media.title)) return;
    const { trackerSettings: settings, trackerPermissions: permissions = {}, trackerMappings: mappings = {}, trackerDetectionCache: cache = {} } =
      await this.storage.get(["trackerSettings", "trackerPermissions", "trackerMappings", "trackerDetectionCache"]);
    if (!settings?.enabled || !hasAccountPermission(settings, permissions)) return;
    const key = `${settings.malUserId}:${normalizeTitle(media.title)}`;
    const hint = Number.isSafeInteger(media.malAnimeId) && media.malAnimeId > 0 ? media.malAnimeId : null;
    const previous = mappings[key];
    // A user's explicit correction takes priority over automated metadata.
    if (previous && (previous.source !== "automatic" || (!force && (!hint || previous.malAnimeId === hint)))) return previous;
    const cacheKey = `${key}:${hint ?? "title"}`;
    if (!force && cache[cacheKey]?.retryAt > Date.now()) {
      const cached = cache[cacheKey];
      const { trackerSyncStatus: current } = await this.storage.get("trackerSyncStatus");
      if (cached.message && (current?.sourceTitle !== media.title || current?.phase !== cached.phase)) {
        await this.status(cached.phase, cached.message, { sourceTitle: media.title });
      }
      return;
    }
    if (previous) {
      delete mappings[key];
      await this.storage.set({ trackerMappings: mappings });
      if (hint && hint !== previous.malAnimeId) {
        const { trackerOutbox: outbox = {} } = await this.storage.get("trackerOutbox");
        for (const [pendingKey, request] of Object.entries(outbox)) {
          if (request.malUserId === settings.malUserId && normalizeTitle(request.sourceTitle) === normalizeTitle(media.title) &&
              request.malAnimeId === previous.malAnimeId) delete outbox[pendingKey];
        }
        await this.storage.set({ trackerOutbox: outbox });
      }
    }
    await this.status("detecting", `Automatically identifying ${media.title} on MAL...`, { sourceTitle: media.title });
    try {
      let node;
      if (hint) node = (await this.request(`/api/extension/anime/${hint}?userId=${settings.userId}`)).node;
      else {
        const candidates = await this.search(media.title.slice(0, 100));
        const matches = exactAnimeMatches(media.title, candidates);
        if (matches.length !== 1) {
          const message = matches.length > 1 ? "Multiple MAL entries match this title. Confirm the correct season in the popup."
            : "No exact MAL title or alias match was found. You can confirm the show in the popup.";
          cache[cacheKey] = { retryAt: Date.now() + 300000, phase: "needs_mapping", message };
          await this.storage.set({ trackerDetectionCache: cache });
          await this.status("needs_mapping", message, { sourceTitle: media.title });
          return;
        }
        node = matches[0];
      }
      const binding = { malAnimeId: node.id, title: node.title, numEpisodes: node.num_episodes,
        source: "automatic", matchMethod: hint ? "page" : "title" };
      mappings[key] = binding;
      delete cache[cacheKey];
      await this.storage.set({ trackerMappings: mappings, trackerDetectionCache: cache });
      await this.status("detected", `Automatically detected ${node.title} (MAL ${node.id}).`, { sourceTitle: media.title });
      return binding;
    } catch (error) {
      cache[cacheKey] = { retryAt: Date.now() + 30000, phase: "detection_retry", message: error.message };
      await this.storage.set({ trackerDetectionCache: cache });
      await this.status("detection_retry", error.message, { sourceTitle: media.title });
    }
  }

  async retryDetection(force = false) {
    const { lastWatchedAnime } = await this.storage.get("lastWatchedAnime");
    await this.ensureMapping(lastWatchedAnime, force);
    await this.queueCompleted(lastWatchedAnime);
    await this.flush();
    await this.refreshStatus();
    return this.state();
  }

  async observe(value, sourceUrl) {
    if (!isSupportedUrl(sourceUrl) || typeof value?.title !== "string" || value.title.length > 500) return;
    const currentTime = Number(value.currentTime), duration = Number(value.duration);
    const validTime = Number.isFinite(currentTime) && Number.isFinite(duration) && duration > 0 && currentTime >= 0 && currentTime <= duration + 2;
    const media = {
      title: value.title.trim(), episode: value.episode,
      malAnimeId: Number.isSafeInteger(value.malAnimeId) && value.malAnimeId > 0 ? value.malAnimeId : null,
      currentTime: validTime ? currentTime : 0, duration: validTime ? duration : 0,
      progress: validTime ? `${Math.min(100, currentTime / duration * 100).toFixed(1)}%` : "0%",
      isFinished: validTime && currentTime / duration >= 0.9,
      isBroken: Boolean(value.isBroken), isIdle: Boolean(value.isIdle),
      url: sourceUrl, updatedAt: new Date().toISOString(),
    };
    await this.storage.set({ lastWatchedAnime: media });
    await this.ensureMapping(media);
    await this.queueCompleted(media);
    await this.flush();
  }

  async queueCompleted(media) {
    if (!media?.isFinished || media.isIdle || media.isBroken) return;
    const episode = parseEpisode(media.episode);
    if (!episode || !normalizeTitle(media.title) || /^(unknown anime|browsing anikoto)$/i.test(media.title)) return;
    const { trackerSettings: settings, trackerMappings: mappings = {}, trackerOutbox: outbox = {}, trackerSent: sent = {}, trackerPermissions: permissions = {} } =
      await this.storage.get(["trackerSettings", "trackerMappings", "trackerOutbox", "trackerSent", "trackerPermissions"]);
    if (!settings?.enabled || !hasAccountPermission(settings, permissions)) return;
    const binding = mappings[`${settings.malUserId}:${normalizeTitle(media.title)}`];
    if (!binding) return;
    if (binding.numEpisodes > 0 && episode > binding.numEpisodes) {
      await this.status("blocked", "Episode exceeds this MAL entry's episode count. Check the selected season."); return;
    }
    const watchStatus = binding.numEpisodes > 0 && episode === binding.numEpisodes ? "completed" : "watching";
    const episodeKey = `${settings.malUserId}:${binding.malAnimeId}:${episode}`;
    // Completion can upgrade an episode already sent as watching, including
    // updates saved by older extension versions or before MAL knew the total.
    const completedKey = `${episodeKey}:completed`;
    const key = watchStatus === "completed" ? completedKey : episodeKey;
    if (sent[completedKey] || outbox[completedKey] || sent[key] || outbox[key]) return;
    if (watchStatus === "completed") delete outbox[episodeKey];
    outbox[key] = {
      userId: Number(settings.userId), malUserId: settings.malUserId,
      malAnimeId: binding.malAnimeId, title: binding.title, episode,
      watchStatus, sourceTitle: media.title,
    };
    await this.storage.set({ trackerOutbox: outbox });
  }

  async flush() {
    const { trackerSettings: settings, trackerOutbox: outbox = {}, trackerSent: sent = {}, trackerRetryAt = 0, trackerPermissions: permissions = {} } =
      await this.storage.get(["trackerSettings", "trackerOutbox", "trackerSent", "trackerRetryAt", "trackerPermissions"]);
    if (!settings?.enabled || !hasAccountPermission(settings, permissions)) return;
    if (Date.now() < trackerRetryAt) return;
    for (const [key, item] of Object.entries(outbox)) {
      if (String(item.userId) !== settings.userId || item.malUserId !== settings.malUserId) continue;
      try {
        const result = await this.request("/api/extension/progress", { method: "POST", body: JSON.stringify(item) });
        delete outbox[key];
        sent[key] = new Date().toISOString();
        const recent = Object.entries(sent).slice(-1000);
        await this.storage.set({ trackerOutbox: outbox, trackerSent: Object.fromEntries(recent), trackerRetryAt: 0 });
        await this.status(result.saved ? "pending" : "recorded",
          result.saved ? (result.queued ? "Queued for the MAL sync worker." : "Saved to Tracker. Waiting for the publisher and MAL sync worker.") : result.reason ?? "Progress already recorded.",
          { userId: settings.userId, syncJobId: result.syncJobId, malAnimeId: item.malAnimeId, episode: item.episode, sourceTitle: item.sourceTitle });
      } catch (error) {
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
          delete outbox[key];
          await this.storage.set({ trackerOutbox: outbox });
          if (error.status === 409) await this.storage.set({ trackerSettings: { ...settings, enabled: false } });
          await this.status("blocked", error.message);
        } else {
          await this.storage.set({ trackerRetryAt: Date.now() + 30000 });
          await this.status("retrying", error.message);
        }
        break;
      }
    }
  }

  async refreshStatus() {
    const { trackerSyncStatus: current } = await this.storage.get("trackerSyncStatus");
    if (!current?.syncJobId || !["pending", "failed"].includes(current.phase)) return;
    const { jobs } = await this.request(`/api/sync/jobs?userId=${current.userId}`);
    const job = jobs.find((j) => j.id === current.syncJobId);
    if (!job) return;
    const descriptions = {
      synced: "MAL confirmed the episode update.",
      superseded: "This update was superseded by newer progress or an authoritative MAL import.",
      failed: job.last_error ?? "MAL sync failed. Check the sync worker.",
      pending: job.last_error ?? "Saved to Tracker. Waiting for MAL sync.",
    };
    await this.storage.set({ trackerSyncStatus: { ...current, phase: job.state, message: descriptions[job.state] ?? job.state, updatedAt: new Date().toISOString() } });
  }

  async state() {
    return this.storage.get(["trackerSettings", "trackerPermissions", "trackerMappings", "lastWatchedAnime", "trackerSyncStatus"]);
  }
}
