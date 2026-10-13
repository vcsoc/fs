'use strict';

let mediaControlsCleanup = null;
function closeMediaControls() {
  mediaControlsCleanup?.(); mediaControlsCleanup = null;
  $('media-controls').hidden = true;
  $('viewer-content').classList.remove('media-mode', 'has-video-sections');
}
function setupMediaControls(media, data, clearClip) {
  closeMediaControls();
  $('media-controls').hidden = false;
  $('viewer-content').classList.add('media-mode');
  $('viewer-content').classList.toggle('has-video-sections', data.sections.length > 0 || Boolean(data.text));
  const controller = new AbortController(), options = {signal:controller.signal};
  const listen = (target, name, handler) => target.addEventListener(name, handler, options);
  const timeline = $('video-timeline');
  const progress = element('span', 'viewer-timeline-progress');
  const playhead = element('span', 'viewer-timeline-playhead');
  progress.setAttribute('aria-hidden', 'true'); playhead.setAttribute('aria-hidden', 'true');
  timeline.replaceChildren(progress, playhead);
  const validDuration = () => Number.isFinite(media.duration) && media.duration > 0;
  const play = () => media.play().catch(error => { $('viewer-notice').textContent = 'Playback paused: ' + error.message; });
  const update = () => {
    const duration = validDuration() ? media.duration : 0;
    const time = media.currentTime || 0, fraction = duration ? Math.min(1, time / duration) : 0;
    progress.style.width = (fraction * 100) + '%'; playhead.style.left = (fraction * 100) + '%';
    timeline.setAttribute('aria-valuemax', String(duration)); timeline.setAttribute('aria-valuenow', String(time));
    timeline.setAttribute('aria-valuetext', timeLabel(time) + ' of ' + (duration ? timeLabel(duration) : 'unknown duration'));
    timeline.setAttribute('aria-disabled', String(!duration));
    $('media-time').textContent = timeLabel(time) + ' / ' + (duration ? timeLabel(duration) : '—');
    $('media-play').textContent = media.paused ? 'Play' : 'Pause';
    $('media-play').setAttribute('aria-label', media.paused ? 'Play media' : 'Pause media');
    $('viewer-mute').textContent = media.muted || !media.volume ? 'Unmute' : 'Mute';
    $('viewer-mute').setAttribute('aria-pressed', String(media.muted || !media.volume));
    $('media-volume').value = String(media.volume); $('media-speed').value = String(media.playbackRate);
    for (const id of ['media-back', 'media-forward', 'media-restart']) $(id).disabled = !duration;
  };
  const seek = (time, resume = true) => {
    if (!validDuration()) return;
    clearClip(); media.currentTime = Math.max(0, Math.min(media.duration - .001, time)); update();
    if (resume) play();
  };
  const seekPointer = event => {
    const rect = timeline.getBoundingClientRect();
    if (rect.width) seek((event.clientX - rect.left) / rect.width * media.duration);
  };
  let dragging = false;
  listen(timeline, 'pointerdown', event => {
    if (event.button !== 0 || !validDuration()) return;
    dragging = true; timeline.setPointerCapture(event.pointerId); event.preventDefault(); seekPointer(event);
  });
  listen(timeline, 'pointermove', event => { if (dragging) seekPointer(event); });
  listen(timeline, 'pointerup', event => {
    if (!dragging) return;
    dragging = false; seekPointer(event);
    if (timeline.hasPointerCapture(event.pointerId)) timeline.releasePointerCapture(event.pointerId);
  });
  listen(timeline, 'pointercancel', () => { dragging = false; });
  listen(timeline, 'click', event => { if (event.detail > 0) seekPointer(event); });
  listen(timeline, 'keydown', event => {
    if (event.target !== timeline) return;
    const step = event.shiftKey ? 10 : 5;
    if (event.key === 'ArrowLeft') seek(media.currentTime - step);
    else if (event.key === 'ArrowRight') seek(media.currentTime + step);
    else if (event.key === 'Home') seek(0);
    else if (event.key === 'End') seek(media.duration);
    else if (event.key === ' ' || event.key === 'Enter') media.paused ? play() : media.pause();
    else return;
    event.preventDefault();
  });
  const markers = () => {
    timeline.querySelectorAll('.timeline-marker').forEach(marker => marker.remove());
    if (!validDuration()) { update(); return; }
    for (const section of data.sections) {
      if (section.start >= media.duration || section.end <= section.start) continue;
      const marker = element('button', 'timeline-marker ' + section.type);
      marker.style.left = (100 * section.start / media.duration) + '%';
      marker.style.width = Math.max(.3, 100 * (Math.min(section.end, media.duration) - section.start) / media.duration) + '%';
      marker.title = timeLabel(section.start) + ' → ' + timeLabel(section.end) + ': ' + section.text;
      marker.setAttribute('aria-label', marker.title);
      // Pointer clicks use their exact timeline position; keyboard activation
      // still makes each recorded interval directly accessible.
      listen(marker, 'click', event => { if (!event.detail) { event.stopPropagation(); seek(section.start); } });
      timeline.append(marker);
    }
    update();
  };
  listen($('media-play'), 'click', () => media.paused ? play() : media.pause());
  listen($('media-back'), 'click', () => seek(media.currentTime - 10));
  listen($('media-forward'), 'click', () => seek(media.currentTime + 10));
  listen($('media-restart'), 'click', () => seek(0));
  listen($('viewer-mute'), 'click', () => { media.muted = !media.muted; if (!media.volume) media.volume = .5; });
  listen($('media-volume'), 'input', () => { media.volume = Number($('media-volume').value); media.muted = media.volume === 0; });
  listen($('media-speed'), 'change', () => { media.playbackRate = Number($('media-speed').value); });
  $('media-fullscreen').hidden = data.kind !== 'video';
  listen($('media-fullscreen'), 'click', () => {
    const action = document.fullscreenElement ? document.exitFullscreen() : $('viewer-stage').requestFullscreen();
    action.catch(error => { $('viewer-notice').textContent = 'Fullscreen unavailable: ' + error.message; });
  });
  for (const event of ['timeupdate', 'seeking', 'seeked', 'play', 'pause', 'ended', 'volumechange', 'ratechange']) listen(media, event, update);
  listen(media, 'loadedmetadata', markers); listen(media, 'durationchange', markers);
  mediaControlsCleanup = () => controller.abort();
  markers();
}
