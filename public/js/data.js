const DataLayer = (() => {
  let _cache = null;

  async function fetchCandidates() {
    if (_cache) return _cache;
    const res = await fetch('/api/candidates');
    const json = await res.json();
    _cache = json.candidates.filter(c => c._valid !== false && c.candidate);
    return _cache;
  }

  function safe(val, fallback = null) {
    return val !== undefined && val !== null ? val : fallback;
  }

  function scoreLabel(score) {
    if (score === null || score === undefined) return { label: 'Sin datos', cls: 'score-none' };
    if (score >= 8.5) return { label: 'Excelente', cls: 'score-excellent' };
    if (score >= 7.0) return { label: 'Sólido', cls: 'score-solid' };
    if (score >= 5.5) return { label: 'Intermedio', cls: 'score-medium' };
    if (score >= 4.0) return { label: 'Débil', cls: 'score-weak' };
    return { label: 'Muy débil', cls: 'score-very-weak' };
  }

  function scoreColor(score) {
    if (score === null || score === undefined) return '#9ca3af';
    if (score >= 8.5) return '#16a34a';
    if (score >= 7.0) return '#2563eb';
    if (score >= 5.5) return '#d97706';
    if (score >= 4.0) return '#ea580c';
    return '#dc2626';
  }

  function computeScore(criteria) {
    if (!criteria) return null;
    const fields = ['diagnostico', 'propuesta', 'medidas', 'implementacion', 'viabilidad', 'especificidad'];
    const vals = fields.map(f => criteria[f]).filter(v => typeof v === 'number');
    if (vals.length === 0) return null;
    return Math.round((vals.reduce((a, b) => a + b, 0) / 12) * 100) / 10;
  }

  function normalizeCandidate(raw) {
    const c = raw.candidate || {};
    const blocks = (raw.blocks || []).map(block => ({
      id: safe(block.id, 'bloque'),
      name: safe(block.name, 'Sin nombre'),
      average_score: safe(block.average_score),
      summary: safe(block.summary, ''),
      strengths: safe(block.strengths, []),
      weaknesses: safe(block.weaknesses, []),
      variables: (block.variables || []).map(v => {
        const computedScore = v.final_score !== undefined ? v.final_score : computeScore(v.criteria);
        return {
          id: safe(v.id, 'variable'),
          name: safe(v.name, 'Sin nombre'),
          final_score: computedScore,
          rating_label: safe(v.rating_label, computedScore !== null ? scoreLabel(computedScore).label.toLowerCase() : ''),
          summary: safe(v.summary, ''),
          strengths: safe(v.strengths, []),
          weaknesses: safe(v.weaknesses, []),
          gaps: safe(v.gaps, []),
          conclusion: safe(v.conclusion, ''),
          corrected_methodology: safe(v.corrected_methodology, false),
          correction_note: safe(v.correction_note, ''),
          criteria: {
            diagnostico: safe(v.criteria?.diagnostico, null),
            propuesta: safe(v.criteria?.propuesta, null),
            medidas: safe(v.criteria?.medidas, null),
            implementacion: safe(v.criteria?.implementacion, null),
            viabilidad: safe(v.criteria?.viabilidad, null),
            especificidad: safe(v.criteria?.especificidad, null),
          },
          analysis_sections: safe(v.analysis_sections, {})
        };
      })
    }));

    const totalScore = safe(c.total_score, blocks.length > 0
      ? Math.round(blocks.reduce((s, b) => s + (b.average_score || 0), 0) / blocks.length * 10) / 10
      : null
    );

    return {
      id: safe(c.id, raw._file?.replace('.json', '') || 'candidato'),
      name: safe(c.name, 'Candidato sin nombre'),
      party: safe(c.party, '—'),
      color: safe(c.color, '#b5121b'),
      plan_period: safe(c.plan_period, ''),
      plan_pages: safe(c.plan_pages, null),
      total_score: totalScore,
      ranking_position: safe(c.ranking_position, null),
      summary: safe(c.summary, ''),
      strengths: safe(c.strengths, []),
      weaknesses: safe(c.weaknesses, []),
      methodological_notes: safe(c.methodological_notes, []),
      blocks,
      final_analysis: safe(raw.final_analysis, {}),
      _file: raw._file
    };
  }

  async function getCandidates() {
    const raw = await fetchCandidates();
    return raw.map(normalizeCandidate);
  }

  async function getCandidateById(id) {
    const all = await getCandidates();
    return all.find(c => c.id === id) || null;
  }

  async function getRanking() {
    const all = await getCandidates();
    return [...all]
      .filter(c => c.total_score !== null)
      .sort((a, b) => b.total_score - a.total_score)
      .map((c, i) => ({ ...c, rank: i + 1 }));
  }

  async function getHeatmapMatrix() {
    const all = await getCandidates();
    if (all.length === 0) return { rows: [], candidates: [] };

    const varMap = {};
    for (const c of all) {
      for (const block of c.blocks) {
        for (const v of block.variables) {
          if (!varMap[v.id]) {
            varMap[v.id] = { id: v.id, name: v.name, block: block.name, block_id: block.id, scores: {} };
          }
          varMap[v.id].scores[c.id] = v.final_score;
        }
      }
    }

    const rows = Object.values(varMap);
    const candidateIds = all.map(c => c.id);
    return { rows, candidates: all, candidateIds };
  }

  async function getComparisonData(candidateIds) {
    const all = await getCandidates();
    const selected = all.filter(c => candidateIds.includes(c.id));
    if (selected.length < 2) return null;

    const blockMap = {};
    for (const c of selected) {
      for (const block of c.blocks) {
        if (!blockMap[block.id]) blockMap[block.id] = { id: block.id, name: block.name, scores: {} };
        blockMap[block.id].scores[c.id] = block.average_score;
      }
    }

    return { candidates: selected, blocks: Object.values(blockMap) };
  }

  async function getBlocks() {
    const all = await getCandidates();
    const blockMap = {};
    for (const c of all) {
      for (const block of c.blocks) {
        if (!blockMap[block.id]) {
          blockMap[block.id] = { id: block.id, name: block.name, candidateCount: 0, avgScore: 0, scores: [] };
        }
        blockMap[block.id].candidateCount++;
        if (block.average_score !== null) blockMap[block.id].scores.push(block.average_score);
      }
    }
    for (const b of Object.values(blockMap)) {
      b.avgScore = b.scores.length > 0
        ? Math.round(b.scores.reduce((a, x) => a + x, 0) / b.scores.length * 10) / 10
        : null;
    }
    return Object.values(blockMap);
  }

  return { getCandidates, getCandidateById, getRanking, getHeatmapMatrix, getComparisonData, getBlocks, scoreLabel, scoreColor, computeScore };
})();
