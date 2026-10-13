'use strict';

const mediaIconPaths = {
  play:'M8 5L19 12L8 19Z', pause:'M8 5V19M16 5V19',
  back:'M8 5L4 9L8 13M4 9H14A6 6 0 0 1 14 21',
  forward:'M16 5L20 9L16 13M20 9H10A6 6 0 0 0 10 21',
  restart:'M4 5V11H10M4 11A8 8 0 1 1 6 18',
  sound:'M3 9H7L12 5V19L7 15H3ZM16 8Q21 12 16 16',
  muted:'M3 9H7L12 5V19L7 15H3ZM16 9L22 15M22 9L16 15',
  fullscreen:'M3 9V3H9M15 3H21V9M21 15V21H15M9 21H3V15',
  exitFullscreen:'M9 3V9H3M21 9H15V3M15 21V15H21M3 15H9V21',
  speed:'M4 18A9 9 0 1 1 20 18M12 13L17 7M8 18H16',
};
function setMediaIcon(button, name, label) {
  if (button.dataset.icon !== name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(svg.namespaceURI, 'path');
    path.setAttribute('d', mediaIconPaths[name]); path.setAttribute('fill', name === 'play' ? 'currentColor' : 'none');
    path.setAttribute('stroke', 'currentColor'); path.setAttribute('stroke-width', '1.8'); path.setAttribute('stroke-linecap', 'round'); path.setAttribute('stroke-linejoin', 'round'); svg.append(path);
    if (name === 'back' || name === 'forward') {
      const number = document.createElementNS(svg.namespaceURI, 'text'); number.setAttribute('x', '12'); number.setAttribute('y', '17'); number.setAttribute('text-anchor', 'middle'); number.setAttribute('font-size', '7'); number.setAttribute('fill', 'currentColor'); number.textContent = '10'; svg.append(number);
    }
    button.replaceChildren(svg); button.dataset.icon = name;
  }
  button.title = label; button.setAttribute('aria-label', label);
}
let mediaMatchPlayback = null;
function stopMatchPlayback() { mediaMatchPlayback?.cancel(); }
function matchingPlaybackActive() { return Boolean(mediaMatchPlayback?.active); }
function restoreMatchingPlayback(resume) { mediaMatchPlayback?.start(resume, true); }
let mediaControlsCleanup = null;
function closeMediaControls() {
  mediaMatchPlayback?.cancel(); mediaMatchPlayback = null;
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
  setMediaIcon($('media-back'), 'back', 'Skip back 10 seconds');
  setMediaIcon($('media-forward'), 'forward', 'Skip forward 10 seconds');
  setMediaIcon($('media-restart'), 'restart', 'Restart playback');
  setMediaIcon($('media-speed-icon'), 'speed', 'Playback speed');
  const matches = new MatchPlayback(media, data.sections, active => {
    $('media-match-play').setAttribute('aria-pressed', String(active));
    $('media-match-play').textContent = active ? 'Exit match mode' : 'Play matches';
    $('media-match-play').title = active ? 'Return to normal playback from here' : 'Play the listed matching intervals in time order, skipping every gap';
  }, error => { $('viewer-notice').textContent = 'Match playback paused: ' + error.message; });
  mediaMatchPlayback = matches;
  listen($('media-match-play'), 'click', () => {
    if (matches.active) matches.cancel(); else { clearClip(); matches.start(); }
  });
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
    setMediaIcon($('media-play'), media.paused ? 'play' : 'pause', media.paused ? 'Play media' : 'Pause media');
    setMediaIcon($('viewer-mute'), media.muted || !media.volume ? 'muted' : 'sound', media.muted || !media.volume ? 'Unmute' : 'Mute');
    setMediaIcon($('media-fullscreen'), document.fullscreenElement ? 'exitFullscreen' : 'fullscreen', document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen');
    $('media-match-play').disabled = !matches.intervals().length;
    $('viewer-mute').setAttribute('aria-pressed', String(media.muted || !media.volume));
    $('media-volume').value = String(media.volume); $('media-speed').value = String(media.playbackRate);
    for (const id of ['media-back', 'media-forward', 'media-restart']) $(id).disabled = !duration;
  };
  const seek = (time, resume = true) => {
    if (!validDuration()) return;
    matches.cancel(); clearClip(); media.currentTime = Math.max(0, Math.min(media.duration - .001, time)); update();
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
  for (const event of ['timeupdate', 'seeking', 'seeked', 'play', 'pause', 'ended', 'volumechange', 'ratechange']) listen(media, event, () => { matches.tick(); update(); });
  listen(document, 'fullscreenchange', update);
  listen(media, 'loadedmetadata', markers); listen(media, 'durationchange', markers);
  mediaControlsCleanup = () => controller.abort();
  markers();
}
