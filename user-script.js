// ==UserScript==
// @name         Zaycev.net — скачать аудио
// @namespace    local.zaycev.download
// @version      1.3.37
// @description  Добавляет скачивание доступного для прослушивания аудио без штатной кнопки.
// @match        https://zaycev.net/*
// @match        https://www.zaycev.net/*
// @grant        GM_xmlhttpRequest
// @connect      cdndl.zaycev.net
// @connect      cdnimg.zaycev.net
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';
  const marker = 'data-zaycev-save';
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  let bulkJob = null;
  let singleDownloads = 0;
  const coverCache = new Map();
  const busyButtons = new WeakSet();
  const downloadIcon = '<svg data-zaycev-icon="download" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m-4-4 4 4 4-4M5 17v4h14v-4"/></svg>';
  const style = document.createElement('style');
  style.textContent = `
    .zaycev-download-button{display:inline-flex!important;align-items:center!important;justify-content:center!important;flex-shrink:0!important;width:36px!important;height:36px!important;padding:0!important;margin-left:8px!important;border:0!important;border-radius:9px!important;background:transparent!important;color:#00a0b6!important;cursor:pointer!important;transition:background .2s,transform .2s!important}
    .zaycev-download-button:hover{background:#00a0b619!important;transform:translateY(-1px)}
    .zaycev-download-button svg{width:21px!important;height:21px!important;fill:none!important;stroke:currentColor!important;stroke-width:1.7!important;stroke-linecap:round;stroke-linejoin:round}
    .zaycev-download-button svg path{fill:none!important;stroke:currentColor!important}
    .zaycev-download-button:focus-visible{outline:2px solid #00a0b6;outline-offset:2px}
    .zaycev-download-button:disabled{opacity:.5;cursor:wait!important}
    .zaycev-download-button[aria-busy="true"] svg{animation:zaycev-pulse .8s ease-in-out infinite alternate}
    [data-zaycev-bulk]{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin:16px 0;padding:18px;border:1px solid #00a0b633;border-radius:16px;background:linear-gradient(120deg,#00a0b60b,#af66ff0b);font:14px/1.5 sans-serif}
    [data-zaycev-bulk] button,[data-zaycev-bulk] select{font:inherit;padding:8px 12px;border:1px solid #00a0b644;border-radius:9px;background:transparent;color:inherit;cursor:pointer}
    [data-zaycev-bulk] button:first-child{background:#00a0b6;color:white;border-color:#00a0b6;font-weight:600}
    [data-zaycev-bulk] button:disabled{opacity:.5;cursor:default}
    .zaycev-bulk-status{flex:1 0 100%;overflow-wrap:anywhere}
    .zaycev-bulk-progress{flex:1 0 100%;width:100%;height:10px;border:0;border-radius:10px;overflow:hidden;background:#00a0b619;accent-color:#00a0b6}
    .zaycev-bulk-progress::-webkit-progress-bar{background:#00a0b619;border-radius:10px}
    .zaycev-bulk-progress::-webkit-progress-value{background:linear-gradient(90deg,#00a0b6,#9e71ee);border-radius:10px;transition:width .35s ease}
    .zaycev-bulk-progress::-moz-progress-bar{background:linear-gradient(90deg,#00a0b6,#9e71ee);border-radius:10px}
    .zaycev-bulk-tracks{flex:1 0 100%;min-height:34px;display:flex;flex-wrap:wrap;gap:8px;overflow:hidden}
    .zaycev-bulk-track{max-width:100%;box-sizing:border-box;padding:5px 10px;border-radius:20px;background:#00a0b617;color:inherit;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;animation:zaycev-pop 4s both}
    @keyframes zaycev-pop{0%{opacity:0;transform:translateY(18px) scale(.9)}12%,78%{opacity:1;transform:translateY(0) scale(1)}100%{opacity:0;transform:translateY(-12px) scale(.97)}}
    @keyframes zaycev-pulse{to{opacity:.35}}
    @media(prefers-reduced-motion:reduce){.zaycev-bulk-track,.zaycev-download-button[aria-busy="true"] svg{animation:none}.zaycev-download-button{transition:none!important}.zaycev-download-button:hover{transform:none}}
  `;
  document.head.append(style);
  function styleDownloadButton(button) {
    button.classList.add('zaycev-download-button');
    if (!button.querySelector('[data-zaycev-icon]')) button.innerHTML = downloadIcon;
  }
  // Браузер сам выбирает текст стандартного предупреждения о закрытии.
  function warnBeforeUnload(event) {
    event.preventDefault();
    event.returnValue = '';
  }
  function updateUnloadWarning() {
    window.removeEventListener('beforeunload', warnBeforeUnload);
    if (bulkJob || singleDownloads) window.addEventListener('beforeunload', warnBeforeUnload);
  }
  function setProgressTitle(job, progress) {
    job.title = `🎵 ${progress} — ${job.originalTitle}`;
    document.title = job.title;
  }
  // Плеер сайта тоже может менять заголовок при переключении композиции.
  new MutationObserver(() => {
    if (bulkJob?.title && document.title !== bulkJob.title) document.title = bulkJob.title;
  }).observe(document.head, { childList: true, subtree: true, characterData: true });
  function httpError(status) {
    return Object.assign(new Error(`Сервер ответил HTTP ${status}`), { status });
  }

  async function api(path, body) {
    const response = await fetch(`/api/external/${path.startsWith('pages/') ? path : `track/${path}`}`, {
      method: body ? 'POST' : 'GET',
      credentials: 'include',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw httpError(response.status);
    return response.json();
  }

  function loadAudio(url) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'cdndl.zaycev.net') {
      throw new Error('Сайт изменил адрес аудио. Нужно обновить скрипт.');
    }
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET', url: parsed.href, responseType: 'blob', timeout: 120000,
        onload(result) {
          const blob = result.response;
          if (result.status < 200 || result.status >= 300) {
            reject(httpError(result.status));
          } else if (!blob?.size || /text\/|json|html/i.test(blob.type)) {
            reject(new Error('Аудиосервер не вернул аудиофайл'));
          } else resolve(blob);
        },
        onerror: () => reject(new Error('Не удалось загрузить аудио')),
        ontimeout: () => reject(new Error('Истекло время загрузки аудио')),
        onabort: () => reject(new Error('Загрузка отменена')),
      });
    });
  }

  function loadCover(url) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'cdnimg.zaycev.net') {
      throw new Error('Неизвестный адрес обложки');
    }
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET', url: parsed.href, responseType: 'blob', timeout: 30000,
        onload: async result => {
          try {
            if (result.status < 200 || result.status >= 300) throw httpError(result.status);
            const blob = result.response;
            const bytes = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
            const mime = bytes[0] === 255 && bytes[1] === 216 ? 'image/jpeg'
              : bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71 ? 'image/png' : '';
            if (!mime || !blob.size) throw new Error('Сервер не вернул JPEG/PNG обложку');
            resolve({ blob, mime });
          } catch (error) { reject(error); }
        },
        onerror: () => reject(new Error('Не удалось загрузить обложку')),
        ontimeout: () => reject(new Error('Истекло время загрузки обложки')),
      });
    });
  }

  async function bestCover(metadata) {
    const url = metadata.bigImageJpg || metadata.imageJpg;
    if (!url) return null;
    const original = new URL('original.jpg', url).href;
    if (!coverCache.has(original)) {
      const task = (async () => {
        try { return await loadCover(original); }
        catch (error) {
          // Отсутствие оригинала — единственная причина пробовать меньший размер.
          if (![404, 410].includes(error.status)) throw error;
          return loadCover(url);
        }
      })();
      coverCache.set(original, task);
      // Ограничиваем память при больших каталогах.
      if (coverCache.size > 12) coverCache.delete(coverCache.keys().next().value);
      task.catch(() => { if (coverCache.get(original) === task) coverCache.delete(original); });
    }
    return coverCache.get(original);
  }

  const ascii = text => Uint8Array.from(text, char => char.charCodeAt(0));
  function integerBytes(value, syncSafe = false) {
    return syncSafe
      ? Uint8Array.of((value >>> 21) & 127, (value >>> 14) & 127, (value >>> 7) & 127, value & 127)
      : Uint8Array.of(value >>> 24, value >>> 16, value >>> 8, value);
  }
  function readInteger(bytes, offset, syncSafe = false) {
    let value = 0;
    for (let i = 0; i < 4; i++) value = value * (syncSafe ? 128 : 256) + bytes[offset + i];
    return value;
  }
  function unicodeText(text) {
    const bytes = new Uint8Array(3 + text.length * 2);
    bytes.set([1, 255, 254]); // UTF-16 LE с BOM, включая кириллицу.
    for (let i = 0; i < text.length; i++) {
      bytes[3 + i * 2] = text.charCodeAt(i) & 255;
      bytes[4 + i * 2] = text.charCodeAt(i) >>> 8;
    }
    return bytes;
  }

  async function tagMp3(blob, metadata, cover) {
    const first = new Uint8Array(await blob.slice(0, 10).arrayBuffer());
    let version = 3, offset = 0;
    const frames = [];
    const replaced = new Set(['TIT2', 'TPE1', ...(cover ? ['APIC'] : [])]);
    if (String.fromCharCode(...first.slice(0, 3)) === 'ID3') {
      version = first[3];
      if (![3, 4].includes(version) || first[5] !== 0) {
        throw new Error('Нестандартные ID3-теги: файл не изменён, скачивание отменено');
      }
      const size = readInteger(first, 6, true);
      offset = 10 + size;
      if (offset > blob.size) throw new Error('Повреждённый ID3-заголовок');
      const old = new Uint8Array(await blob.slice(10, offset).arrayBuffer());
      for (let pos = 0; pos + 10 <= old.length;) {
        if (old[pos] === 0) break;
        const name = String.fromCharCode(...old.slice(pos, pos + 4));
        const length = readInteger(old, pos + 4, version === 4);
        const end = pos + 10 + length;
        if (!/^[A-Z0-9]{4}$/.test(name) || end > old.length) throw new Error('Повреждённые ID3-фреймы');
        if (!replaced.has(name)) frames.push(old.slice(pos, end));
        pos = end;
      }
    } else if (!(first[0] === 255 && (first[1] & 224) === 224)) {
      throw new Error('Этот формат аудио пока не поддерживает запись тегов');
    }
    function frame(name, payload) {
      frames.push(new Blob([ascii(name), integerBytes(payload.size, version === 4), Uint8Array.of(0, 0), payload]));
    }
    frame('TIT2', new Blob([unicodeText(metadata.track)]));
    frame('TPE1', new Blob([unicodeText(metadata.artistName)]));
    if (cover) frame('APIC', new Blob([
      Uint8Array.of(0), ascii(cover.mime), Uint8Array.of(0, 3, 0), cover.blob,
    ]));
    const body = new Blob(frames);
    if (body.size > 0x0fffffff) throw new Error('Слишком большой ID3-тег');
    return new Blob([ascii('ID3'), Uint8Array.of(version, 0, 0), integerBytes(body.size, true), body, blob.slice(offset)], { type: 'audio/mpeg' });
  }

  async function downloadTrack(id, title, job) {
    const check = () => { if (job?.stop) throw new Error('Очередь остановлена'); };
    check();
    const info = await api('filezmeta', { trackIds: [id], subscription: false });
    check();
    const track = info.tracks?.find(item => Number(item.id) === id);
    if (!track?.streaming) throw new Error('Сайт не разрешает прослушивание этого трека');
    const play = await api(`play/${encodeURIComponent(track.streaming)}`);
    check();
    if (!play.url) throw new Error('Сайт не выдал ссылку на аудио');
    if (track.isPreview || play.isPreview) throw new Error('Доступен только фрагмент трека');
    const detail = await api(`pages/track?id=${id}`);
    check();
    const metadata = detail.info;
    if (!metadata?.artistName || !metadata?.track) throw new Error('Сайт не выдал название и исполнителя');
    const cover = await bestCover(metadata);
    check();
    let blob = await loadAudio(play.url);
    check();
    blob = await tagMp3(blob, metadata, cover);
    // Уже начатый запрос завершается, но после остановки файл не сохраняется.
    check();
    const extension = /ogg/i.test(blob.type) ? 'ogg' : /mp4|m4a/i.test(blob.type) ? 'm4a' : /wav/i.test(blob.type) ? 'wav' : 'mp3';
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${title.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 180)}.${extension}`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  async function save(row, button) {
    if (busyButtons.has(button)) return;
    if (bulkJob) {
      alert('Сначала остановите массовое скачивание.');
      return;
    }
    busyButtons.add(button);
    const wasDisabled = button.disabled;
    const previousTitle = button.title;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.title = 'Загрузка аудио, тегов и обложки…';
    singleDownloads++;
    updateUnloadWarning();
    try {
      const link = row.querySelector('[data-qa="track-link"]');
      const id = Number(new URL(link.href).pathname.match(/\/(\d+)\.shtml$/)?.[1]);
      if (!id) throw new Error('Не удалось определить номер трека');
      // Сохраняем название до запросов: плеер может переключиться во время загрузки.
      const title = link.title || `${row.querySelector('[data-qa="artist-link"]')?.textContent?.trim() || 'Исполнитель'} - ${link.textContent.trim()}`;
      await downloadTrack(id, title);
    } catch (error) {
      console.error('[Zaycev download]', error);
      alert(`Не удалось скачать трек: ${error.message}`);
    } finally {
      singleDownloads--;
      updateUnloadWarning();
      busyButtons.delete(button);
      button.disabled = wasDisabled;
      button.removeAttribute('aria-busy');
      button.title = previousTitle;
    }
  }

  function nativeDownloadRow(button) {
    const row = button.closest('[data-qa="track"], [data-qa="track track-is-banned"]');
    if (row) return row;
    const player = button.closest('[data-qa="player"]');
    if (player) return player.querySelector('[data-qa="player-info"]');
    // Другие представления сайта: ищем ближайший блок ровно с одним треком.
    for (let parent = button.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      const links = parent.querySelectorAll('[data-qa="track-link"]');
      if (links.length === 1) return parent;
      if (links.length > 1) break;
    }
    return null;
  }

  // Capture перехватывает клик до обработчиков React, в том числе у новых кнопок.
  window.addEventListener('click', event => {
    const button = event.target instanceof Element
      ? event.target.closest('[data-qa="track-download"]') : null;
    if (!button) return;
    const row = nativeDownloadRow(button);
    if (!row?.querySelector('[data-qa="track-link"]')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void save(row, button);
  }, true);

  function bulkPanel() {
    const artistId = location.pathname.match(/^\/artist\/(\d+)\.shtml$/)?.[1];
    const old = document.querySelector('[data-zaycev-bulk]');
    if (old?.dataset.artistId !== artistId) old?.remove();
    if (!artistId || document.querySelector('[data-zaycev-bulk]')) return;
    const heading = document.querySelector('h1');
    if (!heading) return;
    const panel = document.createElement('div');
    panel.setAttribute('data-zaycev-bulk', '');
    panel.dataset.artistId = artistId;
    const start = document.createElement('button');
    start.textContent = '🎧 Скачать все треки исполнителя';
    const count = document.createElement('select');
    for (const n of [1, 2, 3]) count.add(new Option(`${n} одновременно`, String(n)));
    const stop = document.createElement('button');
    stop.textContent = 'Остановить';
    stop.disabled = true;
    const status = document.createElement('span');
    status.className = 'zaycev-bulk-status';
    status.setAttribute('role', 'status');
    status.textContent = '🎶 Соберём музыку с обложками в твою коллекцию';
    const progress = document.createElement('progress');
    progress.className = 'zaycev-bulk-progress';
    progress.max = 1;
    progress.value = 0;
    progress.setAttribute('aria-label', 'Прогресс обработки треков');
    const bubbles = document.createElement('div');
    bubbles.className = 'zaycev-bulk-tracks';
    bubbles.setAttribute('aria-hidden', 'true');
    const showBatch = tracks => {
      bubbles.replaceChildren();
      tracks.forEach((track, index) => {
        const pill = document.createElement('span');
        pill.className = 'zaycev-bulk-track';
        pill.textContent = `🚀 ${track.artistName} — ${track.track}`;
        pill.title = pill.textContent;
        pill.style.animationDelay = `${index * 120}ms`;
        bubbles.append(pill);
        setTimeout(() => pill.remove(), 4500 + index * 120);
      });
    };
    const completed = new Set();
    stop.onclick = () => {
      if (!bulkJob || bulkJob.stop) return;
      if (!window.confirm('Остановить скачивание треков? Уже сохранённые файлы останутся, очередь можно будет продолжить.')) return;
      bulkJob.stop = true;
      stop.disabled = true;
      status.textContent = 'Остановка — ожидаем текущие запросы…';
    };
    start.onclick = async () => {
      if (bulkJob) return;
      const job = { stop: false, originalTitle: document.title, title: '' };
      bulkJob = job;
      updateUnloadWarning();
      setProgressTitle(job, 'собираем список…');
      status.title = '';
      progress.removeAttribute('value');
      bubbles.replaceChildren();
      start.disabled = count.disabled = true;
      stop.disabled = false;
      let saved = 0, failed = 0, skipped = 0;
      const errors = [];
      try {
        const tracks = new Map();
        // Обычная пагинация сайта, без увеличения размера страницы.
        for (let page = 1, pages = 1; page <= pages && !job.stop; page++) {
          status.textContent = `🔎 Собираем плейлист: страница ${page} из ${pages}`;
          const data = await api(`pages/artist/${artistId}/tracks?page=${page}&sort=popularity&limit=10`);
          if (!Array.isArray(data.list) || !data.info) throw new Error('Изменился формат списка треков');
          pages = Number(data.pagesCount) || 1;
          setProgressTitle(job, `0/${Number(data.totalCount) || '?'}`);
          for (const id of data.list) {
            const track = data.info[id];
            if (!track) throw new Error(`Нет информации о треке ${id}`);
            tracks.set(Number(id), track);
          }
          if (page < pages) await sleep(1500);
        }
        const queue = [...tracks.values()].filter(track => {
          if (completed.has(Number(track.id))) return false;
          if (!track.playbackEnabled || track.isPreview || track.rejected) { skipped++; return false; }
          return true;
        });
        const parallel = Number(count.value);
        const update = () => {
          status.textContent = `🎵 В коллекцию: ${saved}/${queue.length} · Ошибок: ${failed} · Пропущено: ${skipped}`;
          progress.max = Math.max(1, queue.length);
          progress.value = queue.length ? saved + failed : 1;
          progress.setAttribute('aria-valuetext', `Обработано ${saved + failed} из ${queue.length}; передано браузеру ${saved}`);
          setProgressTitle(job, `${saved}/${queue.length}`);
        };
        update();
        for (let i = 0; i < queue.length && !job.stop; i += parallel) {
          update();
          const batch = queue.slice(i, i + parallel);
          showBatch(batch);
          await Promise.all(batch.map(async track => {
            try {
              await downloadTrack(Number(track.id), `${track.artistName} - ${track.track}`, job);
              completed.add(Number(track.id));
              saved++;
            } catch (error) {
              if (!job.stop) { failed++; errors.push(`${track.track}: ${error.message}`); }
              if ([401, 403, 429].includes(error.status)) {
                job.stop = true;
                errors.push(`Очередь остановлена: HTTP ${error.status}. Повторных запросов не будет.`);
              }
            }
            update();
          }));
          // Пауза между партиями, никаких автоматических повторов ошибок.
          if (i + parallel < queue.length && !job.stop) await sleep(5000);
        }
        update();
        status.textContent += job.stop ? ' · ⏸ Очередь остановлена' : failed ? ' · 🏁 Завершено с ошибками' : ' · 🎉 Готово!';
        if (errors.length) {
          console.warn('[Zaycev bulk]', errors);
          status.title = errors.join('\n');
          status.textContent += `; ${errors[0]}`;
        }
      } catch (error) {
        status.textContent = `Очередь остановлена: ${error.message}`;
        if (!progress.hasAttribute('value')) progress.value = 0;
      } finally {
        bulkJob = null;
        document.title = job.originalTitle;
        updateUnloadWarning();
        start.disabled = count.disabled = false;
        stop.disabled = true;
        start.textContent = '🎧 Скачать оставшиеся треки';
      }
    };
    panel.append(start, count, stop, status, progress, bubbles);
    heading.parentElement.insertAdjacentElement('afterend', panel);
  }

  function scan() {
    bulkPanel();
    const nativeButtons = [...document.querySelectorAll('[data-qa="track-download"]')];
    nativeButtons.forEach(styleDownloadButton);
    document.querySelectorAll('[data-qa="track"], [data-qa="track track-is-banned"], [data-qa="player-info"]').forEach(row => {
      const isPlayer = row.matches('[data-qa="player-info"]');
      const playerBar = isPlayer ? row.parentElement : null;
      const playlistButton = playerBar?.querySelector('[data-qa="player-playlist"]');
      const playerControls = playlistButton?.parentElement;
      const target = isPlayer ? playerControls || playerBar || row
        : row.querySelector('[data-qa="track-duration"]')?.parentElement || row;
      const existing = isPlayer
        ? playerBar?.querySelector(`[${marker}="player"]`) || row.querySelector(`[${marker}]`)
        : row.querySelector(`[${marker}]`);
      // Штатная кнопка плеера может находиться рядом с player-info, а не внутри.
      if (row.querySelector('[data-qa="track-download"]') ||
          (isPlayer && nativeButtons.some(button => nativeDownloadRow(button) === row))) {
        existing?.remove();
        return;
      }
      if (existing) {
        if (isPlayer) existing.setAttribute(marker, 'player');
        if (playlistButton) {
          if (existing.nextElementSibling !== playlistButton) target.insertBefore(existing, playlistButton);
        } else if (existing.parentElement !== target) target.append(existing);
        return;
      }
      if (!row.querySelector('[data-qa="track-link"]')) return;
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute(marker, isPlayer ? 'player' : '');
      button.title = isPlayer ? 'Скачать текущий трек' : 'Скачать аудио для прослушивания';
      button.setAttribute('aria-label', button.title);
      styleDownloadButton(button);
      button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        const currentRow = isPlayer
          ? button.closest('[data-qa="player"]')?.querySelector('[data-qa="player-info"]') || row
          : row;
        void save(currentRow, button);
      });
      if (playlistButton) target.insertBefore(button, playlistButton);
      else target.append(button);
    });
  }

  let scheduled = false;
  new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => { scheduled = false; scan(); }, 150);
  }).observe(document.body, {
    childList: true, subtree: true, attributes: true, attributeFilter: ['href'],
  });
  scan();
})();
