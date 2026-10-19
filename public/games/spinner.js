// ============================================================
// games/spinner.js － 「陀螺大戰」遊戲（S0：圓盤互撞，把別人撞出平台）
//   - 個人混戰；共兩回合：
//       第 1 回合 計時賽：被撞出平台 5 秒後復活，計算擊殺數
//       第 2 回合 淘汰賽：不復活，平台慢慢縮小，剩最後 3 位就結束（人少時打到只剩 1 位）
//   - 最終名次：第 2 回合留下來的人排前面（依第 1 回合擊殺數），其餘依淘汰順序（越晚淘汰名次越高）
//   - S0 先用搖桿移動（手機端沿用足球的浮動搖桿）；之後 S1 才接手機陀螺儀；暫時沒有轉速與衝撞
//   - 物理全部在 host 端算（固定 60Hz）；角色大頭放在圓盤中間
//   - 和大廳（host.js）的溝通只透過 Hub 與下面回傳的介面
// 階段 phase：countdown → playing → roundEnd（第 1 回合結束）→ countdown → playing → result
// ============================================================
const SpinnerGame = (() => {
  const { players, $, escapeHtml, setPhase, sendStatus } = Hub;

  // ---------- 平台（畫布 1280x720，俯視）----------
  const AX = 640, AY = 390;            // 平台中心
  const ARENA_R = 300;                 // 平台起始半徑

  // ---------- 規則 ----------
  const MAX_PLAYERS = 12;              // 最多上場人數（衣服顏色也只有 12 色）
  const ROUND1_SECONDS = 90;           // 第 1 回合（計時賽）長度
  const RESPAWN_MS = 5000;             // 第 1 回合：被撞出去多久後復活
  const SPAWN_PROTECT_MS = 2000;       // 復活後的無敵時間（不會被撞、也不會撞人）
  const KILL_CREDIT_MS = 3000;         // 被誰撞最後一下、幾秒內掉下去，就算那個人的擊殺
  const FINALISTS = 3;                 // 第 2 回合剩幾位就結束（參賽 3 人以下則打到剩 1 位）
  const SHRINK_START_S = 15;           // 第 2 回合開打後幾秒開始縮圈
  const SHRINK_SECONDS = 60;           // 縮圈要花多久
  const SHRINK_MIN_RATIO = 0.4;        // 最小縮到原本的幾倍
  const ROUND2_MAX_S = 150;            // 保險：第 2 回合最久打多久
  const COUNTDOWN_SECONDS = 3;
  const ROUND_END_AUTO_MS = 10000;     // 第 1 回合結束後，自動開始第 2 回合的等待時間
  const FORFEIT_GRACE_MS = 15000;      // 所有人都離線超過這麼久就回大廳

  // ---------- 手感數值（要調整就改這裡）----------
  const DISC_R = 30;                   // 圓盤半徑
  const ACCEL = 1500;                  // 推到底時的加速度（像素/秒²）
  const DAMP = 2.0;                    // 滑行阻力（每秒；越小越滑）
  const MAX_SPEED = 450;
  const RESTITUTION = 0.9;             // 圓盤互撞的彈性（1 = 完全彈性）
  const FALL_SECONDS = 0.7;            // 掉出平台後縮小旋轉掉下去的時間
  const INPUT_TIMEOUT_MS = 600;        // 超過這麼久沒收到搖桿更新，就當作放開
  const HEAD_PX = 46;                  // 圓盤中間的大頭顯示大小
  const STEP = 1 / 60;                 // 物理固定步長

  // ---------- 這個遊戲的狀態 ----------
  // 每位玩家的狀態放在 p.spinner（回大廳時清掉）：{ input, kills1, kills2, deaths, eliminated, roundRank, finalRank }
  const S = (p) => p.spinner || (p.spinner = { input: { mx: 0, my: 0, at: 0 }, kills1: 0, kills2: 0, deaths: 0, eliminated: false, roundRank: null, finalRank: null });
  let discs = [];                      // 場上的圓盤（見 newDisc）
  let version = 0;                     // 場上圓盤換了就加一，場景據此重建
  let round = 1;
  let arenaR = ARENA_R;
  let remainingMs = 0;                 // 第 1 回合剩餘時間
  let elapsedMs = 0;                   // 第 2 回合已經過的時間
  let elimOrder = [];                  // 第 2 回合淘汰順序（先淘汰的在前）
  let centerText = '', subText = '';   // 畫面正中間的大字（倒數）與上方小字（回合說明）
  let feed = [];                       // 擊殺訊息 { text, at }
  let hitEvents = [];                  // 撞擊事件（場景播火花、震動）
  let fallEvents = [];                 // 掉下去事件（場景播水花）
  let timers = [];
  let allOfflineSince = 0;
  function clearTimers() { timers.forEach(clearTimeout); timers = []; }
  function later(fn, ms) { timers.push(setTimeout(fn, ms)); }
  const discOf = (p) => discs.find((d) => d.p === p);
  const totalKills = (p) => S(p).kills1 + S(p).kills2;

  function newDisc(p) {
    return { p, x: AX, y: AY, vx: 0, vy: 0, alive: true, falling: false, fallT: 0, respawnAt: 0, ghostUntil: 0, lastHit: null, spin: 0 };
  }

  // ============================================================
  // 開局站位
  // ============================================================
  // 圍著平台排成一圈（離邊緣遠一點），第 1、2 回合開始時都用這個
  function placeRing() {
    discs.forEach((d, i) => {
      const a = (i / discs.length) * Math.PI * 2 - Math.PI / 2, r = ARENA_R * 0.6;
      Object.assign(d, { x: AX + Math.cos(a) * r, y: AY + Math.sin(a) * r, vx: 0, vy: 0, alive: !S(d.p).eliminated, falling: false, fallT: 0, respawnAt: 0, ghostUntil: 0, lastHit: null });
    });
  }
  // 復活位置：在平台中間偏內的範圍隨機挑 24 個點，選離其他人最遠的那個
  function pickSpawn() {
    let best = { x: AX, y: AY, score: -1 };
    for (let k = 0; k < 24; k++) {
      const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * arenaR * 0.55;
      const x = AX + Math.cos(a) * r, y = AY + Math.sin(a) * r;
      let nearest = Infinity;
      for (const d of discs) if (d.alive && !d.falling) nearest = Math.min(nearest, Math.hypot(d.x - x, d.y - y));
      if (nearest > best.score) best = { x, y, score: nearest };
    }
    return best;
  }

  // ============================================================
  // 物理
  // ============================================================
  function stepPhysics(dt) {
    const now = Date.now();
    // 圓盤：搖桿方向 → 加速度；阻力讓它滑行；掉出去的倒數、死掉的復活
    for (const d of discs) {
      if (d.falling) {
        d.fallT += dt;
        d.x += d.vx * dt; d.y += d.vy * dt;                    // 掉下去時繼續往外飛一小段
        if (d.fallT >= FALL_SECONDS) { d.falling = false; d.alive = false; }
        continue;
      }
      if (!d.alive) {
        if (round === 1 && !S(d.p).eliminated && d.respawnAt && now >= d.respawnAt) respawn(d, now);
        continue;
      }
      if (d.p.online) {
        const inp = S(d.p).input;
        let mx = inp.mx, my = inp.my;
        if (now - inp.at > INPUT_TIMEOUT_MS) { mx = 0; my = 0; }
        const mag = Math.hypot(mx, my);
        if (mag > 1) { mx /= mag; my /= mag; }
        d.vx += mx * ACCEL * dt; d.vy += my * ACCEL * dt;
      }
      const drag = Math.exp(-DAMP * dt);
      d.vx *= drag; d.vy *= drag;
      const sp = Math.hypot(d.vx, d.vy);
      if (sp > MAX_SPEED) { d.vx *= MAX_SPEED / sp; d.vy *= MAX_SPEED / sp; }
      d.x += d.vx * dt; d.y += d.vy * dt;
      d.spin += dt * (6 + sp / 40);                              // 圓盤花紋轉動的角度（只是好看）
    }
    // 圓盤互撞：等質量、彈性碰撞；速度快的一方把對方撞得更遠，並記下「最後撞到我的是誰」
    for (let i = 0; i < discs.length; i++) {
      const a = discs[i];
      if (!a.alive || a.falling || !a.p.online || now < a.ghostUntil) continue;
      for (let j = i + 1; j < discs.length; j++) {
        const b = discs[j];
        if (!b.alive || b.falling || !b.p.online || now < b.ghostUntil) continue;
        const dx = b.x - a.x, dy = b.y - a.y, dist = Math.hypot(dx, dy), min = DISC_R * 2;
        if (dist <= 0 || dist >= min) continue;
        const nx = dx / dist, ny = dy / dist, push = (min - dist) / 2;
        a.x -= nx * push; a.y -= ny * push; b.x += nx * push; b.y += ny * push;     // 先分開
        const vrel = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;                       // 沿著連線、互相靠近的速度
        if (vrel > 0) {
          const j2 = ((1 + RESTITUTION) * vrel) / 2;
          a.vx -= j2 * nx; a.vy -= j2 * ny; b.vx += j2 * nx; b.vy += j2 * ny;
          a.lastHit = { id: b.p.id, at: now }; b.lastHit = { id: a.p.id, at: now };
          if (vrel > 80) hitEvents.push({ x: a.x + nx * DISC_R, y: a.y + ny * DISC_R, power: Math.min(1, vrel / 500) });
        }
      }
    }
    // 平台邊緣：圓盤中心超出平台 → 掉下去
    for (const d of discs) {
      if (!d.alive || d.falling) continue;
      if (Math.hypot(d.x - AX, d.y - AY) > arenaR) startFall(d, now);
    }
    tickRound(dt);
  }

  // 掉出平台：記擊殺、第 1 回合安排復活、第 2 回合記淘汰順序
  function startFall(d, now) {
    d.falling = true; d.fallT = 0;
    const out = { x: d.x - AX, y: d.y - AY }, len = Math.hypot(out.x, out.y) || 1;
    d.vx = (out.x / len) * 140; d.vy = (out.y / len) * 140;
    fallEvents.push({ x: d.x, y: d.y });
    S(d.p).deaths++;
    const hitter = d.lastHit && now - d.lastHit.at <= KILL_CREDIT_MS ? players.get(d.lastHit.id) : null;
    if (hitter && hitter !== d.p) {
      S(hitter)[round === 1 ? 'kills1' : 'kills2']++;
      feed.push({ text: `${hitter.name} 撞出了 ${d.p.name}`, at: now });
      sendStatus(hitter);
    } else {
      feed.push({ text: `${d.p.name} 自己掉下去了`, at: now });
    }
    d.lastHit = null;
    if (round === 1) d.respawnAt = now + RESPAWN_MS;
    else { S(d.p).eliminated = true; d.elimAt = now; d.elimDist = Math.hypot(d.x - AX, d.y - AY); elimOrder.push(d); }
    sendStatus(d.p);
  }

  function respawn(d, now) {
    const s = pickSpawn();
    Object.assign(d, { x: s.x, y: s.y, vx: 0, vy: 0, alive: true, falling: false, respawnAt: 0, ghostUntil: now + SPAWN_PROTECT_MS, lastHit: null });
    sendStatus(d.p);
  }

  // ============================================================
  // 回合流程
  // ============================================================
  function aliveCount() { return discs.filter((d) => (d.alive || d.falling) && !S(d.p).eliminated).length; }
  function finalistTarget() { return discs.length >= 4 ? FINALISTS : 1; }

  function tickRound(dt) {
    if (Hub.phase !== 'playing') return;
    if (round === 1) {
      remainingMs -= dt * 1000;
      if (remainingMs <= 0) { remainingMs = 0; endRound1(); }
      return;
    }
    elapsedMs += dt * 1000;
    const t = (elapsedMs / 1000 - SHRINK_START_S) / SHRINK_SECONDS;
    arenaR = ARENA_R * (1 - (1 - SHRINK_MIN_RATIO) * Math.min(1, Math.max(0, t)));
    // 一有人掉出平台就算淘汰（掉下去的動畫還在播也無妨），人數降到目標就立刻結束，不再讓剩下的人互撞
    const stillIn = discs.filter((d) => !S(d.p).eliminated).length;
    if (stillIn <= finalistTarget() || elapsedMs >= ROUND2_MAX_S * 1000) endRound2();
  }

  // 準備開始某一回合：圓盤歸位，3、2、1 倒數
  function beginRound(r) {
    clearTimers();
    round = r; arenaR = ARENA_R; elapsedMs = 0; remainingMs = ROUND1_SECONDS * 1000; elimOrder = r === 2 ? [] : elimOrder;
    if (r === 2) discs.forEach((d) => { S(d.p).eliminated = false; });
    placeRing();
    feed = [];
    subText = r === 1 ? `第 1 回合：計時賽（被撞出去 ${RESPAWN_MS / 1000} 秒後復活，比誰撞得多）` : `第 2 回合：淘汰賽（不復活，平台會縮小，剩最後 ${finalistTarget()} 位）`;
    $('spinnerPanel').classList.add('hidden');
    setPhase('countdown');
    let count = COUNTDOWN_SECONDS;
    centerText = String(count);
    const tick = () => {
      count--;
      if (count > 0) { centerText = String(count); later(tick, 1000); return; }
      centerText = 'GO!';
      setPhase('playing');
      later(() => { if (centerText === 'GO!') centerText = ''; subText = ''; }, 900);
    };
    later(tick, 1000);
  }

  // 第 1 回合結束：依擊殺數排名（同分：死得少的在前）
  function endRound1() {
    clearTimers(); centerText = ''; subText = '';
    if (discs.length < 2) { endRound2(); return; }                 // 只有 1 個人（測試用）：沒有第 2 回合，直接結算
    const ranked = [...discs].sort((a, b) => totalK1(b) - totalK1(a) || S(a.p).deaths - S(b.p).deaths);
    ranked.forEach((d, i) => { S(d.p).roundRank = i + 1; });
    $('spinnerTitle').textContent = '第 1 回合結束';
    $('spinnerSub').textContent = '擊殺王：' + (ranked[0] ? `${ranked[0].p.name}（${S(ranked[0].p).kills1} 殺）` : '—');
    $('spinnerList').classList.toggle('many', ranked.length > 6);
    $('spinnerList').innerHTML = ranked.map((d, i) =>
      `<li><span>${i + 1}. ${escapeHtml(d.p.name)}</span><span>${S(d.p).kills1} 殺　${S(d.p).deaths} 次掉落</span></li>`).join('');
    $('spinnerNextBtn').classList.remove('hidden'); $('spinnerAgainBtn').classList.add('hidden'); $('spinnerLobbyBtn').classList.add('hidden');
    $('spinnerNextBtn').textContent = '開始第 2 回合';
    setPhase('roundEnd');
    later(() => beginRound(2), ROUND_END_AUTO_MS);           // 主持人沒按就自動開始
  }
  const totalK1 = (d) => S(d.p).kills1;

  // 第 2 回合結束：留下來的人在前（依第 1 回合擊殺數），其餘依淘汰順序（越晚淘汰名次越高）
  function endRound2() {
    clearTimers(); centerText = ''; subText = '';
    let survivors = discs.filter((d) => !S(d.p).eliminated).sort((a, b) => S(b.p).kills1 - S(a.p).kills1 || S(b.p).kills2 - S(a.p).kills2);
    let out = [...elimOrder].reverse();
    // 同一瞬間有好幾個人一起掉下去，導致留下的人比目標少：從最後一批掉下去的人裡，挑掉下去時離平台中心最近的補上
    const need = Math.min(finalistTarget(), discs.length) - survivors.length;
    if (need > 0 && elimOrder.length) {
      const lastAt = elimOrder[elimOrder.length - 1].elimAt;
      const promoted = elimOrder.filter((d) => lastAt - d.elimAt < 300).sort((a, b) => a.elimDist - b.elimDist).slice(0, need);
      promoted.forEach((d) => { S(d.p).eliminated = false; });
      survivors = [...survivors, ...promoted].sort((a, b) => S(b.p).kills1 - S(a.p).kills1 || S(b.p).kills2 - S(a.p).kills2);
      out = out.filter((d) => !promoted.includes(d));
    }
    const final = [...survivors, ...out];
    final.forEach((d, i) => { S(d.p).finalRank = i + 1; });
    $('spinnerTitle').textContent = '🏆 比賽結束';
    $('spinnerSub').textContent = `最後 ${survivors.length} 位：${survivors.map((d) => d.p.name).join('、')}`;
    $('spinnerList').classList.toggle('many', final.length > 6);
    $('spinnerList').innerHTML = final.map((d, i) => {
      const left = survivors.includes(d);
      return `<li><span>${i + 1}. ${escapeHtml(d.p.name)}${left ? ' 🏆' : ''}</span><span>${totalKills(d.p)} 殺${left ? '' : '　淘汰'}</span></li>`;
    }).join('');
    $('spinnerNextBtn').classList.add('hidden'); $('spinnerAgainBtn').classList.remove('hidden'); $('spinnerLobbyBtn').classList.remove('hidden');
    setPhase('result');
  }

  // ============================================================
  // 畫面層（Phaser）：平台、圓盤（中間放角色大頭）、擊殺榜與訊息
  // ============================================================
  class SpinnerScene extends Phaser.Scene {
    create() {
      this.acc = 0; this.sprites = []; this.version = -1;
      if (!this.textures.exists('dot')) {
        const dot = this.textures.createCanvas('dot', 8, 8);
        dot.getContext().fillStyle = '#fff'; dot.getContext().fillRect(0, 0, 8, 8); dot.refresh();
      }
      // 平台（畫在固定半徑，縮圈時整個縮放）
      this.pit = this.add.circle(AX, AY, ARENA_R + 70, 0x0a1017).setDepth(0);
      const g = this.add.graphics();
      g.fillStyle(0x2d4256).fillCircle(0, 0, ARENA_R);
      g.lineStyle(3, 0x3d5a78, 0.9);
      for (const k of [0.25, 0.5, 0.75]) g.strokeCircle(0, 0, ARENA_R * k);
      g.lineStyle(2, 0x3d5a78, 0.5);
      for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2; g.lineBetween(Math.cos(a) * 20, Math.sin(a) * 20, Math.cos(a) * ARENA_R, Math.sin(a) * ARENA_R); }
      this.platform = this.add.container(AX, AY, [g]).setDepth(1);
      this.rim = this.add.graphics().setDepth(2);
      // 文字：上方回合資訊、左邊擊殺榜、右邊訊息、中間大字
      const base = { fontSize: '30px', color: '#fff', fontStyle: 'bold', stroke: '#000', strokeThickness: 5 };
      this.titleText = this.add.text(AX, 40, '', base).setOrigin(0.5).setDepth(10);
      this.subTextObj = this.add.text(AX, 80, '', { fontSize: '20px', color: '#fde68a', stroke: '#000', strokeThickness: 4 }).setOrigin(0.5).setDepth(10);
      this.board = Array.from({ length: 7 }, (_, i) => this.add.text(24, 130 + i * 34, '', { fontSize: '22px', color: '#fff', stroke: '#000', strokeThickness: 4 }).setDepth(10));
      this.feedTexts = Array.from({ length: 5 }, (_, i) => this.add.text(1256, 130 + i * 30, '', { fontSize: '20px', color: '#fff', stroke: '#000', strokeThickness: 4 }).setOrigin(1, 0).setDepth(10));
      this.cdText = this.add.text(AX, AY - 10, '', { fontSize: '160px', color: '#fff', fontStyle: 'bold', stroke: '#000', strokeThickness: 12 }).setOrigin(0.5).setDepth(5000);
    }

    burst(x, y, lifespan, config, n) {
      const em = this.add.particles(x, y, 'dot', { ...config, lifespan, quantity: n, emitting: false }).setDepth(4000);
      em.explode(n);
      this.time.delayedCall(lifespan + 200, () => em.destroy());
    }

    // 依場上圓盤重建：圓盤（外圈 = 衣服顏色、花紋、中間是角色大頭）+ 名字 + 陰影
    rebuild() {
      this.sprites.forEach((s) => { s.c.destroy(); s.label.destroy(); s.shadow.destroy(); });
      this.sprites = discs.map((d) => {
        const p = d.p, color = Phaser.Display.Color.HexStringToColor(p.color).color;
        const rim = this.add.graphics();
        rim.fillStyle(color).fillCircle(0, 0, DISC_R).lineStyle(3, 0x111111).strokeCircle(0, 0, DISC_R);
        rim.fillStyle(0x1b2733).fillCircle(0, 0, DISC_R - 6);
        const spin = this.add.graphics();                           // 會轉的花紋
        spin.lineStyle(3, color, 0.55);
        for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2; spin.lineBetween(Math.cos(a) * 12, Math.sin(a) * 12, Math.cos(a) * (DISC_R - 7), Math.sin(a) * (DISC_R - 7)); }
        const center = this.add.circle(0, 0, 22, 0x2a3b4c);
        const head = this.add.image(0, 0, p.photo ? 'head-' + p.id : 'char-' + p.charId).setDisplaySize(HEAD_PX, HEAD_PX);   // 中間放角色大頭（不跟著轉，保持正面）
        const c = this.add.container(d.x, d.y, [rim, spin, center, head]);
        const label = this.add.text(d.x, d.y, p.name, { fontSize: '18px', color: '#fff', stroke: '#000', strokeThickness: 4 }).setOrigin(0.5).setDepth(2000);
        const shadow = this.add.ellipse(d.x, d.y, DISC_R * 2.2, DISC_R * 1.3, 0x000000, 0.35).setDepth(3);
        return { d, c, spin, head, label, shadow };
      });
      this.version = version;
    }

    update(time, delta) {
      if (this.version !== version) this.rebuild();
      // 固定步長物理（只有比賽中才動；畫面卡頓時最多補 6 步）
      if (Hub.phase === 'playing') {
        this.acc = Math.min(this.acc + delta / 1000, STEP * 6);
        while (this.acc >= STEP && Hub.phase === 'playing') { stepPhysics(STEP); this.acc -= STEP; }
      } else this.acc = 0;

      // 撞擊：火花 + 輕微震動；掉下去：水花
      for (const h of hitEvents.splice(0)) {
        this.burst(h.x, h.y, 300, { speed: { min: 60, max: 120 + h.power * 220 }, scale: { start: 0.9, end: 0 }, tint: [0xffffff, 0xfacc15, 0xf97316] }, Math.round(6 + h.power * 10));
        this.cameras.main.shake(70, 0.002 + h.power * 0.004);
      }
      for (const f of fallEvents.splice(0)) {
        this.burst(f.x, f.y, 600, { speed: { min: 40, max: 160 }, scale: { start: 1, end: 0 }, gravityY: 200, tint: [0x93c5fd, 0xffffff] }, 14);
      }

      // 平台（縮圈時縮小）+ 邊框（越縮越紅）
      const k = arenaR / ARENA_R;
      this.platform.setScale(k);
      const danger = round === 2 ? Math.min(1, (ARENA_R - arenaR) / (ARENA_R * (1 - SHRINK_MIN_RATIO))) : 0;
      this.rim.clear().lineStyle(10, Phaser.Display.Color.GetColor(Math.round(174 + 70 * danger), Math.round(195 - 100 * danger), Math.round(216 - 130 * danger))).strokeCircle(AX, AY, arenaR + 3);

      // 圓盤
      const now = Date.now();
      for (const s of this.sprites) {
        const d = s.d, show = d.alive || d.falling, online = d.p.online;
        s.c.setVisible(show); s.label.setVisible(show); s.shadow.setVisible(show);
        if (!show) continue;
        let scale = 1, alpha = online ? 1 : 0.4, ang = 0;
        if (d.falling) { const u = Math.min(1, d.fallT / FALL_SECONDS); scale = 1 - 0.75 * u; alpha *= 1 - u * 0.8; ang = u * 6; }
        else if (now < d.ghostUntil) alpha *= Math.floor(now / 100) % 2 ? 1 : 0.35;      // 復活無敵：閃爍
        s.c.setPosition(d.x, d.y).setScale(scale).setAlpha(alpha).setDepth(d.falling ? 1.5 : 10 + d.y * 0.001);
        s.spin.setRotation(d.spin + ang);
        s.head.setAngle(Phaser.Math.Clamp(d.vx / 40, -10, 10));                              // 衝得快時頭微微歪一點
        s.label.setPosition(d.x, d.y - DISC_R - 16).setAlpha(alpha).setVisible(!d.falling);
        s.shadow.setPosition(d.x + 3, d.y + 7).setScale(scale).setAlpha(0.35 * alpha);
      }

      // 上方標題、擊殺榜、訊息、中間大字
      const sec = Math.ceil(remainingMs / 1000);
      this.titleText.setText(round === 1 ? `第 1 回合　${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}` : `第 2 回合　剩 ${aliveCount()} 人（目標 ${finalistTarget()} 人）`);
      this.subTextObj.setText(subText);
      const rows = [...discs].sort((a, b) => totalKills(b.p) - totalKills(a.p)).slice(0, this.board.length);
      this.board.forEach((t, i) => {
        const d = rows[i];
        t.setText(d ? `${i === 0 ? '👑' : ' '}${d.p.name}  ${totalKills(d.p)} 殺${!d.alive && !d.falling && !S(d.p).eliminated ? ' ⏳' : ''}${S(d.p).eliminated ? ' ✖' : ''}` : '')
          .setColor(d ? d.p.color : '#fff');
      });
      feed = feed.filter((f) => now - f.at < 5000);
      this.feedTexts.forEach((t, i) => { const f = feed[feed.length - 1 - i]; t.setText(f ? f.text : '').setAlpha(f ? 1 - Math.max(0, (now - f.at - 3500) / 1500) : 0); });
      this.cdText.setText(centerText);
    }
  }

  // ============================================================
  // 給大廳（host.js）呼叫的介面
  // ============================================================
  function start() {
    for (const [id, p] of players) if (!p.online) players.delete(id);         // 離線的人這場不參加
    const list = [...players.values()].filter((p) => p.color).slice(0, MAX_PLAYERS);
    if (!list.length) return;
    clearTimers();
    players.forEach((p) => { delete p.spinner; });
    discs = list.map(newDisc);
    version++;
    elimOrder = []; hitEvents = []; fallEvents = []; allOfflineSince = 0;
    Hub.game.scene.stop('spinner');
    Hub.game.scene.start('spinner');
    beginRound(1);
  }

  function stop() {
    clearTimers();
    discs = []; version++; centerText = ''; subText = ''; feed = [];
    players.forEach((p) => { delete p.spinner; });
    $('spinnerPanel').classList.add('hidden');
    $('hud').textContent = '';
    Hub.game.scene.stop('spinner');
  }

  // 所有人都離線太久就回大廳
  function checkAllOffline() {
    clearTimeout(checkAllOffline.t);
    if (discs.length && !discs.some((d) => d.p.online) && Hub.phase !== 'lobby') {
      checkAllOffline.t = setTimeout(() => { if (!discs.some((d) => d.p.online)) Hub.backToLobby(); }, FORFEIT_GRACE_MS);
    }
  }

  $('spinnerNextBtn').onclick = () => { if (Hub.phase === 'roundEnd') beginRound(2); };
  $('spinnerAgainBtn').onclick = start;                    // 再來一場：重新開始兩個回合
  $('spinnerLobbyBtn').onclick = () => Hub.backToLobby();
  Hub.game.scene.add('spinner', SpinnerScene, false);

  return {
    start,
    stop,
    // 手機的 input 事件：{ mx, my }（搖桿方向；S1 之後會換成陀螺儀傾斜向量，格式不變）
    onInput(playerId, data) {
      const p = players.get(playerId);
      if (!p || !discOf(p) || typeof data.mx !== 'number') return;
      S(p).input = { mx: data.mx, my: data.my, at: Date.now() };
    },
    onPlayerLeft(p) { if (p.spinner) p.spinner.input = { mx: 0, my: 0, at: 0 }; checkAllOffline(); },
    onPlayerJoin() { checkAllOffline(); },
    onPhase(phase) {
      $('spinnerPanel').classList.toggle('hidden', phase !== 'roundEnd' && phase !== 'result');
    },
    // 傳給某位玩家手機的狀態（和大廳的通用狀態合併）
    statusOf(p) {
      const d = discOf(p);
      if (!d) return { role: 'late' };                          // late = 本場開始後才加入，或超過人數上限
      const st = S(p);
      return {
        role: 'player', round, kills: totalKills(p), deaths: st.deaths,
        alive: d.alive || d.falling, eliminated: st.eliminated,
        respawnMs: round === 1 && !d.alive && !d.falling && d.respawnAt ? Math.max(0, d.respawnAt - Date.now()) : 0,
        roundRank: st.roundRank, finalRank: st.finalRank,
      };
    },
    stateExtra: () => ({ round }),
    lobbyInfo: (n) => n ? `已選好 ${n} 人，個人混戰（共 2 回合，最多 ${MAX_PLAYERS} 人）` : '至少要有 1 人選好角色',
    // 測試用
    _state: () => ({ phase: Hub.phase, round, arenaR, remainingMs, elapsedMs, elim: elimOrder.map((d) => d.p.id),
      discs: discs.map((d) => ({ id: d.p.id, x: d.x, y: d.y, vx: d.vx, vy: d.vy, alive: d.alive, falling: d.falling, kills1: S(d.p).kills1, kills2: S(d.p).kills2, deaths: S(d.p).deaths, eliminated: S(d.p).eliminated, ghost: Date.now() < d.ghostUntil, finalRank: S(d.p).finalRank, roundRank: S(d.p).roundRank })) }),
    _set: (o) => {
      if (o.disc) Object.assign(discs[o.disc.index], o.disc.set);
      if (o.remainingMs != null) remainingMs = o.remainingMs;
      if (o.elapsedMs != null) elapsedMs = o.elapsedMs;
    },
  };
})();
Hub.games.spinner = SpinnerGame;
