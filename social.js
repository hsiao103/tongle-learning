'use strict';
/*
 * 同樂學習入口：Google 登入、分享作品、按讚、留言。
 * 後端為 Supabase（設定見 config.js 與 supabase-setup.sql）。
 * 未設定時自動進入「示範模式」，資料只存在目前瀏覽器的 localStorage。
 */
(() => {
  const cfg = window.TONGLE_CONFIG || {};
  const LIVE = Boolean(cfg.supabaseUrl && cfg.supabaseAnonKey);
  const SDK = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js';
  const BUCKET = 'work-covers';
  const NICK_KEY = 'tl_nick';
  const CAT = { explore: '校園探索', game: '遊戲學習', teach: '教學互動' };
  const ART = { explore: 'sand', game: 'mint', teach: 'peach' };
  const ROLE = { teacher: '教師作品', student: '學生作品', guest: '訪客作品' };

  const $ = (sel, root = document) => root.querySelector(sel);

  // 以 DOM API 建立元素；文字一律走 textContent，避免使用者內容被當成 HTML。
  function el(tag, props = {}, ...kids) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v === false || v == null) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    node.append(...kids.flat().filter(x => x != null));
    return node;
  }

  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
    },
    set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 隱私模式等情況略過 */ } }
  };

  const S = {
    user: null,                 // { id, name, avatar }
    admin: false,
    likes: new Map(),           // work_key -> Set(user_id)
    commentCount: new Map(),    // work_key -> number
    comments: new Map(),        // work_key -> [comment]（展開留言後才載入）
    works: new Map(),           // 'w:'+id -> work
    wishes: [],                 // 許願池（只在登入後載入）
    wvotes: new Map(),          // wish_id -> Set(user_id)
    clicks: null                // work_key -> 累計開啟次數；null＝尚未載入或資料庫還沒建立統計功能
  };
  let api = null;

  const safeUrl = u => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : null; } catch { return null; } };
  const safeImg = u => (typeof u === 'string' && (/^https:\/\//.test(u) || /^data:image\/(jpeg|png|webp);base64,/.test(u))) ? u : null;
  const nick = () => String(store.get(NICK_KEY, '') || (S.user && S.user.name) || '同樂夥伴').slice(0, 20);
  const fmtDate = iso => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleDateString('zh-TW', { year: 'numeric', month: 'numeric', day: 'numeric' }); };

  /* ---- 點擊統計：匿名訪客代號（只存在這個瀏覽器，不含任何個資）---- */
  const taipeiDay = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  function visitorId() {
    let v = store.get('tl_vid', '');
    if (typeof v !== 'string' || v.length < 8) {
      const a = new Uint8Array(12);
      try { crypto.getRandomValues(a); } catch { for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256); }
      v = [...a].map(b => b.toString(16).padStart(2, '0')).join('');
      store.set('tl_vid', v);
    }
    return v;
  }

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 3500);
  }
  const openDlg = d => { if (!d) return; if (typeof d.showModal === 'function') { if (!d.open) d.showModal(); } else d.setAttribute('open', ''); };
  const closeDlg = d => { if (!d) return; if (typeof d.close === 'function') { if (d.open) d.close(); } else d.removeAttribute('open'); };

  /* ---------------------------------------------------------------
   * 後端 A：示範模式（localStorage）
   * ------------------------------------------------------------- */
  function localBackend() {
    const K = { works: 'tl_demo_works', likes: 'tl_demo_likes', comments: 'tl_demo_comments', user: 'tl_demo_user' };
    const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
    let notify = () => {};
    return {
      demo: true,
      async init(onChange) { notify = onChange; return store.get(K.user, null); },
      async signIn() { const u = { id: 'demo-user', name: '示範使用者', avatar: '' }; store.set(K.user, u); notify(u); },
      async signOut() { store.set(K.user, null); notify(null); },
      async isAdmin() { return true; },
      async listWorks() { return store.get(K.works, []).sort((a, b) => b.created_at.localeCompare(a.created_at)); },
      async addWork(w, blob) {
        const image_url = blob ? await blobToDataUrl(blob) : null;
        const row = { id: uid(), ...w, image_url, author_id: S.user.id, author_role: 'guest', created_at: new Date().toISOString() };
        store.set(K.works, [...store.get(K.works, []), row]);
        return row;
      },
      async deleteWork(w) {
        const key = 'w:' + w.id;
        store.set(K.works, store.get(K.works, []).filter(x => x.id !== w.id));
        store.set(K.likes, store.get(K.likes, []).filter(x => x.work_key !== key));
        store.set(K.comments, store.get(K.comments, []).filter(x => x.work_key !== key));
      },
      async listLikes() { return store.get(K.likes, []); },
      async setLike(key, on) {
        const rest = store.get(K.likes, []).filter(x => !(x.work_key === key && x.user_id === S.user.id));
        if (on) rest.push({ work_key: key, user_id: S.user.id });
        store.set(K.likes, rest);
      },
      async commentKeys() { return store.get(K.comments, []).map(c => c.work_key); },
      async listComments(key) { return store.get(K.comments, []).filter(c => c.work_key === key).sort((a, b) => a.created_at.localeCompare(b.created_at)); },
      async addComment(key, body) {
        const row = { id: uid(), work_key: key, user_id: S.user.id, author_name: nick(), avatar_url: '', body, created_at: new Date().toISOString() };
        store.set(K.comments, [...store.get(K.comments, []), row]);
        return row;
      },
      async deleteComment(id) { store.set(K.comments, store.get(K.comments, []).filter(c => c.id !== id)); },
      async listWishes() { return store.get('tl_demo_wishes', []); },
      async addWish(body) {
        const row = { id: uid(), user_id: S.user.id, author_name: nick(), avatar_url: '', body, status: 'open', created_at: new Date().toISOString() };
        store.set('tl_demo_wishes', [row, ...store.get('tl_demo_wishes', [])]);
        return row;
      },
      async deleteWish(id) {
        store.set('tl_demo_wishes', store.get('tl_demo_wishes', []).filter(w => w.id !== id));
        store.set('tl_demo_wvotes', store.get('tl_demo_wvotes', []).filter(v => v.wish_id !== id));
      },
      async setWishStatus(id, status) { store.set('tl_demo_wishes', store.get('tl_demo_wishes', []).map(w => (w.id === id ? { ...w, status } : w))); },
      async listWishVotes() { return store.get('tl_demo_wvotes', []); },
      async setWishVote(id, on) {
        const rest = store.get('tl_demo_wvotes', []).filter(v => !(v.wish_id === id && v.user_id === S.user.id));
        if (on) rest.push({ wish_id: id, user_id: S.user.id });
        store.set('tl_demo_wvotes', rest);
      },
      async trackClick(key) {
        const rows = store.get('tl_demo_clicks', []), day = taipeiDay(), v = visitorId();
        if (rows.some(r => r.work_key === key && r.visitor === v && r.day === day)) return;
        rows.push({ work_key: key, visitor: v, day, role: S.user ? 'teacher' : 'guest' });
        store.set('tl_demo_clicks', rows);
      },
      async clickCounts() {
        const m = {};
        store.get('tl_demo_clicks', []).forEach(r => { m[r.work_key] = (m[r.work_key] || 0) + 1; });
        return Object.entries(m).map(([work_key, total]) => ({ work_key, total }));
      },
      async clickStats(days) {
        const from = new Date(Date.now() + 8 * 3600e3 - (days - 1) * 86400e3).toISOString().slice(0, 10), m = {};
        store.get('tl_demo_clicks', []).filter(r => r.day >= from).forEach(r => { const k = r.work_key + '|' + r.role + '|' + r.day; m[k] = (m[k] || 0) + 1; });
        return Object.entries(m).map(([k, n]) => { const [work_key, role, day] = k.split('|'); return { work_key, role, day, n }; });
      }
    };
  }

  /* ---------------------------------------------------------------
   * 後端 B：Supabase
   * ------------------------------------------------------------- */
  async function supabaseBackend() {
    if (!window.supabase) {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = SDK; s.onload = resolve; s.onerror = () => reject(new Error('Supabase SDK 載入失敗'));
        document.head.append(s);
      });
    }
    const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
    const toUser = session => {
      const u = session && session.user;
      if (!u) return null;
      const m = u.user_metadata || {};
      return { id: u.id, name: m.full_name || m.name || '同樂夥伴', avatar: m.avatar_url || m.picture || '' };
    };
    const must = ({ data, error }) => { if (error) throw error; return data; };
    return {
      demo: false,
      async init(onChange) {
        // 回呼內不可直接 await Supabase 呼叫，所以延後一個 tick 再處理
        sb.auth.onAuthStateChange((_event, session) => setTimeout(() => onChange(toUser(session)), 0));
        return toUser(must(await sb.auth.getSession()).session);
      },
      signIn: () => sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + location.pathname } }),
      signOut: () => sb.auth.signOut(),
      async isAdmin() { const { data, error } = await sb.rpc('is_admin'); return !error && data === true; },
      async listWorks() { return must(await sb.from('works').select('*').order('created_at', { ascending: false }).limit(200)); },
      async addWork(w, blob) {
        let image_url = null;
        if (blob) {
          const path = `${S.user.id}/${Date.now()}.jpg`;
          const up = await sb.storage.from(BUCKET).upload(path, blob, { contentType: 'image/jpeg' });
          if (up.error) throw up.error;
          image_url = sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
        }
        return must(await sb.from('works').insert({ ...w, image_url }).select().single());
      },
      async deleteWork(w) {
        must(await sb.from('works').delete().eq('id', w.id));
        const marker = `/${BUCKET}/`;
        if (w.image_url && w.image_url.includes(marker)) {
          await sb.storage.from(BUCKET).remove([decodeURIComponent(w.image_url.split(marker)[1])]).catch(() => {});
        }
      },
      async listLikes() { return must(await sb.from('likes').select('work_key,user_id').limit(10000)); },
      async setLike(key, on) {
        if (on) {
          const { error } = await sb.from('likes').insert({ work_key: key, user_id: S.user.id });
          if (error && error.code !== '23505') throw error;   // 23505：已按過讚，視為成功
        } else {
          must(await sb.from('likes').delete().eq('work_key', key).eq('user_id', S.user.id));
        }
      },
      async commentKeys() { return must(await sb.from('comments').select('work_key').limit(10000)).map(r => r.work_key); },
      async listComments(key) {
        return must(await sb.from('comments').select('id,user_id,author_name,avatar_url,body,created_at').eq('work_key', key).order('created_at').limit(200));
      },
      async addComment(key, body) {
        return must(await sb.from('comments').insert({ work_key: key, user_id: S.user.id, author_name: nick(), avatar_url: S.user.avatar || null, body }).select().single());
      },
      async deleteComment(id) { must(await sb.from('comments').delete().eq('id', id)); },
      async listWishes() { return must(await sb.from('wishes').select('id,user_id,author_name,avatar_url,body,status,created_at').order('created_at', { ascending: false }).limit(300)); },
      async addWish(body) { return must(await sb.from('wishes').insert({ user_id: S.user.id, author_name: nick(), avatar_url: S.user.avatar || null, body }).select().single()); },
      async deleteWish(id) { must(await sb.from('wishes').delete().eq('id', id)); },
      async setWishStatus(id, status) { must(await sb.from('wishes').update({ status }).eq('id', id)); },
      async listWishVotes() { return must(await sb.from('wish_votes').select('wish_id,user_id').limit(20000)); },
      async setWishVote(id, on) {
        if (on) {
          const { error } = await sb.from('wish_votes').insert({ wish_id: id, user_id: S.user.id });
          if (error && error.code !== '23505') throw error;
        } else must(await sb.from('wish_votes').delete().eq('wish_id', id).eq('user_id', S.user.id));
      },
      // 點擊紀錄用 keepalive 直接送出，即使同一分頁立刻跳轉也不會被中斷；失敗時靜默略過，不影響使用者
      async trackClick(key) {
        const { data } = await sb.auth.getSession();
        const headers = { apikey: cfg.supabaseAnonKey, 'Content-Type': 'application/json' };
        if (data && data.session) headers.Authorization = 'Bearer ' + data.session.access_token;
        await fetch(cfg.supabaseUrl + '/rest/v1/rpc/track_click', { method: 'POST', keepalive: true, headers, body: JSON.stringify({ p_key: key, p_visitor: visitorId() }) });
      },
      async clickCounts() { return must(await sb.rpc('click_counts')); },
      async clickStats(days) { return must(await sb.rpc('click_stats', { p_days: days })); }
    };
  }

  /* ---------------------------------------------------------------
   * 圖片處理：縮到最長邊 960px 並轉成 JPEG（<1MB），再上傳
   * ------------------------------------------------------------- */
  function toJpegBlob(file, max = 960) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const r = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.width * r));
        c.height = Math.max(1, Math.round(img.height * r));
        const g = c.getContext('2d');
        g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
        g.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob(b => (b ? resolve(b) : reject(new Error('圖片轉換失敗'))), 'image/jpeg', 0.82);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('無法讀取圖片')); };
      img.src = url;
    });
  }
  const blobToDataUrl = blob => new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result); fr.onerror = reject; fr.readAsDataURL(blob);
  });

  /* ---------------------------------------------------------------
   * 卡片上的互動列：按讚、留言、（作者／管理者）刪除
   * ------------------------------------------------------------- */
  function buildSocial(card) {
    if ($('.social', card)) return;
    const k = card.dataset.work;
    const title = ($('h3', card) || {}).textContent || '這個作品';
    const pid = 'cmt-' + k.replace(/[^a-z0-9]/gi, '-');
    const likeBtn = el('button', { class: 'like-btn', type: 'button', 'aria-pressed': 'false', 'aria-label': `為「${title}」按讚` },
      el('span', { class: 'heart', 'aria-hidden': 'true', text: '♡' }),
      el('span', { class: 'like-text', text: '按讚' }),
      el('span', { class: 'count', text: '0' }));
    const cmtBtn = el('button', { class: 'cmt-btn', type: 'button', 'aria-expanded': 'false', 'aria-controls': pid, 'aria-label': `查看或留言：「${title}」` },
      el('span', { 'aria-hidden': 'true', text: '✎' }),
      el('span', { text: '留言' }),
      el('span', { class: 'count', text: '0' }));
    const delBtn = el('button', { class: 'del-btn', type: 'button', hidden: true, text: '刪除作品', 'aria-label': `刪除作品「${title}」` });
    const clickInfo = el('span', { class: 'click-count', hidden: true, title: '累計開啟次數（同一位訪客、同一作品、同一天只算一次）' });
    const panel = el('div', { class: 'cmt-panel', id: pid, hidden: true });
    $('.card-body', card).append(el('div', { class: 'social', 'data-key': k }, el('div', { class: 'social-row' }, likeBtn, cmtBtn, delBtn, clickInfo), panel));
    likeBtn.addEventListener('click', () => onLike(k, likeBtn));
    cmtBtn.addEventListener('click', () => togglePanel(k, cmtBtn, panel));
    delBtn.addEventListener('click', () => onDeleteWork(k));
  }

  function paint() {
    const sb = $('#stats-btn');
    if (sb) sb.hidden = !S.admin;
    document.querySelectorAll('.social').forEach(s => {
      const k = s.dataset.key;
      const likers = S.likes.get(k) || new Set();
      const liked = Boolean(S.user && likers.has(S.user.id));
      const lb = $('.like-btn', s);
      lb.setAttribute('aria-pressed', String(liked));
      $('.heart', lb).textContent = liked ? '♥' : '♡';
      $('.like-text', lb).textContent = liked ? '已按讚' : '按讚';
      $('.count', lb).textContent = String(likers.size);
      $('.cmt-btn .count', s).textContent = String(S.commentCount.get(k) || 0);
      const ci = $('.click-count', s);
      if (ci) {
        ci.hidden = !S.clicks;
        if (S.clicks) { const n = S.clicks.get(k) || 0; ci.textContent = `↗ 開啟 ${n} 次`; ci.setAttribute('aria-label', `已被開啟 ${n} 次`); }
      }
      const w = S.works.get(k);
      $('.del-btn', s).hidden = !(w && S.user && (S.admin || w.author_id === S.user.id));
      const panel = $('.cmt-panel', s);
      if (!panel.hidden && panel.dataset.ready && S.comments.has(k)) syncPanel(k, panel);
    });
  }

  async function onLike(k, btn) {
    if (!S.user) return needLogin('按讚');
    const set = S.likes.get(k) || new Set();
    const was = set.has(S.user.id);
    if (was) set.delete(S.user.id); else set.add(S.user.id);
    S.likes.set(k, set);
    paint();
    btn.disabled = true;
    try { await api.setLike(k, !was); }
    catch (e) {
      console.error(e);
      if (was) set.add(S.user.id); else set.delete(S.user.id);
      paint(); toast('按讚失敗，請稍後再試');
    } finally { btn.disabled = false; }
  }

  /* ---- 留言面板 ---- */
  function buildPanel(k, panel) {
    const list = el('ul', { class: 'cmt-list', 'aria-live': 'polite' }, el('li', { class: 'cmt-empty', text: '載入中…' }));
    const ta = el('textarea', { rows: '2', maxlength: '300', placeholder: '留下友善的回饋，最多 300 字', 'aria-label': '留言內容', required: true });
    const send = el('button', { class: 'btn-send', type: 'submit', text: '送出' });
    const form = el('form', { class: 'cmt-form' }, ta, send);
    const gate = el('button', { class: 'cmt-gate', type: 'button', text: '登入後即可留言' });
    form.addEventListener('submit', e => { e.preventDefault(); onComment(k, ta, send); });
    gate.addEventListener('click', () => needLogin('留言'));
    panel.append(list, form, gate);
    panel.dataset.ready = '1';
  }

  function commentItem(k, c) {
    const mine = Boolean(S.user && c.user_id === S.user.id);
    const name = c.author_name || '同樂夥伴';
    const av = safeImg(c.avatar_url);
    const avatar = av
      ? el('img', { class: 'cmt-avatar', src: av, alt: '', width: '28', height: '28', referrerpolicy: 'no-referrer', loading: 'lazy' })
      : el('span', { class: 'cmt-avatar fallback', 'aria-hidden': 'true', text: name.slice(0, 1) });
    const meta = el('div', { class: 'cmt-meta' }, el('strong', { text: name }), el('time', { datetime: c.created_at, text: fmtDate(c.created_at) }));
    if (mine || S.admin) meta.append(el('button', { class: 'cmt-del', type: 'button', text: '刪除', 'aria-label': '刪除這則留言', onclick: () => onDeleteComment(k, c.id) }));
    return el('li', { class: 'cmt-item' }, avatar, el('div', { class: 'cmt-main' }, meta, el('p', { text: c.body })));
  }

  function syncPanel(k, panel) {
    const list = $('.cmt-list', panel);
    const items = S.comments.get(k) || [];
    list.replaceChildren();
    if (!items.length) list.append(el('li', { class: 'cmt-empty', text: '還沒有留言，來當第一位吧！' }));
    items.forEach(c => list.append(commentItem(k, c)));
    $('.cmt-form', panel).hidden = !S.user;
    $('.cmt-gate', panel).hidden = Boolean(S.user);
  }

  async function togglePanel(k, btn, panel) {
    const willOpen = panel.hidden;
    panel.hidden = !willOpen;
    btn.setAttribute('aria-expanded', String(willOpen));
    if (!willOpen) return;
    if (!panel.dataset.ready) buildPanel(k, panel);
    if (!S.comments.has(k)) {
      try { S.comments.set(k, await api.listComments(k)); }
      catch (e) { console.error(e); toast('留言載入失敗，請稍後再試'); return; }
    }
    syncPanel(k, panel);
  }

  async function onComment(k, ta, send) {
    if (!S.user) return needLogin('留言');
    const body = ta.value.trim();
    if (!body) return;
    send.disabled = true;
    try {
      const row = await api.addComment(k, body.slice(0, 300));
      S.comments.set(k, [...(S.comments.get(k) || []), row]);
      S.commentCount.set(k, (S.commentCount.get(k) || 0) + 1);
      ta.value = '';
      paint();
    } catch (e) { console.error(e); toast('留言送出失敗，請稍後再試'); }
    finally { send.disabled = false; }
  }

  async function onDeleteComment(k, id) {
    if (!confirm('確定要刪除這則留言嗎？')) return;
    try {
      await api.deleteComment(id);
      S.comments.set(k, (S.comments.get(k) || []).filter(c => c.id !== id));
      S.commentCount.set(k, Math.max(0, (S.commentCount.get(k) || 1) - 1));
      paint();
    } catch (e) { console.error(e); toast('刪除失敗，請稍後再試'); }
  }

  /* ---------------------------------------------------------------
   * 使用者分享的作品卡
   * ------------------------------------------------------------- */
  function workCard(w) {
    const k = 'w:' + w.id;
    const cat = CAT[w.category] ? w.category : 'game';
    const img = safeImg(w.image_url);
    const href = safeUrl(w.url);
    const author = w.author_name || '同樂夥伴';
    const role = ROLE[w.author_role] ? w.author_role : 'guest';
    const art = el('div', { class: `card-art ${ART[cat]}` },
      el('span', { class: `role-badge ${role}`, text: ROLE[role] }),
      el('span', { class: 'card-no', text: 'COMMUNITY / 社群分享' }),
      img ? el('img', { src: img, alt: `${w.title} 的封面圖`, width: '600', height: '340', loading: 'lazy', referrerpolicy: 'no-referrer' })
          : el('div', { class: 'card-glyph', 'aria-hidden': 'true', text: '✳︎' }),
      el('span', { class: 'art-chip', text: `分享者・${author}` }));
    const tags = (Array.isArray(w.tags) ? w.tags : []).slice(0, 4).map(t => el('li', { text: String(t).slice(0, 12) }));
    const body = el('div', { class: 'card-body' },
      el('p', { class: 'category' }, `${CAT[cat]} `, el('span', { text: '✦' }), ' 社群分享'),
      el('h3', { text: w.title }),
      el('p', { class: 'description', text: w.description || '分享者尚未填寫簡介。' }),
      el('ul', { class: 'tags', 'aria-label': '作品特色' }, tags),
      href ? el('a', { class: 'project-link', href, target: '_blank', rel: 'noopener noreferrer ugc' },
        '前往作品 ', el('span', { 'aria-hidden': 'true', text: '↗' }), el('span', { class: 'sr-only', text: '（另開分頁）' })) : null);
    return el('article', { class: 'project-card', 'data-category': cat, 'data-role': role, 'data-work': k, 'data-user-work': '1' }, art, body);
  }

  function insertWork(w, prepend) {
    const grid = $('.project-grid');
    const card = workCard(w);
    const firstUser = $('.project-card[data-user-work]', grid);
    if (prepend && firstUser) grid.insertBefore(card, firstUser); else grid.append(card);
    buildSocial(card);
  }

  async function onDeleteWork(k) {
    const w = S.works.get(k);
    if (!w || !confirm(`確定要刪除「${w.title}」嗎？這個作品的按讚與留言也會一併移除。`)) return;
    try {
      await api.deleteWork(w);
      S.works.delete(k); S.likes.delete(k); S.comments.delete(k); S.commentCount.delete(k);
      const card = $(`.project-card[data-work="${CSS.escape(k)}"]`);
      if (card) card.remove();
      if (window.TongleFilter) window.TongleFilter.refresh();
      toast('已刪除作品');
    } catch (e) { console.error(e); toast('刪除失敗，請稍後再試'); }
  }

  /* ---------------------------------------------------------------
   * 許願池：只有登入者看得到（前端隱藏＋資料庫 RLS 雙重把關）
   * ------------------------------------------------------------- */
  function paintWishes() {
    const sec = $('#wishes'), nav = $('#wish-nav');
    const on = Boolean(S.user);
    if (sec) sec.hidden = !on;
    if (nav) nav.hidden = !on;
    const list = $('#wish-list');
    if (!on || !list) { if (list) list.replaceChildren(); return; }
    const votes = w => (S.wvotes.get(w.id) || new Set()).size;
    const items = [...S.wishes].sort((a, b) => (a.status === 'done') - (b.status === 'done') || votes(b) - votes(a) || b.created_at.localeCompare(a.created_at));
    list.replaceChildren();
    if (!items.length) list.append(el('li', { class: 'wish-empty', text: '許願池還是空的，來投下第一個願望吧！' }));
    items.forEach(w => {
      const set = S.wvotes.get(w.id) || new Set();
      const voted = set.has(S.user.id);
      const mine = w.user_id === S.user.id;
      const meta = el('div', { class: 'wish-meta' }, el('strong', { text: w.author_name || '同樂夥伴' }), el('time', { datetime: w.created_at, text: fmtDate(w.created_at) }));
      if (w.status === 'done') meta.append(el('span', { class: 'wish-badge', text: '✓ 已實現' }));
      const acts = el('div', { class: 'wish-actions' },
        el('button', { type: 'button', class: 'wish-vote', 'aria-pressed': String(voted), onclick: () => onWishVote(w.id) }, `🙏 我也想要 ${set.size}`));
      if (S.admin) acts.append(el('button', { type: 'button', class: 'wish-link', text: w.status === 'done' ? '改回許願中' : '標為已實現', onclick: () => onWishStatus(w) }));
      if (mine || S.admin) acts.append(el('button', { type: 'button', class: 'wish-link', text: '刪除', 'aria-label': '刪除這個願望', onclick: () => onWishDelete(w.id) }));
      list.append(el('li', { class: 'wish-item' + (w.status === 'done' ? ' done' : '') }, meta, el('p', { text: w.body }), acts));
    });
  }

  let wishSeq = 0;
  async function loadWishes() {
    const seq = ++wishSeq;
    if (!S.user) { S.wishes = []; S.wvotes = new Map(); paintWishes(); return; }
    try {
      const [ws, vs] = await Promise.all([api.listWishes(), api.listWishVotes()]);
      if (seq !== wishSeq || !S.user) return;
      S.wishes = ws;
      S.wvotes = new Map();
      vs.forEach(v => { if (!S.wvotes.has(v.wish_id)) S.wvotes.set(v.wish_id, new Set()); S.wvotes.get(v.wish_id).add(v.user_id); });
    } catch (e) {
      console.error(e);
      S.wishes = []; S.wvotes = new Map();
      toast('許願池讀取失敗。若剛設定好，請確認已執行最新的 supabase-setup.sql。');
    }
    paintWishes();
  }

  async function onWishSubmit(e) {
    e.preventDefault();
    if (!S.user) return needLogin('使用許願池');
    const ta = $('#wish-body'), btn = $('#wish-form button[type=submit]');
    const body = ta.value.trim();
    if (body.length < 2) { toast('願望至少要寫 2 個字喔'); return; }
    btn.disabled = true;
    try {
      const row = await api.addWish(body.slice(0, 200));
      S.wishes = [row, ...S.wishes];
      ta.value = ''; $('#wish-count').textContent = '0 / 200';
      paintWishes(); toast('願望已投進許願池 🪙');
    } catch (err) {
      console.error(err);
      toast(err && err.code === 'P0001' ? '今天許太多願望囉，明天再來吧！' : '投遞失敗，請稍後再試');
    } finally { btn.disabled = false; }
  }

  async function onWishVote(id) {
    if (!S.user) return needLogin('使用許願池');
    const set = S.wvotes.get(id) || new Set();
    const was = set.has(S.user.id);
    if (was) set.delete(S.user.id); else set.add(S.user.id);
    S.wvotes.set(id, set); paintWishes();
    try { await api.setWishVote(id, !was); }
    catch (err) { console.error(err); if (was) set.add(S.user.id); else set.delete(S.user.id); paintWishes(); toast('操作失敗，請稍後再試'); }
  }

  async function onWishStatus(w) {
    const next = w.status === 'done' ? 'open' : 'done';
    try { await api.setWishStatus(w.id, next); w.status = next; paintWishes(); }
    catch (err) { console.error(err); toast('更新失敗，請稍後再試'); }
  }

  async function onWishDelete(id) {
    if (!confirm('確定要刪除這個願望嗎？')) return;
    try { await api.deleteWish(id); S.wishes = S.wishes.filter(w => w.id !== id); S.wvotes.delete(id); paintWishes(); }
    catch (err) { console.error(err); toast('刪除失敗，請稍後再試'); }
  }

  /* ---------------------------------------------------------------
   * 登入與帳號
   * ------------------------------------------------------------- */
  function needLogin(action) {
    $('#login-reason').textContent = `登入後才能${action}。`;
    openDlg($('#login-dialog'));
  }

  function paintAuth() {
    const btn = $('#auth-btn');
    if (!btn) return;
    btn.replaceChildren();
    if (S.user) {
      const av = safeImg(S.user.avatar);
      if (av) btn.append(el('img', { src: av, alt: '', width: '22', height: '22', referrerpolicy: 'no-referrer' }));
      btn.append(el('span', { text: nick() }));
      btn.setAttribute('aria-label', `我的帳號：${nick()}`);
    } else {
      btn.append(el('span', { text: 'Google 登入' }));
      btn.setAttribute('aria-label', '使用 Google 登入');
    }
  }

  async function onUserChange(u) {
    if ((u && u.id) === (S.user && S.user.id)) return;
    S.user = u;
    S.admin = u ? await api.isAdmin().catch(() => false) : false;
    paintAuth(); paint(); loadWishes();
    if (u) closeDlg($('#login-dialog'));
  }

  async function doSignIn() {
    try { await api.signIn(); } catch (e) { console.error(e); toast('登入失敗，請稍後再試'); }
  }

  /* ---------------------------------------------------------------
   * 分享作品表單
   * ------------------------------------------------------------- */
  async function onAddSubmit(e) {
    if (e.submitter && e.submitter.value === 'cancel') return;   // 「取消」交給 dialog 原生關閉
    e.preventDefault();
    const f = e.target;
    const err = $('#add-error');
    const btn = $('#add-submit');
    err.textContent = '';
    if (!S.user) { closeDlg($('#add-dialog')); return needLogin('分享作品'); }
    const title = f.elements['w-title'].value.trim();
    const url = safeUrl(f.elements['w-url'].value.trim());
    const description = f.elements['w-desc'].value.trim();
    const category = f.elements['w-category'].value;
    const tags = f.elements['w-tags'].value.split(/[,，、\s]+/).map(t => t.trim().slice(0, 10)).filter(Boolean).slice(0, 4);
    const file = f.elements['w-image'].files[0];
    if (!title) { err.textContent = '請填寫作品名稱。'; return; }
    if (!url) { err.textContent = '請填寫以 http:// 或 https:// 開頭的作品網址。'; return; }
    if (!CAT[category]) { err.textContent = '請選擇分類。'; return; }
    if (file && (!/^image\//.test(file.type) || file.size > 10 * 1024 * 1024)) { err.textContent = '封面圖請選擇 10MB 以內的圖片檔。'; return; }
    btn.disabled = true; btn.textContent = '上傳中…';
    try {
      const blob = file ? await toJpegBlob(file) : null;
      const row = await api.addWork({ title: title.slice(0, 60), description: description.slice(0, 300), category, url, tags, author_name: nick() }, blob);
      S.works = new Map([['w:' + row.id, row], ...S.works]);
      insertWork(row, true);
      paint();
      if (window.TongleFilter) window.TongleFilter.refresh();
      f.reset();
      closeDlg($('#add-dialog'));
      toast('作品已分享到作品列表！');
      const card = $(`.project-card[data-work="${CSS.escape('w:' + row.id)}"]`);
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (ex) {
      console.error(ex);
      err.textContent = '上傳失敗，請稍後再試。若持續發生，請通知管理者。';
    } finally { btn.disabled = false; btn.textContent = '分享作品'; }
  }

  /* ---------------------------------------------------------------
   * 點擊統計：記錄、顯示、管理者面板
   * ------------------------------------------------------------- */
  function onOpenWork(e) {
    if (e.type === 'auxclick' && e.button !== 1) return;   // 中鍵開新分頁也算
    const a = e.target.closest && e.target.closest('a.project-link');
    const card = a && a.closest('.project-card[data-work]');
    if (!card || !api) return;
    const key = card.dataset.work, day = taipeiDay();
    const seen = store.get('tl_clk', {});
    const keys = seen.day === day ? seen.keys : [];
    if (keys.includes(key)) return;                         // 今天已記過，不重複送出
    store.set('tl_clk', { day, keys: [...keys, key] });
    api.trackClick(key).then(() => {
      if (S.clicks) { S.clicks.set(key, (S.clicks.get(key) || 0) + 1); paint(); }
    }).catch(() => {});
  }

  async function loadClicks() {
    try {
      const rows = await api.clickCounts();
      S.clicks = new Map(rows.map(r => [r.work_key, Number(r.total)]));
    } catch (e) { S.clicks = null; }                        // 資料庫尚未執行統計的 SQL：不顯示，其他功能照常
    paint();
  }

  const ROLE_TXT = { guest: '訪客', teacher: '教師', student: '學生' };
  async function openStats() {
    const dlg = $('#stats-dialog'), body = $('#stats-body'), sel = $('#stats-range');
    openDlg(dlg);
    body.replaceChildren(el('p', { class: 'dlg-note', text: '載入中…' }));
    let rows;
    try { rows = await api.clickStats(Number(sel.value)); }
    catch (e) { console.error(e); body.replaceChildren(el('p', { class: 'dlg-note', text: '無法讀取統計：請確認已執行最新的 supabase-setup.sql，且你的信箱已加入管理者名單。' })); return; }
    const title = k => { const c = $(`.project-card[data-work="${CSS.escape(k)}"] h3`); return c ? c.textContent : (k + '（已移除）'); };
    const per = new Map(), perDay = new Map();
    let total = 0;
    rows.forEach(r => {
      const n = Number(r.n); total += n;
      const o = per.get(r.work_key) || { total: 0, guest: 0, teacher: 0, student: 0 };
      o.total += n; o[r.role] = (o[r.role] || 0) + n; per.set(r.work_key, o);
      perDay.set(r.day, (perDay.get(r.day) || 0) + n);
    });
    const list = [...per.entries()].sort((a, b) => b[1].total - a[1].total);
    const max = list.length ? list[0][1].total : 1;
    const head = el('p', { class: 'stats-total' }, '期間總開啟 ', el('strong', { text: String(total) }), ' 次（每位訪客每天、每個作品最多算一次）');
    const table = el('table', { class: 'stats-table' },
      el('thead', {}, el('tr', {}, ['作品', '合計', '訪客', '教師', '學生'].map(h => el('th', { scope: 'col', text: h })))),
      el('tbody', {}, list.length ? list.map(([k, o]) => el('tr', {},
        el('th', { scope: 'row' }, el('span', { text: title(k) }), el('span', { class: 'bar', style: `width:${Math.max(3, Math.round(o.total / max * 100))}%`, 'aria-hidden': 'true' })),
        el('td', { text: String(o.total) }), el('td', { text: String(o.guest) }), el('td', { text: String(o.teacher) }), el('td', { text: String(o.student) })))
        : [el('tr', {}, el('td', { colspan: '5', text: '這段期間還沒有點擊紀錄。' }))]));
    const days = Number(sel.value), dayEls = [], dayMax = Math.max(1, ...perDay.values());
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() + 8 * 3600e3 - i * 86400e3).toISOString().slice(0, 10), n = perDay.get(d) || 0;
      dayEls.push(el('span', { class: 'dbar', title: `${d}：${n} 次`, style: `height:${Math.max(2, Math.round(n / dayMax * 100))}%` }));
    }
    body.replaceChildren(head, el('div', { class: 'stats-days', role: 'img', 'aria-label': `每日開啟次數長條圖，共 ${days} 天` }, dayEls), el('div', { class: 'stats-scroll' }, table),
      el('p', { class: 'dlg-note', text: `身分依登入信箱網域判斷（tmail＝教師、smail＝學生），未登入一律算訪客。` }));
  }

  /* ---------------------------------------------------------------
   * 初始化
   * ------------------------------------------------------------- */
  function showBanner(msg) {
    const b = $('#demo-banner');
    if (!b) return;
    b.textContent = msg; b.hidden = false;
  }

  function bindUI() {
    $('#auth-btn').addEventListener('click', () => {
      if (S.user) { $('#nick-input').value = nick(); $('#account-name').textContent = api.demo ? '示範模式帳號（資料只存在此瀏覽器）' : `已使用 Google 登入：${S.user.name}`; openDlg($('#account-dialog')); }
      else doSignIn();
    });
    $('#add-work-btn').addEventListener('click', () => (S.user ? openDlg($('#add-dialog')) : needLogin('分享作品')));
    $('#google-login').addEventListener('click', doSignIn);
    $('#logout-btn').addEventListener('click', async () => {
      closeDlg($('#account-dialog'));
      try { await api.signOut(); if (!api.demo) { /* 由 onAuthStateChange 通知 */ } } catch (e) { console.error(e); toast('登出失敗，請稍後再試'); }
    });
    $('#account-form').addEventListener('submit', () => {
      const v = $('#nick-input').value.trim().slice(0, 20);
      store.set(NICK_KEY, v);
      paintAuth();
    });
    $('#add-form').addEventListener('submit', onAddSubmit);
    $('#wish-form').addEventListener('submit', onWishSubmit);
    $('#wish-body').addEventListener('input', e => { $('#wish-count').textContent = `${e.target.value.length} / 200`; });
    document.addEventListener('click', onOpenWork);
    document.addEventListener('auxclick', onOpenWork);
    const sbtn = $('#stats-btn');
    if (sbtn) { sbtn.addEventListener('click', openStats); $('#stats-range').addEventListener('change', openStats); }
  }

  async function loadData() {
    try {
      const [works, likes, keys] = await Promise.all([api.listWorks(), api.listLikes(), api.commentKeys()]);
      S.likes = new Map();
      likes.forEach(r => { if (!S.likes.has(r.work_key)) S.likes.set(r.work_key, new Set()); S.likes.get(r.work_key).add(r.user_id); });
      S.commentCount = new Map();
      keys.forEach(key => S.commentCount.set(key, (S.commentCount.get(key) || 0) + 1));
      S.works = new Map(works.map(w => ['w:' + w.id, w]));
      document.querySelectorAll('.project-card[data-user-work]').forEach(c => c.remove());
      works.forEach(w => insertWork(w, false));
      if (window.TongleFilter) window.TongleFilter.refresh();
    } catch (e) {
      console.error(e);
      toast('社群資料暫時讀取失敗。若剛設定好，請確認已執行 supabase-setup.sql。');
    }
    paint();
  }

  async function boot() {
    document.querySelectorAll('.project-card[data-work]').forEach(buildSocial);
    let bannerMsg = '';
    try { api = LIVE ? await supabaseBackend() : localBackend(); }
    catch (e) { console.error(e); api = localBackend(); bannerMsg = '無法連線到資料庫，目前改用示範模式：按讚、留言與分享的內容只會存在這個瀏覽器。'; }
    if (!bannerMsg && api.demo) bannerMsg = '示範模式：尚未連接資料庫（見 config.js），按讚、留言與分享的內容只會存在這個瀏覽器，也不會是真正的 Google 登入。';
    if (bannerMsg) showBanner(bannerMsg);
    if (api.demo) $('#google-login').textContent = '以示範身分登入（僅此瀏覽器）';
    bindUI();
    S.user = await api.init(onUserChange);
    S.admin = S.user ? await api.isAdmin().catch(() => false) : false;
    paintAuth();
    await loadData();
    loadClicks();
    loadWishes();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
