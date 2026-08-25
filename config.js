require('dotenv').config();

// -------------------------------------------------------
// Toutes les valeurs sensibles viennent UNIQUEMENT des
// variables d'environnement (.env / docker-compose).
// Il n'y a volontairement aucune clé ou mot de passe en dur
// ici : un fichier config.js versionné sur GitHub avec des
// identifiants réels, même en "valeur par défaut", finit
// tôt ou tard exposé publiquement.
// -------------------------------------------------------

function required(name) {
  const val = process.env[name];
  if (!val) {
    console.warn(`⚠️  Variable d'environnement manquante : ${name} (à définir dans .env)`);
  }
  return val;
}

module.exports = {
  // --- Mistral OCR ---
  MISTRAL_API_KEY: required('MISTRAL_API_KEY'),
  MISTRAL_OCR_URL: 'https://api.mistral.ai/v1/ocr',
  MISTRAL_CHAT_URL: 'https://api.mistral.ai/v1/chat/completions',
  MISTRAL_OCR_MODEL: 'mistral-ocr-latest',
  MISTRAL_CHAT_MODEL: process.env.MISTRAL_CHAT_MODEL || 'mistral-small-latest',

  // --- Google Sheets (destination active pour le moment) ---
  GOOGLE: {
    SERVICE_ACCOUNT_EMAIL: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    // Les clés privées contiennent des "\n" littéraux quand elles passent par une
    // variable d'environnement à une seule ligne (Portainer, .env...) : on les
    // reconvertit en vrais retours à la ligne.
    PRIVATE_KEY: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    SHEET_ID: process.env.GOOGLE_SHEET_ID,
  },

  // --- Odoo (JSON-RPC) — destination active pour les prospects ---
  ODOO_JSONRPC_URL: process.env.ODOO_JSONRPC_URL,
  ODOO_DB: process.env.ODOO_DB,
  ODOO_USER: process.env.ODOO_USER,
  ODOO_PASSWORD: process.env.ODOO_PASSWORD,

  // Type d'activité Odoo à créer sur chaque fiche (xml id standard Odoo pour "Appel")
  ODOO_ACTIVITY_TYPE_XMLID: { module: 'mail', name: 'mail_activity_data_call' },

  // -------------------------------------------------------
  // TYPES DE DOCUMENTS
  // Un type = un modèle Odoo Studio (x_...) + une correspondance
  // de champs + le schéma que Mistral doit renvoyer.
  //
  // Les noms techniques x_studio_* ci-dessous sont des exemples :
  // créez les champs correspondants dans Odoo Studio sur votre
  // modèle, puis ajustez ces noms pour qu'ils correspondent
  // exactement (Odoo Studio → champ → "Nom technique").
  // -------------------------------------------------------
  DOCUMENT_TYPES: {
    suivi_rdv: {
      label: 'Suivi des RDV',
      odooModel: process.env.ODOO_MODEL_RDV || 'x_suivi_rdv_ocr',
      dedupeKeys: ['TELEPHONE', 'DATE_RDV'],
      // Onglet Google Sheets utilisé pour ce type + ordre des colonnes
      sheetTab: process.env.GOOGLE_SHEET_TAB_RDV || 'Suivi RDV',
      sheetHeader: ['Date fiche', 'Agent', 'Téléphone', 'Client', 'Date RDV', 'Heure RDV', 'Ville', 'Commentaire'],
      sheetRowFields: ['telephone', 'client', 'date_rdv', 'heure_rdv', 'ville', 'commentaire'],
      // Anti-doublon : téléphone (colonne 2) + date RDV (colonne 4) dans la feuille
      dedupePhoneCol: 2,
      dedupeDateCol: 4,
      dedupeDateField: 'date_rdv', // champ de la ligne à utiliser comme "date" pour la clé
      fields: {
        NAME:        'x_name',
        TELEPHONE:   'x_studio_telephone',
        CLIENT:      'x_studio_client',
        DATE_RDV:    'x_studio_date_rdv',
        HEURE_RDV:   'x_studio_heure_rdv',
        VILLE:       'x_studio_ville',
        COMMENTAIRE: 'x_studio_commentaire',
        AGENT:       'x_studio_agent',
      },
      // --- Étiquette "scan" + statut (à créer dans Odoo Studio si absents) ---
      // tagField : nom technique du champ étiquette existant sur le modèle.
      //   Peut être un champ "Tags" (many2many), texte ou case à cocher :
      //   le code détecte le type automatiquement via fields_get.
      tagField: process.env.ODOO_TAG_FIELD_RDV || 'x_studio_etiquette',
      tagValue: 'scan',
      // Statut désactivé pour l'instant (aucun champ Studio requis pour ça).
      // colonnes affichées / éditables côté interface
      columns: [
        { key: 'telephone',   label: 'Téléphone',    placeholder: '6xx xxx xxx' },
        { key: 'client',      label: 'Client',        placeholder: 'Nom du client' },
        { key: 'date_rdv',    label: 'Date RDV',      placeholder: 'JJ/MM/AAAA' },
        { key: 'heure_rdv',   label: 'Heure',          placeholder: 'HH:MM' },
        { key: 'ville',       label: 'Ville',          placeholder: 'Ydé / Dla…' },
        { key: 'commentaire', label: 'Commentaire',   placeholder: 'Visite…' },
      ],
      // schéma que Mistral doit produire pour ce type de document
      schemaHint: `{
  "date_fiche": "YYYY-MM-DD",
  "agent": "...",
  "rows": [{
    "telephone": "...",
    "client": "...",
    "date_rdv": "JJ/MM/AAAA",
    "heure_rdv": "HH:MM",
    "ville": "...",
    "commentaire": "..."
  }]
}`,
    },

    fiche_appel: {
      label: 'Fiche appel',
      // --- Historisation : 1 en-tête de scan + N lignes d'appel ---
      historized: true,
      odooModel: process.env.ODOO_MODEL_APPEL || 'x_fiche_appel_scan',       // en-tête
      odooLineModel: process.env.ODOO_MODEL_APPEL_LIGNE || 'x_ligne_d_appel', // lignes
      // Noms techniques réels tels que générés par Odoo Studio (les accents
      // sont retirés bizarrement par Studio : "Téléphone" → tlphone, etc.
      // Vérifiable à tout moment via GET /api/odoo/fields?docType=fiche_appel)
      headerFields: {
        NAME:        'x_name',
        DATE_SCAN:   'x_studio_date_du_scan',
        DATE_FICHE:  'x_studio_date_de_la_fiche',
        AGENT:       'x_studio_agent',
        NB_APPELS:   'x_studio_nb_dappels',
        HASH_DEDUP:  'x_studio_hash_anti_doublon',
        LIGNE_IDS:   'x_studio_appels',
      },
      lineFields: {
        NAME:          'x_name',
        FICHE_ID:      'x_studio_fiche_1',
        TELEPHONE:     'x_studio_tlphone',
        CODE_RESULTAT: 'x_studio_code_rsultat',
        DATE_APPEL:    'x_studio_date_de_lappel',
      },
      tagField: process.env.ODOO_TAG_FIELD_APPEL || 'x_studio_etiquette',
      tagValue: 'scan',
      // Statut désactivé pour l'instant (aucun champ Studio requis pour ça).
      columns: [
        { key: 'telephone',     label: 'Téléphone',     placeholder: '6xx xxx xxx' },
        { key: 'code_resultat', label: 'Code résultat', placeholder: 'PEL / NRP / PI / RDV…' },
      ],
      schemaHint: `{
  "date_fiche": "YYYY-MM-DD",
  "agent": "...",
  "rows": [{
    "telephone": "...",
    "code_resultat": "..."
  }]
}`,
    },
  },

  // --- Session / upload ---
  MAX_UPLOAD_SIZE: 10 * 1024 * 1024,
  ALLOWED_EXTENSIONS: ['jpg', 'jpeg', 'png', 'pdf'],

  PORT: process.env.PORT || 3000,
};
