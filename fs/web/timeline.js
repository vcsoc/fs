'use strict';

function thumbnailTimeline(holder, file) {
  const strip = element('div', 'thumbnail-seekbar'); strip.setAttribute('aria-hidden', 'true');
  const playhead = element('span', 'thumbnail-playhead'); playhead.setAttribute('aria-hidden', 'true');
  holder.append(strip, playhead);
  return {
    update(ratio) {
      ratio = Math.max(0, Math.min(1, Number(ratio) || 0));
      playhead.style.left = (ratio * 100) + '%'; strip.style.setProperty('--playhead', (ratio * 100) + '%');
      holder.dataset.playhead = String(ratio);
    },
    matches(duration) {
      if (!(duration > 0) || !Number.isFinite(duration)) return;
      strip.replaceChildren();
      const sections = file.matched_sections || [];
      for (const section of sections) {
        if (!Number.isFinite(section.start) || !Number.isFinite(section.end) || section.end <= section.start || section.start >= duration) continue;
        const marker = element('span', 'thumbnail-match ' + (section.type === 'semantic' ? 'semantic' : 'caption'));
        marker.style.left = (Math.max(0, section.start) / duration * 100) + '%';
        marker.style.width = ((Math.min(duration, section.end) - Math.max(0, section.start)) / duration * 100) + '%';
        marker.dataset.start = section.start; marker.dataset.end = section.end;
        marker.title = timeLabel(section.start) + ' → ' + timeLabel(section.end) + ' · ' + (section.type === 'semantic' ? 'Semantic indexed interval' : 'Caption passage') + ': ' + section.text;
        strip.append(marker);
      }
      holder.classList.toggle('has-timed-matches', strip.children.length > 0);
      strip.setAttribute('aria-label', strip.children.length + ' recorded search-match intervals');
    },
  };
}

let metadataLoads = 0;
const metadataQueue = [];
function queueThumbnailMetadata(video, holder, file) {
  if (!file.matched_sections?.length) return;
  const observer = new IntersectionObserver(entries => {
    if (!entries.some(entry => entry.isIntersecting)) return;
    observer.disconnect(); metadataQueue.push({video, holder, file}); drainThumbnailMetadata();
  }, {root:document.querySelector('.result-table')});
  observer.observe(holder);
  // Disconnect observers when results are replaced, including never-visible cards.
  const removed = new MutationObserver(() => { if (!holder.isConnected) { observer.disconnect(); removed.disconnect(); } });
  removed.observe($('results'), {childList:true});
}
async function drainThumbnailMetadata() {
  while (metadataLoads < 2 && metadataQueue.length) {
    const item = metadataQueue.shift();
    if (!item.holder.isConnected) continue;
    metadataLoads++;
    (async () => {
      try {
        const url = await hoverMediaURL(item.file);
        if (!item.holder.isConnected || item.video.readyState >= 1) return;
        await new Promise(resolve => {
          const finish = () => { clearTimeout(timer); item.video.removeEventListener('loadedmetadata', finish); item.video.removeEventListener('error', finish); resolve(); };
          const timer = setTimeout(finish, 6000);
          item.video.addEventListener('loadedmetadata', finish); item.video.addEventListener('error', finish);
          item.video.preload = 'metadata'; item.video.src = url; item.video.load();
        });
      } catch (_) { /* Offline results retain posters without fabricated markers. */ }
      finally { metadataLoads--; drainThumbnailMetadata(); }
    })();
  }
}
