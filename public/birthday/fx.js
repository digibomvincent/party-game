// ============================================================
// 共用特效：愛心／彩帶噴發（各關都可以用）
// FX.burst(x, y, { count, emojis })：在螢幕座標 (x, y) 噴出一堆小東西
// FX.rain(ms)：整個畫面下彩帶雨
// ============================================================
window.FX = (() => {
  const layer = document.createElement('div');
  layer.className = 'fx-layer';
  document.addEventListener('DOMContentLoaded', () => document.body.appendChild(layer));

  function piece(text, x, y, dx, dy, rot, ms, size) {
    const p = document.createElement('span');
    p.className = 'fx-piece';
    p.textContent = text;
    p.style.left = `${x}px`;
    p.style.top = `${y}px`;
    p.style.fontSize = `${size}px`;
    layer.appendChild(p);
    p.animate(
      [
        { transform: 'translate(-50%, -50%) scale(.4) rotate(0deg)', opacity: 1 },
        { transform: `translate(calc(-50% + ${dx * 0.7}px), calc(-50% + ${dy * 0.7}px)) scale(1) rotate(${rot * 0.7}deg)`, opacity: 1, offset: 0.6 },
        { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy + 80}px)) scale(.9) rotate(${rot}deg)`, opacity: 0 },
      ],
      { duration: ms, easing: 'cubic-bezier(.2,.8,.4,1)' }
    ).onfinish = () => p.remove();
  }

  function burst(x, y, { count = 18, emojis = ['💖', '💕', '✨', '💗'], spread = 160 } = {}) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = spread * (0.4 + Math.random() * 0.6);
      piece(emojis[i % emojis.length], x, y, Math.cos(a) * r, Math.sin(a) * r - 40, (Math.random() - 0.5) * 360, 900 + Math.random() * 500, 16 + Math.random() * 14);
    }
  }

  function rain(ms = 2500, emojis = ['🎉', '💖', '🎊', '✨', '💕', '🌸']) {
    const end = performance.now() + ms;
    const tick = () => {
      for (let i = 0; i < 3; i++) {
        piece(emojis[(Math.random() * emojis.length) | 0], Math.random() * innerWidth, -20, (Math.random() - 0.5) * 120, innerHeight * (0.7 + Math.random() * 0.4), (Math.random() - 0.5) * 540, 2200 + Math.random() * 1200, 18 + Math.random() * 16);
      }
      if (performance.now() < end) setTimeout(tick, 90);
    };
    tick();
  }

  // 從某個元素的中心噴
  function burstAt(el, opts) {
    const r = el.getBoundingClientRect();
    burst(r.left + r.width / 2, r.top + r.height / 2, opts);
  }

  return { burst, burstAt, rain };
})();
