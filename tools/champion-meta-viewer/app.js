const DEFAULT_STATS_URL = '../../databases/champion-meta/stats.json';

const state = {
  raw: null,
  search: '',
  pokemonSort: { key: 'uses', dir: 'desc' },
  teamSort: { key: 'score', dir: 'desc' },
};

const refs = {
  status: document.getElementById('status'),
  loadDefault: document.getElementById('load-default'),
  fileInput: document.getElementById('file-input'),
  search: document.getElementById('search'),
  summaryGrid: document.getElementById('summary-grid'),
  pokemonTable: document.getElementById('pokemon-table'),
  teamTable: document.getElementById('team-table'),
};

const pokemonColumns = [
  { key: 'name', label: 'Pokemon' },
  { key: 'uses', label: 'Uses', numeric: true },
  { key: 'wins', label: 'Wins', numeric: true },
  { key: 'losses', label: 'Losses', numeric: true },
  { key: 'ties', label: 'Ties', numeric: true },
  { key: 'usageRate', label: 'Usage Rate', numeric: true, percent: true },
  { key: 'winRate', label: 'Win Rate', numeric: true, percent: true },
];

const teamColumns = [
  { key: 'id', label: 'Team ID' },
  { key: 'members', label: 'Members' },
  { key: 'uses', label: 'Uses', numeric: true },
  { key: 'score', label: 'Score', numeric: true },
  { key: 'wins', label: 'Wins', numeric: true },
  { key: 'losses', label: 'Losses', numeric: true },
  { key: 'ties', label: 'Ties', numeric: true },
  { key: 'winRate', label: 'Win Rate', numeric: true, percent: true },
];

function setStatus(text, isError = false) {
  refs.status.textContent = text;
  refs.status.classList.toggle('error', isError);
}

function safePercent(value) {
  const num = Number(value) || 0;
  return `${(num * 100).toFixed(2)}%`;
}

function sortRows(rows, sort, columns) {
  const column = columns.find(c => c.key === sort.key);
  const dir = sort.dir === 'asc' ? 1 : -1;

  return [...rows].sort((a, b) => {
    const va = a[sort.key];
    const vb = b[sort.key];

    if (column?.numeric) {
      return ((Number(va) || 0) - (Number(vb) || 0)) * dir;
    }

    return String(va ?? '').localeCompare(String(vb ?? '')) * dir;
  });
}

function applySearch(rows) {
  const q = state.search.trim().toLowerCase();
  if (!q) return rows;

  return rows.filter(row => (
    String(row.name || '').toLowerCase().includes(q) ||
    String(row.id || '').toLowerCase().includes(q) ||
    String(row.members || '').toLowerCase().includes(q)
  ));
}

function renderSummary() {
  if (!state.raw) {
    refs.summaryGrid.innerHTML = '';
    return;
  }

  const totals = state.raw.totals || {};
  const kpis = [
    ['Battles', totals.battles || 0],
    ['Wins P1', totals.winsP1 || 0],
    ['Wins P2', totals.winsP2 || 0],
    ['Ties', totals.ties || 0],
    ['Errors', totals.errors || 0],
    ['Format', state.raw.formatId || '-'],
  ];

  refs.summaryGrid.innerHTML = kpis.map(([label, value]) => (
    `<article class="kpi"><div class="kpi-label">${label}</div><div class="kpi-value">${value}</div></article>`
  )).join('');
}

function renderTable(table, rows, columns, sortState, onSort) {
  const sorted = sortRows(rows, sortState, columns);

  table.querySelector('thead').innerHTML = `
    <tr>
      ${columns.map(col => {
        const active = sortState.key === col.key;
        const arrow = active ? (sortState.dir === 'asc' ? ' ▲' : ' ▼') : '';
        return `<th data-key="${col.key}" class="${active ? 'sorted' : ''}">${col.label}${arrow}</th>`;
      }).join('')}
    </tr>
  `;

  table.querySelector('tbody').innerHTML = sorted.map(row => `
    <tr>
      ${columns.map(col => {
        const value = row[col.key];
        if (col.percent) return `<td>${safePercent(value)}</td>`;
        return `<td>${value ?? ''}</td>`;
      }).join('')}
    </tr>
  `).join('');

  table.querySelectorAll('th').forEach(th => {
    th.addEventListener('click', () => onSort(th.dataset.key));
  });
}

function toggleSort(current, key) {
  if (current.key !== key) return { key, dir: 'desc' };
  return { key, dir: current.dir === 'desc' ? 'asc' : 'desc' };
}

function normalizePokemon(raw) {
  return Object.values(raw?.pokemon || {}).map(p => ({
    name: p.name,
    uses: p.uses || 0,
    wins: p.wins || 0,
    losses: p.losses || 0,
    ties: p.ties || 0,
    usageRate: p.usageRate || 0,
    winRate: p.winRate || 0,
    id: p.id,
  }));
}

function normalizeTeams(raw) {
  return Object.values(raw?.teams || {}).map(t => ({
    id: t.id,
    members: Array.isArray(t.members) ? t.members.join(', ') : '',
    uses: t.uses || 0,
    score: t.score || 0,
    wins: t.wins || 0,
    losses: t.losses || 0,
    ties: t.ties || 0,
    winRate: t.winRate || 0,
  }));
}

function renderAll() {
  if (!state.raw) return;

  const pokemonRows = applySearch(normalizePokemon(state.raw));
  const teamRows = applySearch(normalizeTeams(state.raw));

  renderSummary();
  renderTable(refs.pokemonTable, pokemonRows, pokemonColumns, state.pokemonSort, key => {
    state.pokemonSort = toggleSort(state.pokemonSort, key);
    renderAll();
  });
  renderTable(refs.teamTable, teamRows, teamColumns, state.teamSort, key => {
    state.teamSort = toggleSort(state.teamSort, key);
    renderAll();
  });
}

function loadData(raw) {
  state.raw = raw;
  setStatus(`Données chargées: ${raw?.totals?.battles || 0} battles.`);
  renderAll();
}

async function loadDefaultFile() {
  try {
    setStatus('Chargement du fichier par défaut...');
    const response = await fetch(DEFAULT_STATS_URL, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const raw = await response.json();
    loadData(raw);
  } catch (err) {
    setStatus(`Impossible de charger ${DEFAULT_STATS_URL}: ${err.message}`, true);
  }
}

function loadFromFileInput(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      loadData(JSON.parse(reader.result));
    } catch (err) {
      setStatus(`JSON invalide: ${err.message}`, true);
    }
  };
  reader.onerror = () => {
    setStatus('Erreur de lecture du fichier.', true);
  };
  reader.readAsText(file);
}

refs.loadDefault.addEventListener('click', loadDefaultFile);
refs.fileInput.addEventListener('change', event => {
  const [file] = event.target.files || [];
  if (file) loadFromFileInput(file);
});
refs.search.addEventListener('input', event => {
  state.search = event.target.value;
  renderAll();
});
