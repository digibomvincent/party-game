// ============================================================
// games/spinner.js － 「陀螺大戰」遊戲（S1：碗型平台 + 手機陀螺儀操控；圓盤互撞，把別人撞出平台）
//   - 個人混戰；共兩回合：
//       第 1 回合 計時賽：被撞出平台 5 秒後復活，計算擊殺數
//       第 2 回合 淘汰賽：不復活，平台慢慢縮小，剩最後 3 位就結束（人少時打到只剩 1 位）
//   - 最終名次：第 2 回合留下來的人排前面（依第 1 回合擊殺數），其餘依淘汰順序（越晚淘汰名次越高）
//   - 平台是中間下凹的「碗」：往中心衝會加速、往外圍衝會減速，所以比較不會自己衝出去；要把人撞出去得靠撞擊，而且在外圈撞最有效
//   - 手機用陀螺儀（傾斜）操控，或用搖桿備案；開打前先有「準備」階段，等所有人按「準備好」
//   - 暫時沒有轉速與衝撞
//   - 物理全部在 host 端算（固定 60Hz）；角色大頭放在圓盤中間
//   - 和大廳（host.js）的溝通只透過 Hub 與下面回傳的介面
// 階段 phase：prepare（等大家準備好）→ countdown → playing → roundEnd（第 1 回合結束）→ countdown → playing → result
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
  const PREPARE_MS = 25000;            // 準備階段最久等多久（時間到沒按準備好的人當作用搖桿）
  const FORFEIT_GRACE_MS = 15000;      // 所有人都離線超過這麼久就回大廳

  // ---------- 手感數值（要調整就改這裡）----------
  const DISC_R = 30;                   // 圓盤半徑
  const ACCEL = 1000;                  // 推到底時的加速度（像素/秒²）
  const DAMP = 1.2;                    // 滑行阻力（每秒；越小越滑，在碗裡會來回晃一陣子才停）
  const MAX_SPEED = 380;               // 自己操控能加速到的最高速度
  const HARD_MAX_SPEED = 800;          // 被撞飛時允許的最高速度
  const BOWL_G = 1400;                 // 碗的「重力」：在平台邊緣（半徑 ARENA_R）把圓盤拉向中心的加速度；越靠近中心越小。
                                       //   要比 ACCEL 大：這樣自己用力往外衝，到邊緣就推不動了（不會自己衝出去）；
                                       //   而被撞飛的速度可以到 HARD_MAX_SPEED，遠高於自己能跑的 MAX_SPEED，所以還是能把人撞出去。
                                       //   （用離線模擬調過：亂走的假人 40 秒自己掉出去 ≈ 1 次，舊的平面設定 ≈ 44 次；8 個追擊 AI、90 秒約 20 次擊殺）
                                       //   縮圈時碗不變，平台邊緣越來越靠近中心、拉力越來越小，所以越縮越容易掉出去
  const RESTITUTION = 0.9;             // 圓盤互撞的彈性（1 = 完全彈性）
  const HIT_BOOST = 1.45;              // 撞擊力道加成（>1 比較誇張，撞得比較遠）
  const RAM_SPEED = 520;               // 衝撞：朝目前操控方向額外加的速度
  const RAM_SECONDS = 0.4;             // 衝撞狀態持續多久（這段時間撞到人，對方被撞得更遠）
  const RAM_COOLDOWN = 2;              // 衝撞冷卻（秒）
  const RAM_POWER = 1.7;               // 衝撞中撞到別人，對方受到的撞擊力道倍率
  const RAM_MAX_SPEED = 950;           // 衝撞中速度上限
  const FALL_SECONDS = 0.7;            // 掉出平台後縮小旋轉掉下去的時間
  const INPUT_TIMEOUT_MS = 600;        // 超過這麼久沒收到搖桿更新，就當作放開
  const HEAD_PX = 46;                  // 圓盤中間的大頭顯示大小
  const STEP = 1 / 60;                 // 物理固定步長

  // ---------- 這個遊戲的狀態 ----------
  // 每位玩家的狀態放在 p.spinner（回大廳時清掉）：{ input, kills1, kills2, deaths, eliminated, roundRank, finalRank }
  const S = (p) => p.spinner || (p.spinner = { input: { mx: 0, my: 0, at: 0, dash: false, ramReq: false }, kills1: 0, kills2: 0, deaths: 0, eliminated: false, roundRank: null, finalRank: null });
  let discs = [];                      // 場上的圓盤（見 newDisc）
  let version = 0;                     // 場上圓盤換了就加一，場景據此重建
  let round = 1;
  let arenaR = ARENA_R;
  let remainingMs = 0;                 // 第 1 回合剩餘時間
  let elapsedMs = 0;                   // 第 2 回合已經過的時間
  let elimOrder = [];                  // 第 2 回合淘汰順序（先淘汰的在前）
  let centerText = '', subText = '';   // 畫面正中間的大字（倒數）與上方小字（回合說明）
  let feed = [];                       // 擊殺訊息 { text, at }
  let ramEvents = [];                  // 衝撞事件（場景播衝刺煙塵）
  let hitEvents = [];                  // 撞擊事件（場景播火花、震動）
  let fallEvents = [];                 // 掉下去事件（場景播水花）
  let timers = [];
  let allOfflineSince = 0;
  function clearTimers() { timers.forEach(clearTimeout); timers = []; }
  function later(fn, ms) { timers.push(setTimeout(fn, ms)); }
  const discOf = (p) => discs.find((d) => d.p === p);
  // 手機的操控方式與「準備好」：放在 p.spinnerCtrl，回大廳／再來一場都保留（手機已經授權過陀螺儀就不用再按）
  const C = (p) => p.spinnerCtrl || (p.spinnerCtrl = { mode: '', ready: false });
  const totalKills = (p) => S(p).kills1 + S(p).kills2;

  // 角色的身體數值（characters.json 的 spinner 欄位，都是倍率；沒填的當 1）
  //   speed 最高速度、accel 加速、size 體型（圓盤大小）、mass 重量（重的被撞得少、撞人時推得動）、power 撞擊力道（撞到別人時給對方的力）、
  //   grip 抓地（滑行阻力：高 = 被撞飛後停得快、飛不遠）、ram 衝撞的衝力、ramRate 衝撞冷卻的快慢（越大冷卻越短）
  const STAT_DEFAULT = { speed: 1, accel: 1, size: 1, mass: 1, power: 1, grip: 1, ram: 1, ramRate: 1 };
  const statsOf = (p) => ({ ...STAT_DEFAULT, ...((Hub.characters.find((c) => c.id === p.charId) || {}).spinner || {}) });
  function newDisc(p) {
    const st = statsOf(p);
    return { p, st, r: DISC_R * st.size, x: AX, y: AY, vx: 0, vy: 0, alive: true, falling: false, fallT: 0, respawnAt: 0, ghostUntil: 0, lastHit: null, spin: 0, ramT: 0, ramCd: 0 };
  }

  // ============================================================
  // 開局站位
  // ============================================================
  // 圍著平台排成一圈（離邊緣遠一點），第 1、2 回合開始時都用這個
  function placeRing() {
    discs.forEach((d, i) => {
      const a = (i / discs.length) * Math.PI * 2 - Math.PI / 2, r = ARENA_R * 0.6;
      Object.assign(d, { x: AX + Math.cos(a) * r, y: AY + Math.sin(a) * r, vx: 0, vy: 0, alive: !S(d.p).eliminated, falling: false, fallT: 0, respawnAt: 0, ghostUntil: 0, lastHit: null, ramT: 0, ramCd: 0 });
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
      // 操控：搖桿／傾斜方向 → 加速度（已經跑到自己的最高速度、還往同方向推就不再加速）
      if (d.p.online) {
        const inp = S(d.p).input;
        let mx = inp.mx, my = inp.my;
        if (now - inp.at > INPUT_TIMEOUT_MS) { mx = 0; my = 0; }
        const mag = Math.hypot(mx, my);
        if (mag > 1) { mx /= mag; my /= mag; }
        const along = mag > 0 ? (d.vx * mx + d.vy * my) / mag : 0;
        if (along < MAX_SPEED * d.st.speed) { d.vx += mx * ACCEL * d.st.accel * dt; d.vy += my * ACCEL * d.st.accel * dt; }
        // 衝撞：按一下往操控方向（沒推就往目前滑行方向）猛衝一段；冷卻中、或完全沒在動就不觸發
        if (inp.ramReq) {
          inp.ramReq = false;
          if (d.ramCd <= 0 && now >= d.ghostUntil) {
            const v = Math.hypot(d.vx, d.vy);
            const dx = mag > 0.15 ? mx / mag : v > 40 ? d.vx / v : 0, dy = mag > 0.15 ? my / mag : v > 40 ? d.vy / v : 0;
            if (dx || dy) {
              d.vx += dx * RAM_SPEED * d.st.ram; d.vy += dy * RAM_SPEED * d.st.ram; d.ramT = RAM_SECONDS; d.ramCd = RAM_COOLDOWN / d.st.ramRate;
              ramEvents.push({ x: d.x, y: d.y, dx, dy });
            }
          }
        }
      }
      d.ramT = Math.max(0, d.ramT - dt); d.ramCd = Math.max(0, d.ramCd - dt);
      // 碗：離中心越遠、被拉回中心的力越大（線性）。往中心衝會越來越快，往外衝會越來越慢
      const rx = d.x - AX, ry = d.y - AY, rd = Math.hypot(rx, ry);
      if (rd > 0.001) { const pull = BOWL_G * (rd / ARENA_R) * dt; d.vx -= (rx / rd) * pull; d.vy -= (ry / rd) * pull; }
      const drag = Math.exp(-DAMP * d.st.grip * dt);
      d.vx *= drag; d.vy *= drag;
      const sp = Math.hypot(d.vx, d.vy);
      const cap = d.ramT > 0 ? RAM_MAX_SPEED : HARD_MAX_SPEED;
      if (sp > cap) { d.vx *= cap / sp; d.vy *= cap / sp; }
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
        const dx = b.x - a.x, dy = b.y - a.y, dist = Math.hypot(dx, dy), min = a.r + b.r;
        if (dist <= 0 || dist >= min) continue;
        const nx = dx / dist, ny = dy / dist, ma = a.st.mass, mb = b.st.mass;
        const pa = (min - dist) * mb / (ma + mb), pb = (min - dist) * ma / (ma + mb);     // 先分開（輕的被推開得多）
        a.x -= nx * pa; a.y -= ny * pa; b.x += nx * pb; b.y += ny * pb;
        const vrel = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;                       // 沿著連線、互相靠近的速度
        if (vrel > 0) {
          const base = (HIT_BOOST * (1 + RESTITUTION) * vrel) / (1 / ma + 1 / mb);       // 不等質量的彈性碰撞（質量相同時 = 原本的算法）
          const ja = base * b.st.power * (b.ramT > 0 ? RAM_POWER : 1), jb = base * a.st.power * (a.ramT > 0 ? RAM_POWER : 1);   // 對方撞擊力道大、或在衝撞中 → 我被撞得更遠
          a.vx -= (ja / ma) * nx; a.vy -= (ja / ma) * ny; b.vx += (jb / mb) * nx; b.vy += (jb / mb) * ny;
          a.lastHit = { id: b.p.id, at: now }; b.lastHit = { id: a.p.id, at: now };
          if (vrel > 80) hitEvents.push({ x: a.x + nx * a.r, y: a.y + ny * a.r, power: Math.min(1, vrel / 500 * (a.ramT > 0 || b.ramT > 0 ? 1.4 : 1)) });
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
    Sfx.play('respawn');
    const s = pickSpawn();
    Object.assign(d, { x: s.x, y: s.y, vx: 0, vy: 0, alive: true, falling: false, respawnAt: 0, ghostUntil: now + SPAWN_PROTECT_MS, lastHit: null, ramT: 0, ramCd: 0 });
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
  // 準備階段：等所有人（在線的）按「準備好」，或等到時間到；手機在這時請求陀螺儀權限、校正
  function beginPrepare() {
    clearTimers();
    round = 1; arenaR = ARENA_R; elapsedMs = 0; remainingMs = ROUND1_SECONDS * 1000; elimOrder = [];
    placeRing(); feed = []; centerText = ''; subText = '準備好了嗎？每個人在手機上按「準備好」';
    $('spinnerPanel').classList.add('hidden');
    setPhase('prepare');
    later(() => { if (Hub.phase === 'prepare') beginRound(1); }, PREPARE_MS);
    checkAllReady();
  }
  function checkAllReady() {
    if (Hub.phase !== 'prepare') return;
    const online = discs.filter((d) => d.p.online);
    if (online.length && online.every((d) => C(d.p).ready)) {
      clearTimers();
      later(() => beginRound(1), 900);                         // 全部準備好：稍等一下就開始
    }
  }
  function prepareLines() {
    return discs.map((d) => `${!d.p.online ? '📵' : C(d.p).ready ? '✅' : '⏳'} ${d.p.name}  ${C(d.p).mode === 'gyro' ? '📱 體感' : C(d.p).mode === 'stick' ? '🕹 搖桿' : ''}`).join('\n');
  }

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
    centerText = String(count); Sfx.play('beep');
    const tick = () => {
      count--;
      if (count > 0) { centerText = String(count); Sfx.play('beep'); later(tick, 1000); return; }
      centerText = 'GO!'; Sfx.play('go');
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
      // 平台：碗型。中間深（暗）、外圈淺（亮），一圈一圈的等高線；碗的形狀固定，縮圈時只是外圍的平台被「吃掉」（蓋上深色環）
      this.pit = this.add.circle(AX, AY, ARENA_R + 70, 0x0a1017).setDepth(0);
      // 碗只畫一次、存成貼圖（每格重畫 28 個大圓太吃效能），之後每格只貼一張圖
      if (!this.textures.exists('spinner-bowl')) {
        const g = this.add.graphics(), C = ARENA_R;                  // 貼圖是 2R x 2R，圓心在 (R, R)
        const STEPS = 28, dark = Phaser.Display.Color.ValueToColor(0x16222f), light = Phaser.Display.Color.ValueToColor(0x6a8cae);
        for (let i = 0; i < STEPS; i++) {
          const t = 1 - i / STEPS;                                   // 1 = 最外圈，0 = 中心
          const c = Phaser.Display.Color.Interpolate.ColorWithColor(dark, light, 100, Math.pow(t, 1.3) * 100);
          g.fillStyle(Phaser.Display.Color.GetColor(c.r, c.g, c.b)).fillCircle(C, C, ARENA_R * t);
        }
        g.lineStyle(2, 0x9bb6d1, 0.25);
        for (const k of [0.25, 0.5, 0.75]) g.strokeCircle(C, C, ARENA_R * k);
        g.lineStyle(2, 0x9bb6d1, 0.12);
        for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2; g.lineBetween(C + Math.cos(a) * 20, C + Math.sin(a) * 20, C + Math.cos(a) * ARENA_R, C + Math.sin(a) * ARENA_R); }
        g.generateTexture('spinner-bowl', ARENA_R * 2, ARENA_R * 2);
        g.destroy();
      }
      this.platform = this.add.image(AX, AY, 'spinner-bowl').setDepth(1);
      this.pitRing = this.add.graphics().setDepth(1.2);            // 縮圈時蓋住被「吃掉」的外圍
      this.rim = this.add.graphics().setDepth(2);
      // 文字：上方回合資訊、左邊擊殺榜、右邊訊息、中間大字
      const base = { fontSize: '30px', color: '#fff', fontStyle: 'bold', stroke: '#000', strokeThickness: 5 };
      this.titleText = this.add.text(AX, 40, '', base).setOrigin(0.5).setDepth(10);
      this.subTextObj = this.add.text(AX, 80, '', { fontSize: '20px', color: '#fde68a', stroke: '#000', strokeThickness: 4 }).setOrigin(0.5).setDepth(10);
      this.board = Array.from({ length: 7 }, (_, i) => this.add.text(24, 130 + i * 34, '', { fontSize: '22px', color: '#fff', stroke: '#000', strokeThickness: 4 }).setDepth(10));
      this.feedTexts = Array.from({ length: 5 }, (_, i) => this.add.text(1256, 130 + i * 30, '', { fontSize: '20px', color: '#fff', stroke: '#000', strokeThickness: 4 }).setOrigin(1, 0).setDepth(10));
      this.prepText = this.add.text(AX, AY, '', { fontSize: '26px', color: '#fff', align: 'left', lineSpacing: 8, stroke: '#000', strokeThickness: 5 }).setOrigin(0.5).setDepth(4000);
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
        const glow = this.add.circle(d.x, d.y, DISC_R + 10, 0xfb923c, 0.45).setStrokeStyle(4, 0xfff7ed).setDepth(9);   // 衝撞中的光圈
        return { d, c, spin, head, label, shadow, glow };
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
        Sfx.play('hit', { power: h.power });
      }
      for (const r of ramEvents.splice(0)) {
        Sfx.play('ram');
        this.burst(r.x - r.dx * 30, r.y - r.dy * 30, 350, { speed: { min: 30, max: 140 }, angle: { min: Math.atan2(-r.dy, -r.dx) * 57.3 - 30, max: Math.atan2(-r.dy, -r.dx) * 57.3 + 30 }, scale: { start: 0.8, end: 0 }, tint: [0xffffff, 0xfdba74, 0xfb923c] }, 12);
      }
      for (const f of fallEvents.splice(0)) {
        Sfx.play('fall');
        this.burst(f.x, f.y, 600, { speed: { min: 40, max: 160 }, scale: { start: 1, end: 0 }, gravityY: 200, tint: [0x93c5fd, 0xffffff] }, 14);
      }

      // 縮圈：外圍被吃掉的部分蓋上深色環；邊框（越縮越紅）
      this.pitRing.clear();
      if (arenaR < ARENA_R - 0.5) this.pitRing.lineStyle(ARENA_R + 4 - arenaR, 0x0a1017).strokeCircle(AX, AY, (arenaR + ARENA_R + 4) / 2);
      const danger = round === 2 ? Math.min(1, (ARENA_R - arenaR) / (ARENA_R * (1 - SHRINK_MIN_RATIO))) : 0;
      this.rim.clear().lineStyle(10, Phaser.Display.Color.GetColor(Math.round(174 + 70 * danger), Math.round(195 - 100 * danger), Math.round(216 - 130 * danger))).strokeCircle(AX, AY, arenaR + 3);

      // 圓盤
      const now = Date.now();
      for (const s of this.sprites) {
        const d = s.d, show = d.alive || d.falling, online = d.p.online;
        s.c.setVisible(show); s.label.setVisible(show); s.shadow.setVisible(show);
        if (!show) { s.glow.setVisible(false); continue; }
        let scale = 1, alpha = online ? 1 : 0.4, ang = 0;
        if (d.falling) { const u = Math.min(1, d.fallT / FALL_SECONDS); scale = 1 - 0.75 * u; alpha *= 1 - u * 0.8; ang = u * 6; }
        else if (now < d.ghostUntil) alpha *= Math.floor(now / 100) % 2 ? 1 : 0.35;      // 復活無敵：閃爍
        s.c.setPosition(d.x, d.y).setScale(scale * d.st.size).setAlpha(alpha).setDepth(d.falling ? 1.5 : 10 + d.y * 0.001);
        s.glow.setPosition(d.x, d.y).setVisible(d.ramT > 0 && !d.falling).setScale((0.9 + 0.3 * (d.ramT / RAM_SECONDS)) * d.st.size);
        s.spin.setRotation(d.spin + ang);
        s.head.setAngle(Phaser.Math.Clamp(d.vx / 40, -10, 10));                              // 衝得快時頭微微歪一點
        s.label.setPosition(d.x, d.y - d.r - 16).setAlpha(alpha).setVisible(!d.falling);
        s.shadow.setPosition(d.x + 3, d.y + 7).setScale(scale * d.st.size).setAlpha(0.35 * alpha);
      }

      // 上方標題、擊殺榜、訊息、中間大字
      const sec = Math.ceil(remainingMs / 1000);
      this.titleText.setText(Hub.phase === 'prepare' ? '陀螺大戰　準備中' : round === 1 ? `第 1 回合　${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}` : `第 2 回合　剩 ${aliveCount()} 人（目標 ${finalistTarget()} 人）`);
      this.subTextObj.setText(subText);
      const rows = [...discs].sort((a, b) => totalKills(b.p) - totalKills(a.p)).slice(0, this.board.length);
      this.board.forEach((t, i) => {
        const d = rows[i];
        t.setText(d ? `${i === 0 ? '👑' : ' '}${d.p.name}  ${totalKills(d.p)} 殺${!d.alive && !d.falling && !S(d.p).eliminated ? ' ⏳' : ''}${S(d.p).eliminated ? ' ✖' : ''}` : '')
          .setColor(d ? d.p.color : '#fff');
      });
      feed = feed.filter((f) => now - f.at < 5000);
      this.feedTexts.forEach((t, i) => { const f = feed[feed.length - 1 - i]; t.setText(f ? f.text : '').setAlpha(f ? 1 - Math.max(0, (now - f.at - 3500) / 1500) : 0); });
      this.cdText.setText(Hub.phase === 'prepare' ? '' : centerText);
      this.prepText.setText(Hub.phase === 'prepare' ? prepareLines() : '').setVisible(Hub.phase === 'prepare');
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
    elimOrder = []; ramEvents = []; hitEvents = []; fallEvents = []; allOfflineSince = 0;
    Hub.game.scene.stop('spinner');
    Hub.game.scene.start('spinner');
    beginPrepare();
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
      const prev = S(p).input;
      S(p).input = { mx: data.mx, my: data.my, at: Date.now(), dash: !!data.dash, ramReq: prev.ramReq || (!!data.dash && !prev.dash) };   // 衝撞：按下的瞬間觸發一次
      if (data.mode === 'gyro' || data.mode === 'stick') C(p).mode = data.mode;
      if (data.ready && !C(p).ready) { C(p).ready = true; sendStatus(p); checkAllReady(); }
    },
    onPlayerLeft(p) { if (p.spinner) p.spinner.input = { mx: 0, my: 0, at: 0, dash: false, ramReq: false }; checkAllOffline(); checkAllReady(); },
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
        roundRank: st.roundRank, finalRank: st.finalRank, ready: C(p).ready, mode: C(p).mode,
        ramMs: Math.round(RAM_COOLDOWN * 1000 / d.st.ramRate),                 // 這個角色的衝撞冷卻（手機鈕的冷卻外觀用）
      };
    },
    stateExtra: () => ({ round }),
    lobbyInfo: (n) => n ? `已選好 ${n} 人，個人混戰（共 2 回合，最多 ${MAX_PLAYERS} 人）` : '至少要有 1 人選好角色',
    // 測試用
    _state: () => ({ phase: Hub.phase, round, arenaR, remainingMs, elapsedMs, elim: elimOrder.map((d) => d.p.id),
      discs: discs.map((d) => ({ id: d.p.id, x: d.x, y: d.y, vx: d.vx, vy: d.vy, alive: d.alive, falling: d.falling, ramT: d.ramT, ramCd: d.ramCd, kills1: S(d.p).kills1, kills2: S(d.p).kills2, deaths: S(d.p).deaths, eliminated: S(d.p).eliminated, ghost: Date.now() < d.ghostUntil, finalRank: S(d.p).finalRank, roundRank: S(d.p).roundRank })) }),
    _set: (o) => {
      if (o.disc) Object.assign(discs[o.disc.index], o.disc.set);
      if (o.remainingMs != null) remainingMs = o.remainingMs;
      if (o.elapsedMs != null) elapsedMs = o.elapsedMs;
    },
  };
})();
Hub.games.spinner = SpinnerGame;
