document.addEventListener('DOMContentLoaded', () => {
  chrome.storage.local.get(['lastWatchedAnime'], (result) => {
    const data = result.lastWatchedAnime;
    
    if (!data) {
      document.getElementById('anime-title').innerText = "No media playing";
      return;
    }

    // Handle Idle / Browsing Home state
    if (data.isIdle) {
      document.getElementById('anime-title').innerText = "Browsing AniKoto";
      document.getElementById('anime-episode').innerText = "Home / Menu";
      document.getElementById('anime-progress').innerText = "-";
      
      const badge = document.getElementById('status-badge');
      badge.innerText = "Idle";
      badge.className = "badge";
      badge.style.backgroundColor = "#6c757d"; // Gray badge
      badge.style.color = "#fff";
      return;
    }

    document.getElementById('anime-title').innerText = data.title;
    document.getElementById('anime-episode').innerText = data.episode;

    const badge = document.getElementById('status-badge');

    if (data.isBroken) {
      document.getElementById('anime-progress').innerText = "Stream Offline / Broken";
      badge.innerText = "Error";
      badge.style.backgroundColor = "#dc3545";
      badge.style.color = "#fff";
      return;
    }

    document.getElementById('anime-progress').innerText = `${data.progress}`;
    
    if (data.isFinished) {
      badge.innerText = "Completed";
      badge.className = "badge finished";
    } else {
      badge.innerText = "Watching";
      badge.className = "badge watching";
    }
  });
});