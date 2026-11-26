# 照片、影片放這裡

## 要準備的檔案

| 檔名 | 說明 |
|---|---|
| `avatar-me.jpg` | 你的頭貼（正方形、臉在中間） |
| `avatar-her.jpg` | 她的頭貼 |
| `tokyo-1.jpg`、`tokyo-2.jpg`、`tokyo-3.mp4` | 東京 |
| `danang-1.jpg`、`danang-2.jpg` | 峴港 |
| `busan-1.jpg`、`busan-2.jpg` | 釜山 |
| `osaka-1.jpg`、`osaka-2.jpg` | 大阪 |
| `sabah-1.jpg`、`sabah-2.jpg` | 沙巴 |

- 每個地方的張數不限：多的話在 `../config.js` 對應地點的 `media` 多加幾行，例如
  `{ src: 'media/tokyo-4.jpg', caption: '一句話' }`
- 照片和影片可以混著放，順序就是播放順序；影片放 `.mp4` 最保險（iPhone 的 `.mov` 在部分 Android 不能播）。
- 還沒放的檔案，播放時會顯示「這裡要放照片」和檔名，方便你對照。

## 檔案大小建議

- 照片：長邊 1600px 左右、每張 500KB 以內，手機才不會載很久。
- 影片：每段 15～30 秒、720p，每支 10MB 以內。

## 國家名稱（地圖塗色用，`config.js` 的 `country` 欄位）

Japan、Vietnam、South Korea、Malaysia、Taiwan……
（就是 `../world.svg` 裡 `data-name` 的英文名）
