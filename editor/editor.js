const storageKey = 'crazy-random-design-desktop-draft';
const limitY = 200000;
const clamp = (value, min, max) => Math.min(max, Math.max(min, Math.round(value)));

function makeButton(className, label, text = '') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.setAttribute('aria-label', label);
  button.textContent = text;
  return button;
}

function readDraft() {
  try {
    return JSON.parse(localStorage.getItem(storageKey)) ?? null;
  } catch {
    return null;
  }
}

function saveDraft(positions) {
  try {
    if (positions) {
      localStorage.setItem(storageKey, JSON.stringify(positions));
    } else {
      localStorage.removeItem(storageKey);
    }
  } catch {
    // Editing and publishing also work without browser storage.
  }
}

export function initializeEditor({ gallery, works, canvasWidth, canvasMetrics, completePositions, setPositions, orientedRatio, saved, editorToken }) {
  const toolbar = document.createElement('aside');
  toolbar.className = 'editor-toolbar';
  toolbar.setAttribute('aria-label', 'Редактор раскладки');
  toolbar.innerHTML = '<strong>Десктопная раскладка</strong>';
  const jump = document.createElement('select');
  jump.setAttribute('aria-label', 'Перейти к работе');
  jump.add(new Option('Перейти к работе…', ''));
  const moveHere = makeButton('', 'Перенести выбранное в видимую область', 'Перенести сюда');
  const scaleControls = document.createElement('div');
  scaleControls.className = 'editor-scale';
  scaleControls.setAttribute('role', 'group');
  scaleControls.setAttribute('aria-label', 'Размер выбранных работ');
  const shrink = makeButton('', 'Уменьшить выбранное', '−');
  const grow = makeButton('', 'Увеличить выбранное', '+');
  const rotate = makeButton('', 'Повернуть на 90° по часовой стрелке', '↻ 90°');
  scaleControls.append(shrink, grow);
  const selectionCount = document.createElement('span');
  selectionCount.setAttribute('aria-live', 'polite');
  const undo = makeButton('', 'Отменить последнее изменение', 'Отменить');
  const publish = makeButton('editor-publish', 'Опубликовать раскладку', 'Опубликовать');
  const status = document.createElement('output');
  status.setAttribute('role', 'status');
  status.textContent = 'Удерживай ⇧ или ⌘ для выбора нескольких';
  toolbar.append(jump, scaleControls, rotate, moveHere, undo, selectionCount, status, publish);
  document.body.prepend(toolbar);
  new ResizeObserver(() => {
    document.body.style.setProperty('--editor-toolbar-height', `${toolbar.offsetHeight}px`);
  }).observe(toolbar);

  const byId = new Map(works.map((work) => [work.id, work]));
  const grabButtons = new Map();
  const history = [];
  const baseline = completePositions(saved);
  const draft = readDraft();
  const positions = draft ? completePositions(draft) : baseline;
  let selected = new Set();
  let drag;
  let scrollFrame;
  let busy = false;
  let published = JSON.stringify(baseline);

  function snapshot() {
    return Array.from(selected, (id) => [id, [...positions[id]]]);
  }

  function bounds(entries) {
    let left = Infinity, top = Infinity, right = 0, bottom = 0, maxY = 0;
    for (const [id, [x, y, width, rotation]] of entries) {
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x + width);
      bottom = Math.max(bottom, y + width * orientedRatio(byId.get(id).ratio, rotation));
      maxY = Math.max(maxY, y);
    }
    return { left, top, right, bottom, maxY };
  }

  function scaleLimits(entries, frame) {
    const min = Math.max(...entries.map(([, [, , width]]) => 60 / width));
    const maxX = canvasWidth / (frame.right - frame.left);
    const maxY = frame.maxY > frame.top ? (limitY - frame.top) / (frame.maxY - frame.top) : Infinity;
    return [min, Math.min(maxX, maxY)];
  }

  function updateScaleButtons() {
    if (!selected.size) {
      shrink.disabled = grow.disabled = true;
      return;
    }
    const entries = snapshot();
    const [min, max] = scaleLimits(entries, bounds(entries));
    shrink.disabled = min >= 1;
    grow.disabled = max <= 1;
  }

  function select(ids) {
    const next = new Set(ids);
    for (const id of new Set([...selected, ...next])) {
      const active = next.has(id);
      const { figure } = byId.get(id);
      figure.classList.toggle('editor-selected', active);
      figure.classList.toggle('editor-selected-single', active && next.size === 1);
      grabButtons.get(id).setAttribute('aria-pressed', String(active));
    }
    selected = next;
    jump.value = selected.size === 1 ? selected.values().next().value : '';
    moveHere.disabled = !selected.size;
    rotate.disabled = selected.size !== 1;
    selectionCount.hidden = selected.size < 2;
    selectionCount.textContent = `Выбрано ${selected.size}`;
    updateScaleButtons();
  }

  function toggleSelection(id) {
    select(selected.has(id) ? [...selected].filter((workId) => workId !== id) : [...selected, id]);
  }

  function update() {
    setPositions(positions);
    undo.disabled = !history.length;
    publish.disabled = busy || JSON.stringify(positions) === published;
    updateScaleButtons();
  }

  function persist() {
    saveDraft(JSON.stringify(positions) === published ? null : positions);
  }

  function record(original) {
    if (original.every(([id, old]) => positions[id].length === old.length
      && positions[id].every((value, index) => value === old[index]))) return;
    history.push(original);
    persist();
    status.textContent = 'Черновик сохранён в этом браузере';
    update();
  }

  function scaleSelected(factor) {
    const original = snapshot();
    const frame = bounds(original);
    const [min, max] = scaleLimits(original, frame);
    const scale = Math.min(max, Math.max(min, factor));
    const width = frame.right - frame.left;
    const left = clamp(frame.left + (width - width * scale) / 2, 0, canvasWidth - Math.round(width * scale));
    for (const [id, [x, y, workWidth, ...orientation]] of original) {
      const nextWidth = clamp(workWidth * scale, 60, canvasWidth);
      const nextX = clamp(left + (x - frame.left) * scale, 0, canvasWidth - nextWidth);
      const nextY = clamp(frame.top + (y - frame.top) * scale, 0, limitY);
      positions[id] = [nextX, nextY, nextWidth, ...orientation];
    }
    record(original);
  }

  shrink.addEventListener('click', () => scaleSelected(1 / 1.12));
  grow.addEventListener('click', () => scaleSelected(1.12));
  rotate.addEventListener('click', () => {
    const original = snapshot();
    const [[id, [x, y, width, rotation = 0]]] = original;
    const { ratio } = byId.get(id);
    const nextRotation = (rotation + 90) % 360;
    const height = width * orientedRatio(ratio, rotation);
    const nextWidth = clamp(height, 60, canvasWidth);
    const nextHeight = nextWidth * orientedRatio(ratio, nextRotation);
    const nextX = clamp(x + (width - nextWidth) / 2, 0, canvasWidth - nextWidth);
    const nextY = clamp(y + (height - nextHeight) / 2, 0, limitY);
    positions[id] = nextRotation ? [nextX, nextY, nextWidth, nextRotation] : [nextX, nextY, nextWidth];
    record(original);
  });

  function coordinates(event) {
    const { left, top, scale, rect } = canvasMetrics();
    return [(event.clientX - rect.left - left) / scale, (event.clientY - rect.top - top) / scale];
  }

  function translate(original, frame, dx, dy) {
    const offsetX = clamp(dx, -frame.left, canvasWidth - frame.right);
    const offsetY = clamp(dy, -frame.top, limitY - frame.maxY);
    for (const [id, [x, y, width, ...orientation]] of original) {
      positions[id] = [x + offsetX, y + offsetY, width, ...orientation];
    }
  }

  function resizeOne(original, dx) {
    const [[id, [x, y, width, ...orientation]]] = original;
    positions[id] = [x, y, clamp(width + dx, 60, canvasWidth - x), ...orientation];
  }

  function positionDrag(event) {
    const [cursorX, cursorY] = coordinates(event);
    const dx = cursorX - drag.startX;
    const dy = cursorY - drag.startY;
    if (drag.resize) {
      resizeOne(drag.original, dx);
    } else {
      translate(drag.original, drag.frame, dx, dy);
    }
    setPositions(positions);
  }

  function autoScroll() {
    if (!drag) return;
    const y = drag.event.clientY;
    const top = toolbar.getBoundingClientRect().bottom + 46;
    const bottom = innerHeight - 70;
    const delta = y < top ? Math.max(-34, (y - top) / 2) : Math.min(34, Math.max(0, (y - bottom) / 2));
    if (delta) {
      window.scrollBy(0, delta);
      positionDrag(drag.event);
    }
    scrollFrame = requestAnimationFrame(autoScroll);
  }

  function startDrag(event, work, resize) {
    if (event.button !== 0 || drag) return;
    if (!resize && (event.shiftKey || event.metaKey)) {
      event.preventDefault();
      toggleSelection(work.id);
      return;
    }
    if (!selected.has(work.id)) select([work.id]);
    const [startX, startY] = coordinates(event);
    const original = snapshot();
    drag = { work, pointerId: event.pointerId, event, startX, startY, resize, original, frame: bounds(original), moving: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function endDrag(event) {
    if (drag?.pointerId !== event.pointerId) return;
    cancelAnimationFrame(scrollFrame);
    const { work, original, moving, resize } = drag;
    drag = null;
    if (moving) {
      record(original);
    } else if (!resize && event.type === 'pointerup') {
      select([work.id]);
    }
  }

  for (const work of works) {
    const grab = makeButton('editor-grab', `Переместить: ${work.title}`);
    const resize = makeButton('editor-resize', `Изменить ширину: ${work.title}`);
    grab.setAttribute('aria-pressed', 'false');
    grabButtons.set(work.id, grab);
    grab.addEventListener('click', (event) => {
      if (event.detail !== 0) return;
      if (event.shiftKey || event.metaKey) toggleSelection(work.id);
      else select([work.id]);
    });
    for (const handle of [grab, resize]) {
      handle.addEventListener('pointerdown', (event) => startDrag(event, work, handle === resize));
      handle.addEventListener('pointermove', (event) => {
        if (drag?.pointerId !== event.pointerId) return;
        if (!drag.moving) {
          if (Math.hypot(event.clientX - drag.event.clientX, event.clientY - drag.event.clientY) < 3) return;
          drag.moving = true;
          scrollFrame = requestAnimationFrame(autoScroll);
        }
        drag.event = event;
        positionDrag(event);
      });
      for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) {
        handle.addEventListener(event, endDrag);
      }
      handle.addEventListener('keydown', (event) => {
        if (!event.key.startsWith('Arrow')) return;
        if (!selected.has(work.id)) select([work.id]);
        const step = event.shiftKey ? 24 : 4;
        const dx = step * ((event.key === 'ArrowRight') - (event.key === 'ArrowLeft'));
        const dy = step * ((event.key === 'ArrowDown') - (event.key === 'ArrowUp'));
        const original = snapshot();
        if (handle === resize) resizeOne(original, dx + dy);
        else translate(original, bounds(original), dx, dy);
        event.preventDefault();
        record(original);
      });
    }
    work.figure.append(grab, resize);
    jump.add(new Option(work.title, work.id));
  }

  jump.addEventListener('change', () => {
    const work = byId.get(jump.value);
    select(work ? [work.id] : []);
    work?.figure.scrollIntoView({ block: 'center' });
  });
  gallery.addEventListener('click', (event) => {
    if (event.target === gallery) select([]);
  });
  moveHere.addEventListener('click', () => {
    const original = snapshot();
    const frame = bounds(original);
    const { scale, top, rect } = canvasMetrics();
    const offsetY = (innerHeight / 2 - rect.top - top) / scale - (frame.top + frame.bottom) / 2;
    translate(original, frame, 0, offsetY);
    record(original);
  });
  undo.addEventListener('click', () => {
    const original = history.pop();
    for (const [id, position] of original) positions[id] = position;
    persist();
    select(original.map(([id]) => id));
    update();
    status.textContent = 'Последнее изменение отменено';
  });

  publish.addEventListener('click', async () => {
    const snapshot = JSON.stringify(positions);
    busy = true;
    status.textContent = 'Отправляю на GitHub…';
    update();
    try {
      const response = await fetch('/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Editor-Token': editorToken },
        body: `{"positions":${snapshot}}`,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      published = snapshot;
      persist();
      status.textContent = 'Раскладка отправлена. GitHub Pages обновит сайт.';
    } catch (error) {
      status.textContent = error.message || 'Публикация не удалась. Черновик сохранён.';
    } finally {
      busy = false;
      update();
    }
  });

  select([]);
  update();
}
