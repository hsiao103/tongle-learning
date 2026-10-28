'use strict';
(() => {
  const buttons = [...document.querySelectorAll('[data-filter]')];
  const cards = [...document.querySelectorAll('.project-card')];
  const status = document.getElementById('result-count');
  function filterProjects(category) {
    if (!buttons.some(button => button.dataset.filter === category)) return;
    buttons.forEach(button => {
      const selected = button.dataset.filter === category;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
    let count = 0;
    cards.forEach(card => {
      card.hidden = category !== 'all' && card.dataset.category !== category;
      if (!card.hidden) count++;
    });
    status.textContent = `共 ${count} 項作品`;
  }
  buttons.forEach(button => button.addEventListener('click', () => filterProjects(button.dataset.filter)));
  document.querySelectorAll('[data-preset]').forEach(link => {
    link.addEventListener('click', () => filterProjects(link.dataset.preset));
  });
})();
