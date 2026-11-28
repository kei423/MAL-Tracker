(() => {
  // Some extension reloads/matching rules can inject twice into one document.
  if (globalThis.__malTrackerInjected) return;
  globalThis.__malTrackerInjected = true;
  const topFrame = window.self === window.top;
  const supported = location.hostname === "anikototv.bz" || location.hostname.endsWith(".anikototv.bz");
  if (topFrame && !supported) return;

  function alive() {
    try { return Boolean(chrome.runtime?.id); } catch { return false; }
  }

  function details() {
    const watchPage = /\/(watch|detail)(?:\/|$)/i.test(location.pathname);
    const titleElement = document.querySelector('h1[itemprop="name"], h1.title.d-title, #w-info .info h1, h1.title') ??
      document.querySelector(".breadcrumb li:nth-last-child(2) a, .breadcrumb-item:nth-last-child(2) a");
    const title = titleElement?.textContent?.trim() || "Unknown Anime";
    const active = document.querySelector(".ep-item.active, .ssl-item.active, .eps-item.active, .item.active[data-number]");
    let number = active?.getAttribute("data-number") || active?.textContent?.trim();
    if (!number) number = location.pathname.match(/(?:ep|episode)-(\d+)(?:\/|$)/i)?.[1];
    const malIds = new Set();
    const info = document.querySelector("#w-info, .anime-info, .film-detail, .watch-info") ?? document;
    for (const link of info.querySelectorAll('a[href*="myanimelist.net/anime/"]')) {
      try {
        const url = new URL(link.href, location.href);
        const id = ["https:", "http:"].includes(url.protocol) && ["myanimelist.net", "www.myanimelist.net"].includes(url.hostname)
          ? Number(url.pathname.match(/^\/anime\/([1-9]\d*)(?:\/|$)/)?.[1]) : 0;
        if (Number.isSafeInteger(id) && id > 0) malIds.add(id);
      } catch { /* Ignore malformed links. */ }
    }
    for (const element of [info, ...info.querySelectorAll("[data-mal-id], [data-myanimelist-id]")]) {
      const raw = element.getAttribute?.("data-mal-id") || element.getAttribute?.("data-myanimelist-id");
      const id = /^[1-9]\d*$/.test(raw ?? "") ? Number(raw) : 0;
      if (Number.isSafeInteger(id) && id > 0) malIds.add(id);
    }
    return { title, episode: number ? (/^\d+$/.test(number) ? `Episode ${number}` : number) : "Unknown Episode", isIdle: !watchPage,
      malAnimeId: malIds.size === 1 ? [...malIds][0] : null };
  }

  let lastKey = "", lastReport = 0;
  function publish(status) {
    if (!alive()) return;
    if (!topFrame) { window.parent.postMessage({ type: "ANIME_PROGRESS_UPDATE", ...status }, "*"); return; }
    const meta = details();
    const ratio = status.duration > 0 ? status.currentTime / status.duration : 0;
    const key = `${meta.title}:${meta.episode}:${meta.malAnimeId}:${meta.isIdle}:${Boolean(status.isBroken)}:${ratio >= 0.9}`;
    if (key === lastKey && Date.now() - lastReport < 5000) return;
    lastKey = key; lastReport = Date.now();
    void chrome.runtime.sendMessage({ type: "TRACKER_MEDIA_UPDATE", media: { ...status, ...meta } }).catch(() => {});
  }

  // Accept progress only from an actual child frame. Nested player frames relay
  // to their parent until the supported AniKoto top frame adds episode metadata.
  window.addEventListener("message", (event) => {
    if (!["ANIME_PROGRESS_UPDATE", "ANIME_STREAM_ERROR"].includes(event.data?.type)) return;
    if (![...document.querySelectorAll("iframe")].some((frame) => frame.contentWindow === event.source)) return;
    const currentTime = event.data.currentTime, duration = event.data.duration;
    if (event.data.type === "ANIME_STREAM_ERROR" || event.data.isBroken) {
      publish({ currentTime: 0, duration: 0, isBroken: true }); return;
    }
    if (typeof currentTime !== "number" || typeof duration !== "number" || !Number.isFinite(currentTime) ||
        !Number.isFinite(duration) || duration <= 0 || currentTime < 0 || currentTime > duration + 2) return;
    publish({ currentTime, duration, isBroken: false });
  });

  const tracked = new WeakSet();
  function attachVideos() {
    for (const video of document.querySelectorAll("video")) {
      if (tracked.has(video)) continue;
      tracked.add(video);
      const send = () => {
        if (video.error || video.networkState === 3) {
          publish({ currentTime: 0, duration: 0, isBroken: true }); return;
        }
        if (!Number.isFinite(video.duration) || video.duration <= 0) return;
        publish({ currentTime: video.currentTime, duration: video.duration, isBroken: false });
      };
      for (const event of ["timeupdate", "play", "pause", "ended", "error"]) video.addEventListener(event, send);
      send();
    }
  }

  let previousUrl = location.href;
  const observer = new MutationObserver(() => {
    attachVideos();
    if (topFrame && previousUrl !== location.href) {
      previousUrl = location.href; lastKey = "";
      publish({ currentTime: 0, duration: 0, isBroken: false });
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  if (topFrame) publish({ currentTime: 0, duration: 0, isBroken: false });
  attachVideos();
})();
