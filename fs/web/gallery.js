'use strict';

let galleryFrame = 0;
let galleryFocusedCard = null;
let galleryFocusedFile = null;
const galleryDetails = element('aside', 'gallery-details');
galleryDetails.id = 'gallery-details'; galleryDetails.hidden = true;
galleryDetails.setAttribute('role', 'tooltip'); document.body.append(galleryDetails);

function hideGalleryDetails() {
  galleryFocusedCard?.removeAttribute('aria-describedby');
  galleryFocusedCard = null; galleryFocusedFile = null; galleryDetails.hidden = true;
}
function showGalleryDetails(card, file) {
  if (document.body.dataset.resultLayout !== 'masonry') return;
  hideGalleryDetails(); galleryFocusedCard = card; galleryFocusedFile = file;
  card.setAttribute('aria-describedby', galleryDetails.id);
  galleryDetails.replaceChildren(element('strong', '', file.name), element('p', 'gallery-detail-path', file.path));
  const fields = [
    ['Type', file.kind], ['Size', size(file.size)],
    ['Analysis', file.error ? 'Incomplete: ' + file.error : file.analyzed_at == null ? 'Metadata only / not analysed' : 'Completed within configured budgets'],
    ['Relevance', file.relevance == null ? 'Not searched' : file.relevance_basis === 'literal' ? 'Exact' : file.relevance.toFixed(1) + '% similarity'],
    ['Modified', file.modified], ['Created', file.created], ['Added', file.indexed_at], ['Analysed', file.analyzed_at],
  ];
  const list = element('dl');
  for (const [label, value] of fields) {
    list.append(element('dt', '', label), element('dd', '', typeof value === 'number' ? new Date(value * 1000).toLocaleString() : value ?? 'Unknown'));
  }
  galleryDetails.append(list);
  if (file.availability === 'offline') galleryDetails.append(element('p', '', 'Offline · cached metadata'));
  galleryDetails.hidden = false;
  const rect = card.querySelector('.file-thumbnail').getBoundingClientRect();
  const sideSpace = Math.max(rect.left - 16, innerWidth - rect.right - 16);
  const width = sideSpace >= 180 ? Math.min(290, sideSpace) : Math.min(290, innerWidth - 16);
  galleryDetails.style.width = width + 'px';
  const height = galleryDetails.getBoundingClientRect().height;
  let left, top = rect.top;
  if (innerWidth - rect.right >= width + 16) left = rect.right + 8;
  else if (rect.left >= width + 16) left = rect.left - width - 8;
  else { left = Math.max(8, Math.min(innerWidth - width - 8, rect.left)); top = rect.bottom + 8; }
  galleryDetails.style.left = left + 'px';
  galleryDetails.style.top = Math.max(8, Math.min(innerHeight - height - 8, top)) + 'px';
}
function observeGalleryCard(card, preview, file) {
  card.dataset.aspectRatio = '1';
  const poster = preview.querySelector('img');
  const updateRatio = () => {
    if (poster.naturalWidth && poster.naturalHeight) {
      card.dataset.aspectRatio = String(poster.naturalWidth / poster.naturalHeight);
      scheduleGallery();
    }
  };
  if (poster) { poster.addEventListener('load', updateRatio); if (poster.complete) updateRatio(); }
  const video = preview.querySelector('video');
  video?.addEventListener('loadedmetadata', () => {
    if (video.videoWidth && video.videoHeight) { card.dataset.aspectRatio = String(video.videoWidth / video.videoHeight); scheduleGallery(); }
  });
  preview.addEventListener('pointerenter', event => { if (event.pointerType !== 'touch') showGalleryDetails(card, file); });
  preview.addEventListener('pointerleave', () => { if (galleryFocusedCard === card) hideGalleryDetails(); });
  card.onfocusin = () => showGalleryDetails(card, file);
  card.onfocusout = event => { if (!card.contains(event.relatedTarget) && galleryFocusedCard === card) hideGalleryDetails(); };
}
function scheduleGallery() {
  cancelAnimationFrame(galleryFrame);
  galleryFrame = requestAnimationFrame(layoutGallery);
}
function layoutGallery() {
  const results = $('results');
  const cards = [...results.querySelectorAll('.result-card')];
  if (document.body.dataset.resultLayout !== 'masonry') {
    for (const card of cards) { card.style.removeProperty('width'); card.querySelector('.file-thumbnail').style.removeProperty('height'); }
    return;
  }
  const style = getComputedStyle(results);
  // clientWidth includes padding; leave a subpixel rounding margin so a
  // justified row never wraps its final card into the following row.
  const width = results.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 1;
  if (width <= 0) return;
  const gap = 12, target = innerWidth <= 760 ? 130 : 180;
  let row = [], sum = 0;
  const flush = last => {
    // A short final row stays at the target height rather than stretching one
    // portrait across the entire gallery. Every other row fills its width.
    const height = last ? Math.min(target, (width - gap * (row.length - 1)) / sum) : (width - gap * (row.length - 1)) / sum;
    for (const card of row) {
      const ratio = Number(card.dataset.aspectRatio) || 1;
      card.style.width = (height * ratio) + 'px';
      card.querySelector('.file-thumbnail').style.height = height + 'px';
    }
    row = []; sum = 0;
  };
  for (const card of cards) {
    const ratio = Number(card.dataset.aspectRatio) || 1;
    if (row.length) {
      const before = (width - gap * (row.length - 1)) / sum;
      const after = (width - gap * row.length) / (sum + ratio);
      if (after < target && Math.abs(before - target) < Math.abs(after - target)) flush(false);
    }
    row.push(card); sum += ratio;
    if ((width - gap * (row.length - 1)) / sum <= target) flush(false);
  }
  if (row.length) flush(true);
  if (galleryFocusedCard) showGalleryDetails(galleryFocusedCard, galleryFocusedFile);
}
new ResizeObserver(scheduleGallery).observe($('results'));
$('results').addEventListener('load', scheduleGallery, true);
document.querySelector('.result-table').addEventListener('scroll', hideGalleryDetails, {passive:true});
window.addEventListener('resize', hideGalleryDetails);
window.addEventListener('keydown', event => { if (event.key === 'Escape') hideGalleryDetails(); });
