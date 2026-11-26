// ============================================================
// 第 1 關：旅遊地圖
// 兩個人的頭貼坐在飛機上，從家飛到每個去過的地方，
// 抵達後用「限時動態」風格的幻燈片播放照片與影片。
//
// 地圖是 world.svg（麥卡托投影，寬 2000 單位）。
// 所有東西都放在「世界座標」裡，鏡頭 camera = { cx, cy, z } 決定畫面看哪裡、放大多少。
// ============================================================
window.Stage1 = (() => {
  const WORLD_W = 2000;
  const LEG_MAX_ZOOM = 5;     // 飛行時最多放大到幾倍
  const ARRIVE_ZOOM = 7;      // 降落時拉近到幾倍
  const VIDEO_EXT = /\.(mp4|mov|webm|m4v)(\?|$)/i;

  // ---------- 小工具 ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const easeOut = (t) => 1 - Math.pow(1 - t, 3);
  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // 經緯度 → 世界座標（麥卡托）
  function project(lat, lng) {
    const phi = (clamp(lat, -84, 84) * Math.PI) / 180;
    return {
      x: ((lng + 180) / 360) * WORLD_W,
      y: WORLD_W / 2 - (WORLD_W / (2 * Math.PI)) * Math.log(Math.tan(Math.PI / 4 + phi / 2)),
    };
  }

  // 每幀呼叫 fn(t)，t 從 0 跑到 1
  function tween(ms, fn, ease = easeInOut) {
    return new Promise((resolve) => {
      const start = performance.now();
      function frame(now) {
        const t = clamp((now - start) / ms, 0, 1);
        fn(ease(t), t);
        if (t < 1) requestAnimationFrame(frame);
        else resolve();
      }
      requestAnimationFrame(frame);
    });
  }

  // 二次貝茲曲線（飛行路線是一條往上拱的弧線）
  function bezier(p0, p1, p2, t) {
    const u = 1 - t;
    return { x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x, y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y };
  }
  function bezierTangent(p0, p1, p2, t) {
    return { x: 2 * (1 - t) * (p1.x - p0.x) + 2 * t * (p2.x - p1.x), y: 2 * (1 - t) * (p1.y - p0.y) + 2 * t * (p2.y - p1.y) };
  }
  function arcControl(a, b) {
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    let nx = -dy / len, ny = dx / len;
    if (ny > 0) { nx = -nx; ny = -ny; } // 一律往北（畫面上方）拱
    const bend = len * 0.22;
    return { x: mx + nx * bend, y: my + ny * bend };
  }

  // 頭貼：圖片載入失敗就顯示表情符號
  function avatarHtml(src, fallback) {
    return `<img src="${escapeHtml(src)}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('span'),{textContent:'${fallback}'}))">`;
  }

  // 飛機（面向右邊），兩個窗戶放兩個人的頭貼
  function planeHtml(cfg) {
    return `
      <div class="plane-park"><div class="plane-tilt"><div class="plane-flip"><div class="plane-bob">
        <svg viewBox="0 0 200 100" aria-hidden="true">
          <path d="M30 40 L14 10 H36 L58 40Z" fill="#ff8fab" stroke="#e4527f" stroke-width="3" stroke-linejoin="round"/>
          <path d="M28 38 H150 C176 38 194 47 194 55 C194 63 176 72 150 72 H40 C27 72 18 63 18 55 C18 46 22 38 28 38Z"
                fill="#fff" stroke="#e4527f" stroke-width="3"/>
          <path d="M166 43 C178 44 187 50 189 55 H166Z" fill="#9ad7f5" stroke="#e4527f" stroke-width="2" stroke-linejoin="round"/>
          <path d="M40 64 H160" stroke="#ffc2d1" stroke-width="4" stroke-linecap="round"/>
          <path d="M84 62 H118 L96 94 H80Z" fill="#ff8fab" stroke="#e4527f" stroke-width="3" stroke-linejoin="round"/>
          <path d="M20 47 L6 44 M20 55 L2 55 M20 63 L6 66" stroke="#fff" stroke-width="3" stroke-linecap="round" opacity=".9"/>
        </svg>
        <div class="window w1">${avatarHtml(cfg.avatars?.me, '🙂')}</div>
        <div class="window w2">${avatarHtml(cfg.avatars?.her, '😊')}</div>
      </div></div></div></div>`;
  }

  // ============================================================
  // 幻燈片：回傳 Promise，按「繼續」後 resolve
  // ============================================================
  function openSlideshow(trip, ctx, { finishLabel }) {
    const cfg = ctx.cfg;
    const media = trip.media || [];
    const root = el('div', 'slideshow');
    root.innerHTML = `
      <div class="ss-bg"></div>
      <div class="ss-top">
        <div class="ss-bars">${media.map(() => '<i><b></b></i>').join('')}</div>
        <div class="ss-head">
          <span class="ss-flag">${escapeHtml(trip.flag || '📍')}</span>
          <div><div class="ss-title">${escapeHtml(trip.title)}</div>${trip.date ? `<div class="ss-date">${escapeHtml(trip.date)}</div>` : ''}</div>
          <button class="ss-skip">跳過 ⏭</button>
        </div>
      </div>
      <div class="ss-tap left"></div><div class="ss-tap right"></div>
      <div class="ss-stage"></div>
      <div class="ss-caption"></div>
      <div class="ss-bottom"></div>`;
    document.body.appendChild(root);

    const $ = (s) => root.querySelector(s);
    const bars = [...root.querySelectorAll('.ss-bars b')];
    const stage = $('.ss-stage'), caption = $('.ss-caption'), bottom = $('.ss-bottom'), bg = $('.ss-bg');
    let index = -1, raf = 0, video = null, resolveDone;
    const done = new Promise((r) => (resolveDone = r));

    function stopCurrent() {
      cancelAnimationFrame(raf);
      if (video) { video.pause(); video.removeAttribute('src'); video.load(); video = null; }
      ctx.music.duck(false);
    }
    function setBars(i, frac) {
      bars.forEach((b, k) => (b.style.width = k < i ? '100%' : k === i ? `${frac * 100}%` : '0%'));
    }
    // 照片／找不到檔案：計時自動換下一張
    function runTimer(ms) {
      const start = performance.now();
      const loop = (now) => {
        const f = clamp((now - start) / ms, 0, 1);
        setBars(index, f);
        if (f >= 1) go(index + 1);
        else raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
    }
    function showMissing(box, src) {
      box.innerHTML = `<div class="ss-missing"><div class="big">${VIDEO_EXT.test(src) ? '🎬' : '📷'}</div><div>這裡要放${VIDEO_EXT.test(src) ? '影片' : '照片'}</div><code>${escapeHtml(src)}</code></div>`;
      bg.style.backgroundImage = '';
      runTimer(2500);
    }

    function go(i) {
      stopCurrent();
      if (i < 0) i = 0;
      if (i >= media.length) return showEnd();
      index = i;
      const item = media[i];
      const box = el('div', 'ss-media enter');
      stage.replaceChildren(box);
      caption.textContent = item.caption || '';
      caption.classList.remove('enter'); void caption.offsetWidth; caption.classList.add('enter');
      bottom.replaceChildren();
      setBars(i, 0);

      const isVideo = item.type === 'video' || (item.type !== 'image' && VIDEO_EXT.test(item.src));
      if (isVideo) {
        const v = el('video');
        v.playsInline = true; v.setAttribute('playsinline', ''); v.preload = 'auto';
        v.src = item.src;
        video = v;
        box.appendChild(v);
        bg.style.backgroundImage = '';
        v.onerror = () => { if (video === v) { video = null; showMissing(box, item.src); } };
        v.onended = () => { if (video === v) go(index + 1); };
        ctx.music.duck(true);
        v.play().catch(() => {
          // 瀏覽器不允許有聲自動播放 → 先靜音播，給一顆開聲音的按鈕
          v.muted = true;
          v.play().catch(() => {});
          const b = el('button', 'ss-unmute', '🔊 點我開聲音');
          b.onclick = (e) => { e.stopPropagation(); v.muted = false; v.play(); b.remove(); };
          box.appendChild(b);
        });
        const loop = () => {
          if (video !== v) return;
          if (v.duration) setBars(index, v.currentTime / v.duration);
          raf = requestAnimationFrame(loop);
        };
        raf = requestAnimationFrame(loop);
      } else {
        const img = new Image();
        img.alt = item.caption || '';
        img.onload = () => {
          if (index !== i) return;
          box.appendChild(img);
          bg.style.backgroundImage = `url("${item.src}")`;
          runTimer((cfg.slideSeconds || 4.5) * 1000);
        };
        img.onerror = () => { if (index === i) showMissing(box, item.src); };
        img.src = item.src;
      }
    }

    function showEnd() {
      stopCurrent();
      index = media.length;
      setBars(media.length, 0);
      bg.style.backgroundImage = '';
      stage.innerHTML = `<div class="ss-end-card"><div class="emoji">${escapeHtml(trip.flag || '💖')}</div><p>${escapeHtml(trip.title)}<br>回憶播放完畢 💕</p></div>`;
      caption.textContent = '';
      bottom.replaceChildren();
      const again = el('button', 'big-btn ghost', '再看一次');
      again.onclick = () => go(0);
      const next = el('button', 'big-btn', finishLabel);
      next.onclick = close;
      bottom.append(again, next);
    }

    function close() {
      stopCurrent();
      root.classList.add('closing');
      setTimeout(() => { root.remove(); resolveDone(); }, 350);
    }

    $('.ss-tap.left').onclick = () => { if (index > 0 && index < media.length) go(index - 1); };
    $('.ss-tap.right').onclick = () => { if (index < media.length) go(index + 1); };
    $('.ss-skip').onclick = () => { if (index < media.length) showEnd(); };

    // 左右滑動也能換張
    let sx = null;
    root.addEventListener('touchstart', (e) => (sx = e.touches[0].clientX), { passive: true });
    root.addEventListener('touchend', (e) => {
      if (sx == null) return;
      const dx = e.changedTouches[0].clientX - sx;
      sx = null;
      if (Math.abs(dx) < 50 || index >= media.length) return;
      go(dx < 0 ? index + 1 : Math.max(0, index - 1));
    });

    if (media.length) go(0); else showEnd();
    return done;
  }

  // ============================================================
  // 主流程
  // ============================================================
  async function run(container, ctx) {
    const cfg = ctx.cfg;
    const trips = cfg.trips || [];
    const home = { ...cfg.home, ...project(cfg.home.lat, cfg.home.lng) };
    const stops = trips.map((t) => ({ ...t, ...project(t.lat, t.lng) }));

    // ---------- 建立畫面 ----------
    const root = el('div', 'map-stage');
    const world = el('div', 'map-world');
    const mapCopy = el('div', 'map-copy');
    const trailSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    trailSvg.setAttribute('class', 'map-trail');
    const overlay = el('div');
    world.append(mapCopy, trailSvg);
    root.append(world, overlay);
    container.appendChild(root);

    // 載入世界地圖
    try {
      const svgText = await (await fetch('world.svg')).text();
      mapCopy.innerHTML = svgText;
      const svg = mapCopy.querySelector('svg');
      const vb = svg.viewBox.baseVal;
      svg.style.top = `${vb.y}px`;
      svg.style.height = `${vb.height}px`;
      svg.setAttribute('width', vb.width);
      svg.setAttribute('height', vb.height);
    } catch (e) {
      console.warn('地圖載入失敗', e);
    }
    const markCountry = (name, cls) => {
      if (!name) return;
      mapCopy.querySelectorAll(`path[data-name="${CSS.escape(name)}"]`).forEach((p) => p.classList.add(cls));
    };
    // 台灣（家）先塗成暖黃色
    markCountry(cfg.home.country || 'Taiwan', 'home');

    // ---------- 鏡頭 ----------
    const cam = { cx: home.x, cy: home.y, z: 1 };
    const things = []; // 地圖上固定大小的東西：{ el, x, y }

    function viewSize() {
      return { w: root.clientWidth, h: root.clientHeight };
    }
    function render() {
      const { w, h } = viewSize();
      world.style.transform = `translate(${w / 2 - cam.cx * cam.z}px, ${h / 2 - cam.cy * cam.z}px) scale(${cam.z})`;
      const inv = 1 / cam.z;
      // 虛線粗細要跟著縮放調整（直接設在每條線上，瀏覽器才會重畫）
      for (const line of trailSvg.children) {
        line.setAttribute('stroke-width', 3.5 * inv);
        line.setAttribute('stroke-dasharray', `${2 * inv} ${9 * inv}`);
      }
      for (const t of things) t.el.style.transform = `translate(${t.x}px, ${t.y}px) scale(${inv})`;
    }
    function addThing(node, x, y) {
      const wrap = el('div', 'map-thing');
      wrap.appendChild(node);
      world.appendChild(wrap);
      const t = { el: wrap, x, y };
      things.push(t);
      render();
      return t;
    }
    function removeThing(t) {
      t.el.remove();
      things.splice(things.indexOf(t), 1);
    }

    // 算出能把這些點都框進畫面的鏡頭
    function fit(points, maxZoom, padBottom = 120) {
      const { w, h } = viewSize();
      const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
      const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
      const padX = 70, padTop = 140; // 上面留給標題與飛機、下面（padBottom）留給按鈕或卡片
      const z = clamp(Math.min((w - padX * 2) / Math.max(maxX - minX, 1), (h - padTop - padBottom) / Math.max(maxY - minY, 1)), 0.15, maxZoom);
      // 因為上下留白不一樣，中心點要往下修一點
      const cy = (minY + maxY) / 2 - (padTop - padBottom) / 2 / z;
      return { cx: (minX + maxX) / 2, cy, z };
    }
    async function moveCamera(target, ms = 1300) {
      const from = { ...cam };
      world.classList.add('moving');
      await tween(ms, (t) => {
        cam.cx = lerp(from.cx, target.cx, t);
        cam.cy = lerp(from.cy, target.cy, t);
        cam.z = Math.exp(lerp(Math.log(from.z), Math.log(target.z), t));
        render();
      });
      world.classList.remove('moving'); // 停下來後讓地圖重新畫清楚
    }
    const onResize = () => render();
    window.addEventListener('resize', onResize);

    // ---------- 圖釘 ----------
    function addPin(stop, { isHome = false, onClick, short = false } = {}) {
      const pin = el(onClick ? 'button' : 'div', `pin${isHome ? ' home' : ''}${short ? ' short' : ''}`);
      // 縮短版標籤：「日本・東京」只顯示「東京」
      const label = isHome ? stop.name : short ? String(stop.title).split('・').pop() : stop.title;
      pin.innerHTML = `<div class="pin-head"><span>${escapeHtml(isHome ? '🏠' : stop.flag || '📍')}</span></div><div class="pin-label">${escapeHtml(label)}</div>`;
      if (onClick) pin.onclick = onClick;
      return addThing(pin, stop.x, stop.y);
    }

    // ---------- 飛機 ----------
    const planeEl = el('div', 'plane', planeHtml(cfg));
    const plane = addThing(planeEl, home.x, home.y);
    plane.el.classList.add('top');
    planeEl.classList.add('landed');
    const tilt = planeEl.querySelector('.plane-tilt');
    function aimPlane(dx, dy) {
      const left = dx < 0;
      planeEl.classList.toggle('flip', left);
      let a = Math.atan2(dy, dx) - (left ? Math.PI : 0);
      a = Math.atan2(Math.sin(a), Math.cos(a));
      tilt.style.transform = `rotate(${clamp(a, -0.6, 0.6)}rad)`;
    }

    // 飛行：沿弧線移動，後面留下虛線和小愛心
    async function fly(from, to, { trail = true, ms } = {}) {
      const ctrl = arcControl(from, to);
      const dist = Math.hypot(to.x - from.x, to.y - from.y);
      const duration = ms || clamp(dist * 40, 2200, 4200);
      let line = null;
      if (trail) {
        line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
        trailSvg.appendChild(line);
      }
      const pts = [];
      let lastPuff = 0;
      planeEl.classList.remove('landed');
      tilt.style.transition = 'none';
      await tween(duration, (t, raw) => {
        const p = bezier(from, ctrl, to, t);
        const d = bezierTangent(from, ctrl, to, Math.min(t, 0.999));
        plane.x = p.x; plane.y = p.y;
        aimPlane(d.x, d.y);
        if (line) {
          pts.push(`${p.x.toFixed(1)},${p.y.toFixed(1)}`);
          line.setAttribute('points', pts.join(' '));
        }
        const now = performance.now();
        if (trail && now - lastPuff > 260 && raw < 0.95) {
          lastPuff = now;
          const puff = addThing(el('div', 'puff', '💗'), p.x, p.y);
          setTimeout(() => removeThing(puff), 1600);
        }
        render();
      });
      tilt.style.transition = '';
      tilt.style.transform = 'rotate(0rad)';
      planeEl.classList.add('landed');
    }

    function banner(html, ms) {
      const b = el('div', 'map-banner', html);
      overlay.appendChild(b);
      if (ms) setTimeout(() => b.remove(), ms);
      return b;
    }
    function bottomButton(label) {
      return new Promise((resolve) => {
        const bar = el('div', 'map-bottom');
        const btn = el('button', 'big-btn', label);
        btn.onclick = () => { bar.remove(); resolve(); };
        bar.appendChild(btn);
        overlay.appendChild(bar);
      });
    }

    // ---------- 開場：看到全部的目的地 ----------
    // 卡片蓋住畫面下方，鏡頭要避開卡片的高度
    const cardRoom = (card) => card.querySelector('.stage-card').offsetHeight + 40;
    addPin(home, { isHome: true });
    const intro = el('div', 'map-ending');
    intro.innerHTML = `<div class="stage-card">
        <div class="stage-no">STAGE 1</div>
        <h2>我們的旅行地圖 ✈️</h2>
        <p>搭上我們的愛心航班\n回到一起去過的 ${stops.length} 個地方</p>
        <button class="big-btn">起飛！</button>
      </div>`;
    overlay.appendChild(intro);
    const introView = fit([home, ...stops], LEG_MAX_ZOOM, cardRoom(intro));
    Object.assign(cam, introView, { z: introView.z * 0.6 }); // 先拉遠一點，再推近
    render();
    moveCamera(introView, 1600);
    await new Promise((r) => (intro.querySelector('button').onclick = r));
    intro.remove();

    // ---------- 一站一站飛 ----------
    for (let i = 0; i < stops.length; i++) {
      const stop = stops[i];
      const from = { x: plane.x, y: plane.y };
      await moveCamera(fit([from, stop, arcControl(from, stop)], LEG_MAX_ZOOM), 1200);
      await fly(from, stop);

      addPin(stop);
      markCountry(stop.country, 'visited');
      await moveCamera({ cx: stop.x, cy: stop.y - 30 / ARRIVE_ZOOM, z: Math.max(cam.z, ARRIVE_ZOOM) }, 1100);
      const b = banner(`<small>第 ${i + 1} 站・抵達</small><b>${escapeHtml(stop.flag || '')} ${escapeHtml(stop.title)}</b>${stop.date ? `<span>${escapeHtml(stop.date)}</span>` : ''}`);
      await sleep(1600);
      b.remove();

      const last = i === stops.length - 1;
      await openSlideshow(stop, ctx, { finishLabel: last ? '回家囉 🏠' : '下一站 ✈️' });

      // 每趟旅行結束都先飛回家（快速、不留虛線）
      await moveCamera(fit([stop, home, arcControl(stop, home)], LEG_MAX_ZOOM), 900);
      await fly(stop, home, { trail: false, ms: 1500 });
    }

    // ---------- 結尾：看到全部足跡，圖釘可以點來重看 ----------
    things.filter((t) => t !== plane && t.el.querySelector('.pin')).forEach((t) => removeThing(t));
    addPin(home, { isHome: true });
    stops.forEach((s) => addPin(s, { short: true, onClick: () => openSlideshow(s, ctx, { finishLabel: '關閉' }) }));
    const ending = el('div', 'map-ending');
    ending.innerHTML = `<div class="stage-card">
        <h2>🗺️ 旅程完成！</h2>
        <p>${escapeHtml(cfg.mapEnding || '')}\n<small>（點地圖上的圖釘可以再看一次）</small></p>
        <button class="big-btn">前往第 2 關 →</button>
      </div>`;
    overlay.appendChild(ending);
    await moveCamera(fit([home, ...stops], LEG_MAX_ZOOM, cardRoom(ending)), 1600);
    await new Promise((r) => (ending.querySelector('button').onclick = r));

    window.removeEventListener('resize', onResize);
    root.remove();
  }

  return { run, project, openSlideshow };
})();
