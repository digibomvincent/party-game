// ============================================================
// 主程式：開場、密碼、音樂、五關進度（星星）、切換關卡
// 每一關是一個 run(container, ctx) → Promise，過關時 resolve
// ============================================================
(() => {
  const cfg = window.BIRTHDAY_CONFIG;
  const STORE_KEY = 'bday-progress';

  // 關卡清單：還沒做好的關卡用 placeholder 先頂著
  const STAGES = [
    { title: '我們的旅行地圖', emoji: '✈️', run: (c, ctx) => window.Stage1.run(c, ctx) },
    { title: '回憶大考驗', emoji: '📝', run: placeholder },
    { title: '小遊戲', emoji: '🎮', run: placeholder },
    { title: '給你的卡片', emoji: '💌', run: placeholder },
    { title: '約會邀請函', emoji: '🍽️', run: placeholder },
  ];

  const $ = (s) => document.querySelector(s);
  const stageEl = $('#stage');
  const bgm = $('#bgm');

  // ---------- 進度（存在瀏覽器裡，不小心關掉可以接著玩） ----------
  function loadProgress() {
    try { return Number(localStorage.getItem(STORE_KEY)) || 0; } catch { return 0; }
  }
  function saveProgress(n) {
    try { localStorage.setItem(STORE_KEY, String(n)); } catch { /* 無痕模式等情況就不存 */ }
  }
  function drawStars(done, popIndex = -1) {
    $('#stars').innerHTML = STAGES.map((s, i) => `<span class="${i < done ? 'on' : ''}${i === popIndex ? ' pop' : ''}" title="${s.title}">⭐</span>`).join('');
  }

  // ---------- 音樂 ----------
  let musicOn = true, ducked = false;
  const music = {
    start() {
      if (!cfg.music) { $('#musicBtn').hidden = true; return; }
      bgm.src = cfg.music;
      bgm.volume = 0.6;
      bgm.play().catch(() => {});
    },
    // 播影片時先把背景音樂停掉
    duck(on) {
      ducked = on;
      if (!cfg.music) return;
      if (on || !musicOn) bgm.pause(); else bgm.play().catch(() => {});
    },
  };
  $('#musicBtn').onclick = () => {
    musicOn = !musicOn;
    $('#musicBtn').classList.toggle('off', !musicOn);
    music.duck(ducked);
  };

  const ctx = { cfg, music };

  // ---------- 關卡流程 ----------
  async function play(from) {
    $('#intro').hidden = true;
    $('#hud').hidden = false;
    drawStars(from);
    for (let i = from; i < STAGES.length; i++) {
      stageEl.replaceChildren();
      await STAGES[i].run(stageEl, { ...ctx, index: i, stage: STAGES[i] });
      saveProgress(i + 1);
      drawStars(i + 1, i);
    }
    finale();
  }

  // 還沒做的關卡：顯示施工中，按鈕直接過關
  function placeholder(container, { index, stage }) {
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.className = 'screen';
      wrap.innerHTML = `<div class="stage-card">
          <div class="emoji">${stage.emoji}</div>
          <div class="stage-no">STAGE ${index + 1}</div>
          <h2>${stage.title}</h2>
          <div class="todo-tag">🚧 這關還在準備中</div><br>
          <button class="big-btn">${index === STAGES.length - 1 ? '完成！' : '下一關 →'}</button>
        </div>`;
      wrap.querySelector('button').onclick = resolve;
      container.appendChild(wrap);
    });
  }

  function finale() {
    stageEl.innerHTML = `<div class="screen"><div class="stage-card">
        <div class="emoji">🎉</div>
        <h2>全部通關！</h2>
        <p>生日快樂，${cfg.herName} 💖</p>
        <button class="big-btn ghost" id="replayBtn">再玩一次</button>
      </div></div>`;
    $('#replayBtn').onclick = () => { saveProgress(0); play(0); };
  }

  // ---------- 開場 ----------
  $('.intro-to').textContent = `To ${cfg.herName}`;
  const progress = loadProgress();
  if (progress > 0 && progress < STAGES.length) {
    $('#startBtn').textContent = `繼續第 ${progress + 1} 關 ✈️`;
    $('#restartBtn').hidden = false;
  }
  if (cfg.password) {
    $('#pwForm').hidden = false;
    $('.pw-hint').textContent = cfg.passwordHint || '';
  }

  function tryStart(from) {
    if (cfg.password && $('#pwInput').value.trim() !== String(cfg.password)) {
      $('.pw-error').hidden = false;
      const card = $('.intro-card');
      card.classList.remove('shake'); void card.offsetWidth; card.classList.add('shake');
      return;
    }
    music.start(); // 一定要在點擊當下開始播，手機才允許有聲音
    play(from >= STAGES.length ? 0 : from);
  }
  $('#startBtn').onclick = () => tryStart(progress);
  $('#restartBtn').onclick = () => { saveProgress(0); tryStart(0); };
  $('#pwForm').onsubmit = (e) => { e.preventDefault(); tryStart(progress); };
})();
