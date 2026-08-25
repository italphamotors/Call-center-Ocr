const express = require('express');
const axios   = require('axios');
const crypto  = require('crypto');
const config  = require('../config');

const router = express.Router();

// -------------------------------------------------------
// UTILITAIRE JSON-RPC ODOO
// -------------------------------------------------------
async function jsonRpc(service, method, args) {
  const response = await axios.post(
    config.ODOO_JSONRPC_URL,
    { jsonrpc: '2.0', method: 'call', params: { service, method, args }, id: Date.now() },
    { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
  );
  if (response.data.error) {
    throw new Error(JSON.stringify(response.data.error));
  }
  return response.data.result;
}

async function login() {
  const uid = await jsonRpc('common', 'login', [config.ODOO_DB, config.ODOO_USER, config.ODOO_PASSWORD]);
  if (!uid) throw new Error('Authentification Odoo refusée.');
  return uid;
}

function execute(uid, model, method, args, kwargs = {}) {
  return jsonRpc('object', 'execute_kw', [
    config.ODOO_DB, uid, config.ODOO_PASSWORD, model, method, args, kwargs,
  ]);
}

// -------------------------------------------------------
// DATES : l'OCR renvoie du "JJ/MM/AAAA", Odoo attend "AAAA-MM-JJ".
// -------------------------------------------------------
function toISODate(str) {
  if (!str) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str; // déjà au bon format
  const m = String(str).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

// -------------------------------------------------------
// TYPE D'ACTIVITÉ "APPELER" — recherché une fois par sauvegarde
// -------------------------------------------------------
async function getCallActivityTypeId(uid) {
  try {
    const { module, name } = config.ODOO_ACTIVITY_TYPE_XMLID;
    const found = await execute(uid, 'ir.model.data', 'search_read',
      [[['module', '=', module], ['name', '=', name]]], { fields: ['res_id'], limit: 1 });
    if (found && found.length) return found[0].res_id;
  } catch (e) { /* on tente le repli ci-dessous */ }

  try {
    const found = await execute(uid, 'mail.activity.type', 'search_read',
      [[['name', 'in', ['Call', 'Appel']]]], { fields: ['id'], limit: 1 });
    return found && found.length ? found[0].id : null;
  } catch (e) {
    return null;
  }
}

// -------------------------------------------------------
// ÉTIQUETTE "scan" — détecte le type du champ (many2many Tags,
// texte ou booléen) et prépare la valeur à écrire.
// -------------------------------------------------------
async function prepareTag(uid, model, tagField, tagLabel) {
  if (!tagField) return null;
  let meta;
  try {
    const fields = await execute(uid, model, 'fields_get', [[tagField]], { attributes: ['type', 'relation'] });
    meta = fields[tagField];
  } catch (e) {
    return null;
  }
  if (!meta) return null;

  if (meta.type === 'many2many' && meta.relation) {
    let tagId = null;
    try {
      const found = await execute(uid, meta.relation, 'search_read', [[['name', '=', tagLabel]]], { fields: ['id'], limit: 1 });
      tagId = (found && found.length) ? found[0].id : await execute(uid, meta.relation, 'create', [{ name: tagLabel }]);
    } catch (e) { return null; }
    return { type: 'many2many', value: [[6, 0, [tagId]]] };
  }
  if (meta.type === 'boolean') return { type: 'boolean', value: true };
  if (meta.type === 'char' || meta.type === 'text') return { type: 'char', value: tagLabel };
  if (meta.type === 'selection') return { type: 'selection', value: tagLabel };
  return null;
}

// -------------------------------------------------------
// AGENT → UTILISATEUR ODOO (pour assigner l'activité)
// Recherche un utilisateur dont le nom correspond ; sinon
// on repart sur l'utilisateur connecté (compte de service).
// -------------------------------------------------------
async function resolveAgentUserId(uid, agentName) {
  if (!agentName || !agentName.trim()) return uid;
  try {
    const found = await execute(uid, 'res.users', 'search_read',
      [[['name', 'ilike', agentName.trim()]]], { fields: ['id'], limit: 1 });
    return (found && found.length) ? found[0].id : uid;
  } catch (e) {
    return uid;
  }
}

// -------------------------------------------------------
// HASH ANTI-DOUBLON (fiches historisées)
// Calculé à partir de la date de fiche + agent + numéros
// de téléphone triés : deux scans de la même fiche donnent
// le même hash, même si l'ordre des lignes OCR diffère.
// -------------------------------------------------------
function computeFicheHash(date_fiche, agent, rows) {
  const phones = rows.map(r => (r.telephone || '').replace(/\D/g, '')).sort();
  const raw = `${date_fiche || ''}|${(agent || '').trim().toLowerCase()}|${phones.join(',')}`;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

// -------------------------------------------------------
// PIÈCE JOINTE : attache le fichier scanné d'origine
// (image/PDF) à l'enregistrement d'en-tête, via ir.attachment.
// -------------------------------------------------------
async function attachSourceFile(uid, model, resId, file) {
  if (!file || !file.base64) return;
  try {
    await execute(uid, 'ir.attachment', 'create', [{
      name: file.filename || 'fiche_scan',
      res_model: model,
      res_id: resId,
      datas: file.base64,
      mimetype: file.mimetype || 'application/octet-stream',
    }]);
  } catch (e) {
    // non bloquant : le prospect/l'enregistrement doit rester créé même si la pièce jointe échoue
  }
}

// -------------------------------------------------------
// SAUVEGARDE — TYPE HISTORISÉ (en-tête + lignes)
// Un scan validé = 1 enregistrement d'en-tête (x_fiche_appel_scan)
// + N enregistrements de lignes (x_fiche_appel_ligne), reliés par
// le champ Many2one FICHE_ID. Anti-doublon au niveau de la fiche
// entière (même date + agent + jeu de numéros = même scan).
// -------------------------------------------------------
async function saveHistorized(uid, docTypeConfig, date_fiche, agent, validRows, file) {
  const HF = docTypeConfig.headerFields;
  const LF = docTypeConfig.lineFields;
  const isoDateFiche = toISODate(date_fiche) || date_fiche || false;
  const hash = computeFicheHash(date_fiche, agent, validRows);

  // ── Anti-doublon au niveau de la fiche ──
  if (HF.HASH_DEDUP) {
    try {
      const existing = await execute(uid, docTypeConfig.odooModel, 'search_read',
        [[[HF.HASH_DEDUP, '=', hash]]], { fields: [HF.NAME, HF.DATE_SCAN], limit: 1 });
      if (existing && existing.length) {
        return {
          success: true, created: 0, skipped: validRows.length,
          skippedRows: validRows.map(r => r.telephone),
          errors: [],
          message: `Cette fiche a déjà été scannée le ${existing[0][HF.DATE_SCAN] || '(date inconnue)'} — aucun doublon créé.`,
        };
      }
    } catch (e) { /* non bloquant, on tente quand même la création */ }
  }

  // ── Étiquette + statut sur l'en-tête ──
  const tag = await prepareTag(uid, docTypeConfig.odooModel, docTypeConfig.tagField, docTypeConfig.tagValue);

  const headerValues = {
    [HF.NAME]: `Fiche appel - ${date_fiche || '?'} - ${agent || '?'}`,
  };
  if (HF.DATE_SCAN)  headerValues[HF.DATE_SCAN]  = new Date().toISOString().slice(0, 19).replace('T', ' ');
  if (HF.DATE_FICHE) headerValues[HF.DATE_FICHE] = isoDateFiche;
  if (HF.AGENT)       headerValues[HF.AGENT]       = agent || false;
  if (HF.NB_APPELS)   headerValues[HF.NB_APPELS]   = validRows.length;
  if (HF.HASH_DEDUP)  headerValues[HF.HASH_DEDUP]  = hash;
  if (tag && docTypeConfig.tagField) headerValues[docTypeConfig.tagField] = tag.value;
  if (docTypeConfig.statusField && docTypeConfig.statusDefault) headerValues[docTypeConfig.statusField] = docTypeConfig.statusDefault;

  const errors = [];
  let headerId;
  try {
    headerId = await execute(uid, docTypeConfig.odooModel, 'create', [headerValues]);
  } catch (err) {
    return { success: false, message: "Impossible de créer la fiche dans Odoo : " + err.message };
  }

  // ── Pièce jointe (fichier/photo d'origine) ──
  await attachSourceFile(uid, docTypeConfig.odooModel, headerId, file);

  // ── Lignes d'appel ──
  let created = 0;
  for (const row of validRows) {
    const lineValues = {
      [LF.NAME]: row.telephone || '',
      [LF.FICHE_ID]: headerId,
    };
    if (LF.TELEPHONE)     lineValues[LF.TELEPHONE]     = row.telephone || false;
    if (LF.CODE_RESULTAT) lineValues[LF.CODE_RESULTAT] = row.code_resultat || false;
    if (LF.DATE_APPEL)    lineValues[LF.DATE_APPEL]    = isoDateFiche;

    try {
      await execute(uid, docTypeConfig.odooLineModel, 'create', [lineValues]);
      created++;
    } catch (err) {
      errors.push(`${row.telephone} (${err.message})`);
    }
  }

  return { success: true, created, skipped: 0, skippedRows: [], errors };
}

// -------------------------------------------------------
// GET /api/odoo/fields?docType=suivi_rdv   (diagnostic)
// Utile pour vérifier que les noms techniques dans config.js
// correspondent bien à ceux créés dans Odoo Studio.
// -------------------------------------------------------
router.get('/fields', async (req, res) => {
  const docTypeConfig = config.DOCUMENT_TYPES[req.query.docType];
  if (!docTypeConfig) return res.json({ success: false, message: 'docType inconnu.' });

  try {
    const uid = await login();
    const fields = await jsonRpc('object', 'execute_kw', [
      config.ODOO_DB, uid, config.ODOO_PASSWORD,
      docTypeConfig.odooModel, 'fields_get', [],
      { attributes: ['string', 'type', 'relation'] },
    ]);
    return res.json({ success: true, fields });
  } catch (err) {
    return res.json({ success: false, message: err.message });
  }
});

// -------------------------------------------------------
// POST /api/odoo/save
// body: { docType, date_fiche, agent, rows: [ {telephone, client, ...} ] }
//
// - Construit les valeurs Odoo à partir de la config.FIELDS du type
// - Anti-doublon simple sur les dedupeKeys définies par type
//   (ex: même téléphone + même date pour "suivi_rdv")
// -------------------------------------------------------
router.post('/save', async (req, res) => {
  const { docType, date_fiche, agent, rows, file } = req.body;
  const docTypeConfig = config.DOCUMENT_TYPES[docType];

  if (!docTypeConfig) {
    return res.json({ success: false, message: 'Type de document invalide.' });
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    return res.json({ success: false, message: 'Aucune ligne à enregistrer.' });
  }

  const validRows = rows.filter(r => r.telephone && r.telephone.trim() !== '');
  if (validRows.length === 0) {
    return res.json({ success: false, message: 'Aucune ligne avec un numéro de téléphone.' });
  }

  try {
    const uid = await login();

    // ── Type historisé (en-tête + lignes, ex: Fiche appel) ──
    if (docTypeConfig.historized) {
      const result = await saveHistorized(uid, docTypeConfig, date_fiche, agent, validRows, file);
      return res.json(result);
    }

    // ── Type "plat" existant (ex: Suivi des RDV) — inchangé ──
    const F = docTypeConfig.fields;
    const callActivityTypeId = await getCallActivityTypeId(uid);
    const tag = await prepareTag(uid, docTypeConfig.odooModel, docTypeConfig.tagField, docTypeConfig.tagValue);
    const activityUserId = await resolveAgentUserId(uid, agent);

    let created = 0;
    let skipped = 0;
    const errors = [];
    const skippedRows = [];

    for (const row of validRows) {
      // ── Anti-doublon simple ────────────────────────────
      const dedupeDomain = docTypeConfig.dedupeKeys
        .map(key => {
          const fieldName = F[key];
          const value = key === 'DATE_RDV' || key === 'DATE_APPEL' ? (row.date_rdv || date_fiche) : row.telephone;
          return [fieldName, '=', value || ''];
        })
        .filter(([, , value]) => value !== '');

      let alreadyExists = false;
      if (dedupeDomain.length > 0) {
        try {
          const count = await jsonRpc('object', 'execute_kw', [
            config.ODOO_DB, uid, config.ODOO_PASSWORD,
            docTypeConfig.odooModel, 'search_count',
            [dedupeDomain], {},
          ]);
          alreadyExists = count > 0;
        } catch (e) { /* non bloquant, on tente quand même la création */ }
      }

      if (alreadyExists) {
        skipped++;
        skippedRows.push(row.telephone);
        continue;
      }

      // ── Construction des valeurs selon le type de document ──
      const isoDateRdv = toISODate(row.date_rdv);
      const values = { [F.NAME]: `${row.telephone} - ${row.client || row.code_resultat || ''}`.trim() };
      if (F.TELEPHONE)     values[F.TELEPHONE]     = row.telephone || false;
      if (F.CLIENT)        values[F.CLIENT]        = row.client || false;
      if (F.DATE_RDV)      values[F.DATE_RDV]      = isoDateRdv || false;
      if (F.HEURE_RDV)     values[F.HEURE_RDV]     = row.heure_rdv || false;
      if (F.VILLE)         values[F.VILLE]         = row.ville || false;
      if (F.COMMENTAIRE)   values[F.COMMENTAIRE]   = row.commentaire || false;
      if (F.CODE_RESULTAT) values[F.CODE_RESULTAT] = row.code_resultat || false;
      if (F.DATE_APPEL)    values[F.DATE_APPEL]    = date_fiche || false;
      if (F.AGENT)         values[F.AGENT]         = agent || false;

      // ── Étiquette "scan" ──
      if (tag && docTypeConfig.tagField) {
        values[docTypeConfig.tagField] = tag.value;
      }
      // ── Statut par défaut ──
      if (docTypeConfig.statusField && docTypeConfig.statusDefault) {
        values[docTypeConfig.statusField] = docTypeConfig.statusDefault;
      }

      try {
        const newId = await execute(uid, docTypeConfig.odooModel, 'create', [values]);
        created++;

        // ── Activité "Appeler" avec la date de RDV/appel ──
        if (callActivityTypeId) {
          const deadline = isoDateRdv || toISODate(date_fiche) || new Date().toISOString().slice(0, 10);
          try {
            await execute(uid, 'mail.activity', 'create', [{
              res_model: docTypeConfig.odooModel,
              res_id: newId,
              activity_type_id: callActivityTypeId,
              date_deadline: deadline,
              summary: `Rappeler ${row.client || row.telephone}`,
              note: row.commentaire || row.code_resultat || '',
              user_id: activityUserId,
            }]);
          } catch (actErr) {
            errors.push(`Activité non créée pour ${row.telephone} : ${actErr.message}`);
          }
        }
      } catch (err) {
        errors.push(`${row.telephone} (${err.message})`);
      }
    }

    return res.json({ success: true, created, skipped, skippedRows, errors });

  } catch (err) {
    return res.json({ success: false, message: 'Impossible de contacter Odoo (vérifie identifiants/réseau) : ' + err.message });
  }
});

module.exports = router;
