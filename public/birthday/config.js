// ============================================================
// 生日闖關網頁的設定檔：名字、頭貼、旅行地點、照片影片都在這裡改
// 照片和影片放在 public/birthday/media/ 資料夾，這裡只寫檔名
// ============================================================
window.BIRTHDAY_CONFIG = {
  herName: '寶貝',          // 開場顯示「To 寶貝」
  myName: '我',             // 你的名字或暱稱（第 2 關最後一題的四個選項都是它）

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
  // 每個地點都填了 date（例如 '2023.04'）就會自動照時間排序
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

  // ---------- 第 2 關：回憶大考驗 ----------
  // answer 是正確答案的位置：第一個選項是 0、第二個是 1……
  // 每題都可以加 right / wrong 自訂答對答錯的反應，note 是答對後補充的一句話
  // ⚠️ 下面是範例題目，請換成你們自己的回憶
  quiz: [
    {
      type: 'choice',
      q: '我們第一次一起出國是去哪裡？',
      options: ['東京', '峴港', '釜山', '沙巴'],
      answer: 0,
      note: '那時候連買車票都手忙腳亂 😂',
    },
    {
      type: 'choice',
      q: '我們第一次約會吃了什麼？',
      options: ['火鍋', '拉麵', '義大利麵', '燒肉'],
      answer: 1,
    },
    {
      type: 'choice',
      q: '這張照片是在哪裡拍的？',
      image: 'media/quiz-1.jpg',
      zoom: { x: 50, y: 50, scale: 3 },   // 先放大 3 倍只露出中間一塊，答對後拉遠看全貌
      options: ['大阪', '釜山', '峴港', '沙巴'],
      answer: 3,
    },
    {
      type: 'order',
      q: '把我們的旅行照時間排好！',
      // 不用寫選項：直接用第 1 關的旅行地點，config 裡 trips 的順序就是正確答案
    },
    {
      type: 'choice',
      q: '我最常對你說的一句話是？',
      options: ['肚子餓了', '你好可愛', '等我一下', '都可以'],
      answer: 1,
      wrong: '欸！我明明每天都說 😤',
    },
    {
      type: 'love',
      q: '最後一題：你最愛的人是誰？',
      // 四個選項都會是 myName（上面設定的名字），點哪個都對 😆
    },
  ],
};
