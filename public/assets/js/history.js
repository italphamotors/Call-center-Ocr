// -------------------------------------------------------
// HISTORIQUE — navigation, recherche/filtre, liste, détail
// (uniquement pour les types de document historisés, ex: Fiche appel)
// -------------------------------------------------------

let histOffset = 0;
const HIST_PAGE_SIZE = 20;
const HIST_DOC_TYPE = 'fiche_appel'; // seul type historisé pour l'instant

function showView(id) {
  ['view-scanner', 'view-history', 'view-history-detail'].forEach(v => {
    document.getElementById(v).classList.toggle('hidden', v !== id);
  });
  document.getElementById('nav-scan').classList.toggle('active', id === 'view-scanner');
  document.getElementById('nav-history').classList.toggle('active', id !== 'view-scanner');
}

function formatDate(d) {
  if (!d) return '—';
  // Odoo renvoie "YYYY-MM-DD" ou "YYYY-MM-DD HH:MM:SS"
  const datePart = String(d).split(' ')[0];
  const m = datePart.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return d;
  const timePart = String(d).split(' ')[1];
  return timePart ? `${m[3]}/${m[2]}/${m[1]} ${timePart.slice(0, 5)}` : `${m[3]}/${m[2]}/${m[1]}`;
}

async function loadHistory(resetOffset) {
  if (resetOffset) histOffset = 0;

  const dateFrom = document.getElementById('hist_dateFrom').value;
  const dateTo = document.getElementById('hist_dateTo').value;
  const agent = document.getElementById('hist_agent').value;

  const loading = document.getElementById('histLoading');
  const errorBox = document.getElementById('histError');
  const emptyBox = document.getElementById('histEmpty');
  const table = document.getElementById('histTable');
  const pager = document.getElementById('histPager');

  loading.classList.remove('hidden');
  errorBox.classList.add('hidden');
  emptyBox.classList.add('hidden');
  table.classList.add('hidden');
  pager.classList.add('hidden');

  const params = new URLSearchParams({
    docType: HIST_DOC_TYPE,
    limit: HIST_PAGE_SIZE,
    offset: histOffset,
  });
  if (dateFrom) params.set('dateFrom', dateFrom);
  if (dateTo) params.set('dateTo', dateTo);
  if (agent && agent.trim()) params.set('agent', agent.trim());

  try {
    const res = await fetch(`/api/odoo/history?${params.toString()}`);
    const data = await res.json();
    loading.classList.add('hidden');

    if (!data.success) {
      errorBox.textContent = "❌ " + (data.message || "Erreur inconnue");
      errorBox.classList.remove('hidden');
      return;
    }

    if (!data.records || data.records.length === 0) {
      emptyBox.classList.remove('hidden');
      return;
    }

    const tbody = document.getElementById('histTableBody');
    tbody.innerHTML = '';
    data.records.forEach(r => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${formatDate(r.date_scan)}</td>
        <td>${formatDate(r.date_fiche)}</td>
        <td>${r.agent || '—'}</td>
        <td>${r.nb_appels != null ? r.nb_appels : '—'}</td>
        <td><button class="btnHistOpen" data-id="${r.id}">Ouvrir →</button></td>
      `;
      tbody.appendChild(tr);
    });
    table.classList.remove('hidden');

    document.querySelectorAll('.btnHistOpen').forEach(btn => {
      btn.addEventListener('click', () => openHistoryDetail(btn.dataset.id));
    });

    const from = data.total === 0 ? 0 : histOffset + 1;
    const to = Math.min(histOffset + HIST_PAGE_SIZE, data.total);
    document.getElementById('histPagerLabel').textContent = `${from}–${to} sur ${data.total}`;
    document.getElementById('btnHistPrev').disabled = histOffset === 0;
    document.getElementById('btnHistNext').disabled = to >= data.total;
    pager.classList.remove('hidden');

  } catch (err) {
    loading.classList.add('hidden');
    errorBox.textContent = "❌ Erreur réseau lors du chargement de l'historique.";
    errorBox.classList.remove('hidden');
  }
}

async function openHistoryDetail(id) {
  showView('view-history-detail');
  document.getElementById('histDetailTitle').textContent = 'Chargement…';
  document.getElementById('histDetailTableBody').innerHTML = '';
  document.getElementById('histDetailAttachments').innerHTML = '';

  try {
    const res = await fetch(`/api/odoo/history/${id}?docType=${HIST_DOC_TYPE}`);
    const data = await res.json();

    if (!data.success) {
      document.getElementById('histDetailTitle').textContent = '❌ ' + (data.message || 'Erreur');
      return;
    }

    document.getElementById('histDetailTitle').textContent = data.header.name || `Fiche #${data.header.id}`;
    document.getElementById('histDetailScan').textContent = formatDate(data.header.date_scan);
    document.getElementById('histDetailFiche').textContent = formatDate(data.header.date_fiche);
    document.getElementById('histDetailAgent').textContent = data.header.agent || '—';

    const tbody = document.getElementById('histDetailTableBody');
    if (data.lines.length === 0) {
      tbody.innerHTML = '<tr><td colspan="3" class="sub">Aucun appel enregistré sur cette fiche.</td></tr>';
    } else {
      data.lines.forEach(l => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>${l.telephone || '—'}</td>
          <td>${l.code_resultat || '—'}</td>
          <td>${formatDate(l.date_appel)}</td>
        `;
        tbody.appendChild(tr);
      });
    }

    const attContainer = document.getElementById('histDetailAttachments');
    if (data.attachments && data.attachments.length > 0) {
      attContainer.innerHTML = '<div class="sub" style="margin-top:12px;">Fichier(s) d\'origine :</div>' +
        data.attachments.map(a => `<a href="${a.url}" target="_blank" rel="noopener">📎 ${a.name}</a>`).join('<br>');
    }

  } catch (err) {
    document.getElementById('histDetailTitle').textContent = '❌ Erreur réseau';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('nav-scan').addEventListener('click', () => showView('view-scanner'));
  document.getElementById('nav-history').addEventListener('click', () => {
    showView('view-history');
    loadHistory(true);
  });
  document.getElementById('btnHistBack').addEventListener('click', () => showView('view-history'));

  document.getElementById('btnHistSearch').addEventListener('click', () => loadHistory(true));
  document.getElementById('btnHistReset').addEventListener('click', () => {
    document.getElementById('hist_dateFrom').value = '';
    document.getElementById('hist_dateTo').value = '';
    document.getElementById('hist_agent').value = '';
    loadHistory(true);
  });
  document.getElementById('btnHistPrev').addEventListener('click', () => {
    histOffset = Math.max(0, histOffset - HIST_PAGE_SIZE);
    loadHistory(false);
  });
  document.getElementById('btnHistNext').addEventListener('click', () => {
    histOffset += HIST_PAGE_SIZE;
    loadHistory(false);
  });
});
