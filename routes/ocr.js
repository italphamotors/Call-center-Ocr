const express = require('express');
const multer  = require('multer');
const axios   = require('axios');
const fs      = require('fs');
const path    = require('path');
const config  = require('../config');

const router = express.Router();

const upload = multer({
  dest: path.join(__dirname, '..', 'tmp_uploads'),
  limits: { fileSize: config.MAX_UPLOAD_SIZE },
});

const MIME_TYPES = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg',
  png: 'image/png', pdf: 'application/pdf',
};

function logOcr(msg) {
  const line = `${new Date().toISOString()} | ${msg}\n`;
  fs.appendFile(path.join(__dirname, '..', 'ocr_debug.log'), line, () => {});
}

// -------------------------------------------------------
// Construit le prompt de structuration en fonction du
// type de document choisi par l'utilisateur (docType).
// -------------------------------------------------------
function buildStructurePrompt(docTypeConfig) {
  return `Voici le texte brut extrait d'une fiche "${docTypeConfig.label}" (issu d'un OCR d'écriture manuscrite ou imprimée camerounaise).

Analyse le texte et retourne UNIQUEMENT un objet JSON valide (sans aucun texte
autour, sans balises markdown) respectant EXACTEMENT cette structure :

${docTypeConfig.schemaHint}

Règles :
- "date_fiche" : extrais la date en haut du document (ex: "18/07/26" → "2026-07-18"). Si absente, mets null.
- Ne complète JAMAIS un champ que tu n'arrives pas à lire clairement : mets une chaîne vide "" plutôt que de deviner.
- Si l'écriture est ambiguë sur un numéro de téléphone, retranscris ta meilleure lecture mais n'invente aucun chiffre.
- Respecte la casse et les accents du texte source pour les noms.
- Ne retourne RIEN d'autre que cet objet JSON.

Texte extrait :
`;
}

// -------------------------------------------------------
// ROUTE POST /api/ocr
// Champs attendus (multipart/form-data) :
//   - document : le fichier (jpg/png/pdf)
//   - docType  : 'suivi_rdv' | 'fiche_appel'
// -------------------------------------------------------
router.post('/', upload.single('document'), async (req, res) => {
  const file = req.file;
  const docType = req.body.docType;

  const docTypeConfig = config.DOCUMENT_TYPES[docType];

  if (!docTypeConfig) {
    if (file) fs.unlink(file.path, () => {});
    return res.json({ success: false, error: 'Type de document invalide ou non sélectionné.' });
  }

  if (!file) {
    return res.json({ success: false, error: 'Aucun fichier reçu.' });
  }

  const ext = path.extname(file.originalname).slice(1).toLowerCase();

  if (!config.ALLOWED_EXTENSIONS.includes(ext)) {
    fs.unlink(file.path, () => {});
    return res.json({ success: false, error: 'Format de fichier non autorisé.' });
  }

  logOcr(`Type de document : ${docType} | fichier : ${file.originalname}`);

  try {
    const fileBuffer = fs.readFileSync(file.path);
    const base64 = fileBuffer.toString('base64');
    const mime = MIME_TYPES[ext];
    const dataUrl = `data:${mime};base64,${base64}`;

    // --- ÉTAPE 1 : extraction du texte brut via l'endpoint OCR dédié ---
    const isPdf = ext === 'pdf';
    const documentPayload = isPdf
      ? { type: 'document_url', document_url: dataUrl }
      : { type: 'image_url', image_url: dataUrl };

    const ocrResponse = await axios.post(
      config.MISTRAL_OCR_URL,
      { model: config.MISTRAL_OCR_MODEL, document: documentPayload },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.MISTRAL_API_KEY}`,
        },
        timeout: 60000,
        validateStatus: () => true,
      }
    );

    logOcr(`OCR HTTP ${ocrResponse.status} | ${JSON.stringify(ocrResponse.data).slice(0, 1000)}`);

    if (ocrResponse.status === 401) {
      return res.json({ success: false, error: 'Clé API Mistral invalide.' });
    }
    if (ocrResponse.status !== 200) {
      return res.json({ success: false, error: `Erreur du service OCR (code ${ocrResponse.status}).` });
    }

    const pages = ocrResponse.data?.pages || [];
    const rawText = pages.map(p => p.markdown || '').join('\n\n');

    if (!rawText.trim()) {
      return res.json({ success: false, error: 'Aucun texte détecté dans le document.' });
    }

    // --- ÉTAPE 2 : structuration en JSON via chat completions ---
    const structurePrompt = buildStructurePrompt(docTypeConfig);

    const chatResponse = await axios.post(
      config.MISTRAL_CHAT_URL,
      {
        model: config.MISTRAL_CHAT_MODEL,
        messages: [{ role: 'user', content: structurePrompt + rawText }],
        temperature: 0.1,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.MISTRAL_API_KEY}`,
        },
        timeout: 60000,
        validateStatus: () => true,
      }
    );

    logOcr(`Chat HTTP ${chatResponse.status} | ${JSON.stringify(chatResponse.data).slice(0, 1500)}`);

    if (chatResponse.status !== 200) {
      return res.json({ success: false, error: `Erreur de structuration (code ${chatResponse.status}).` });
    }

    const content = chatResponse.data?.choices?.[0]?.message?.content || '';
    const parsed = extractJsonObject(content);

    if (parsed === null) {
      logOcr(`Échec extraction JSON depuis : ${content}`);
      return res.json({ success: false, error: 'Format de réponse OCR inattendu.' });
    }

    logOcr(`Date détectée : ${parsed.date_fiche || 'aucune'} | ${parsed.rows.length} ligne(s)`);
    return res.json({
      success: true,
      rows: parsed.rows,
      detected_date: parsed.date_fiche,
      agent: parsed.agent || '',
    });

  } catch (err) {
    logOcr(`Erreur réseau : ${err.message}`);
    return res.json({ success: false, error: 'Impossible de contacter le service OCR (réseau).' });
  } finally {
    fs.unlink(file.path, () => {});
  }
});

// -------------------------------------------------------
// GET /api/ocr/types
// Retourne la liste des types de documents configurés,
// pour construire dynamiquement le sélecteur côté interface.
// -------------------------------------------------------
router.get('/types', (req, res) => {
  const types = Object.entries(config.DOCUMENT_TYPES).map(([key, cfg]) => ({
    key,
    label: cfg.label,
    columns: cfg.columns,
  }));
  res.json({ success: true, types });
});

// -------------------------------------------------------
// UTILITAIRE : extraction de l'objet JSON depuis la réponse Mistral
// -------------------------------------------------------
function extractJsonObject(text) {
  const cleaned = text.replace(/```json|```/g, '').trim();

  const objStart = cleaned.indexOf('{');
  const objEnd   = cleaned.lastIndexOf('}');
  if (objStart !== -1 && objEnd !== -1 && objEnd > objStart) {
    try {
      const parsed = JSON.parse(cleaned.slice(objStart, objEnd + 1));
      if (parsed && Array.isArray(parsed.rows)) {
        return parsed;
      }
    } catch (e) { /* on essaie le fallback */ }
  }

  const arrStart = cleaned.indexOf('[');
  const arrEnd   = cleaned.lastIndexOf(']');
  if (arrStart !== -1 && arrEnd !== -1 && arrEnd > arrStart) {
    try {
      const parsed = JSON.parse(cleaned.slice(arrStart, arrEnd + 1));
      if (Array.isArray(parsed)) {
        return { date_fiche: null, rows: parsed };
      }
    } catch (e) { /* échec total */ }
  }

  return null;
}

module.exports = router;
