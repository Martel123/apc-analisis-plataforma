const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;
const ANALISIS_DIR = path.join(__dirname, 'analisis');

app.use(express.static(path.join(__dirname)));

app.get('/api/candidates', (req, res) => {
  if (!fs.existsSync(ANALISIS_DIR)) {
    return res.json({ candidates: [], count: 0 });
  }

  const files = fs.readdirSync(ANALISIS_DIR).filter(f => f.endsWith('.json'));
  const candidates = [];

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(ANALISIS_DIR, file), 'utf8');
      const data = JSON.parse(content);
      candidates.push({ ...data, _file: file, _valid: true });
    } catch (e) {
      candidates.push({ _file: file, _valid: false, _error: e.message });
    }
  }

  res.json({ candidates, count: candidates.length });
});

app.get('/api/validate', (req, res) => {
  if (!fs.existsSync(ANALISIS_DIR)) {
    return res.json({ reports: [], error: 'Carpeta /analisis no encontrada' });
  }

  const files = fs.readdirSync(ANALISIS_DIR).filter(f => f.endsWith('.json'));
  const reports = [];

  for (const file of files) {
    const report = { file, issues: [], warnings: [], ok: false };

    try {
      const content = fs.readFileSync(path.join(ANALISIS_DIR, file), 'utf8');
      const data = JSON.parse(content);

      if (!data.candidate) {
        report.issues.push('Falta el objeto raíz "candidate"');
      } else {
        const c = data.candidate;
        const required = ['id', 'name', 'party', 'total_score'];
        for (const f of required) {
          if (c[f] === undefined || c[f] === null || c[f] === '') {
            report.issues.push(`candidate.${f} es obligatorio y está vacío`);
          }
        }
        const recommended = ['color', 'plan_period', 'plan_pages', 'summary', 'strengths', 'weaknesses', 'methodological_notes'];
        for (const f of recommended) {
          if (c[f] === undefined) {
            report.warnings.push(`candidate.${f} recomendado pero falta`);
          }
        }
      }

      if (!data.blocks || !Array.isArray(data.blocks)) {
        report.issues.push('Falta el array "blocks"');
      } else {
        if (data.blocks.length === 0) {
          report.warnings.push('El array "blocks" está vacío');
        }
        data.blocks.forEach((block, bi) => {
          if (!block.id) report.issues.push(`blocks[${bi}] le falta "id"`);
          if (!block.name) report.issues.push(`blocks[${bi}] le falta "name"`);
          if (block.average_score === undefined) report.warnings.push(`blocks[${bi}] le falta "average_score"`);

          if (!block.variables || !Array.isArray(block.variables)) {
            report.warnings.push(`blocks[${bi}] (${block.name || bi}) no tiene variables`);
          } else {
            block.variables.forEach((v, vi) => {
              const vkey = `blocks[${bi}].variables[${vi}]`;
              if (!v.id) report.issues.push(`${vkey} le falta "id"`);
              if (!v.name) report.issues.push(`${vkey} le falta "name"`);
              if (v.final_score === undefined) report.warnings.push(`${vkey} le falta "final_score"`);
              if (!v.criteria) {
                report.warnings.push(`${vkey} le falta el objeto "criteria"`);
              } else {
                const criterios = ['diagnostico', 'propuesta', 'medidas', 'implementacion', 'viabilidad', 'especificidad'];
                for (const cr of criterios) {
                  if (v.criteria[cr] === undefined) {
                    report.warnings.push(`${vkey}.criteria.${cr} falta`);
                  }
                }
              }
            });
          }
        });
      }

      if (!data.final_analysis) {
        report.warnings.push('Falta el objeto "final_analysis"');
      }

      report.ok = report.issues.length === 0;
    } catch (e) {
      report.issues.push(`Error al parsear JSON: ${e.message}`);
      report.ok = false;
    }

    reports.push(report);
  }

  res.json({ reports, total: files.length });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor corriendo en http://0.0.0.0:${PORT}`);
  console.log(`Leyendo candidatos desde: ${ANALISIS_DIR}`);
});
