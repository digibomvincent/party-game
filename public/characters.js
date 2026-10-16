// ============================================================
// characters.js － 主畫面與手機共用：角色大頭的畫法
//   - 角色資料在 characters.json（img 是你之後要放的圖：public/img/char1.png ...）
//   - 圖檔存在就用圖檔；還沒有圖（載入失敗）就畫下面的預設臉
//   - 圖檔建議：正方形、透明背景 PNG（程式會原比例置中縮放，不裁切）
// ============================================================
const CharArt = {
  // 預設臉：index 0~3 對應 characters.json 裡的順序
  drawFace(g, size, index) {
    g.save();
    g.scale(size / 128, size / 128);
    const disc = (color) => {                       // 臉：圓形 + 白色外框
      g.fillStyle = color; g.beginPath(); g.arc(64, 64, 60, 0, 7); g.fill();
      g.lineWidth = 6; g.strokeStyle = '#fff'; g.stroke();
    };
    const dot = (x, y, r, color) => { g.fillStyle = color; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill(); };
    g.lineCap = g.lineJoin = 'round';
    const i = ((index % 4) + 4) % 4;
    if (i === 0) {                                  // 小笑
      disc('#fcd34d');
      dot(44, 54, 7, '#111'); dot(84, 54, 7, '#111');
      g.lineWidth = 6; g.strokeStyle = '#111'; g.beginPath(); g.arc(64, 74, 24, 0.2, Math.PI - 0.2); g.stroke();
    } else if (i === 1) {                           // 小酷（墨鏡）
      disc('#fbbf24');
      g.fillStyle = '#111'; g.beginPath(); g.roundRect(20, 44, 38, 26, 8); g.roundRect(70, 44, 38, 26, 8); g.fill();
      g.fillRect(56, 50, 16, 6);
      g.lineWidth = 6; g.strokeStyle = '#111'; g.beginPath(); g.moveTo(46, 92); g.quadraticCurveTo(70, 104, 90, 86); g.stroke();
    } else if (i === 2) {                           // 小貓
      g.fillStyle = '#fb923c';
      g.beginPath(); g.moveTo(14, 56); g.lineTo(22, 6); g.lineTo(60, 22); g.fill();
      g.beginPath(); g.moveTo(114, 56); g.lineTo(106, 6); g.lineTo(68, 22); g.fill();
      disc('#fb923c');
      g.fillStyle = '#16a34a'; g.beginPath(); g.ellipse(44, 58, 8, 11, 0, 0, 7); g.ellipse(84, 58, 8, 11, 0, 0, 7); g.fill();
      dot(44, 58, 4, '#111'); dot(84, 58, 4, '#111');
      g.fillStyle = '#f472b6'; g.beginPath(); g.moveTo(58, 76); g.lineTo(70, 76); g.lineTo(64, 84); g.fill();
      g.lineWidth = 3; g.strokeStyle = '#111';
      for (const dy of [-4, 6]) {
        g.beginPath(); g.moveTo(34, 88 + dy); g.lineTo(8, 88 + dy * 2); g.moveTo(94, 88 + dy); g.lineTo(120, 88 + dy * 2); g.stroke();
      }
    } else {                                        // 小熊
      dot(24, 24, 20, '#92400e'); dot(104, 24, 20, '#92400e');
      disc('#b45309');
      g.fillStyle = '#fde68a'; g.beginPath(); g.ellipse(64, 82, 26, 20, 0, 0, 7); g.fill();
      dot(44, 54, 6, '#111'); dot(84, 54, 6, '#111'); dot(64, 74, 7, '#111');
      g.lineWidth = 4; g.strokeStyle = '#111'; g.beginPath(); g.moveTo(64, 80); g.lineTo(64, 88);
      g.arc(56, 88, 8, 0, Math.PI * 0.8); g.moveTo(64, 88); g.arc(72, 88, 8, Math.PI, Math.PI * 0.2, true); g.stroke();
    }
    g.restore();
  },
  // 試著載入角色圖檔；載入失敗就什麼都不做（維持預設臉）
  loadImage(c, cb) {
    if (!c.img) return;
    const im = new Image();
    im.onload = () => cb(im);
    im.src = c.img;
  },
  // 把圖檔原比例置中畫進 size x size
  drawImage(g, img, size) {
    const k = Math.min(size / img.width, size / img.height);
    const w = img.width * k, h = img.height * k;
    g.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
  },
};
