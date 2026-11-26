// ============================================================
// 生日闖關網頁的設定檔：名字、頭貼、旅行地點、照片影片都在這裡改
// 照片和影片放在 public/birthday/media/ 資料夾，這裡只寫檔名
// ============================================================
window.BIRTHDAY_CONFIG = {
  herName: '寶貝',          // 開場顯示「To 寶貝」
  myName: '我',

  // 開場密碼（例如紀念日 0214）；留空 '' 就不用輸入密碼
  password: '',
  passwordHint: '提示：我們的紀念日（4 位數）',

  // 背景音樂（可不填）：例如 'media/our-song.mp3'
  music: '',

  // 兩個人的頭貼：正方形、臉在中間最好看
  avatars: {
    me: 'media/avatar-me.jpg',
    her: 'media/avatar-her.jpg',
  },

  // ---------- 第 1 關：旅遊地圖 ----------
  // 飛機從 home 出發，照下面的順序飛到每個地點，抵達後播放照片／影片
  // 想照時間順序就調整順序（整段 { ... } 搬上搬下）
  home: { name: '台北', lat: 25.03, lng: 121.56 },

  trips: [
    {
      country: 'Japan',          // 地圖上要塗色的國家（英文名，見 media/README.md）
      title: '日本・東京',        // 抵達時顯示的大標題
      flag: '🇯🇵',
      date: '',                  // 例如 '2023.04'，不填就不顯示
      lat: 35.68, lng: 139.69,   // 降落的位置
      media: [
        // 照片：jpg / png / webp；影片：mp4 / mov / webm
        { src: 'media/tokyo-1.jpg', caption: '東京的回憶 1' },
        { src: 'media/tokyo-2.jpg', caption: '東京的回憶 2' },
        { src: 'media/tokyo-3.mp4', caption: '東京的影片' },
      ],
    },
    {
      country: 'Vietnam',
      title: '越南・峴港',
      flag: '🇻🇳',
      date: '',
      lat: 16.05, lng: 108.22,
      media: [
        { src: 'media/danang-1.jpg', caption: '峴港的回憶 1' },
        { src: 'media/danang-2.jpg', caption: '峴港的回憶 2' },
      ],
    },
    {
      country: 'South Korea',
      title: '韓國・釜山',
      flag: '🇰🇷',
      date: '',
      lat: 35.18, lng: 129.08,
      media: [
        { src: 'media/busan-1.jpg', caption: '釜山的回憶 1' },
        { src: 'media/busan-2.jpg', caption: '釜山的回憶 2' },
      ],
    },
    {
      country: 'Japan',
      title: '日本・大阪',
      flag: '🇯🇵',
      date: '',
      lat: 34.69, lng: 135.5,
      media: [
        { src: 'media/osaka-1.jpg', caption: '大阪的回憶 1' },
        { src: 'media/osaka-2.jpg', caption: '大阪的回憶 2' },
      ],
    },
    {
      country: 'Malaysia',
      title: '馬來西亞・沙巴',
      flag: '🇲🇾',
      date: '',
      lat: 5.98, lng: 116.07,    // 亞庇（哥打京那巴魯）
      media: [
        { src: 'media/sabah-1.jpg', caption: '沙巴的回憶 1' },
        { src: 'media/sabah-2.jpg', caption: '沙巴的回憶 2' },
      ],
    },
  ],

  // 照片每張停留幾秒（影片會播完才換下一張）
  slideSeconds: 4.5,

  // 全部飛完後的結語
  mapEnding: '這些都是和你一起走過的地方\n接下來，還想跟你去更多更多地方 ✈️',
};
