# Evaluación Técnica de Planes de Gobierno · Perú 2026

## Descripción
Plataforma editorial técnica para explorar y comparar análisis de planes de gobierno presidenciales del Perú 2026. El sistema es completamente data-driven: la **fuente única de verdad** es la carpeta `/analisis`, que contiene un archivo JSON por candidato.

Agregar un nuevo `.json` a `/analisis` auto-registra el candidato en toda la plataforma, sin tocar código.

## Arquitectura

```
/
├── server.js             → Express (puerto 3000). APIs: /api/candidates, /api/validate
├── start.sh              → Script de arranque
├── package.json
│
├── index.html            → Home limpio (modal de orientación, 2 botones, stats)
├── analizar.html         → Selector de candidatos (grid de tarjetas)
├── candidato.html        → Resumen del candidato (header, correcciones, bloques)
├── bloque.html           → Detalle de bloque (variables, barras, lista navegable)
├── variable.html         → Detalle de variable (10 secciones + tabla criterios + fuentes)
├── metodologia.html      → Página de metodología explicada
├── comparar.html         → Comparación multi-candidato (radar, barras, tabla, brechas)
├── heatmap.html          → Heatmap global de variables × candidatos
├── validacion.html       → Validador de estructura JSON
│
├── /analisis/            ← FUENTE ÚNICA DE VERDAD
│   └── demo-candidato.json  → Plantilla oficial con schema v2.0 completo
│
└── /public/
    ├── /js/
    │   ├── data.js       → DataLayer: getCandidates(), getCandidateById(), getHeatmapMatrix(), etc.
    │   ├── engine.js     → Engine: getKpis(), getRadarData(), getBlockComparisonData(), etc.
    │   ├── charts.js     → Charts: radar(), bar(), heatmap()
    │   └── ui.js         → UI helpers: scoreBadge(), criteriaBars(), emptyState(), etc.
    └── /styles/
        ├── globals.css   → Sistema de diseño editorial completo
        └── home.css      → Estilos compat para páginas legacy (comparar, heatmap, validacion)
```

## Flujo de navegación

```
index.html
  → analizar.html (selector de candidatos)
      → candidato.html?id=X (resumen del candidato)
          → bloque.html?id=X&bloque=Y (detalle del bloque)
              → variable.html?id=X&bloque=Y&var=Z (10 secciones + criterios + fuentes)
  → comparar.html
  → metodologia.html
```

## API del servidor

- `GET /api/candidates` → Lee todos los `.json` de `/analisis` y los retorna normalizados
- `GET /api/validate`   → Valida estructura completa de cada archivo (criterios, secciones, fuentes, correcciones)

## Schema JSON v2.0 (por candidato)

Cada archivo en `/analisis/*.json` debe seguir el schema de `demo-candidato.json`:

```json
{
  "_schema_version": "2.0",
  "candidate": {
    "id": "...",                    // OBLIGATORIO
    "name": "...",                  // OBLIGATORIO
    "party": "...",                 // OBLIGATORIO
    "total_score": 6.8,             // OBLIGATORIO
    "color": "#b5121b",
    "plan_period": "2026-2031",
    "plan_pages": 80,
    "summary": "...",
    "strengths": ["..."],
    "weaknesses": ["..."],
    "methodological_notes": ["..."],
    "methodological_corrections": [
      {
        "target_variable_id": "politica_tributaria",
        "target_variable_name": "Política tributaria",
        "type": "criterio_corregido",
        "description": "...",
        "original_score": 7.5,
        "corrected_score": 8.3
      }
    ]
  },
  "blocks": [{
    "id": "economia",               // OBLIGATORIO
    "name": "Economía",             // OBLIGATORIO
    "average_score": 7.4,
    "color": "#1d4ed8",
    "summary": "...",
    "interpretation": "...",
    "strengths": ["..."],
    "weaknesses": ["..."],
    "variables": [{
      "id": "politica_tributaria",  // OBLIGATORIO
      "name": "Política tributaria", // OBLIGATORIO
      "final_score": 8.3,
      "summary": "...",
      "strengths": ["..."],
      "weaknesses": ["..."],
      "gaps": ["..."],
      "conclusion": "...",
      "corrected_methodology": true,
      "correction_note": "...",
      "criteria": {
        "diagnostico": 2,    // 0, 1 o 2
        "propuesta": 2,
        "medidas": 1,
        "implementacion": 1,
        "viabilidad": 1,
        "especificidad": 2
      },
      "criteria_notes": {
        "diagnostico": "Justificación del criterio...",
        "propuesta": "...",
        "medidas": "...",
        "implementacion": "...",
        "viabilidad": "...",
        "especificidad": "..."
      },
      "analysis_sections": {
        "definicion": "¿Qué evalúa esta variable?",
        "importancia": "¿Por qué importa?",
        "diagnostico_externo": "Problema actual del país",
        "propuesta_plan": "Qué propone el plan",
        "medidas_concretas": "Medidas específicas",
        "implementacion_necesaria": "Quién ejecutaría",
        "impacto_potencial": "Qué impacto podría tener",
        "vacios": "Qué le falta al plan",
        "evaluacion_tecnica": "Evaluación técnica",
        "calificacion_final": "Fórmula y puntaje",
        "conclusion": "Conclusión"
      },
      "sources": [
        {
          "title": "Nombre de la fuente",
          "type": "official|academic|press|report|other",
          "note": "Nota de uso",
          "url": "https://..."
        }
      ]
    }]
  }],
  "final_analysis": {
    "global_findings": ["..."],
    "final_conclusion": "...",
    "ranking_note": "...",
    "comparability_note": "..."
  }
}
```

## Escala de puntajes
- 9.0–10.0 → Muy sólido (verde)
- 7.0–8.9  → Sólido (azul)
- 5.0–6.9  → Intermedio (ámbar)
- 3.0–4.9  → Débil (naranja)
- 0.0–2.9  → Muy débil (rojo)

## Fórmula
Puntaje variable = (D + P + M + Im + V + E) / 12 × 10

Donde cada criterio vale 0, 1 o 2 puntos.

## Para agregar un candidato nuevo
1. Copiar `analisis/demo-candidato.json`
2. Renombrar (ej: `acuna.json`)
3. Completar todos los campos
4. Guardar → auto-registrado en toda la plataforma

## Tech Stack
- Backend: Node.js + Express (puerto 3000)
- Frontend: HTML + CSS + Vanilla JS
- Charts: Chart.js 4.4 (CDN)
- Fonts: Inter + Sora (Google Fonts)
