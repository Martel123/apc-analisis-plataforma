const Engine = (() => {

  function getKpis(candidate) {
    const blocks = candidate.blocks || [];
    if (blocks.length === 0) return {};

    const scoredBlocks = blocks.filter(b => b.average_score !== null);
    const bestBlock = scoredBlocks.sort((a, b) => b.average_score - a.average_score)[0] || null;
    const worstBlock = scoredBlocks.sort((a, b) => a.average_score - b.average_score)[0] || null;

    const allVars = blocks.flatMap(b => b.variables);
    const scoredVars = allVars.filter(v => v.final_score !== null);
    const bestVar = scoredVars.sort((a, b) => b.final_score - a.final_score)[0] || null;
    const worstVar = scoredVars.sort((a, b) => a.final_score - b.final_score)[0] || null;

    const avgScore = scoredVars.length > 0
      ? Math.round(scoredVars.reduce((s, v) => s + v.final_score, 0) / scoredVars.length * 10) / 10
      : null;

    const corrected = allVars.filter(v => v.corrected_methodology).length;

    const scores = scoredVars.map(v => v.final_score);
    let consistency = null;
    if (scores.length > 1) {
      const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
      const variance = scores.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / scores.length;
      const stddev = Math.sqrt(variance);
      consistency = Math.round((1 - stddev / 10) * 100);
    }

    return {
      bestBlock,
      worstBlock,
      bestVar,
      worstVar,
      avgScore,
      totalVars: allVars.length,
      correctedVars: corrected,
      consistency
    };
  }

  function getRadarData(candidate, allCandidates = null) {
    const blocks = candidate.blocks || [];
    const labels = blocks.map(b => b.name);
    const data = blocks.map(b => b.average_score ?? 0);

    const datasets = [{
      label: candidate.name,
      data,
      backgroundColor: hexToRgba(candidate.color, 0.15),
      borderColor: candidate.color,
      borderWidth: 2,
      pointBackgroundColor: candidate.color,
      pointRadius: 4
    }];

    if (allCandidates && allCandidates.length > 1) {
      const others = allCandidates.filter(c => c.id !== candidate.id);
      for (const other of others.slice(0, 3)) {
        const otherData = labels.map(label => {
          const block = other.blocks.find(b => b.name === label);
          return block?.average_score ?? 0;
        });
        datasets.push({
          label: other.name,
          data: otherData,
          backgroundColor: hexToRgba(other.color, 0.08),
          borderColor: other.color,
          borderWidth: 1.5,
          borderDash: [4, 4],
          pointBackgroundColor: other.color,
          pointRadius: 3
        });
      }
    }

    return { labels, datasets };
  }

  function getBlockComparisonData(blockId, candidates) {
    return candidates.map(c => {
      const block = c.blocks.find(b => b.id === blockId);
      return {
        candidateId: c.id,
        name: c.name,
        color: c.color,
        score: block?.average_score ?? null
      };
    }).filter(d => d.score !== null).sort((a, b) => b.score - a.score);
  }

  function getVariableComparisonData(varId, candidates) {
    return candidates.map(c => {
      for (const block of c.blocks) {
        const v = block.variables.find(v => v.id === varId);
        if (v) return { candidateId: c.id, name: c.name, color: c.color, score: v.final_score, block: block.name };
      }
      return null;
    }).filter(Boolean).sort((a, b) => b.score - a.score);
  }

  function getStructuralStrengths(candidates) {
    const varScores = {};
    for (const c of candidates) {
      for (const block of c.blocks) {
        for (const v of block.variables) {
          if (!varScores[v.id]) varScores[v.id] = { id: v.id, name: v.name, block: block.name, scores: [] };
          if (v.final_score !== null) varScores[v.id].scores.push(v.final_score);
        }
      }
    }
    return Object.values(varScores)
      .filter(v => v.scores.length > 0)
      .map(v => ({ ...v, avg: Math.round(v.scores.reduce((a, b) => a + b, 0) / v.scores.length * 10) / 10 }))
      .sort((a, b) => b.avg - a.avg);
  }

  function hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  return { getKpis, getRadarData, getBlockComparisonData, getVariableComparisonData, getStructuralStrengths, hexToRgba };
})();
