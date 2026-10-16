// ============================================================
// games/race.js － 「跑步」遊戲：左右交替連按衝向終點
//   - 規則、分組、倒數、名次、跑道畫面（Phaser 場景）都在這個檔案
//   - 和大廳（host.js）的溝通只透過 Hub 與下面回傳的介面：
//       start() / stop() / onInput() / onPlayerLeft() / onPhase() / statusOf() / stateExtra() / lobbyInfo()
//   - 階段 phase：countdown → racing → heatResult → (下一組 countdown ...) → result，結束後由大廳切回 lobby
// ============================================================
const RaceGame = (() => {
  const { players, $, escapeHtml, setPhase, sendStatus } = Hub;

  // ---------- 遊戲數值（要調整手感改這裡）----------
  const TRACK_LENGTH = 1000;       // 跑道長度（抽象單位）
  const STEP_DISTANCE = 25;        // 每按一下前進的距離（1000/25 = 要按 40 下）
  const PLAYERS_PER_HEAT = 5;      // 每組最多幾人一起跑（人數不能整除時會平均分，例如 10 人 → 5+5、11 人 → 4+4+3）
  const FALL_MS = 1200;            // 左右鍵同時按 → 跌倒，這段時間內按鍵無效
  const SLOW_MS = 1000;            // 連按同一邊 → 跳一下，之後這段時間內前進變慢
  const SLOW_FACTOR = 0.5;         // 變慢時每步只前進這個比例
  const COUNTDOWN_SECONDS = 3;     // 倒數秒數
  const FINISH_TIMEOUT_MS = 10000; // 第一名抵達後，最多再等幾毫秒就結束這一組
  const HEAT_MAX_MS = 90000;       // 保險：一組最久跑多久（避免沒人到終點卡住）
  // 畫面排版（Phaser 畫布大小 1280x720）
  const CANVAS_W = 1280, CANVAS_H = 720;
  const LANE_COUNT = PLAYERS_PER_HEAT;
  const LANE_TOP = 90, LANE_HEIGHT = 120;      // 一組最多 5 條跑道
  const CHAR_SCALE = 0.85;         // 角色整體縮放（配合跑道高度）
  const START_X = 150, FINISH_X = 1140, BLOCK_SIZE = 70;

  // ---------- 這個遊戲的狀態 ----------
  // 每位玩家的跑步狀態放在 p.race（進大廳時清掉），不會跟其他遊戲的欄位混在一起
  const newState = () => ({
    heat: null, lane: 0, pos: 0,
    lastSide: null, stunUntil: 0, slowUntil: 0, fallAt: 0, hopAt: 0,   // 連按 / 同時按的懲罰狀態
    finished: false, finishTime: null, heatRank: null, overallRank: null,
  });
  const S = (p) => p.race || (p.race = newState());

  let heats = [];              // 每一組的 playerId 陣列，例如 [[a,b,c,d],[e,f]]
  let currentHeat = -1;        // 目前跑第幾組（從 0 開始）
  let goTime = 0;              // 這一組 GO 的時間點
  let timers = [];             // 目前進行中的計時器，換階段時清掉

  function clearTimers() { timers.forEach(clearTimeout); timers = []; }
  function later(fn, ms) { timers.push(setTimeout(fn, ms)); }
  function fmtTime(ms) { return (ms / 1000).toFixed(2) + ' 秒'; }
  function heatPlayers() { return (heats[currentHeat] || []).map((id) => players.get(id)); }

  // 把每組人數平均分配（例如 10 人 → [5,5]、11 人 → [4,4,3]）
  function heatSizes(n) {
    const heatCount = Math.ceil(n / PLAYERS_PER_HEAT);
    if (!heatCount) return [];
    const base = Math.floor(n / heatCount), extra = n % heatCount;
    return Array.from({ length: heatCount }, (_, i) => base + (i < extra ? 1 : 0));
  }

  // ============================================================
  // 畫面層（Phaser）：只負責「畫」，資料都從 view 讀
  // ============================================================
  const view = { version: 0, racers: [], countdown: '', title: '' };

  class RaceScene extends Phaser.Scene {
    create() {
      this.version = -1;
      this.sprites = [];

      // 畫跑道：每條交錯深淺色
      for (let i = 0; i < LANE_COUNT; i++) {
        const y = LANE_TOP + i * LANE_HEIGHT;
        this.add.rectangle(CANVAS_W / 2, y + LANE_HEIGHT / 2, CANVAS_W - 40, LANE_HEIGHT - 6,
          i % 2 ? 0x24384d : 0x2c4560);
      }
      // 起跑線與終點線（終點線畫成黑白格）
      this.add.rectangle(START_X - BLOCK_SIZE / 2 - 10, LANE_TOP + LANE_COUNT * LANE_HEIGHT / 2, 4, LANE_COUNT * LANE_HEIGHT, 0xffffff);
      const finishLineX = FINISH_X + BLOCK_SIZE / 2 + 10;
      for (let r = 0; r < LANE_COUNT * LANE_HEIGHT / 20; r++) {
        this.add.rectangle(finishLineX + (r % 2 ? 10 : 0), LANE_TOP + 10 + r * 20, 10, 20, 0xffffff);
        this.add.rectangle(finishLineX + (r % 2 ? 0 : 10), LANE_TOP + 10 + r * 20, 10, 20, 0x111111);
      }
      // 撒花用的小方塊貼圖（場景可能重複啟動，貼圖只建一次）
      if (!this.textures.exists('dot')) {
        const dot = this.textures.createCanvas('dot', 8, 8);
        dot.getContext().fillStyle = '#fff'; dot.getContext().fillRect(0, 0, 8, 8); dot.refresh();
      }
      this.titleText = this.add.text(CANVAS_W / 2, 55, '', { fontSize: '44px', color: '#fff', fontStyle: 'bold' }).setOrigin(0.5);
      this.cdText = this.add.text(CANVAS_W / 2, CANVAS_H / 2, '', { fontSize: '220px', color: '#fff', fontStyle: 'bold',
        stroke: '#000', strokeThickness: 12 }).setOrigin(0.5).setDepth(10);
    }

    // 依 view.racers 重建本組玩家：身體（跑步動畫）+ 大頭 + 名字
    rebuild() {
      this.sprites.forEach((s) => { s.c.destroy(); s.label.destroy(); });
      this.sprites = view.racers.map((p) => {
        const y = LANE_TOP + S(p).lane * LANE_HEIGHT + LANE_HEIGHT / 2;
        const color = p.color;
        const bodyKey = CharRender.ensureBody(this, color);
        const body = this.add.sprite(0, 0, bodyKey, 'f0').setScale(CharRender.BODY_SCALE);
        // 脖子位置在身體 sprite 上方；大頭放在脖子上
        const headY = (24 - CharRender.BODY_FRAME_H / 2) * CharRender.BODY_SCALE - CharRender.HEAD_SIZE / 2 + 4;
        const head = this.add.image(0, headY, p.photo ? 'head-' + p.id : 'char-' + p.charId)
          .setDisplaySize(CharRender.HEAD_SIZE, CharRender.HEAD_SIZE);
        const c = this.add.container(START_X, y + 28 * CHAR_SCALE, [body, head]).setScale(CHAR_SCALE);
        const label = this.add.text(START_X, y - 22, p.name, { fontSize: '22px', color: '#fff', stroke: '#000', strokeThickness: 4 }).setOrigin(1, 0.5);  // 名字放在頭的左邊
        return { p, c, body, head, label, color, baseY: y + 28 * CHAR_SCALE, headY, hop: 0, jump: 0, fallY: 0, falling: false,
          lastPos: S(p).pos, lastFallAt: S(p).fallAt, lastHopAt: S(p).hopAt, celebrated: false };
      });
      this.version = view.version;
    }

    // 按鍵回饋：身體瞬間壓扁再彈回
    squash(s) {
      if (s.squashing) return;
      s.squashing = true;
      this.tweens.add({ targets: s.body, scaleX: CharRender.BODY_SCALE * 1.12, scaleY: CharRender.BODY_SCALE * 0.88, duration: 70, yoyo: true,
        onComplete: () => { s.squashing = false; s.body.setScale(CharRender.BODY_SCALE); } });
    }

    // 角色頭上飄一個小表情
    fx(s, emoji) {
      const t = this.add.text(s.c.x, s.baseY - 100, emoji, { fontSize: '30px' }).setOrigin(0.5).setDepth(6);
      this.tweens.add({ targets: t, y: t.y - 30, alpha: 0, duration: 700, onComplete: () => t.destroy() });
    }

    // 左右同時按：整個人往前趴倒，過一下再站起來
    fall(s) {
      if (s.falling) return;
      s.falling = true;
      s.body.anims.stop(); s.body.setFrame('f0');
      this.fx(s, '💫');
      this.tweens.add({ targets: s.c, angle: 80, duration: 150, ease: 'Quad.easeIn' });
      this.tweens.add({ targets: s, fallY: 22, duration: 150 });
      this.time.delayedCall(FALL_MS - 200, () => {
        this.tweens.add({ targets: s.c, angle: 0, duration: 200 });
        this.tweens.add({ targets: s, fallY: 0, duration: 200, onComplete: () => { s.falling = false; } });
      });
    }

    // 連按同一邊：原地跳一下（接著會變慢）
    hop(s) {
      if (s.falling) return;
      this.fx(s, '💦');
      this.tweens.add({ targets: s, jump: 18, duration: 110, yoyo: true, ease: 'Sine.easeOut' });
    }

    // 抵達終點的慶祝動畫
    celebrate(s) {
      s.celebrated = true;
      s.body.setScale(CharRender.BODY_SCALE);
      this.tweens.add({ targets: s, hop: 26, duration: 260, yoyo: true, repeat: -1, ease: 'Sine.easeOut' });
      this.tweens.add({ targets: s.head, angle: 360, duration: 600, ease: 'Cubic.easeOut', onComplete: () => { s.head.angle = 0; } });
      this.tweens.add({ targets: s.body, angle: { from: -6, to: 6 }, duration: 200, yoyo: true, repeat: -1 });
      this.add.particles(FINISH_X - 20, s.baseY - 60, 'dot', {
        speed: { min: 120, max: 320 }, angle: { min: 200, max: 340 }, gravityY: 600, lifespan: 1100,
        scale: { start: 1, end: 0.4 }, rotate: { min: 0, max: 360 }, quantity: 24, emitting: false,
        tint: [0xef4444, 0x3b82f6, 0x22c55e, 0xfacc15, 0xf472b6],
      }).setDepth(5).explode(24);
    }

    update() {
      if (this.version !== view.version) this.rebuild();
      this.titleText.setText(view.title);
      this.cdText.setText(view.countdown);
      for (const s of this.sprites) {
        const targetX = START_X + (S(s.p).pos / TRACK_LENGTH) * (FINISH_X - START_X);
        const dx = targetX - s.c.x;
        s.c.x += dx * 0.25;
        s.label.x = s.c.x - CharRender.HEAD_SIZE * CHAR_SCALE / 2 - 4;
        s.label.setText(S(s.p).finished ? `${s.p.name}  第${S(s.p).heatRank}名` : s.p.name);
        // 在移動就播跑步動畫（越快播越快），停下來就站著
        const running = Math.abs(dx) > 0.6 && !S(s.p).finished && !s.falling;
        if (running) {
          s.body.anims.timeScale = Phaser.Math.Clamp(Math.abs(dx) / 3, 0.6, 3);
          if (!s.body.anims.isPlaying) s.body.play('run-' + s.color);
        } else if (s.body.anims.isPlaying) {
          s.body.anims.stop();
          s.body.setFrame('f0');
        }
        // 大頭隨步伐上下晃、左右搖（跑得越快晃得越大）
        const t = this.time.now / 1000, speed = Phaser.Math.Clamp(Math.abs(dx) / 3, 0, 3);
        if (running) {
          s.head.y = s.headY - Math.abs(Math.sin(t * 8 * s.body.anims.timeScale)) * 3;
          s.head.angle = Math.sin(t * 8 * s.body.anims.timeScale) * (3 + speed * 2);
        } else if (!S(s.p).finished && !s.falling) {
          s.head.y = s.headY; s.head.angle = 0;
        }
        // 每按一下：身體壓扁彈回
        if (S(s.p).pos > s.lastPos && !S(s.p).finished) this.squash(s);
        // 跌倒（左右同時按）／跳一下（連按同一邊）
        if (S(s.p).fallAt !== s.lastFallAt) { s.lastFallAt = S(s.p).fallAt; this.fall(s); }
        if (S(s.p).hopAt !== s.lastHopAt) { s.lastHopAt = S(s.p).hopAt; this.hop(s); }
        s.lastPos = S(s.p).pos;
        // 抵達終點：慶祝（跳、轉頭、撒花）
        if (S(s.p).finished && !s.celebrated) this.celebrate(s);
        s.c.y = s.baseY - s.hop - s.jump + s.fallY;
      }
    }
  }

  // 換一組玩家上場（通知畫面重建角色）
  function showRacers(list) {
    view.racers = list;
    view.version++;
  }

  // ============================================================
  // 遊戲流程
  // ============================================================
  // 開始一整場：把在線玩家依加入順序分組，然後從第 1 組開始
  function start() {
    // 離線的人這場不參加，直接移出名單
    for (const [id, p] of players) if (!p.online) players.delete(id);
    const list = [...players.values()].filter((p) => p.color);   // 只有選好角色與顏色的人上場
    if (!list.length) return;

    clearTimers();
    players.forEach((p) => { p.race = newState(); });
    heats = [];
    let i = 0;
    for (const size of heatSizes(list.length)) {
      const group = list.slice(i, i + size);
      i += size;
      group.forEach((p, lane) => {
        S(p).heat = heats.length;
        S(p).lane = lane;                                // 第幾條跑道
      });
      heats.push(group.map((p) => p.id));
    }
    Hub.game.scene.stop('race');
    Hub.game.scene.start('race');
    startHeat(0);
  }

  // 離開遊戲（回大廳）：清計時器、面板、畫面
  function stop() {
    clearTimers();
    heats = []; currentHeat = -1;
    showRacers([]);
    view.title = ''; view.countdown = '';
    players.forEach((p) => { delete p.race; });
    $('heatPanel').classList.add('hidden');
    $('finalPanel').classList.add('hidden');
    $('hud').textContent = '';
    Hub.game.scene.stop('race');
  }

  function startHeat(n) {
    clearTimers();
    currentHeat = n;
    showRacers(heatPlayers());
    view.title = `第 ${n + 1} / ${heats.length} 組`;
    setPhase('countdown');

    let count = COUNTDOWN_SECONDS;
    view.countdown = String(count);
    const tick = () => {
      count--;
      if (count > 0) {
        view.countdown = String(count);
        later(tick, 1000);
      } else {
        view.countdown = 'GO!';
        later(() => { view.countdown = ''; }, 800);
        beginRace();
      }
    };
    later(tick, 1000);
  }

  function beginRace() {
    goTime = Date.now();
    setPhase('racing');
    later(endHeat, HEAT_MAX_MS); // 保險計時器
  }

  // 收到某位玩家按鍵（side：L 左 / R 右 / both 兩邊同時按）
  //   - 左右交替才會前進
  //   - 同時按 → 跌倒，FALL_MS 內按鍵無效
  //   - 連按同一邊 → 這下不前進，原地跳一下，之後 SLOW_MS 內每步只前進 SLOW_FACTOR
  function onTap(playerId, side) {
    const p = players.get(playerId);
    if (!p || Hub.phase !== 'racing' || S(p).heat !== currentHeat || S(p).finished) return;
    const now = Date.now();
    if (now < S(p).stunUntil) return;                      // 跌倒中
    if (side === 'both') {
      S(p).stunUntil = now + FALL_MS; S(p).lastSide = null; S(p).fallAt = now;
      return;
    }
    if (side === S(p).lastSide) {                          // 連按同一邊
      S(p).slowUntil = now + SLOW_MS; S(p).hopAt = now;
      return;
    }
    S(p).lastSide = side;

    const step = now < S(p).slowUntil ? STEP_DISTANCE * SLOW_FACTOR : STEP_DISTANCE;
    S(p).pos = Math.min(TRACK_LENGTH, S(p).pos + step);
    if (S(p).pos < TRACK_LENGTH) return;

    // 抵達終點：記錄時間與本組名次
    S(p).finished = true;
    S(p).finishTime = now - goTime;
    S(p).heatRank = heatPlayers().filter((x) => S(x).finished).length;
    sendStatus(p);

    if (S(p).heatRank === 1) later(endHeat, FINISH_TIMEOUT_MS); // 第一名到了，開始 10 秒倒數
    checkHeatDone();
  }

  // 本組所有「還在線」的人都到終點了嗎？
  function checkHeatDone() {
    if (Hub.phase !== 'racing') return;
    if (heatPlayers().every((p) => S(p).finished || !p.online)) endHeat();
  }

  // 結束這一組：沒跑完的人依目前位置排在後面，然後顯示本組結果
  function endHeat() {
    if (Hub.phase !== 'racing') return;
    clearTimers();
    const group = heatPlayers();
    let rank = group.filter((p) => S(p).finished).length;
    group.filter((p) => !S(p).finished).sort((a, b) => S(b).pos - S(a).pos).forEach((p) => { S(p).heatRank = ++rank; });

    const sorted = [...group].sort((a, b) => S(a).heatRank - S(b).heatRank);
    $('heatTitle').textContent = `第 ${currentHeat + 1} 組結果`;
    $('heatList').innerHTML = sorted.map((p) =>
      `<li><span>${S(p).heatRank}. ${escapeHtml(p.name)}</span>` +
      (S(p).finished ? `<span>${fmtTime(S(p).finishTime)}</span>` : `<span class="dnf">沒跑完</span>`) + `</li>`).join('');

    const isLast = currentHeat + 1 >= heats.length;
    if (isLast) {
      $('nextInfo').textContent = '全部組別都跑完了！';
      $('nextBtn').textContent = '看總成績';
    } else {
      const names = heats[currentHeat + 1].map((id) => players.get(id).name).join('、');
      $('nextInfo').textContent = `下一組：${names}`;
      $('nextBtn').textContent = `開始第 ${currentHeat + 2} 組`;
    }
    setPhase('heatResult');
  }

  // 全部跑完：依「抵達時間」排總名次，沒跑完的排最後（依位置）
  function showFinal() {
    const all = [...players.values()].filter((p) => S(p).heat !== null);
    const done = all.filter((p) => S(p).finished).sort((a, b) => S(a).finishTime - S(b).finishTime);
    const dnf = all.filter((p) => !S(p).finished).sort((a, b) => S(b).pos - S(a).pos);
    [...done, ...dnf].forEach((p, i) => { S(p).overallRank = i + 1; });

    $('finalList').innerHTML = [...done, ...dnf].map((p) =>
      `<li><span>${S(p).overallRank}. ${escapeHtml(p.name)}</span>` +
      (S(p).finished ? `<span>${fmtTime(S(p).finishTime)}（第 ${S(p).heat + 1} 組）</span>` : `<span class="dnf">沒跑完</span>`) + `</li>`).join('');
    setPhase('result');
  }

  // ============================================================
  // 按鈕（面板在 host.html，由跑步使用）
  // ============================================================
  $('againBtn').onclick = start;                  // 再來一場：重新分組、重新倒數
  $('lobbyBtn').onclick = () => Hub.backToLobby();
  $('nextBtn').onclick = () => {
    if (currentHeat + 1 < heats.length) startHeat(currentHeat + 1);
    else showFinal();
  };

  Hub.game.scene.add('race', RaceScene, false);

  // ============================================================
  // 給大廳（host.js）呼叫的介面
  // ============================================================
  return {
    start,
    stop,
    onInput: (playerId, data) => onTap(playerId, data && data.side),   // 手機的 tap 事件
    onPlayerLeft: () => checkHeatDone(),
    onPhase(phase) {                                                   // 階段切換時更新跑步用的面板
      $('heatPanel').classList.toggle('hidden', phase !== 'heatResult');
      $('finalPanel').classList.toggle('hidden', phase !== 'result');
      $('hud').textContent = (phase === 'lobby' || phase === 'result') ? '' : `第 ${currentHeat + 1} / ${heats.length} 組`;
    },
    // 傳給某位玩家手機的跑步狀態（和大廳的通用狀態合併）
    statusOf: (p) => ({
      role: S(p).heat === null ? 'late' : (S(p).heat === currentHeat ? 'racer' : 'waiting'),   // late = 本場中途才加入
      heat: S(p).heat === null ? null : S(p).heat + 1,
      totalHeats: heats.length,
      finished: S(p).finished,
      heatRank: S(p).heatRank,
      overallRank: S(p).overallRank,
      finishTime: S(p).finishTime,
    }),
    stateExtra: () => ({ heat: currentHeat + 1, totalHeats: heats.length }),   // 廣播給所有手機的 game:state 附加欄位
    lobbyInfo: (n) => {                                                        // 大廳顯示：幾人、分幾組
      const sizes = heatSizes(n);
      return n ? `已選好 ${n} 人，分 ${sizes.length} 組（${sizes.join('、')} 人）` : '至少要有 1 人選好角色';
    },
    // 測試用
    _endHeat: () => endHeat(),
    _state: () => ({ heats, currentHeat }),
  };
})();
Hub.games.race = RaceGame;
