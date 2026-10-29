'use strict';
(() => {
  const buttons = [...document.querySelectorAll('[data-filter]')];
  const status = document.getElementById('result-count');
  const allCount = document.querySelector('[data-filter="all"] span');
  let current = 'all';
  // 卡片可能由 social.js 在載入後動態新增，所以每次篩選都重新取得
  const getCards = () => [...document.querySelectorAll('.project-card')];
  const pad = n => String(n).padStart(2, '0');
  function filterProjects(category) {
    if (!buttons.some(button => button.dataset.filter === category)) return;
    current = category;
    buttons.forEach(button => {
      const selected = button.dataset.filter === category;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
    const cards = getCards();
    let count = 0;
    cards.forEach(card => {
      card.hidden = category !== 'all' && card.dataset.category !== category;
      if (!card.hidden) count++;
    });
    status.textContent = `共 ${count} 項作品`;
    if (allCount) allCount.textContent = pad(cards.length);
  }
  buttons.forEach(button => button.addEventListener('click', () => filterProjects(button.dataset.filter)));
  document.querySelectorAll('[data-preset]').forEach(link => {
    link.addEventListener('click', () => filterProjects(link.dataset.preset));
  });
  window.TongleFilter = { refresh: () => filterProjects(current) };
})();
