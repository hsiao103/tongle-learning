// 同樂學習入口：社群功能（登入、按讚、留言、分享作品）的後端設定。
// 1. 在 Supabase 建立專案並執行 supabase-setup.sql
// 2. 在 Authentication → Providers 啟用 Google
// 3. 把下面兩個值換成專案的 Project URL 與 anon (publishable) key。
//    anon key 設計上就是公開的，資料安全由資料表的 RLS 規則負責，可以放心放在 GitHub。
// 兩個值都留空時，頁面會進入「示範模式」：功能可試玩，但資料只存在這個瀏覽器。
window.TONGLE_CONFIG = {
  supabaseUrl: 'https://sjhibwvjiupjjwokawuk.supabase.co',      // 例：https://abcdxyz.supabase.co
  supabaseAnonKey: 'sb_publishable_azKOkCRTtidnIp9chJa2FA_c85MX3XY'   // 例：eyJhbGciOi...（anon / publishable key）
};
