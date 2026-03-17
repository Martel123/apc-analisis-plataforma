const UI = (() => {

  const CRITERIOS_LABELS = {
    diagnostico: 'Diagnóstico',
    propuesta: 'Propuesta',
    medidas: 'Medidas',
    implementacion: 'Implementación',
    viabilidad: 'Viabilidad',
    especificidad: 'Especificidad'
  };

  function scoreBadge(score, size = 'md') {
    if (score === null || score === undefined) {
      return `<span class="score-badge score-none size-${size}">—</span>`;
    }
    const { label, cls } = DataLayer.scoreLabel(score);
    return `<span class="score-badge ${cls} size-${size}" title="${label}">${score.toFixed(1)}</span>`;
  }

  function tagList(items, type = 'neutral') {
    if (!items || items.length === 0) return '<span class="empty-msg">Sin datos</span>';
    return items.map(i => `<span class="tag tag-${type}">${i}</span>`).join('');
  }

  function criteriaBars(criteria) {
    if (!criteria) return '<p class="empty-msg">Sin criterios</p>';
    const keys = ['diagnostico', 'propuesta', 'medidas', 'implementacion', 'viabilidad', 'especificidad'];
    return `<div class="criteria-bars">
      ${keys.map(k => {
        const val = criteria[k];
        const pct = val !== null ? (val / 2) * 100 : 0;
        const cls = val === 2 ? 'bar-full' : val === 1 ? 'bar-half' : 'bar-empty';
        return `
          <div class="criteria-row">
            <span class="criteria-label">${CRITERIOS_LABELS[k]}</span>
            <div class="criteria-track">
              <div class="criteria-fill ${cls}" style="width:${pct}%"></div>
            </div>
            <span class="criteria-val">${val !== null ? val + '/2' : '—'}</span>
          </div>`;
      }).join('')}
    </div>`;
  }

  function kpiCard(label, value, sub = '', color = '') {
    return `
      <div class="kpi-card">
        <div class="kpi-label">${label}</div>
        <div class="kpi-value" style="${color ? 'color:'+color : ''}">${value !== null && value !== undefined ? value : '—'}</div>
        ${sub ? `<div class="kpi-sub">${sub}</div>` : ''}
      </div>`;
  }

  function emptyState(msg = 'Sin datos disponibles') {
    return `<div class="empty-state"><div class="empty-icon">◌</div><p>${msg}</p></div>`;
  }

  function methodologyNote(notes) {
    if (!notes || notes.length === 0) return '';
    return `<div class="methodology-note">
      <div class="methodology-note-header">
        <span class="note-icon">📋</span>
        <strong>Notas metodológicas</strong>
      </div>
      <ul>${notes.map(n => `<li>${n}</li>`).join('')}</ul>
    </div>`;
  }

  function correctionNote(note) {
    if (!note) return '';
    return `<div class="correction-note">
      <span class="correction-icon">✱</span>
      <span>${note}</span>
    </div>`;
  }

  function setHTML(selector, html) {
    const el = document.querySelector(selector);
    if (el) el.innerHTML = html;
  }

  function setText(selector, text) {
    const el = document.querySelector(selector);
    if (el) el.textContent = text;
  }

  function show(selector) {
    const el = document.querySelector(selector);
    if (el) el.style.display = '';
  }

  function hide(selector) {
    const el = document.querySelector(selector);
    if (el) el.style.display = 'none';
  }

  return {
    scoreBadge, tagList, criteriaBars, kpiCard, emptyState,
    methodologyNote, correctionNote, setHTML, setText, show, hide,
    CRITERIOS_LABELS
  };
})();
