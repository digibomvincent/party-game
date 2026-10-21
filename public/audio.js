// 音效與配樂（只在主畫面播放）。全部用 Web Audio 即時合成，不需要任何音檔。
//   Sfx.play('hit', { power: 0.8 })   播一個音效
//   Sfx.music('race')                 切換配樂（null = 停止）；同一首重複呼叫不會重來
//   Sfx.setMuted(true) / Sfx.setVolume(0~1)
// 瀏覽器規定要使用者點過頁面才能出聲：第一次點擊／按鍵後才會真的開始播（在那之前呼叫的 music() 會被記住）。
const Sfx = (() => {
  let ctx = null, master = null, sfxBus = null, musicBus = null;
  let muted = false, volume = 0.7;
  let wantTrack = null, curTrack = null;           // 想播的 / 正在播的配樂
  let timer = null, nextStep = 0, stepIdx = 0;     // 配樂排程
  const lastAt = {};                               // 各音效上次播放時間（避免同時間疊太多）
  try { muted = localStorage.getItem('pg-muted') === '1'; const v = parseFloat(localStorage.getItem('pg-volume')); if (v >= 0 && v <= 1) volume = v; } catch (e) { /* 沒有 localStorage 也沒關係 */ }

  // ---------- 引擎 ----------
  function init(c) {
    ctx = c;
    master = ctx.createGain();
    const comp = ctx.createDynamicsCompressor();            // 壓縮器：很多人同時撞也不會爆音
    sfxBus = ctx.createGain(); musicBus = ctx.createGain();
    sfxBus.gain.value = 0.9; musicBus.gain.value = 0.8;
    sfxBus.connect(master); musicBus.connect(master);
    master.connect(comp); comp.connect(ctx.destination);
    applyVolume();
    noiseBuf = null;
    return ctx;
  }
  function ensure() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { init(new AC()); } catch (e) { return null; }
    return ctx;
  }
  function applyVolume() { if (master) master.gain.value = muted ? 0 : volume * volume; }   // 平方：滑桿中段比較好調

  let noiseBuf = null;
  function noise() {
    if (noiseBuf) return noiseBuf;
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return noiseBuf;
  }
  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

  // 一個音：type 波形、freq 起始頻率、slide 結束頻率（可省略）、dur 秒、vol、at 開始時間、bus 送去哪
  function tone({ type = 'sine', freq, slide, dur = 0.2, vol = 0.3, at, attack = 0.005, bus, detune = 0 }) {
    const t = at != null ? at : ctx.currentTime;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t); o.detune.value = detune;
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, slide), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(bus || sfxBus);
    o.start(t); o.stop(t + dur + 0.02);
  }
  // 一段雜訊（經過濾波）：打擊、風聲、群眾
  function hiss({ dur = 0.2, vol = 0.3, at, filter = 'lowpass', f0 = 2000, f1, q = 1, attack = 0.005, bus }) {
    const t = at != null ? at : ctx.currentTime;
    const s = ctx.createBufferSource(); s.buffer = noise();
    const f = ctx.createBiquadFilter(), g = ctx.createGain();
    f.type = filter; f.Q.value = q; f.frequency.setValueAtTime(f0, t);
    if (f1) f.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(bus || sfxBus);
    s.start(t, Math.random() * 0.5); s.stop(t + dur + 0.02);
  }

  // ---------- 音效 ----------
  const arp = (notes, step, o) => notes.forEach((m, i) => tone({ type: 'square', freq: mtof(m), dur: o.dur || 0.18, vol: o.vol || 0.14, at: ctx.currentTime + i * step }));
  const SFX = {
    join: () => arp([72, 79], 0.09, { vol: 0.16 }),
    pick: () => tone({ type: 'triangle', freq: 660, slide: 990, dur: 0.12, vol: 0.2 }),
    beep: () => tone({ type: 'square', freq: 660, dur: 0.16, vol: 0.2 }),
    go: () => { tone({ type: 'square', freq: 1320, dur: 0.5, vol: 0.22 }); tone({ type: 'sawtooth', freq: 660, dur: 0.5, vol: 0.12 }); },
    // 跑步
    step: () => { hiss({ dur: 0.05, vol: 0.12, filter: 'bandpass', f0: 900, q: 2 }); },
    stumble: () => { tone({ type: 'sawtooth', freq: 300, slide: 70, dur: 0.35, vol: 0.2 }); hiss({ dur: 0.2, vol: 0.2, f0: 800, f1: 150 }); },
    finish: () => arp([72, 76, 79, 84], 0.07, { vol: 0.17, dur: 0.22 }),
    // 足球
    kick: (o) => {
      const p = o.power != null ? o.power : 0.5;
      tone({ type: 'sine', freq: 180 + p * 60, slide: 45, dur: 0.18, vol: 0.45 + p * 0.25 });
      hiss({ dur: 0.08, vol: 0.2 + p * 0.2, filter: 'lowpass', f0: 3000, f1: 400 });
    },
    dash: () => hiss({ dur: 0.22, vol: 0.18, filter: 'bandpass', f0: 500, f1: 3000, q: 1.5 }),
    whistle: () => {
      const t = ctx.currentTime;
      for (let k = 0; k < 2; k++) {
        const o = ctx.createOscillator(), lfo = ctx.createOscillator(), lg = ctx.createGain(), g = ctx.createGain();
        o.type = 'sine'; o.frequency.value = 2900; lfo.frequency.value = 38; lg.gain.value = 90;
        lfo.connect(lg); lg.connect(o.frequency);
        const a = t + k * 0.32;
        g.gain.setValueAtTime(0.0001, a); g.gain.linearRampToValueAtTime(0.22, a + 0.02); g.gain.setValueAtTime(0.22, a + 0.2); g.gain.exponentialRampToValueAtTime(0.0001, a + 0.26);
        o.connect(g); g.connect(sfxBus); o.start(a); lfo.start(a); o.stop(a + 0.3); lfo.stop(a + 0.3);
      }
    },
    goal: () => {
      arp([67, 72, 76, 79, 84], 0.09, { vol: 0.2, dur: 0.3 });
      hiss({ dur: 1.6, vol: 0.28, filter: 'bandpass', f0: 1200, f1: 2200, q: 0.6, attack: 0.25 });     // 群眾歡呼
      tone({ type: 'sine', freq: 90, slide: 50, dur: 0.5, vol: 0.4 });
    },
    // 陀螺大戰
    hit: (o) => {
      const p = o.power != null ? o.power : 0.5;
      tone({ type: 'square', freq: 220 + p * 200, slide: 90, dur: 0.12, vol: 0.12 + p * 0.1 });
      hiss({ dur: 0.1, vol: 0.2 + p * 0.25, filter: 'highpass', f0: 1500, f1: 600 });
      if (p > 0.6) tone({ type: 'sine', freq: 120, slide: 45, dur: 0.22, vol: 0.4 });
    },
    ram: () => { hiss({ dur: 0.35, vol: 0.25, filter: 'bandpass', f0: 300, f1: 2800, q: 1.2 }); tone({ type: 'sawtooth', freq: 110, slide: 260, dur: 0.3, vol: 0.12 }); },
    fall: () => { tone({ type: 'triangle', freq: 700, slide: 90, dur: 0.6, vol: 0.25 }); hiss({ dur: 0.35, vol: 0.12, filter: 'lowpass', f0: 1800, f1: 200 }); },
    respawn: () => tone({ type: 'triangle', freq: 330, slide: 880, dur: 0.25, vol: 0.2 }),
    shrink: () => tone({ type: 'sawtooth', freq: 140, slide: 90, dur: 0.6, vol: 0.12 }),
    // 通用
    roundEnd: () => { arp([79, 74, 71, 67], 0.12, { vol: 0.17, dur: 0.3 }); },
    win: () => { arp([67, 72, 76, 79, 76, 79, 84], 0.11, { vol: 0.2, dur: 0.35 }); tone({ type: 'triangle', freq: mtof(48), dur: 1.2, vol: 0.25, at: ctx.currentTime + 0.3 }); },
  };
  // 同一種音效最短間隔（秒）：很多人同時按按鈕、撞在一起時，不要變成一團噪音
  const MIN_GAP = { step: 0.045, hit: 0.05, kick: 0.08, dash: 0.1, ram: 0.1, fall: 0.1, respawn: 0.1, stumble: 0.1 };

  function play(name, opts) {
    if (muted || !ensure() || ctx.state !== 'running' || !SFX[name]) return;
    const now = ctx.currentTime;
    if (MIN_GAP[name] && now - (lastAt[name] || -1) < MIN_GAP[name]) return;
    lastAt[name] = now;
    try { SFX[name](opts || {}); } catch (e) { /* 音效壞掉不能影響遊戲 */ }
  }

  // ---------- 配樂 ----------
  // 每首：bpm、tonic（MIDI）、scale（半音間隔）、bass（每小節低音的音階度數）、lead（每小節 16 格，數字 = 音階度數，. = 休止）、drums（k 大鼓 s 小鼓 h 腳踏鈸）
  const MAJOR = [0, 2, 4, 5, 7, 9, 11], MINOR = [0, 2, 3, 5, 7, 8, 10], HARM = [0, 2, 3, 5, 7, 8, 11];
  const TRACKS = {
    lobby: {
      bpm: 100, tonic: 60, scale: MAJOR, bass: [0, 5, 3, 4], vol: { bass: 0.5, pad: 0.35, lead: 0.5, drums: 0.55 },
      lead: ['4 . . 2 . 4 . 7 . . 4 . 2 . . .', '5 . . 7 . 5 . 9 . . 7 . 5 . . .', '7 . . 5 . 3 . 5 . . 7 . 5 . . .', '4 . . 6 . 8 . 6 . . 4 . 1 . . .'],
      drums: { k: 'x...x...x...x...', s: '................', h: '..x...x...x...x.' },
    },
    race: {
      bpm: 152, tonic: 60, scale: MAJOR, bass: [0, 4, 5, 3], vol: { bass: 0.5, pad: 0.25, lead: 0.55, drums: 0.8 },
      lead: ['7 . 9 . 7 . 4 . 7 . 9 . 11 . 9 .', '8 . 6 . 8 . 11 . 8 . 6 . 4 . 6 .', '9 . 7 . 9 . 12 . 9 . 7 . 5 . 7 .', '7 . 5 . 3 . 5 . 7 . 9 . 7 . 5 .'],
      drums: { k: 'x...x...x...x...', s: '....x.......x...', h: 'x.x.x.x.x.x.x.x.' },
    },
    soccer: {
      bpm: 126, tonic: 57, scale: MINOR, bass: [0, 5, 2, 6], vol: { bass: 0.55, pad: 0.3, lead: 0.5, drums: 0.8 },
      lead: ['7 . . 7 . 9 . . 7 . . 5 . 4 . .', '8 . . 8 . 7 . . 5 . . 4 . 2 . .', '9 . . 9 . 11 . . 9 . . 7 . 4 . .', '8 . . 6 . 5 . . 6 . . 5 . 4 . 2'],
      drums: { k: 'x..x..x...x..x..', s: '....x.......x..x', h: 'x.x.x.x.x.x.x.xx' },
    },
    spinner: {
      bpm: 138, tonic: 62, scale: HARM, bass: [0, 3, 4, 0], vol: { bass: 0.55, pad: 0.25, lead: 0.45, drums: 0.85 },
      lead: ['0 2 4 7 4 2 4 7 0 2 4 7 4 2 4 7', '3 5 7 10 7 5 7 10 3 5 7 10 7 5 7 10', '4 6 8 11 8 6 8 11 4 6 8 11 8 6 8 11', '7 . 4 . 2 . 4 . 0 . . . . . . .'],
      drums: { k: 'x..x..x.x..x..x.', s: '....x.......x...', h: '.xx..xx..xx..xx.' },
    },
  };
  const degMidi = (tr, d) => { const o = Math.floor(d / 7), i = ((d % 7) + 7) % 7; return tr.tonic + 12 * o + tr.scale[i]; };
  const LOOKAHEAD = 0.25;

  function scheduleStep(tr, bar, step, t, dur, bus) {
    const v = tr.vol, deg = tr.bass[bar % tr.bass.length];
    // 低音：每小節 4 個八分音符（第 1、3、5、7 拍…）
    if (step % 4 === 0) tone({ type: 'triangle', freq: mtof(degMidi(tr, deg) - 24), dur: dur * 3.6, vol: 0.32 * v.bass, at: t, bus, attack: 0.01 });
    if (step % 8 === 4) tone({ type: 'sawtooth', freq: mtof(degMidi(tr, deg) - 24 + (step === 12 ? 7 : 0)), dur: dur * 1.6, vol: 0.1 * v.bass, at: t, bus });
    // 和弦墊底：每小節換一次
    if (step === 0) for (const k of [0, 2, 4]) tone({ type: 'triangle', freq: mtof(degMidi(tr, deg + k) - 12), dur: dur * 15, vol: 0.09 * v.pad, at: t, bus, attack: 0.08 });
    // 旋律
    const tok = tr.lead[bar % tr.lead.length].split(' ')[step];
    if (tok && tok !== '.') tone({ type: 'square', freq: mtof(degMidi(tr, parseInt(tok, 10)) + 12), dur: dur * 1.8, vol: 0.13 * v.lead, at: t, bus });
    // 鼓
    const d = tr.drums;
    if (d.k[step] === 'x') tone({ type: 'sine', freq: 150, slide: 42, dur: 0.16, vol: 0.55 * v.drums, at: t, bus });
    if (d.s[step] === 'x') { hiss({ dur: 0.14, vol: 0.28 * v.drums, filter: 'highpass', f0: 1800, at: t, bus }); tone({ type: 'triangle', freq: 220, slide: 120, dur: 0.1, vol: 0.18 * v.drums, at: t, bus }); }
    if (d.h[step] === 'x') hiss({ dur: 0.04, vol: 0.12 * v.drums, filter: 'highpass', f0: 7000, at: t, bus });
  }
  // 把排程推進到 until（秒）。timer 每 100ms 呼叫一次；離線測試時也可以手動呼叫
  function pump(until) {
    const tr = TRACKS[curTrack]; if (!tr || !trackBus) return;
    const dur = 60 / tr.bpm / 4;
    while (nextStep < until) {
      const bar = Math.floor(stepIdx / 16), step = stepIdx % 16;
      scheduleStep(tr, bar, step, Math.max(nextStep, ctx.currentTime), dur, trackBus);
      nextStep += dur; stepIdx++;
    }
  }
  let trackBus = null;
  function startTrack(name) {
    stopTrack(0.5);
    if (!name || !TRACKS[name] || !ensure()) return;
    curTrack = name;
    trackBus = ctx.createGain(); trackBus.gain.setValueAtTime(0.0001, ctx.currentTime); trackBus.gain.linearRampToValueAtTime(1, ctx.currentTime + 0.6);
    trackBus.connect(musicBus);
    nextStep = ctx.currentTime + 0.08; stepIdx = 0;
    timer = setInterval(() => pump(ctx.currentTime + LOOKAHEAD), 100);
    pump(ctx.currentTime + LOOKAHEAD);
  }
  function stopTrack(fade) {
    if (timer) { clearInterval(timer); timer = null; }
    if (trackBus && ctx) {
      const b = trackBus, t = ctx.currentTime;
      b.gain.cancelScheduledValues(t); b.gain.setValueAtTime(b.gain.value, t); b.gain.linearRampToValueAtTime(0.0001, t + (fade || 0.3));
      setTimeout(() => { try { b.disconnect(); } catch (e) { /* 已經斷了 */ } }, ((fade || 0.3) + 0.5) * 1000);   // 已排程的音符播完才拆
    }
    trackBus = null; curTrack = null;
  }
  // 切換配樂：沒解鎖前只記住，解鎖後才真的播
  function music(name) {
    wantTrack = name || null;
    if (!ctx || ctx.state !== 'running') return;
    if (wantTrack !== curTrack) startTrack(wantTrack);
  }

  // ---------- 解鎖（使用者第一次點擊）與靜音／音量 ----------
  let unlocked = false;
  function unlock() {
    if (!ensure()) return;
    const go = () => { unlocked = true; updateUi(); music(wantTrack); };
    if (ctx.state === 'running') go(); else ctx.resume().then(go).catch(() => {});
  }
  function setMuted(m) { muted = !!m; try { localStorage.setItem('pg-muted', muted ? '1' : '0'); } catch (e) { /* 略過 */ } applyVolume(); updateUi(); }
  function setVolume(v) { volume = Math.min(1, Math.max(0, v)); try { localStorage.setItem('pg-volume', String(volume)); } catch (e) { /* 略過 */ } applyVolume(); }

  let ui = null;
  function updateUi() {
    if (!ui) return;
    ui.btn.textContent = muted ? '🔇' : '🔊';
    ui.box.classList.toggle('locked', !unlocked);
    ui.box.title = unlocked ? '音效（M：靜音）' : '點一下畫面開啟聲音';
  }
  function mountUi() {
    const box = document.createElement('div'); box.id = 'sndBox';
    box.innerHTML = '<button id="sndBtn" type="button">🔊</button><input id="sndVol" type="range" min="0" max="1" step="0.05">';
    document.body.appendChild(box);
    ui = { box, btn: box.querySelector('#sndBtn'), vol: box.querySelector('#sndVol') };
    ui.vol.value = String(volume);
    ui.btn.onclick = () => { unlock(); setMuted(!muted); };
    ui.vol.oninput = () => { unlock(); setVolume(parseFloat(ui.vol.value)); if (muted) setMuted(false); };
    updateUi();
  }
  if (typeof document !== 'undefined') {
    const once = () => { unlock(); };
    document.addEventListener('pointerdown', once, true);
    document.addEventListener('keydown', (e) => { once(); if (e.key === 'm' || e.key === 'M') setMuted(!muted); }, true);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountUi); else mountUi();
  }

  // 測試用：離線渲染某首配樂 sec 秒（會換掉目前的 AudioContext），回傳 AudioBuffer
  function _render(name, sec) {
    const oc = new OfflineAudioContext(1, 44100 * sec, 44100);
    init(oc); curTrack = name; trackBus = oc.createGain(); trackBus.connect(musicBus); nextStep = 0; stepIdx = 0;
    pump(sec);
    return oc.startRendering();
  }

  return { play, music, unlock, _render, setMuted, setVolume, init, pump, TRACKS,
    isMuted: () => muted, state: () => ({ ctx: ctx && ctx.state, track: curTrack, want: wantTrack, unlocked }) };
})();
