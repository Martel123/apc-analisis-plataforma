/* ── Guided Tour Engine ───────────────────────────────────────────────────── */
(function () {
  'use strict';

  // ── Step definitions ───────────────────────────────────────────────────────
  const STEPS = [
    // ── index.html ────────────────────────────────────────────────────────────
    {
      n: 1, page: 'index',
      sel: '#tour-home-content',
      title: 'Bienvenido',
      body: 'Esta plataforma te permite explorar análisis técnicos de planes de gobierno de forma clara, visual y estructurada.',
      pos: 'bottom'
    },
    {
      n: 2, page: 'index',
      sel: '#tour-home-hero',
      title: '¿Qué puedes hacer aquí?',
      body: 'Aquí puedes revisar candidatos, abrir análisis individuales y entender cómo están organizadas sus propuestas.',
      pos: 'center'
    },
    {
      n: 3, page: 'index',
      sel: '#tour-btn-analizar',
      title: 'Empieza aquí',
      body: 'Este es el punto de entrada principal para comenzar a explorar la plataforma. Haz clic aquí para ver el listado de candidatos.',
      pos: 'bottom',
      navNext: 'analizar.html',
      allowClick: true
    },
    // ── analizar.html ─────────────────────────────────────────────────────────
    {
      n: 4, page: 'analizar',
      sel: '#tour-page-intro',
      title: 'Listado de candidatos',
      body: 'Aquí encontrarás las tarjetas de los candidatos disponibles. Cada tarjeta resume su evaluación general y te da acceso al análisis completo.',
      pos: 'bottom', wait: true
    },
    {
      n: 5, page: 'analizar',
      sel: '.candidate-card',
      title: 'Lectura rápida',
      body: 'Cada tarjeta muestra una vista resumida del candidato, incluyendo un puntaje general y un acceso directo a su análisis detallado.',
      pos: 'bottom', wait: true
    },
    {
      n: 6, page: 'analizar',
      sel: '.candidate-card',
      title: 'Abrir análisis completo',
      body: 'Haz clic en la tarjeta para entrar a la ficha individual del candidato y revisar su evaluación con mayor detalle.',
      pos: 'bottom', wait: true,
      navNext: 'first-candidate',
      allowClick: true
    },
    // ── candidato.html ────────────────────────────────────────────────────────
    {
      n: 7, page: 'candidato',
      sel: '#tour-cand-header',
      title: 'Ficha individual',
      body: 'Ahora estás dentro del análisis individual del candidato. Aquí verás su información principal y su puntaje general.',
      pos: 'bottom', wait: true
    },
    {
      n: 8, page: 'candidato',
      sel: '#tour-score',
      title: 'Puntaje general',
      body: 'Este número resume técnicamente el nivel de desarrollo de las propuestas evaluadas. No es una opinión política, sino una lectura estructurada del plan.',
      pos: 'left', wait: true
    },
    {
      n: 9, page: 'candidato',
      sel: '#tour-summary',
      title: 'Resumen inicial',
      body: 'En esta sección encontrarás una síntesis técnica del candidato y del enfoque general de su propuesta.',
      pos: 'bottom', wait: true
    },
    {
      n: 10, page: 'candidato',
      sel: '#tour-kpi-row',
      title: 'Indicadores clave',
      body: 'Aquí puedes ver métricas resumidas que ayudan a interpretar rápidamente la evaluación antes de entrar al detalle completo.',
      pos: 'bottom', wait: true
    },
    {
      n: 11, page: 'candidato',
      sel: '#tour-blocks-chart',
      title: 'Lectura por bloques',
      body: 'Esta parte muestra cómo rinde el candidato en los distintos bloques temáticos del análisis. Es útil para detectar fortalezas y debilidades de forma visual.',
      pos: 'top', wait: true
    },
    {
      n: 12, page: 'candidato',
      sel: '#tour-blocks-nav',
      title: 'Navega en detalle',
      body: 'Desde aquí puedes ir bloque por bloque para entender con mayor profundidad la evaluación de cada área temática.',
      pos: 'top', wait: true
    },
    {
      n: 13, page: 'candidato',
      sel: '#pageWrap',
      title: 'Ruta completada',
      body: 'Listo. Ya sabes cómo entrar, abrir un candidato y comenzar a leer su análisis. Puedes volver a ver esta guía cuando quieras desde el botón de ayuda.',
      pos: 'center', wait: true, last: true
    }
  ];

  const PAGE_STEPS = {
    index:     STEPS.filter(s => s.page === 'index'),
    analizar:  STEPS.filter(s => s.page === 'analizar'),
    candidato: STEPS.filter(s => s.page === 'candidato')
  };

  // ── State ─────────────────────────────────────────────────────────────────
  const LS_ACTIVE = 'gt_active';
  const LS_STEP   = 'gt_step';
  const LS_SEEN   = 'gt_seen';
  const TOTAL     = STEPS.length;

  let currentPage    = null;
  let currentStep    = null;
  let spotlight      = null;
  let card           = null;
  let clickHandler   = null;
  let clickLinkTarget= null;
  let resizeTimer    = null;
  let stepRendered   = false;

  // ── DOM helpers ───────────────────────────────────────────────────────────
  function $(sel) { return document.querySelector(sel); }

  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }

  // ── Spotlight ─────────────────────────────────────────────────────────────
  function ensureSpotlight() {
    if (!spotlight) {
      spotlight = el('div', 'gt-spotlight');
      document.body.appendChild(spotlight);
    }
  }

  function positionSpotlight(rect) {
    const PAD = 8;
    spotlight.style.top    = (rect.top    - PAD + window.scrollY) + 'px';
    spotlight.style.left   = (rect.left   - PAD + window.scrollX) + 'px';
    spotlight.style.width  = (rect.width  + PAD * 2) + 'px';
    spotlight.style.height = (rect.height + PAD * 2) + 'px';
    spotlight.style.display = 'block';
  }

  function hideSpotlight() {
    if (spotlight) spotlight.style.display = 'none';
  }

  // ── Card positioning ──────────────────────────────────────────────────────
  function positionCard(rect, pos) {
    if (!card) return;

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cw = card.offsetWidth  || 340;
    const ch = card.offsetHeight || 160;
    const GAP = 16;
    const PAD = 12;

    let top, left;

    if (pos === 'center') {
      top  = (vh - ch) / 2;
      left = (vw - cw) / 2;
    } else if (pos === 'bottom') {
      top  = rect.bottom + GAP;
      left = Math.max(PAD, Math.min(rect.left, vw - cw - PAD));
      if (top + ch > vh - PAD) {
        top = rect.top - ch - GAP;
      }
    } else if (pos === 'top') {
      top  = rect.top - ch - GAP;
      left = Math.max(PAD, Math.min(rect.left, vw - cw - PAD));
      if (top < PAD) {
        top = rect.bottom + GAP;
      }
    } else if (pos === 'left') {
      top  = Math.max(PAD, Math.min(rect.top, vh - ch - PAD));
      left = rect.left - cw - GAP;
      if (left < PAD) {
        left = rect.right + GAP;
      }
    } else {
      top  = rect.bottom + GAP;
      left = Math.max(PAD, Math.min(rect.left, vw - cw - PAD));
    }

    // Clamp to viewport
    top  = Math.max(PAD, Math.min(top,  vh - ch - PAD));
    left = Math.max(PAD, Math.min(left, vw - cw - PAD));

    card.style.top  = top  + 'px';
    card.style.left = left + 'px';
  }

  // ── Card render ───────────────────────────────────────────────────────────
  function renderCard(step) {
    if (card) { card.remove(); card = null; }

    const isFirst = step.n === 1;
    const isLast  = step.last;
    const stepNum = step.n;

    card = el('div', 'gt-card');
    card.innerHTML = `
      <div class="gt-card-step">Paso ${stepNum} de ${TOTAL}</div>
      <h3 class="gt-card-title">${step.title}</h3>
      <p class="gt-card-body">${step.body}</p>
      <div class="gt-card-footer">
        <div class="gt-card-progress">
          ${STEPS.map((s, i) => `<div class="gt-dot${s.n === stepNum ? ' active' : ''}"></div>`).join('')}
        </div>
        <div class="gt-actions">
          ${!isFirst ? '<button class="gt-btn gt-btn-prev">← Anterior</button>' : ''}
          ${isLast
            ? '<button class="gt-btn gt-btn-finish">Finalizar</button>'
            : '<button class="gt-btn gt-btn-next">Siguiente →</button>'
          }
          ${!isLast ? '<button class="gt-btn gt-btn-skip">Saltar</button>' : ''}
        </div>
      </div>`;

    document.body.appendChild(card);

    // Events
    const prev   = card.querySelector('.gt-btn-prev');
    const next   = card.querySelector('.gt-btn-next');
    const skip   = card.querySelector('.gt-btn-skip');
    const finish = card.querySelector('.gt-btn-finish');

    if (prev)   prev.addEventListener('click',   () => go(stepNum - 1));
    if (next)   next.addEventListener('click',   () => advance(step));
    if (skip)   skip.addEventListener('click',   () => endTour(false));
    if (finish) finish.addEventListener('click', () => endTour(true));
  }

  // ── Show a step ───────────────────────────────────────────────────────────
  function showStep(step) {
    currentStep = step;
    const target = $(step.sel);

    if (!target) {
      // Element not found — defer to onContentReady or skip
      stepRendered = false;
      return;
    }

    stepRendered = true;

    // Remove old click handler
    if (clickHandler && clickLinkTarget) {
      clickLinkTarget.removeEventListener('click', clickHandler);
      clickHandler = null;
      clickLinkTarget = null;
    }

    // Scroll target into view (centered)
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });

    // Small delay to let scroll finish, then position
    setTimeout(() => {
      const rect = target.getBoundingClientRect();

      ensureSpotlight();
      if (step.pos !== 'center') {
        positionSpotlight(rect);
      } else {
        hideSpotlight();
      }

      renderCard(step);
      positionCard(rect, step.pos || 'bottom');

      // If this step allows clicking the target to advance, wire it
      if (step.allowClick) {
        wireTargetClick(target, step);
      }
    }, 300);
  }

  function wireTargetClick(target, step) {
    // Resolve the actual clickable element
    clickLinkTarget = target.closest('a') || target.querySelector('a') || target;

    clickHandler = (e) => {
      if (step.navNext === 'first-candidate') {
        e.preventDefault();
        const firstCard = document.querySelector('.candidate-card');
        if (firstCard) {
          localStorage.setItem(LS_STEP, 7);
          window.location.href = firstCard.href;
        } else {
          advance(step);
        }
      } else if (step.navNext) {
        e.preventDefault();
        localStorage.setItem(LS_STEP, step.n + 1);
        window.location.href = step.navNext;
      } else {
        advance(step);
      }
    };

    clickLinkTarget.addEventListener('click', clickHandler, { once: true });
  }

  // ── Advance / navigate ────────────────────────────────────────────────────
  function advance(step) {
    if (step.last) { endTour(true); return; }

    if (step.navNext && step.navNext !== 'first-candidate') {
      localStorage.setItem(LS_STEP, step.n + 1);
      teardown();
      window.location.href = step.navNext;
      return;
    }

    if (step.navNext === 'first-candidate') {
      const firstCard = $('.candidate-card');
      if (firstCard) {
        localStorage.setItem(LS_STEP, 7);
        teardown();
        window.location.href = firstCard.href;
      }
      return;
    }

    go(step.n + 1);
  }

  function go(n) {
    const step = STEPS.find(s => s.n === n);
    if (!step || step.page !== currentPage) return;
    localStorage.setItem(LS_STEP, n);
    showStep(step);
  }

  // ── End tour ──────────────────────────────────────────────────────────────
  function endTour(completed) {
    localStorage.removeItem(LS_ACTIVE);
    localStorage.removeItem(LS_STEP);
    if (completed) {
      localStorage.setItem(LS_SEEN, '1');
    }
    teardown();
  }

  function teardown() {
    if (card)      { card.remove();      card = null; }
    if (spotlight) { spotlight.style.display = 'none'; }
    document.body.classList.remove('gt-tour-active');
  }

  // ── Wait for dynamic content ──────────────────────────────────────────────
  function waitFor(sel, timeout) {
    return new Promise((resolve) => {
      const existing = $(sel);
      if (existing) { resolve(existing); return; }

      const observer = new MutationObserver(() => {
        const el = $(sel);
        if (el) { observer.disconnect(); resolve(el); }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => {
        observer.disconnect();
        resolve($(sel) || null);
      }, timeout || 6000);
    });
  }

  // ── Init on a page ────────────────────────────────────────────────────────
  async function init(pageName) {
    currentPage = pageName;

    // Inject trigger button
    renderTrigger();

    // Check if tour should resume
    const active = localStorage.getItem(LS_ACTIVE);
    const savedN = parseInt(localStorage.getItem(LS_STEP) || '0', 10);
    if (!active) return;

    // Find the step for this page
    const pageSteps = PAGE_STEPS[pageName] || [];
    let startStep   = pageSteps.find(s => s.n === savedN) || pageSteps[0];
    if (!startStep) return;

    document.body.classList.add('gt-tour-active');

    // For pages with async content, wait for the first selector to appear
    if (startStep.wait) {
      await waitFor(startStep.sel, 8000);
    }

    showStep(startStep);
  }

  // ── Called by page after dynamic content renders ──────────────────────────
  function onContentReady() {
    if (!localStorage.getItem(LS_ACTIVE)) return;
    // Only (re-)show the step if it hasn't rendered yet (element was missing)
    if (currentStep && !stepRendered) {
      showStep(currentStep);
    }
  }

  // ── Trigger button ────────────────────────────────────────────────────────
  function renderTrigger() {
    const existing = document.querySelector('.gt-trigger');
    if (existing) return;

    const btn = el('button', 'gt-trigger');
    btn.type = 'button';
    btn.title = 'Cómo usar la plataforma';
    btn.innerHTML = `
      <span class="gt-trigger-icon">?</span>
      <span>Cómo usar la plataforma</span>`;

    btn.addEventListener('click', () => {
      // Always restart from step 1
      startTour();
    });

    document.body.appendChild(btn);
  }

  function startTour() {
    teardown();
    localStorage.setItem(LS_ACTIVE, '1');
    localStorage.setItem(LS_STEP, '1');

    // Navigate to index if not already there
    const page = detectPage();
    if (page !== 'index') {
      window.location.href = 'index.html';
      return;
    }
    document.body.classList.add('gt-tour-active');
    showStep(STEPS[0]);
  }

  // ── Detect current page from URL ──────────────────────────────────────────
  function detectPage() {
    const p = window.location.pathname.split('/').pop().replace('.html', '');
    if (p === '' || p === 'index') return 'index';
    return p;
  }

  // ── Resize handler ────────────────────────────────────────────────────────
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!currentStep || !card) return;
      const target = $(currentStep.sel);
      if (!target) return;
      const rect = target.getBoundingClientRect();
      if (currentStep.pos !== 'center') positionSpotlight(rect);
      positionCard(rect, currentStep.pos || 'bottom');
    }, 80);
  });

  // ── Public API ────────────────────────────────────────────────────────────
  window.GuidedTour = { init, startTour, onContentReady };

})();
