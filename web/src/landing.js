// ─── Landing page logic ───
// Scramble animation, scroll observer, chart grid fade.

import { $ } from "./lib/utils.js";

const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#%&*+=/<>[]{}?';

export function initScrambleCycle(el, words, duration = 900, hold = 2000) {
  if (!el || words.length === 0) return;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    el.textContent = words[0];
    return;
  }

  const totalFrames = Math.max(1, Math.round(duration / 16));
  let raf = 0, timer = 0, idx = 0, current = words[0], frame = 0, slots = [];

  const build = (target) => {
    const len = Math.max(current.length, target.length);
    el.replaceChildren();
    slots = [];
    for (let i = 0; i < len; i++) {
      const span = document.createElement('span');
      span.setAttribute('aria-hidden', 'true');
      el.appendChild(span);
      const start = Math.floor((i / len) * totalFrames * 0.5) + Math.floor(Math.random() * 6);
      const end = start + 8 + Math.floor(Math.random() * totalFrames * 0.5);
      slots.push({ from: current[i] || '', to: target[i] || '', start, end, glyph: '', span, state: '' });
    }
  };

  const tick = () => {
    let done = 0;
    for (const s of slots) {
      if (frame >= s.end) {
        if (s.state !== 'done') { s.span.textContent = s.to; s.span.className = ''; s.state = 'done'; }
        done++;
      } else if (frame >= s.start) {
        if (!s.glyph || Math.random() < 0.28) s.glyph = GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
        s.span.textContent = s.glyph;
        if (s.state !== 'scr') { s.span.className = 'glyph'; s.state = 'scr'; }
      } else {
        s.span.textContent = s.from;
      }
    }
    frame++;
    if (done < slots.length) {
      raf = requestAnimationFrame(tick);
    } else {
      current = words[idx];
      timer = window.setTimeout(advance, hold);
    }
  };

  const advance = () => {
    idx = (idx + 1) % words.length;
    build(words[idx]);
    frame = 0;
    raf = requestAnimationFrame(tick);
  };

  build(words[0]);
  frame = 0;
  raf = requestAnimationFrame(tick);

  return () => { cancelAnimationFrame(raf); clearTimeout(timer); };
}

export function initScrollObserver() {
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) entry.target.classList.add('visible');
    });
  }, { threshold: 0.15 });

  document.querySelectorAll('.story-card').forEach((card) => observer.observe(card));
}

export function initChartGridFade() {
  const grid = $('#chart-grid');
  if (!grid) return;

  let raf = 0;
  const update = () => {
    raf = 0;
    const p = Math.min(1, Math.max(0, window.scrollY / (window.innerHeight * 0.6)));
    const a = 1 - p;
    grid.style.setProperty('--grid-v', `rgba(26,29,38,${(0.05 * a).toFixed(3)})`);
    grid.style.setProperty('--grid-h', `rgba(26,29,38,${(0.08 * a).toFixed(3)})`);
    grid.style.setProperty('--grid-op', a.toFixed(3));
  };

  const onScroll = () => {
    if (!raf) raf = requestAnimationFrame(update);
  };

  update();
  window.addEventListener('scroll', onScroll, { passive: true });
  return () => {
    window.removeEventListener('scroll', onScroll);
    if (raf) cancelAnimationFrame(raf);
  };
}
