const express = require('express');
const { google } = require('googleapis');
const config = require('../config');

const router = express.Router();

function getSheetsClient() {
  if (!config.GOOGLE.SERVICE_ACCOUNT_EMAIL || !config.GOOGLE.PRIVATE_KEY) {
    throw new Error(
      "Compte de service Google non configuré (GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_PRIVATE_KEY manquants)."
    );
  }
  if (!config.GOOGLE.SHEET_ID) {
    throw new Error("GOOGLE_SHEET_ID manquant.");
  }

  const auth = new google.auth.JWT(
    config.GOOGLE.SERVICE_ACCOUNT_EMAIL,
    null,
    config.GOOGLE.PRIVATE_KEY,
    ['https://www.googleapis.com/auth/spreadsheets']
  );

  return google.sheets({ version: 'v4', auth });
}

async function ensureTabExists(sheetsApi, spreadsheetId, tabName) {
  const meta = await sheetsApi.spreadsheets.get({ spreadsheetId });
  const exists = (meta.data.sheets || []).some(s => s.properties.title === tabName);
  if (!exists) {
    await sheetsApi.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] },
    });
  }
}

async function ensureHeaderRow(sheetsApi, spreadsheetId, tabName, header) {
  const res = await sheetsApi.spreadsheets.values.get({
    spreadsheetId,
    range: `${tabName}!A1:Z1`,
  });
  const firstRow = res.data.values && res.data.values[0];
  if (!firstRow || firstRow.length === 0) {
    await sheetsApi.spreadsheets.values.update({
      spreadsheetId,
      range: `${tabName}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [header] },
    });
  }
}

// -------------------------------------------------------
// ANTI-DOUBLON
// Clé = téléphone + date (le champ de date dépend du type de document).
// -------------------------------------------------------
function buildRowKey(row, meta, docTypeConfig) {
  const phone = (row.telephone || '').trim().replace(/\s+/g, '');
  const date = (docTypeConfig.dedupeDateField ? row[docTypeConfig.dedupeDateField] : meta.date_fiche) || '';
  return `${phone}|${date.trim()}`;
}

function buildKeyFromSheetCells(cells, docTypeConfig) {
  const phone = (cells[docTypeConfig.dedupePhoneCol] || '').trim().replace(/\s+/g, '');
  const date = (cells[docTypeConfig.dedupeDateCol] || '').trim();
  return `${phone}|${date}`;
}

async function getExistingKeys(sheetsApi, spreadsheetId, tabName, docTypeConfig) {
  const res = await sheetsApi.spreadsheets.values.get({
    spreadsheetId,
    range: `${tabName}!A2:Z`, // on saute la ligne d'en-tête
  });
  const existingRows = res.data.values || [];
  const keys = new Set();
  existingRows.forEach(cells => keys.add(buildKeyFromSheetCells(cells, docTypeConfig)));
  return keys;
}

// -------------------------------------------------------
// POST /api/sheets/save
// body: { docType, date_fiche, agent, rows: [{...}] }
// -------------------------------------------------------
router.post('/save', async (req, res) => {
  const { docType, date_fiche, agent, rows } = req.body;
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
    const sheetsApi = getSheetsClient();
    const spreadsheetId = config.GOOGLE.SHEET_ID;
    const tabName = docTypeConfig.sheetTab;

    await ensureTabExists(sheetsApi, spreadsheetId, tabName);
    await ensureHeaderRow(sheetsApi, spreadsheetId, tabName, docTypeConfig.sheetHeader);

    const seenKeys = await getExistingKeys(sheetsApi, spreadsheetId, tabName, docTypeConfig);
    const meta = { date_fiche, agent };

    const rowsToInsert = [];
    let skipped = 0;
    const skippedRows = [];

    for (const row of validRows) {
      const key = buildRowKey(row, meta, docTypeConfig);
      if (seenKeys.has(key)) {
        skipped++;
        skippedRows.push(row.telephone);
        continue;
      }
      seenKeys.add(key); // évite aussi les doublons à l'intérieur du même envoi
      rowsToInsert.push([
        date_fiche || '',
        agent || '',
        ...docTypeConfig.sheetRowFields.map(field => row[field] || ''),
      ]);
    }

    if (rowsToInsert.length > 0) {
      await sheetsApi.spreadsheets.values.append({
        spreadsheetId,
        range: `${tabName}!A1`,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: rowsToInsert },
      });
    }

    return res.json({
      success: true,
      created: rowsToInsert.length,
      skipped,
      skippedRows,
    });

  } catch (err) {
    const message = err.response?.data?.error?.message || err.message;
    return res.json({ success: false, message: `Erreur Google Sheets : ${message}` });
  }
});

module.exports = router;
