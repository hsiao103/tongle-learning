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
    works: new Map()            // 'w:'+id -> work
  };
  let api = null;

  const safeUrl = u => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : null; } catch { return null; } };
  const safeImg = u => (typeof u === 'string' && (/^https:\/\//.test(u) || /^data:image\/(jpeg|png|webp);base64,/.test(u))) ? u : null;
  const nick = () => String(store.get(NICK_KEY, '') || (S.user && S.user.name) || '同樂夥伴').slice(0, 20);
  const fmtDate = iso => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleDateString('zh-TW', { year: 'numeric', month: 'numeric', day: 'numeric' }); };

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
        const row = { id: uid(), ...w, image_url, author_id: S.user.id, created_at: new Date().toISOString() };
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
      async deleteComment(id) { store.set(K.comments, store.get(K.comments, []).filter(c => c.id !== id)); }
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
      async deleteComment(id) { must(await sb.from('comments').delete().eq('id', id)); }
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
    const panel = el('div', { class: 'cmt-panel', id: pid, hidden: true });
    $('.card-body', card).append(el('div', { class: 'social', 'data-key': k }, el('div', { class: 'social-row' }, likeBtn, cmtBtn, delBtn), panel));
    likeBtn.addEventListener('click', () => onLike(k, likeBtn));
    cmtBtn.addEventListener('click', () => togglePanel(k, cmtBtn, panel));
    delBtn.addEventListener('click', () => onDeleteWork(k));
  }

  function paint() {
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
    const art = el('div', { class: `card-art ${ART[cat]}` },
      el('span', { class: 'card-no', text: 'COMMUNITY / 社群分享' }),
      img ? el('img', { src: img, alt: `${w.title} 的封面圖`, width: '600', height: '340', loading: 'lazy', referrerpolicy: 'no-referrer' })
          : el('div', { class: 'card-glyph', 'aria-hidden': 'true', text: '✳' }),
      el('span', { class: 'art-chip', text: `分享者・${author}` }));
    const tags = (Array.isArray(w.tags) ? w.tags : []).slice(0, 4).map(t => el('li', { text: String(t).slice(0, 12) }));
    const body = el('div', { class: 'card-body' },
      el('p', { class: 'category' }, `${CAT[cat]} `, el('span', { text: '✦' }), ' 社群分享'),
      el('h3', { text: w.title }),
      el('p', { class: 'description', text: w.description || '分享者尚未填寫簡介。' }),
      el('ul', { class: 'tags', 'aria-label': '作品特色' }, tags),
      href ? el('a', { class: 'project-link', href, target: '_blank', rel: 'noopener noreferrer ugc' },
        '前往作品 ', el('span', { 'aria-hidden': 'true', text: '↗' }), el('span', { class: 'sr-only', text: '（另開分頁）' })) : null);
    return el('article', { class: 'project-card', 'data-category': cat, 'data-work': k, 'data-user-work': '1' }, art, body);
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
    paintAuth(); paint();
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
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
