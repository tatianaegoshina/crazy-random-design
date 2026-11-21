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

export function initializeEditor({ gallery, works, desktop, canvasWidth, canvasMetrics, completePositions, setPositions, saved, editorToken }) {
  const toolbar = document.createElement('aside');
  toolbar.className = 'editor-toolbar';
  toolbar.setAttribute('aria-label', 'Редактор раскладки');
  toolbar.innerHTML = '<strong>Расстановка работ</strong>';
  const jump = document.createElement('select');
  jump.setAttribute('aria-label', 'Перейти к работе');
  jump.add(new Option('Перейти к работе…', ''));
  const moveHere = makeButton('', 'Перенести выбранную работу в видимую область', 'Перенести сюда');
  const undo = makeButton('', 'Отменить последнее изменение', 'Отменить');
  const publish = makeButton('editor-publish', 'Опубликовать раскладку', 'Опубликовать');
  const status = document.createElement('output');
  status.setAttribute('role', 'status');
  status.textContent = 'Перетащи работу или потяни за угол';
  toolbar.append(jump, moveHere, undo, status, publish);
  document.body.prepend(toolbar);
  new ResizeObserver(() => {
    document.body.style.setProperty('--editor-toolbar-height', `${toolbar.offsetHeight}px`);
  }).observe(toolbar);

  const note = document.createElement('p');
  note.className = 'editor-note';
  note.textContent = 'Это мобильная колонка. Расширь окно, чтобы редактировать десктопную раскладку.';
  gallery.before(note);

  const byId = new Map(works.map((work) => [work.id, work]));
  const history = [];
  let positions;
  let selected;
  let drag;
  let scrollFrame;
  let busy = false;
  let published = JSON.stringify(saved);

  function select(work) {
    selected?.figure.classList.remove('editor-selected');
    selected = work;
    selected?.figure.classList.add('editor-selected');
    jump.value = selected?.id ?? '';
    moveHere.disabled = !selected;
  }

  function update() {
    setPositions(positions ?? {});
    undo.disabled = !history.length;
    publish.disabled = busy || !positions || JSON.stringify(positions) === published;
  }

  function persist() {
    saveDraft(JSON.stringify(positions) === published ? null : positions);
  }

  function record(id, original) {
    if (positions[id].every((value, index) => value === original[index])) return;
    history.push({ id, original });
    persist();
    status.textContent = 'Черновик сохранён в этом браузере';
    update();
  }

  function coordinates(event) {
    const { left, top, scale, rect } = canvasMetrics();
    return [(event.clientX - rect.left - left) / scale, (event.clientY - rect.top - top) / scale];
  }

  function positionDrag(event) {
    const [x, y, width] = drag.original;
    const [cursorX, cursorY] = coordinates(event);
    const dx = cursorX - drag.startX;
    const dy = cursorY - drag.startY;
    positions[drag.work.id] = drag.resize
      ? [x, y, clamp(width + dx, 60, canvasWidth - x)]
      : [clamp(x + dx, 0, canvasWidth - width), clamp(y + dy, 0, limitY), width];
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
    if (!desktop.matches || event.button !== 0 || drag) return;
    select(work);
    const [startX, startY] = coordinates(event);
    drag = { work, pointerId: event.pointerId, event, startX, startY, resize, original: [...positions[work.id]] };
    event.currentTarget.setPointerCapture(event.pointerId);
    scrollFrame = requestAnimationFrame(autoScroll);
  }

  function endDrag(event) {
    if (drag?.pointerId !== event.pointerId) return;
    cancelAnimationFrame(scrollFrame);
    const { work, original } = drag;
    drag = null;
    record(work.id, original);
  }

  for (const work of works) {
    const grab = makeButton('editor-grab', `Переместить: ${work.title}`);
    const resize = makeButton('editor-resize', `Изменить ширину: ${work.title}`);
    for (const handle of [grab, resize]) {
      handle.addEventListener('focus', () => select(work));
      handle.addEventListener('pointerdown', (event) => startDrag(event, work, handle === resize));
      handle.addEventListener('pointermove', (event) => {
        if (drag?.pointerId !== event.pointerId) return;
        drag.event = event;
        positionDrag(event);
      });
      for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) {
        handle.addEventListener(event, endDrag);
      }
      handle.addEventListener('keydown', (event) => {
        if (!event.key.startsWith('Arrow')) return;
        const [x, y, width] = positions[work.id];
        const step = event.shiftKey ? 24 : 4;
        const dx = step * ((event.key === 'ArrowRight') - (event.key === 'ArrowLeft'));
        const dy = step * ((event.key === 'ArrowDown') - (event.key === 'ArrowUp'));
        const original = [x, y, width];
        positions[work.id] = handle === resize
          ? [x, y, clamp(width + dx + dy, 60, canvasWidth - x)]
          : [clamp(x + dx, 0, canvasWidth - width), clamp(y + dy, 0, limitY), width];
        event.preventDefault();
        record(work.id, original);
      });
    }
    work.figure.append(grab, resize);
    jump.add(new Option(work.title, work.id));
  }

  jump.addEventListener('change', () => {
    select(byId.get(jump.value));
    selected?.figure.scrollIntoView({ block: 'center' });
  });
  moveHere.addEventListener('click', () => {
    const { id, ratio } = selected;
    const original = [...positions[id]];
    const { scale, top, rect } = canvasMetrics();
    const y = (innerHeight / 2 - rect.top - top) / scale - original[2] * ratio / 2;
    positions[id][1] = clamp(y, 0, limitY);
    record(id, original);
    selected.figure.scrollIntoView({ block: 'center' });
  });
  undo.addEventListener('click', () => {
    const { id, original } = history.pop();
    positions[id] = original;
    persist();
    select(byId.get(id));
    update();
    selected.figure.scrollIntoView({ block: 'center' });
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

  function applyMode() {
    note.hidden = desktop.matches;
    if (desktop.matches && !positions) {
      const draft = readDraft();
      const baseline = completePositions(saved);
      published = JSON.stringify(baseline);
      positions = draft ? completePositions(draft) : baseline;
    }
    update();
  }

  select();
  applyMode();
  desktop.addEventListener('change', applyMode);
}
