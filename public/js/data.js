/**
 * DataLayer — Módulo de acceso a datos
 * Lee todo desde /api/candidates (que sirve /analisis/*.json)
 * Schema v2.0: sources, methodological_corrections, criteria_notes
 */
const DataLayer = (() => {
  let _cache = null;

  async function getCandidates() {
    if (_cache) return _cache;
    try {
      const res = await fetch('/api/candidates');
      const data = await res.json();
      _cache = (data.candidates || [])
        .filter(raw => raw._valid)
        .map(raw => normalizeCandidate(raw));
      return _cache;
    } catch (e) {
      console.error('[DataLayer] Error al obtener candidatos:', e);
      return [];
    }
  }

  // Legacy alias
  async function fetchCandidates() { return getCandidates(); }

  async function getCandidateById(id) {
    const all = await getCandidates();
    return all.find(c => c.id === id) || null;
  }

  function normalizeCandidate(raw) {
    const cand = raw.candidate || {};
    const blocks = (raw.blocks || []).map(block => normalizeBlock(block));
    const fa = raw.final_analysis || {};
    const corrections = cand.methodological_corrections || raw.methodological_corrections || [];

    return {
      id:           cand.id || raw._file?.replace('.json', '') || 'unknown',
      name:         cand.name || 'Sin nombre',
      party:        cand.party || '',
      color:        cand.color || null,
      plan_period:  cand.plan_period || null,
      plan_pages:   cand.plan_pages || null,
      total_score:  parseFloat(cand.total_score) || null,
      ranking_position: cand.ranking_position || null,
      summary:              cand.summary || '',
      strengths:            cand.strengths || [],
      weaknesses:           cand.weaknesses || [],
      methodological_notes: cand.methodological_notes || [],
      methodological_corrections: corrections,
      blocks,
      final_analysis: fa,
      _file: raw._file,
      // keep raw for legacy code
      candidate: cand,
      raw_data: raw
    };
  }

  function normalizeBlock(block) {
    return {
      id:             block.id || 'bloque',
      name:           block.name || 'Sin nombre',
      average_score:  block.average_score !== undefined ? parseFloat(block.average_score) : null,
      color:          block.color || null,
      summary:        block.summary || '',
      interpretation: block.interpretation || '',
      strengths:      block.strengths || [],
      weaknesses:     block.weaknesses || [],
      variables:      (block.variables || []).map(v => normalizeVariable(v))
    };
  }

  function normalizeVariable(v) {
    return {
      id:          v.id || 'var',
      name:        v.name || 'Sin nombre',
      final_score: v.final_score !== undefined ? parseFloat(v.final_score) : null,
      rating_label:v.rating_label || '',
      summary:     v.summary || '',
      strengths:   v.strengths || [],
      weaknesses:  v.weaknesses || [],
      gaps:        v.gaps || [],
      conclusion:  v.conclusion || '',
      criteria:    v.criteria || {},
      criteria_notes: v.criteria_notes || {},
      analysis_sections: v.analysis_sections || {},
      sources: (v.sources || []).map(s => ({
        title: s.title || '',
        type:  s.type || 'other',
        note:  s.note || '',
        url:   s.url || ''
      })),
      corrected_methodology: !!v.corrected_methodology,
      correction_note:       v.correction_note || ''
    };
  }

  // ── Score helpers ─────────────────────────────────────────────────

  function scoreLabel(score) {
    if (score === null || score === undefined) return { label: 'Sin datos', cls: 'score-none' };
    const s = parseFloat(score);
    if (s >= 9)   return { label: 'Muy sólido',  cls: 'score-excellent' };
    if (s >= 7)   return { label: 'Sólido',      cls: 'score-solid' };
    if (s >= 5)   return { label: 'Intermedio',  cls: 'score-medium' };
    if (s >= 3)   return { label: 'Débil',       cls: 'score-weak' };
    return              { label: 'Muy débil',    cls: 'score-very-weak' };
  }

  function scoreColor(score) {
    if (score === null || score === undefined) return '#aaaaaa';
    const s = parseFloat(score);
    if (s >= 9)   return '#16a34a';
    if (s >= 7)   return '#2563eb';
    if (s >= 5)   return '#d97706';
    if (s >= 3)   return '#ea580c';
    return              '#dc2626';
  }

  // ── Chart helpers ─────────────────────────────────────────────────

  function getBlocksChartData(candidate) {
    return {
      labels: candidate.blocks.map(b => b.name),
      scores: candidate.blocks.map(b => b.average_score ?? 0),
      colors: candidate.blocks.map(b => scoreColor(b.average_score))
    };
  }

  function getRadarData(candidates) {
    const allBlockIds = [...new Set(candidates.flatMap(c => c.blocks.map(b => b.id)))];
    const labels = allBlockIds.map(id => {
      const found = candidates.flatMap(c => c.blocks).find(b => b.id === id);
      return found?.name || id;
    });
    const datasets = candidates.map(c => {
      const data = allBlockIds.map(id => {
        const block = c.blocks.find(b => b.id === id);
        return block?.average_score ?? 0;
      });
      return { label: c.name, data, color: c.color || '#b5121b' };
    });
    return { labels, datasets };
  }

  function getHeatmapData(candidates) {
    const allVarMap = {};
    candidates.forEach(c => {
      c.blocks.forEach(b => {
        b.variables.forEach(v => {
          if (!allVarMap[v.id]) allVarMap[v.id] = { id: v.id, name: v.name, blockId: b.id, blockName: b.name };
        });
      });
    });
    const variables = Object.values(allVarMap);
    const rows = variables.map(varInfo => {
      const scores = candidates.map(c => {
        let found = null;
        c.blocks.forEach(b => { const v = b.variables.find(x => x.id === varInfo.id); if (v) found = v.final_score; });
        return found;
      });
      return { ...varInfo, scores };
    });
    return { candidates, variables: rows };
  }

  function getAllVariables(candidates) {
    const seen = new Set();
    const result = [];
    candidates.forEach(c => {
      c.blocks.forEach(b => {
        b.variables.forEach(v => {
          if (!seen.has(v.id)) {
            seen.add(v.id);
            result.push({ id: v.id, name: v.name, blockId: b.id, blockName: b.name });
          }
        });
      });
    });
    return result;
  }

  function getVariableScores(candidates) {
    const varMap = {};
    candidates.forEach(c => {
      c.blocks.forEach(b => {
        b.variables.forEach(v => {
          if (!varMap[v.id]) varMap[v.id] = { id: v.id, name: v.name, blockId: b.id, blockName: b.name, scores: {} };
          varMap[v.id].scores[c.id] = v.final_score;
        });
      });
    });
    return Object.values(varMap);
  }

  async function getHeatmapMatrix() {
    const candidates = await getCandidates();
    const rowMap = {};
    candidates.forEach(c => {
      c.blocks.forEach(b => {
        b.variables.forEach(v => {
          if (!rowMap[v.id]) rowMap[v.id] = { id: v.id, name: v.name, block_id: b.id, block: b.name, scores: {} };
          rowMap[v.id].scores[c.id] = v.final_score;
        });
      });
    });
    return { rows: Object.values(rowMap), candidates };
  }

  async function getComparisonData(selectedIds) {
    const all = await getCandidates();
    const candidates = all.filter(c => selectedIds.includes(c.id));
    if (candidates.length < 2) return null;

    const allBlockIds = [...new Set(candidates.flatMap(c => c.blocks.map(b => b.id)))];
    const blocks = allBlockIds.map(bid => {
      const found = candidates.flatMap(c => c.blocks).find(b => b.id === bid);
      const scores = {};
      candidates.forEach(c => {
        const block = c.blocks.find(b => b.id === bid);
        scores[c.id] = block?.average_score ?? null;
      });
      return { id: bid, name: found?.name || bid, scores };
    });

    return { candidates, blocks };
  }

  return {
    getCandidates,
    fetchCandidates,
    getCandidateById,
    getComparisonData,
    getHeatmapMatrix,
    scoreLabel,
    scoreColor,
    getBlocksChartData,
    getRadarData,
    getHeatmapData,
    getAllVariables,
    getVariableScores
  };
})();
