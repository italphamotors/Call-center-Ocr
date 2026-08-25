// === Gestion du tableau de correction (colonnes dynamiques selon le type) ===

const reviewTableBody = document.getElementById('reviewTableBody');
const reviewTableHead = document.getElementById('reviewTableHead');

let currentColumns = [];   // [{key, label, placeholder}, ...] pour le type sélectionné
let originalRows = [];     // copie des données OCR brutes, pour "Réinitialiser"

function setTableColumns(columns) {
  currentColumns = columns;
  const headRow = document.createElement('tr');
  columns.forEach(col => {
    const th = document.createElement('th');
    th.textContent = col.label;
    headRow.appendChild(th);
  });
  headRow.appendChild(document.createElement('th')); // colonne suppression
  reviewTableHead.innerHTML = '';
  reviewTableHead.appendChild(headRow);
}

function renderTable(rows) {
  originalRows = JSON.parse(JSON.stringify(rows));
  reviewTableBody.innerHTML = '';
  rows.forEach(row => addRow(row));
}

function addRow(row = {}) {
  const tr = document.createElement('tr');

  currentColumns.forEach(col => {
    const td = document.createElement('td');
    const input = document.createElement('input');
    input.type = 'text';
    input.dataset.field = col.key;
    input.placeholder = col.placeholder || '';
    input.value = row[col.key] || '';
    input.addEventListener('input', () => input.classList.add('cell-edited'));
    td.appendChild(input);
    tr.appendChild(td);
  });

  const tdBtn = document.createElement('td');
  const btnClear = document.createElement('button');
  btnClear.className = 'btn-clear-row';
  btnClear.textContent = '✕';
  btnClear.title = 'Supprimer cette ligne';
  btnClear.addEventListener('click', () => tr.remove());
  tdBtn.appendChild(btnClear);
  tr.appendChild(tdBtn);

  reviewTableBody.appendChild(tr);
}

document.getElementById('btnResetAll').addEventListener('click', () => {
  if (confirm("Réinitialiser toutes les corrections aux valeurs détectées par l'OCR ?")) {
    renderTable(originalRows);
  }
});

document.getElementById('btnAddRow').addEventListener('click', () => addRow());

function readTableData() {
  const rows = [];
  reviewTableBody.querySelectorAll('tr').forEach(tr => {
    const row = {};
    tr.querySelectorAll('input[data-field]').forEach(input => {
      row[input.dataset.field] = input.value.trim();
    });
    rows.push(row);
  });
  return rows;
}
