/**
 * block-mapper.js — Taxonomía canónica de bloques
 * Normaliza cualquier block.id o block.name a 8 bloques canónicos
 */

const CANONICAL_BLOCKS = [
  { id: 'economia',                  label: 'Economía',                    icon: '💰' },
  { id: 'seguridad',                 label: 'Seguridad',                   icon: '🛡️' },
  { id: 'justicia_estado_derecho',   label: 'Justicia y Estado de Derecho', icon: '⚖️' },
  { id: 'educacion',                 label: 'Educación',                   icon: '📚' },
  { id: 'salud',                     label: 'Salud',                       icon: '🏥' },
  { id: 'politica_social',           label: 'Política Social',             icon: '🤝' },
  { id: 'infraestructura_desarrollo',label: 'Infraestructura y Desarrollo', icon: '🏗️' },
  { id: 'tecnologia_estado_digital', label: 'Tecnología y Estado Digital', icon: '💻' }
];

const CANONICAL_IDS = CANONICAL_BLOCKS.map(b => b.id);

function _normalize(str) {
  return (str || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

function mapBlockId(rawId, rawName) {
  const id  = _normalize(rawId  || '');
  const nm  = _normalize(rawName || '');
  const src = id + ' ' + nm;

  if (src.includes('econom'))                         return 'economia';
  if (src.includes('seguridad'))                      return 'seguridad';
  if (src.includes('justicia') || (src.includes('estado') && src.includes('derecho')))
                                                      return 'justicia_estado_derecho';
  if (src.includes('educaci') || src.includes('educacion'))
                                                      return 'educacion';
  if (src.includes('salud'))                          return 'salud';
  if (src.includes('politic') && src.includes('social'))
                                                      return 'politica_social';
  if (src.includes('infraestruc') || src.includes('desarrollo'))
                                                      return 'infraestructura_desarrollo';
  if (src.includes('tecnolog') || src.includes('digital'))
                                                      return 'tecnologia_estado_digital';
  return null;
}

function canonicalBlockInfo(canonicalId) {
  return CANONICAL_BLOCKS.find(b => b.id === canonicalId) || { id: canonicalId, label: canonicalId, icon: '📋' };
}

/**
 * Dado un candidato normalizado (del DataLayer), construye un mapa
 * canonicalId → average_score usando el primer bloque que matchee.
 */
function getCanonicalScores(candidate) {
  const scores = {};
  CANONICAL_IDS.forEach(cid => { scores[cid] = null; });
  (candidate.blocks || []).forEach(b => {
    const cid = mapBlockId(b.id, b.name);
    if (cid && scores[cid] === null && b.average_score != null) {
      scores[cid] = parseFloat(b.average_score);
    }
  });
  return scores;
}

/**
 * Dado un candidato, devuelve todas las variables indexadas por bloque canónico.
 * { canonicalId: [{ ...variable }] }
 */
function getCanonicalVariables(candidate) {
  const map = {};
  CANONICAL_IDS.forEach(cid => { map[cid] = []; });
  (candidate.blocks || []).forEach(b => {
    const cid = mapBlockId(b.id, b.name);
    if (!cid) return;
    (b.variables || []).forEach(v => {
      if (!map[cid].find(x => x.id === v.id)) {
        map[cid].push({ ...v, _blockId: cid });
      }
    });
  });
  return map;
}

if (typeof module !== 'undefined') {
  module.exports = { CANONICAL_BLOCKS, CANONICAL_IDS, mapBlockId, canonicalBlockInfo, getCanonicalScores, getCanonicalVariables };
}
