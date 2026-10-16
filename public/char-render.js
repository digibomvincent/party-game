// ============================================================
// char-render.js － 角色素材（各遊戲共用）：全部用程式即時畫出來
//   - 大頭：角色的 head 圖（沒圖就畫預設臉）；玩家照片功能（目前隱藏）也走這裡
//   - 身體：6 格跑步動畫的 sprite sheet，每種衣服顏色畫一張
// 使用前要先 CharRender.init(phaserGame)
// ============================================================
const CharRender = (() => {
  const HEAD_SIZE = 76;            // 大頭顯示大小（像素）
  const BODY_SCALE = 0.9;          // 身體 sprite 縮放
  const BODY_FRAME_W = 80, BODY_FRAME_H = 100, BODY_FRAMES = 6;
  const PHOTO_PX = 128;            // 大頭貼圖的解析度

  let phaserGame = null;
  const textures = () => phaserGame.textures;

  function makeHeadTexture(p, img) {
    // 同一位玩家重複使用同一張 canvas 貼圖（照片載入後原地重畫，已顯示的大頭會自動更新）
    const key = 'head-' + p.id;
    const tex = textures().exists(key) ? textures().get(key) : textures().createCanvas(key, PHOTO_PX, PHOTO_PX);
    const g = tex.getContext(), r = PHOTO_PX / 2;
    g.clearRect(0, 0, PHOTO_PX, PHOTO_PX);
    g.save();
    g.beginPath(); g.arc(r, r, r - 4, 0, Math.PI * 2); g.clip();
    if (img) {
      g.drawImage(img, 0, 0, PHOTO_PX, PHOTO_PX);
    } else {                                   // 預設笑臉
      g.fillStyle = '#fcd34d'; g.fillRect(0, 0, PHOTO_PX, PHOTO_PX);
      g.fillStyle = '#111';
      g.beginPath(); g.arc(r - 20, r - 10, 7, 0, 7); g.arc(r + 20, r - 10, 7, 0, 7); g.fill();
      g.lineWidth = 6; g.lineCap = 'round'; g.strokeStyle = '#111';
      g.beginPath(); g.arc(r, r + 6, 24, 0.2, Math.PI - 0.2); g.stroke();
    }
    g.restore();
    g.lineWidth = 6; g.strokeStyle = '#fff';
    g.beginPath(); g.arc(r, r, r - 3, 0, Math.PI * 2); g.stroke();
    tex.refresh();
  }
  // 玩家加入時：先用預設臉，照片載完再換成真的
  function loadHead(p, photo) {
    makeHeadTexture(p, null);
    if (!photo) return;
    const img = new Image();
    img.onload = () => makeHeadTexture(p, img);
    img.src = photo;
  }

  // 角色大頭貼圖（key = 'char-角色id'）：先畫預設臉，有 public/img 的圖檔就換成圖檔
  function makeCharHead(c, i) {
    const key = 'char-' + c.id;
    const tex = textures().exists(key) ? textures().get(key) : textures().createCanvas(key, PHOTO_PX, PHOTO_PX);
    const g = tex.getContext();
    g.clearRect(0, 0, PHOTO_PX, PHOTO_PX);
    CharArt.drawFace(g, PHOTO_PX, i);
    tex.refresh();
    CharArt.loadImage(c, (img) => {
      g.clearRect(0, 0, PHOTO_PX, PHOTO_PX);
      CharArt.drawImage(g, img, PHOTO_PX);
      tex.refresh();
    });
  }

  // 畫一格跑步動作（t = 這格在步伐週期中的角度）
  function drawBodyFrame(g, ox, t, color) {
    const bob = Math.abs(Math.sin(t)) * 4;
    const hipX = ox + BODY_FRAME_W / 2, hipY = 62 - bob, neckY = 24 - bob;
    const limb = (x, y, a1, a2, len, w) => {       // 兩節肢體：回傳末端座標
      const kx = x + Math.sin(a1) * len, ky = y + Math.cos(a1) * len;
      const ex = kx + Math.sin(a2) * len, ey = ky + Math.cos(a2) * len;
      g.lineCap = g.lineJoin = 'round';
      g.strokeStyle = '#111'; g.lineWidth = w + 5;
      g.beginPath(); g.moveTo(x, y); g.lineTo(kx, ky); g.lineTo(ex, ey); g.stroke();
      g.strokeStyle = color; g.lineWidth = w;
      g.beginPath(); g.moveTo(x, y); g.lineTo(kx, ky); g.lineTo(ex, ey); g.stroke();
      return [ex, ey];
    };
    const leg = (ph) => {                          // 腿：向後蹬時伸直，向前抬時彎膝
      const a = Math.sin(t + ph) * 0.9;
      const [fx, fy] = limb(hipX, hipY, a, a - 0.5 - 0.6 * Math.max(0, Math.sin(t + ph + 1.4)), 15, 9);
      g.fillStyle = '#fff'; g.strokeStyle = '#111'; g.lineWidth = 3;
      g.beginPath(); g.ellipse(fx + 4, fy, 8, 5, 0, 0, 7); g.fill(); g.stroke();   // 鞋子
    };
    const arm = (ph) => {                          // 手：與腿反向擺動，手肘彎曲
      const a = -Math.sin(t + ph) * 1.0;
      const [hx, hy] = limb(hipX, neckY + 8, a, a + 1.2, 12, 7);
      g.fillStyle = '#fff'; g.strokeStyle = '#111'; g.lineWidth = 2;
      g.beginPath(); g.arc(hx, hy, 4.5, 0, 7); g.fill(); g.stroke();
    };
    leg(Math.PI); arm(0);                          // 後面的腿和手
    g.fillStyle = color; g.strokeStyle = '#111'; g.lineWidth = 3;   // 身體
    g.beginPath(); g.roundRect(hipX - 14, neckY, 28, hipY - neckY + 8, 10); g.fill(); g.stroke();
    leg(0); arm(Math.PI);                          // 前面的腿和手
  }
  // 取得（或建立）某個顏色的身體 sprite sheet 與跑步動畫
  function ensureBody(scene, color) {
    const key = 'body-' + color;
    if (scene.textures.exists(key)) return key;
    const tex = scene.textures.createCanvas(key, BODY_FRAME_W * BODY_FRAMES, BODY_FRAME_H);
    const g = tex.getContext();
    const frames = [];
    for (let i = 0; i < BODY_FRAMES; i++) {
      drawBodyFrame(g, i * BODY_FRAME_W, (i / BODY_FRAMES) * Math.PI * 2, color);
      tex.add('f' + i, 0, i * BODY_FRAME_W, 0, BODY_FRAME_W, BODY_FRAME_H);
      frames.push({ key, frame: 'f' + i });
    }
    tex.refresh();
    scene.anims.create({ key: 'run-' + color, frames, frameRate: 12, repeat: -1 });
    return key;
  }

  return {
    HEAD_SIZE, BODY_SCALE, BODY_FRAME_W, BODY_FRAME_H, BODY_FRAMES, PHOTO_PX,
    init(g) { phaserGame = g; },
    loadHead, makeCharHead, ensureBody,
  };
})();
