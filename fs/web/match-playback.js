'use strict';

function matchingIntervals(sections, duration) {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const sorted = sections.filter(section => Number.isFinite(section.start) && Number.isFinite(section.end))
    .map(section => ({start:Math.max(0, section.start), end:Math.min(duration, section.end)}))
    .filter(section => section.end > section.start).sort((a, b) => a.start - b.start || a.end - b.end);
  const intervals = [];
  for (const section of sorted) {
    const last = intervals.at(-1);
    if (last && section.start <= last.end) last.end = Math.max(last.end, section.end);
    else intervals.push({...section});
  }
  return intervals;
}
class MatchPlayback {
  constructor(media, sections, change = () => {}, error = () => {}) {
    this.media = media; this.sections = sections; this.change = change; this.error = error;
    this.active = false; this.index = 0; this.timer = null;
  }
  intervals() { return matchingIntervals(this.sections, this.media.duration); }
  cancel() { clearTimeout(this.timer); this.timer = null; this.active = false; this.change(false); }
  start(resume = true, preservePosition = false) {
    const intervals = this.intervals();
    if (!intervals.length) return false;
    this.active = true;
    this.index = preservePosition ? intervals.findIndex(section => this.media.currentTime < section.end) : 0;
    if (this.index < 0) this.index = 0;
    const section = intervals[this.index];
    if (!preservePosition || this.media.currentTime < section.start) this.media.currentTime = section.start;
    this.change(true);
    if (resume) this.media.play().catch(this.error);
    this.tick(); return true;
  }
  tick() {
    clearTimeout(this.timer); this.timer = null;
    if (!this.active || this.media.seeking) return;
    const intervals = this.intervals(), section = intervals[this.index];
    if (!section) { this.media.pause(); this.cancel(); return; }
    if (this.media.currentTime >= section.end) {
      const resume = !this.media.paused;
      this.media.pause(); this.index++;
      if (this.index >= intervals.length) { this.media.currentTime = section.end; this.cancel(); return; }
      this.media.currentTime = intervals[this.index].start;
      if (resume) this.media.play().catch(this.error);
      return;
    }
    if (this.media.currentTime < section.start) this.media.currentTime = section.start;
    if (!this.media.paused) {
      // timeupdate alone can be hundreds of milliseconds late. Schedule the
      // next boundary using playback speed and recheck after stalls/seeks.
      const delay = Math.max(10, (section.end - this.media.currentTime) / this.media.playbackRate * 1000);
      this.timer = setTimeout(() => this.tick(), delay);
    }
  }
}
if (typeof module !== 'undefined') module.exports = {matchingIntervals, MatchPlayback};
