const canvasWidth = 1000;
const desktop = matchMedia('(min-width: 900px)');
const gallery = document.querySelector('.gallery');
const editorToken = document.querySelector('meta[name="layout-editor-token"]')?.content;

const works = Array.from(gallery.querySelectorAll('figure'), (figure) => {
  const media = figure.querySelector('img, video');
  return {
    figure,
    media,
    id: media.getAttribute('src') ?? media.querySelector('source').getAttribute('src'),
    title: media.getAttribute('alt') ?? media.getAttribute('aria-label'),
    ratio: Number(media.getAttribute('height')) / Number(media.getAttribute('width')),
  };
});

function canvasMetrics() {
  const style = getComputedStyle(gallery);
  const left = parseFloat(style.paddingLeft);
  const top = parseFloat(style.paddingTop);
  const bottom = parseFloat(style.paddingBottom);
  const scale = (gallery.clientWidth - left - parseFloat(style.paddingRight)) / canvasWidth;
  return { left, top, bottom, scale, rect: gallery.getBoundingClientRect() };
}

function columnPositions() {
  const measureDesktop = editorToken && !desktop.matches;
  if (measureDesktop) gallery.classList.add('editor-measuring-column');
  const { left, top, scale, rect } = canvasMetrics();
  const column = Object.fromEntries(works.map(({ id, media }) => {
    const box = media.getBoundingClientRect();
    const width = Math.min(canvasWidth, Math.round(box.width / scale));
    const x = Math.round((box.left - rect.left - left) / scale);
    return [id, [
      Math.max(0, Math.min(x, canvasWidth - width)),
      Math.max(0, Math.round((box.top - rect.top - top) / scale)),
      width,
    ]];
  }));
  if (measureDesktop) gallery.classList.remove('editor-measuring-column');
  return column;
}

function isPosition(position) {
  if (!Array.isArray(position) || position.length !== 3 || !position.every(Number.isInteger)) {
    return false;
  }
  const [x, y, width] = position;
  return x >= 0 && y >= 0 && y <= 200000 && width >= 60 && x + width <= canvasWidth;
}

let defaults;
let positions = {};

function completePositions(saved) {
  defaults ??= columnPositions();
  const placed = Object.fromEntries(works
    .filter(({ id }) => isPosition(saved?.[id]))
    .map(({ id }) => [id, saved[id]]));
  if (!Object.keys(placed).length) return structuredClone(defaults);

  let bottom = works.reduce((edge, { id, ratio }) => {
    const position = placed[id];
    return position ? Math.max(edge, position[1] + position[2] * ratio) : edge;
  }, 0);
  for (const { id, ratio } of works) {
    if (placed[id]) continue;
    const [x, , width] = defaults[id];
    const y = Math.round(bottom + 75);
    placed[id] = [x, y, width];
    bottom = y + width * ratio;
  }
  return placed;
}

function render() {
  if ((!desktop.matches && !editorToken) || !Object.keys(positions).length) {
    if (!gallery.classList.contains('gallery--positioned')) return;
    gallery.classList.remove('gallery--positioned');
    gallery.style.removeProperty('min-height');
    for (const { figure } of works) {
      ['left', 'top', 'width'].forEach((property) => figure.style.removeProperty(property));
    }
    return;
  }

  const { left, top, bottom, scale } = canvasMetrics();
  let edge = 0;
  for (const { id, figure, ratio } of works) {
    const [x, y, width] = positions[id];
    figure.style.left = `${left + x * scale}px`;
    figure.style.top = `${top + y * scale}px`;
    figure.style.width = `${width * scale}px`;
    edge = Math.max(edge, y + width * ratio);
  }
  const editingRoom = editorToken ? 480 : 0;
  gallery.style.minHeight = `${top + (edge + editingRoom) * scale + bottom}px`;
  gallery.classList.add('gallery--positioned');
}

function setPositions(next) {
  positions = next;
  render();
}

async function readLayout() {
  try {
    const response = await fetch(new URL('desktop-layout.json', import.meta.url), { cache: 'no-cache' });
    if (response.ok) return (await response.json()).positions ?? {};
  } catch {
    // The ordinary column is usable while the layout file is unavailable.
  }
  return {};
}

const videoObserver = new IntersectionObserver((entries) => {
  for (const { target: video, isIntersecting } of entries) {
    if (isIntersecting) {
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  }
});
for (const { media } of works) {
  if (media.tagName === 'VIDEO') videoObserver.observe(media);
}

let previousWidth = gallery.clientWidth;
new ResizeObserver(() => {
  if (gallery.clientWidth === previousWidth) return;
  previousWidth = gallery.clientWidth;
  render();
}).observe(gallery);

const saved = await readLayout();
if (editorToken) {
  const { initializeEditor } = await import('./editor/editor.js');
  initializeEditor({ gallery, works, canvasWidth, canvasMetrics, completePositions, setPositions, saved, editorToken });
} else if (works.some(({ id }) => isPosition(saved[id]))) {
  function applyDesktopLayout() {
    if (desktop.matches && !Object.keys(positions).length) positions = completePositions(saved);
    render();
  }
  applyDesktopLayout();
  desktop.addEventListener('change', applyDesktopLayout);
}
