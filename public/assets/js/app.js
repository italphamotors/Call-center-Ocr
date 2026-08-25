// === Orchestration générale de l'application ===
// selectedFile est déclaré dans upload.js — ne pas re-déclarer ici

let documentTypes = [];   // chargé depuis /api/ocr/types
let selectedType = null;  // {key, label, columns}

const pill1 = document.getElementById('pill-1');
const pill2 = document.getElementById('pill-2');
const pill3 = document.getElementById('pill-3');
const stepType   = document.getElementById('step-type');
const stepUpload = document.getElementById('step-upload');
const stepReview = document.getElementById('step-review');

function goToStep(n) {
  [stepType, stepUpload, stepReview].forEach(s => s.classList.add('hidden'));
  [pill1, pill2, pill3].forEach(p => p.classList.remove('active', 'done'));

  if (n === 1) { stepType.classList.remove('hidden'); pill1.classList.add('active'); }
  if (n === 2) {
    stepUpload.classList.remove('hidden');
    pill1.classList.add('done'); pill2.classList.add('active');
  }
  if (n === 3) {
    stepReview.classList.remove('hidden');
    pill1.classList.add('done'); pill2.classList.add('done'); pill3.classList.add('active');
  }
}

// -------------------------------------------------------
// CHARGEMENT DES TYPES DE DOCUMENTS
// -------------------------------------------------------
async function loadDocumentTypes() {
  try {
    const res = await fetch('/api/ocr/types');
    const data = await res.json();
    if (data.success) {
      documentTypes = data.types;
      renderTypeTiles();
    }
  } catch (err) {
    document.getElementById('typeGrid').innerHTML =
      '<div class="alert alert-error">Impossible de charger les types de documents. Le serveur est-il démarré ?</div>';
  }
}

function renderTypeTiles() {
  const grid = document.getElementById('typeGrid');
  grid.innerHTML = '';
  documentTypes.forEach(type => {
    const tile = document.createElement('div');
    tile.className = 'type-tile';
    tile.innerHTML = `
      <div class="tag">${type.key}</div>
      <h3>${type.label}</h3>
      <p>${type.columns.map(c => c.label).join(' · ')}</p>
    `;
    tile.addEventListener('click', () => {
      document.querySelectorAll('.type-tile').forEach(t => t.classList.remove('selected'));
      tile.classList.add('selected');
      selectedType = type;
      document.getElementById('uploadSubtitle').textContent = `Type sélectionné : ${type.label}`;
      setTableColumns(type.columns);
      setTimeout(() => goToStep(2), 150);
    });
    grid.appendChild(tile);
  });
}

// -------------------------------------------------------
// PRÉVISUALISATION DU DOCUMENT
// -------------------------------------------------------
function showDocumentPreview(file) {
  const documentPreview = document.getElementById('documentPreview');
  documentPreview.innerHTML = '';
  if (file.type.startsWith('image/')) {
    const img = document.createElement('img');
    img.src = URL.createObjectURL(file);
    documentPreview.appendChild(img);
  } else {
    const iframe = document.createElement('iframe');
    iframe.src = URL.createObjectURL(file);
    documentPreview.appendChild(iframe);
  }
}

// -------------------------------------------------------
// Convertit le fichier sélectionné en base64 brut (sans le
// préfixe "data:...;base64,") pour l'envoyer à Odoo.
// -------------------------------------------------------
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    if (!file) return resolve(null);
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result || '';
      const commaIdx = result.indexOf(',');
      resolve(commaIdx !== -1 ? result.slice(commaIdx + 1) : result);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// -------------------------------------------------------
// ENREGISTREMENT DANS ODOO (prospects, étiquette "scan",
// statut initial + activité "Appeler" créés automatiquement)
// -------------------------------------------------------
async function saveToOdoo() {
  const date_fiche = document.getElementById('fiche_date').value;
  const agent = document.getElementById('fiche_agent').value;
  const saveResult = document.getElementById('saveResult');

  const rows = readTableData().filter(r => r.telephone && r.telephone.trim() !== '');
  if (rows.length === 0) {
    alert("Aucune ligne avec un numéro de téléphone à enregistrer.");
    return;
  }

  const btnSave = document.getElementById('btnSave');
  btnSave.disabled = true;
  btnSave.textContent = "Enregistrement en cours...";

  try {
    // Le fichier d'origine (photo/scan) est joint pour les types historisés
    // (ex: Fiche appel) afin de pouvoir le retrouver dans l'historique.
    let file = null;
    if (selectedFile) {
      const base64 = await fileToBase64(selectedFile);
      if (base64) {
        file = { base64, filename: selectedFile.name, mimetype: selectedFile.type };
      }
    }

    const res = await fetch('/api/odoo/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docType: selectedType.key, date_fiche, agent, rows, file }),
    });
    const data = await res.json();

    saveResult.classList.remove('hidden', 'alert-error', 'alert-success', 'alert-warning');

    if (data.success) {
      saveResult.classList.add('alert-success');
      let msg = data.historized
        ? `✅ ${data.created} appel(s) enregistré(s) dans Odoo, sur la fiche "${data.ficheLabel || ''}" (étiquette "scan").`
        : `✅ ${data.created} prospect(s) créé(s) dans Odoo (étiquette "scan", activité Appeler programmée).`;
      if (data.skipped > 0) {
        msg += `<br>⏭️ ${data.skipped} ligne(s) ignorée(s) (déjà enregistrées) : ${data.skippedRows.join(', ')}`;
      }
      if (data.errors && data.errors.length > 0) {
        msg += `<br>⚠️ ${data.errors.length} avertissement(s) : ${data.errors.join(' · ')}`;
      }
      saveResult.innerHTML = msg;
    } else {
      saveResult.classList.add('alert-error');
      saveResult.textContent = "❌ Erreur lors de l'enregistrement : " + (data.message || 'erreur inconnue');
    }
  } catch (err) {
    saveResult.classList.remove('hidden');
    saveResult.classList.add('alert-error');
    saveResult.textContent = "❌ Erreur réseau. Vérifiez votre connexion et réessayez.";
  } finally {
    btnSave.disabled = false;
    btnSave.textContent = "💾 Enregistrer dans Odoo";
  }
}

// -------------------------------------------------------
// POINT D'ENTRÉE
// -------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  loadDocumentTypes();
  goToStep(1);

  document.getElementById('btnBackToType').addEventListener('click', () => goToStep(1));

  document.getElementById('btnAnalyze').addEventListener('click', async () => {
    if (!selectedFile || !selectedType) return;

    const loadingSpinner = document.getElementById('loadingSpinner');
    const ocrWarning = document.getElementById('ocrWarning');
    const btnAnalyze = document.getElementById('btnAnalyze');

    loadingSpinner.classList.remove('hidden');
    btnAnalyze.disabled = true;

    try {
      const formData = new FormData();
      formData.append('document', selectedFile);
      formData.append('docType', selectedType.key);

      const res = await fetch('/api/ocr', { method: 'POST', body: formData });
      const data = await res.json();

      if (!data.success) {
        alert("Erreur OCR : " + (data.error || "erreur inconnue"));
        return;
      }

      showDocumentPreview(selectedFile);

      let warnings = [];
      if (!data.rows || data.rows.length === 0) {
        warnings.push("⚠️ Aucune donnée détectée. Vérifiez la netteté de la photo ou saisissez manuellement.");
      }

      if (data.detected_date) {
        document.getElementById('fiche_date').value = data.detected_date;
      } else {
        document.getElementById('fiche_date').value = '';
        warnings.push("⚠️ Date non détectée automatiquement. Merci de la saisir manuellement.");
      }
      document.getElementById('fiche_agent').value = data.agent || '';

      warnings.push("ℹ️ Relisez chaque ligne avant d'enregistrer : l'OCR peut se tromper sur l'écriture manuscrite, en particulier les numéros de téléphone.");

      ocrWarning.innerHTML = warnings.join('<br>');
      ocrWarning.classList.remove('hidden');

      renderTable(data.rows || []);
      goToStep(3);

    } catch (err) {
      alert("Erreur réseau pendant l'analyse OCR. Réessayez.");
    } finally {
      loadingSpinner.classList.add('hidden');
      btnAnalyze.disabled = false;
    }
  });

  document.getElementById('btnSave').addEventListener('click', saveToOdoo);

  document.getElementById('btnNewScan').addEventListener('click', () => {
    selectedFile = null;
    document.getElementById('previewArea').classList.add('hidden');
    document.getElementById('btnAnalyze').classList.add('hidden');
    document.getElementById('saveResult').classList.add('hidden');
    goToStep(2);
  });
});
