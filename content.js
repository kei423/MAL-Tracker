// Helper to check if extension context is alive without throwing
function isContextValid() {
  try {
    return !!(chrome && chrome.runtime && chrome.runtime.id);
  } catch (e) {
    return false;
  }
}

// --- 1. Main Page Context: Extract Anime Name & Episode ---
if (window.self === window.top) {
  function getAniKotoDetails() {
    let title = "Unknown Anime";
    let episode = "Unknown Episode";

    // Check if we are on a watch page
    const isWatchPage = window.location.pathname.includes("/watch") || window.location.pathname.includes("/detail");
    if (!isWatchPage && window.location.pathname === "/") {
      return { title: "Browsing AniKoto", episode: "Home / Menu", isIdle: true };
    }

    // --- Direct Target: Exact h1 title element from your DOM tree ---
    // Targets <h1 itemprop="name" class="title d-title">
    const titleEl = document.querySelector(
      'h1[itemprop="name"], h1.title.d-title, #w-info .info h1, h1.title'
    );

    if (titleEl && titleEl.innerText.trim()) {
      title = titleEl.innerText.trim();
    } else {
      // Secondary fallback to breadcrumbs
      const breadcrumbLink = document.querySelector(".breadcrumb li:nth-last-child(2) a, .breadcrumb-item:nth-last-child(2) a");
      if (breadcrumbLink && breadcrumbLink.innerText.trim()) {
        title = breadcrumbLink.innerText.trim();
      }
    }

    // --- Episode Extraction ---
    // Reads episode number from the active episode list or URL
    const activeEpEl = document.querySelector(".ep-item.active, .ssl-item.active, .item.active, .eps-item.active");
    if (activeEpEl) {
      const epNum = activeEpEl.getAttribute("data-number") || activeEpEl.innerText.trim();
      episode = `Episode ${epNum}`;
    } else {
      const urlMatch = window.location.pathname.match(/ep-(\d+)|episode-(\d+)/i);
      if (urlMatch) {
        episode = `Episode ${urlMatch[1] || urlMatch[2]}`;
      }
    }

    return { title, episode, isIdle: false };
  }

  // Check state on load and URL changes (SPAs)
  function checkPageState() {
    if (!isContextValid()) return;
    const meta = getAniKotoDetails();

    if (meta.isIdle) {
      const idlePayload = {
        title: "Browsing AniKoto",
        episode: "Home / Menu",
        currentTime: 0,
        duration: 0,
        progress: "0%",
        isFinished: false,
        isBroken: false,
        isIdle: true,
        url: window.location.href,
        updatedAt: new Date().toISOString()
      };
      try {
        chrome.storage.local.set({ lastWatchedAnime: idlePayload });
      } catch (err) {}
    }
  }

  checkPageState();
  let lastUrl = location.href; 
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      setTimeout(checkPageState, 1000);
    }
  }).observe(document, { subtree: true, childList: true });

  // Listen for progress messages sent from the video iframe
  window.addEventListener("message", (event) => {
    if (!event.data) return;
    if (!isContextValid()) return;

    const meta = getAniKotoDetails();
    if (meta.isIdle) return;

    if (event.data.type === "ANIME_STREAM_ERROR") {
      const payload = {
        title: meta.title,
        episode: meta.episode,
        currentTime: 0,
        duration: 0,
        progress: "Error / Dead Link",
        isFinished: false,
        isBroken: true,
        isIdle: false,
        url: window.location.href,
        updatedAt: new Date().toISOString()
      };
      try {
        chrome.storage.local.set({ lastWatchedAnime: payload });
      } catch (err) {}
      return;
    }

    if (event.data.type === "ANIME_PROGRESS_UPDATE") {
      const payload = {
        title: meta.title,
        episode: meta.episode,
        currentTime: event.data.currentTime,
        duration: event.data.duration,
        progress: event.data.progress,
        isFinished: event.data.isFinished,
        isBroken: false,
        isIdle: false,
        url: window.location.href,
        updatedAt: new Date().toISOString()
      };

      try {
        chrome.storage.local.set({ lastWatchedAnime: payload });
      } catch (err) {}
    }
  });
} 

// --- 2. Iframe Context: Video Player Tracker ---
else {
  function trackVideoInsideIframe() {
    const video = document.querySelector("video");
    if (!video) return;

    const sendStatus = () => {
      if (video.error || video.networkState === 3) {
        window.parent.postMessage({ type: "ANIME_STREAM_ERROR" }, "*");
        return;
      }

      if (!video.duration || isNaN(video.duration) || video.duration === 0) return;

      const currentTime = video.currentTime;
      const duration = video.duration;
      const percentage = ((currentTime / duration) * 100).toFixed(1);
      const isFinished = video.ended || (currentTime / duration) >= 0.90;

      window.parent.postMessage({
        type: "ANIME_PROGRESS_UPDATE",
        currentTime: Math.floor(currentTime),
        duration: Math.floor(duration),
        progress: `${percentage}%`,
        isFinished: isFinished
      }, "*");
    };

    video.addEventListener("timeupdate", sendStatus);
    video.addEventListener("play", sendStatus);
    video.addEventListener("error", sendStatus);
    video.addEventListener("stalled", sendStatus);
    
    setTimeout(sendStatus, 2000);
  }

  const observer = new MutationObserver(() => {
    if (document.querySelector("video")) {
      trackVideoInsideIframe();
      observer.disconnect();
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
  trackVideoInsideIframe();
}