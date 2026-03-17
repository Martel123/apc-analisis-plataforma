const Charts = (() => {

  const instances = {};

  function destroy(id) {
    if (instances[id]) {
      instances[id].destroy();
      delete instances[id];
    }
  }

  function radar(canvasId, radarData, options = {}) {
    destroy(canvasId);
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    instances[canvasId] = new Chart(ctx, {
      type: 'radar',
      data: radarData,
      options: {
        responsive: true,
        maintainAspectRatio: true,
        plugins: {
          legend: { position: 'bottom', labels: { font: { size: 12 }, boxWidth: 12 } }
        },
        scales: {
          r: {
            min: 0, max: 10,
            ticks: { stepSize: 2, font: { size: 10 }, color: '#888' },
            grid: { color: 'rgba(0,0,0,0.07)' },
            pointLabels: { font: { size: 11 }, color: '#333' }
          }
        },
        ...options
      }
    });
    return instances[canvasId];
  }

  function bar(canvasId, labels, datasets, options = {}) {
    destroy(canvasId);
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    instances[canvasId] = new Chart(ctx, {
      type: 'bar',
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        indexAxis: options.horizontal ? 'y' : 'x',
        plugins: {
          legend: { display: datasets.length > 1, position: 'bottom', labels: { font: { size: 12 }, boxWidth: 12 } },
          tooltip: {
            callbacks: {
              label: ctx => ` ${ctx.dataset.label || ''}: ${ctx.parsed[options.horizontal ? 'x' : 'y'].toFixed(1)}`
            }
          }
        },
        scales: {
          x: { grid: { display: !options.horizontal }, ticks: { font: { size: 11 } } },
          y: { grid: { display: options.horizontal }, ticks: { font: { size: 11 } }, min: 0, max: 10 }
        },
        ...options.chartOptions
      }
    });
    return instances[canvasId];
  }

  function heatmap(containerId, matrix, candidates, onClick) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const { rows, candidateIds } = matrix;
    const activeCandidate = candidates;

    let html = `<div class="heatmap-wrap">
      <div class="heatmap-table-wrap">
        <table class="heatmap-table">
          <thead>
            <tr>
              <th class="heatmap-var-col">Variable</th>
              <th class="heatmap-block-col">Bloque</th>
              ${candidates.map(c => `<th class="heatmap-cand-col" style="--cand-color:${c.color}">${c.name}</th>`).join('')}
            </tr>
          </thead>
          <tbody>
            ${rows.map(row => `
              <tr data-var-id="${row.id}">
                <td class="heatmap-var-name">${row.name}</td>
                <td class="heatmap-block-name">${row.block}</td>
                ${candidates.map(c => {
                  const score = row.scores[c.id];
                  const { cls } = DataLayer.scoreLabel(score);
                  const bg = score !== null && score !== undefined ? scoreToHeatmapColor(score) : '#f3f4f6';
                  return `<td class="heatmap-cell ${cls}" 
                    style="background:${bg};color:${score >= 7 ? '#fff' : '#111'}"
                    data-candidate="${c.id}" data-var="${row.id}"
                    title="${c.name} - ${row.name}: ${score !== null ? score.toFixed(1) : '—'}"
                  >${score !== null && score !== undefined ? score.toFixed(1) : '—'}</td>`;
                }).join('')}
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>`;

    container.innerHTML = html;

    if (onClick) {
      container.querySelectorAll('.heatmap-cell').forEach(cell => {
        cell.addEventListener('click', () => {
          onClick(cell.dataset.candidate, cell.dataset.var);
        });
      });
    }
  }

  function scoreToHeatmapColor(score) {
    if (score >= 8.5) return '#15803d';
    if (score >= 7.0) return '#1d4ed8';
    if (score >= 5.5) return '#b45309';
    if (score >= 4.0) return '#c2410c';
    return '#b91c1c';
  }

  return { radar, bar, heatmap, destroy };
})();
