'use strict';

// Native animated-image decoding keeps GIF/WebP/APNG previews local. Keep only
// one decoder active, close every frame, and bound input size and frame count.
class AnimatedThumbnailPreview {
  constructor(canvas, position = () => {}) {
    this.position = position;
    this.canvas = canvas; this.closed = false; this.ready = false; this.decoder = null;
    this.abort = new AbortController(); this.ratio = 0; this.seek = true;
    this.frame = 0; this.tick = 0;
  }
  async load(url, type) {
    if (!globalThis.ImageDecoder || !await ImageDecoder.isTypeSupported(type)) throw new Error('Animated preview decoding is unavailable in this browser.');
    const response = await fetch(url, {signal:this.abort.signal});
    if (!response.ok) throw new Error('Animated preview could not be read.');
    const limit = 8 * 1024 * 1024;
    if (Number(response.headers.get('Content-Length')) > limit) throw new Error('Animated preview exceeds the 8 MiB preview budget.');
    const reader = response.body.getReader(); const parts = []; let bytes = 0;
    try {
      while (true) {
        const {done, value} = await reader.read(); if (done) break;
        bytes += value.byteLength;
        if (bytes > limit) throw new Error('Animated preview exceeds the 8 MiB preview budget.');
        parts.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    if (this.closed) return;
    const data = new Uint8Array(bytes); let at = 0;
    for (const part of parts) { data.set(part, at); at += part.byteLength; }
    const poster = this.canvas.parentElement.querySelector('img');
    const ratio = poster?.naturalWidth && poster?.naturalHeight ? poster.naturalWidth / poster.naturalHeight : 1;
    const desiredWidth = ratio >= 1 ? 384 : Math.max(1, Math.round(384 * ratio));
    const desiredHeight = ratio >= 1 ? Math.max(1, Math.round(384 / ratio)) : 384;
    this.decoder = new ImageDecoder({data, type, preferAnimation:true, desiredWidth, desiredHeight});
    await this.decoder.tracks.ready;
    const track = this.decoder.tracks.selectedTrack;
    if (this.closed || !track?.animated) { this.close(); return; }
    const count = track.frameCount;
    if (!count || count > 300) throw new Error('Animated preview exceeds the 300-frame preview budget.');
    this.starts = []; this.durations = []; this.duration = 0;
    for (let index = 0; index < count && !this.closed; index++) {
      const {image} = await this.decoder.decode({frameIndex:index});
      try {
        if (index === 0) this.draw(image);
        this.starts.push(this.duration);
        const duration = Math.max(20, (image.duration || 100000) / 1000);
        this.durations.push(duration); this.duration += duration;
      } finally { image.close(); }
    }
    if (this.closed) return;
    this.canvas.parentElement.classList.add('preview-playing');
    this.ready = true; this.origin = performance.now();
    this.animate();
  }
  draw(image) {
    this.canvas.width = image.displayWidth; this.canvas.height = image.displayHeight;
    this.canvas.getContext('2d').drawImage(image, 0, 0);
    this.canvas.hidden = false;
  }
  scrub(ratio) { this.ratio = ratio; this.seek = true; }
  async animate() {
    if (this.closed) return;
    if (this.seek) {
      this.origin = performance.now() - this.ratio * Math.max(0, this.duration - 1);
      this.seek = false;
    }
    const time = (performance.now() - this.origin) % this.duration;
    this.position(time / this.duration);
    let index = this.starts.length - 1;
    while (index > 0 && this.starts[index] > time) index--;
    try {
      if (this.frame !== index || !this.tick) {
        const {image} = await this.decoder.decode({frameIndex:index});
        try { if (!this.closed) { this.draw(image); this.frame = index; this.canvas.dataset.frame = String(index); } }
        finally { image.close(); }
      }
      if (!this.closed) this.tick = requestAnimationFrame(() => this.animate());
    } catch (error) { if (!this.closed) { this.canvas.title = error.message; this.close(); } }
  }
  close() {
    if (this.closed) return;
    this.canvas.parentElement.classList.remove('preview-playing');
    this.closed = true; this.abort.abort(); cancelAnimationFrame(this.tick);
    if (this.decoder) this.decoder.close();
    this.canvas.hidden = true;
  }
}
