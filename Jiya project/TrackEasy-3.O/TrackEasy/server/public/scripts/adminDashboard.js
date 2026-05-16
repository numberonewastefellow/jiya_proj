import { get, post, put, del } from './api.js';
import { createCard, createTableRow, renderLoader } from './ui.js';

// Global state
let allOrders = [];
let allOrdersRaw = [];
let currentFilter = 'all';
let lastBlockedUserIds = new Set();
let firstLoad = true;

// D1 — chart instances + refresh timer (module-scope)
const d1Charts = { trend: null, actionMix: null };
let d1RefreshTimer = null;
const ACTION_COLORS = { allow: '#16a34a', warning: '#ca8a04', requires_otp: '#d97706', block: '#dc2626' };

// D2 — Detection Activity chart instances + refresh timer + current window
const d2Charts = { rules: null, models: null, scatter: null, actionByDay: null };
let d2RefreshTimer = null;
let d2CurrentDays = 7;
let d2Wired = false;

// D3 — Geo & Device chart instances + map + refresh timer + current window
const d3Charts = { cities: null, tod: null };
let d3RefreshTimer = null;
let d3CurrentDays = 1;
let d3Wired = false;
let d3LeafletLoaded = false;
let d3Map = null;
const d3MapLayers = { markers: [], polylines: [] };

// D4 — Fraud Ring (Cytoscape) state
let d4Cy = null;
let d4GraphData = null;
let d4MinRisk = 0;
let d4RefreshTimer = null;
let d4CytoscapeLoaded = false;
let d4Wired = false;
const d4EdgeFilters = { phone: true, address: true, device: true };

export async function initAdminDashboard() {
  const ordersTableEl = document.getElementById('orders-table');
  const ordersTable = ordersTableEl ? ordersTableEl.querySelector('tbody') : null;
  if (ordersTable) ordersTable.innerHTML = renderLoader();

  setupNavigation();
  loadAccountData();
  setupPasswordChange();
  setupNotifications();
  loadNotifications();

  // Set personalized title
  try {
    const userStr = localStorage.getItem('user');
    if (userStr) {
      const user = JSON.parse(userStr);
      const titleEl = document.getElementById('page-title');
      if (titleEl && user.username) {
        titleEl.textContent = `${user.username}'s Dashboard`;
      }
    }
  } catch (e) { console.error('Error setting title:', e); }

  try {
    // D1 Fraud Overview — KPIs + charts + risky users + 30s auto-refresh
    await loadFraudOverview();
    startD1AutoRefresh();

    console.log('Admin Dashboard Initializing...');
    // Inject modal if not exists
    if (!document.getElementById('order-details-modal')) {
      injectOrderDetailsModal();
    }

    // Fetch and display orders (drives the separate Orders view)
    const orders = await get('/orders/vendor-orders');
    console.log('Fetched orders:', orders);

    if (!Array.isArray(orders)) {
      if (orders.message && (orders.message.includes('Access denied') || orders.message.includes('Forbidden') || orders.message.includes('No authentication token') || orders.message.includes('Token is invalid'))) {
        alert('Session expired or invalid. Please login again.');
        window.location.href = '/';
        return;
      }
      throw new Error(orders.message || 'Failed to fetch orders');
    }

    // Store orders globally for filtering
    allOrdersRaw = orders;
    allOrders = orders.map(order => ({
      transformed: transformOrderForTable(order),
      raw: order
    }));

    // Setup filter buttons
    setupFilterButtons();

    // Render orders (initially all)
    renderFilteredOrders('all');
  } catch (e) {
    console.error('Admin dashboard error:', e);
    if (ordersTable) ordersTable.innerHTML = `<tr><td colspan="7" class="error-message">Error loading orders: ${e.message}</td></tr>`;
  }
}

async function fetchAdminSummary() {
  // Fetch from /api/admin/summary
  return get('/admin/summary');
}

function transformOrderForTable(order) {
  // Fix: Check order.customer (populated) or fallback
  const customerObj = order.customer || order.customerId;
  const customerName = customerObj?.username || customerObj?.email || (typeof customerObj === 'string' ? customerObj : 'Unknown');
  const vendorName = order.vendorId?.name || order.vendorId?.email || (typeof order.vendorId === 'string' ? order.vendorId : 'Unknown');

  let totalAmount = 0;
  if (order.items && Array.isArray(order.items)) {
    totalAmount = order.items.reduce((sum, item) => {
      return sum + (item.price || 0) * (item.quantity || 0);
    }, 0);
  }

  let dateStr = '-';
  if (order.createdAt) {
    try {
      const date = new Date(order.createdAt);
      const day = String(date.getDate()).padStart(2, '0');
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const year = date.getFullYear();
      const hours = String(date.getHours()).padStart(2, '0');
      const minutes = String(date.getMinutes()).padStart(2, '0');
      const seconds = String(date.getSeconds()).padStart(2, '0');
      dateStr = `${day}/${month}/${year}, ${hours}:${minutes}:${seconds}`;
    } catch (e) { dateStr = order.createdAt; }
  }

  let deliveryStr = '-';
  if (order.delayHours && order.delayHours > 0) {
    deliveryStr = `Delayed (${order.delayHours}h)`;
  } else if (order.status === 'Delivered') {
    deliveryStr = 'On Time';
  } else {
    deliveryStr = order.status || 'Pending';
  }

  return {
    id: order.orderId || order._id?.toString() || 'N/A',
    customer: customerName,
    status: order.status || 'Processing',
    date: dateStr,
    amount: totalAmount > 0 ? `₹${totalAmount.toFixed(0)}` : '-',
    paymentMethod: order.paymentMethod || 'COD',
    delivery: deliveryStr,
    riskScore: order.customerRiskScore || 0
  };
}

function renderSummaryCards(parent, summary) {
  if (!summary) {
    parent.innerHTML = '<div class="error-message">Failed to load summary data</div>';
    return;
  }
  const totalOrders = Number(summary.totalOrders) || 0;
  const onTime = Number(summary.onTime) || 0;
  const delayed = Number(summary.delayed) || 0;
  const failedPayments = Number(summary.failedPayments) || 0;
  const highRiskUsers = Number(summary.highRiskUsers) || 0;

  parent.appendChild(createCard('Total Orders', totalOrders.toLocaleString()));
  parent.appendChild(createCard('On-Time Deliveries', onTime.toLocaleString()));
  parent.appendChild(createCard('Delayed Orders', delayed.toLocaleString()));
  parent.appendChild(createCard('Failed Payments', failedPayments.toLocaleString()));

  const riskCard = createCard('High Risk Users', highRiskUsers.toLocaleString());
  if (highRiskUsers > 0) {
    riskCard.style.borderBottom = '4px solid #ef4444';
    const val = riskCard.querySelector('.card-value');
    if (val) val.style.color = '#ef4444';
  }
  parent.appendChild(riskCard);
}

// =========================================================================
// D1 — Fraud Overview (Dashboard view)
// =========================================================================
function paintKpi(id, todayVal, yestVal) {
  const card = document.getElementById(id);
  if (!card) return;
  const valEl = card.querySelector('.kpi-value');
  const deltaEl = card.querySelector('.kpi-delta');
  if (valEl) valEl.textContent = Number(todayVal || 0).toLocaleString();
  if (!deltaEl) return;
  const t = Number(todayVal || 0);
  const y = Number(yestVal || 0);
  if (y === 0 && t === 0) {
    deltaEl.textContent = '—';
    deltaEl.className = 'kpi-delta';
    return;
  }
  if (y === 0) {
    deltaEl.textContent = '▲ new';
    deltaEl.className = 'kpi-delta up';
    return;
  }
  const pct = ((t - y) / y) * 100;
  const arrow = pct >= 0 ? '▲' : '▼';
  deltaEl.textContent = `${arrow} ${Math.abs(pct).toFixed(1)}% vs yesterday`;
  deltaEl.className = 'kpi-delta ' + (pct >= 0 ? 'up' : 'down');
}

function renderD1Trend(trend) {
  const ctx = document.getElementById('chart-d1-trend');
  if (!ctx || typeof Chart === 'undefined') return;
  if (d1Charts.trend) { d1Charts.trend.destroy(); d1Charts.trend = null; }

  const labels = trend.map(d => d.date.slice(5)); // MM-DD
  d1Charts.trend = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Alerts', data: trend.map(d => d.alerts), borderColor: '#dc2626', backgroundColor: 'rgba(220,38,38,0.1)', tension: 0.3, yAxisID: 'y' },
        { label: 'Orders', data: trend.map(d => d.orders), borderColor: '#2563eb', backgroundColor: 'rgba(37,99,235,0.1)', tension: 0.3, yAxisID: 'y' },
        { label: 'Blocks', data: trend.map(d => d.blocks), borderColor: '#7c2d12', backgroundColor: 'rgba(124,45,18,0.1)', tension: 0.3, yAxisID: 'y' },
        { label: 'Fraud rate', data: trend.map(d => d.fraudRate), borderColor: '#f59e0b', backgroundColor: 'rgba(245,158,11,0.15)', borderDash: [4,3], tension: 0.3, yAxisID: 'y1', fill: false }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'bottom' },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              if (ctx.dataset.label === 'Fraud rate') return `Fraud rate: ${(ctx.parsed.y * 100).toFixed(1)}%`;
              return `${ctx.dataset.label}: ${ctx.parsed.y}`;
            }
          }
        }
      },
      scales: {
        y:  { type: 'linear', position: 'left',  beginAtZero: true, title: { display: true, text: 'Count' } },
        y1: { type: 'linear', position: 'right', beginAtZero: true, max: 1, grid: { drawOnChartArea: false }, ticks: { callback: v => `${Math.round(v * 100)}%` }, title: { display: true, text: 'Fraud rate' } }
      }
    }
  });
}

function renderD1ActionMix(mix) {
  const ctx = document.getElementById('chart-d1-actionmix');
  if (!ctx || typeof Chart === 'undefined') return;
  if (d1Charts.actionMix) { d1Charts.actionMix.destroy(); d1Charts.actionMix = null; }

  const labels = ['allow', 'warning', 'requires_otp', 'block'];
  const data = labels.map(k => mix[k] || 0);
  const colors = labels.map(k => ACTION_COLORS[k]);

  d1Charts.actionMix = new Chart(ctx, {
    type: 'doughnut',
    data: { labels, datasets: [{ data, backgroundColor: colors, borderWidth: 2, borderColor: '#fff' }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom' },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const total = data.reduce((a, b) => a + b, 0) || 1;
              const pct = ((ctx.parsed / total) * 100).toFixed(1);
              return `${ctx.label}: ${ctx.parsed} (${pct}%)`;
            }
          }
        }
      }
    }
  });
}

function renderD1RiskyTable(users) {
  const tbody = document.querySelector('#table-d1-risky tbody');
  if (!tbody) return;
  if (!users || users.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; color:#6b7280; padding:1rem;">No risky users in last 30 days.</td></tr>';
    return;
  }
  tbody.innerHTML = users.map(u => {
    const username = (u.username || 'unknown').replace(/'/g, "\\'");
    const email = u.email || '—';
    const score = (u.latestRiskScore != null) ? u.latestRiskScore : 0;
    const scoreColor = score > 8 ? '#dc2626' : score > 6 ? '#d97706' : score > 3 ? '#ca8a04' : '#16a34a';
    let statusBadge;
    if (u.isBlocked) {
      statusBadge = `<span style="background:#fee2e2; color:#991b1b; padding:0.15rem 0.55rem; border-radius:999px; font-size:0.8rem; font-weight:600;">Blocked</span>`;
    } else {
      statusBadge = `<span style="background:#dcfce7; color:#166534; padding:0.15rem 0.55rem; border-radius:999px; font-size:0.8rem; font-weight:600;">Active</span>`;
    }
    return `
      <tr>
        <td><a href="#" onclick="viewBlockedDetail('${u._id}', '${username}'); return false;" style="color:#2563eb; text-decoration:none; font-weight:500;">${u.username || 'unknown'}</a></td>
        <td>${email}</td>
        <td style="color:${scoreColor}; font-weight:600;">${score}</td>
        <td>${u.alertsCount || 0}</td>
        <td>${statusBadge}</td>
      </tr>`;
  }).join('');
}

async function loadFraudOverview() {
  try {
    const data = await get('/admin/insights/overview');
    if (!data || data.message) {
      console.warn('loadFraudOverview: unexpected response', data);
      return;
    }
    const t = data.today || {};
    const y = data.yesterday || {};
    paintKpi('kpi-events', t.events, y.events);
    paintKpi('kpi-orders', t.orders, y.orders);
    paintKpi('kpi-alerts', t.alerts, y.alerts);
    paintKpi('kpi-blocks', t.blocks, y.blocks);

    renderD1Trend(data.trend7days || []);
    renderD1ActionMix(data.actionMix || {});
    renderD1RiskyTable(data.topRiskyUsers || []);
  } catch (e) {
    console.error('loadFraudOverview error:', e);
  }
}

function startD1AutoRefresh() {
  if (d1RefreshTimer) clearInterval(d1RefreshTimer);
  d1RefreshTimer = setInterval(() => {
    const view = document.getElementById('view-dashboard');
    if (view && !view.classList.contains('hidden')) {
      loadFraudOverview();
    }
  }, 30000);
}

function stopD1AutoRefresh() {
  if (d1RefreshTimer) { clearInterval(d1RefreshTimer); d1RefreshTimer = null; }
}

// =====================================================================
// D2 — Detection Activity (rule + model firing rate, scatter, by-day stack)
// =====================================================================
function renderD2Rules(rules) {
  const ctx = document.getElementById('chart-d2-rules');
  if (!ctx || typeof Chart === 'undefined') return;
  if (d2Charts.rules) { d2Charts.rules.destroy(); d2Charts.rules = null; }
  const labels = rules.map(r => r.id);
  const data = rules.map(r => +(r.rate * 100).toFixed(2));
  d2Charts.rules = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Firing rate (%)',
        data,
        backgroundColor: '#6366f1',
        borderColor: '#4f46e5',
        borderWidth: 1
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const r = rules[ctx.dataIndex] || {};
              return [
                `${r.name || ctx.label}`,
                `Firing rate: ${(r.rate * 100).toFixed(1)}%`,
                `Fired: ${r.fired || 0}`,
                `Avg points when fired: ${r.avgPointsWhenFired || 0}`
              ];
            }
          }
        }
      },
      scales: {
        x: { beginAtZero: true, ticks: { callback: v => `${v}%` }, title: { display: true, text: 'Firing rate' } },
        y: { title: { display: true, text: 'Rule' } }
      }
    }
  });
}

function renderD2Models(models) {
  const ctx = document.getElementById('chart-d2-models');
  if (!ctx || typeof Chart === 'undefined') return;
  if (d2Charts.models) { d2Charts.models.destroy(); d2Charts.models = null; }
  const labels = models.map(m => m.id);
  const data = models.map(m => +(m.rate * 100).toFixed(2));
  d2Charts.models = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Firing rate (%)',
        data,
        backgroundColor: '#0ea5e9',
        borderColor: '#0284c7',
        borderWidth: 1
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const m = models[ctx.dataIndex] || {};
              return [
                `${m.name || ctx.label}`,
                `Endpoint: ${m.endpoint || '—'}`,
                `Firing rate: ${(m.rate * 100).toFixed(1)}%`,
                `Fired: ${m.fired || 0}`,
                `Avg points when fired: ${m.avgPointsWhenFired || 0}`
              ];
            }
          }
        }
      },
      scales: {
        x: { beginAtZero: true, ticks: { callback: v => `${v}%` }, title: { display: true, text: 'Firing rate' } },
        y: { title: { display: true, text: 'Model' } }
      }
    }
  });
}

function renderD2Scatter(points) {
  const ctx = document.getElementById('chart-d2-scatter');
  if (!ctx || typeof Chart === 'undefined') return;
  if (d2Charts.scatter) { d2Charts.scatter.destroy(); d2Charts.scatter = null; }

  const actions = ['allow', 'warning', 'requires_otp', 'block'];
  const datasets = actions.map(a => ({
    label: a,
    data: points
      .filter(p => p.action === a)
      .map(p => ({ x: p.riskScore, y: p.brainProb })),
    backgroundColor: ACTION_COLORS[a],
    borderColor: ACTION_COLORS[a],
    pointRadius: 4,
    pointHoverRadius: 6
  }));

  const quadrantPlugin = {
    id: 'd2Quadrants',
    beforeDatasetsDraw(chart) {
      const { ctx, chartArea: a, scales: { x, y } } = chart;
      if (!a || !x || !y) return;
      const midX = x.getPixelForValue(5);   // ruleScore midpoint (0..10)
      const midY = y.getPixelForValue(0.5); // brainProb midpoint (0..1)
      ctx.save();
      // bottom-left: low rules, low brain — quiet
      ctx.fillStyle = 'rgba(148,163,184,0.06)';
      ctx.fillRect(a.left, midY, midX - a.left, a.bottom - midY);
      // bottom-right: high rules, low brain — rules over-trigger
      ctx.fillStyle = 'rgba(202,138,4,0.08)';
      ctx.fillRect(midX, midY, a.right - midX, a.bottom - midY);
      // top-left: low rules, high brain — brain over-trigger
      ctx.fillStyle = 'rgba(217,119,6,0.08)';
      ctx.fillRect(a.left, a.top, midX - a.left, midY - a.top);
      // top-right: high rules, high brain — agree (block zone)
      ctx.fillStyle = 'rgba(220,38,38,0.08)';
      ctx.fillRect(midX, a.top, a.right - midX, midY - a.top);
      // labels
      ctx.fillStyle = '#94a3b8';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText('quiet',                midX - 6, a.bottom - 6);
      ctx.fillText('rules over-trigger →', a.right - 6, a.bottom - 6);
      ctx.textAlign = 'left';
      ctx.fillText('← brain over-trigger', a.left + 6, a.top + 14);
      ctx.textAlign = 'right';
      ctx.fillText('agree (block zone)',   a.right - 6, a.top + 14);
      ctx.restore();
    }
  };

  d2Charts.scatter = new Chart(ctx, {
    type: 'scatter',
    data: { datasets },
    plugins: [quadrantPlugin],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom' },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: riskScore=${ctx.parsed.x}, brainProb=${(ctx.parsed.y * 100).toFixed(1)}%`
          }
        }
      },
      scales: {
        x: { type: 'linear', min: 0, max: 10, title: { display: true, text: 'RuleScore (0–10)' } },
        y: { type: 'linear', min: 0, max: 1, ticks: { callback: v => `${Math.round(v * 100)}%` }, title: { display: true, text: 'ANN Brain probability' } }
      }
    }
  });
}

function renderD2ActionByDay(rows) {
  const ctx = document.getElementById('chart-d2-actionbyday');
  if (!ctx || typeof Chart === 'undefined') return;
  if (d2Charts.actionByDay) { d2Charts.actionByDay.destroy(); d2Charts.actionByDay = null; }

  const labels = rows.map(r => (r.date || '').slice(5)); // MM-DD
  const actions = ['allow', 'warning', 'requires_otp', 'block'];
  const datasets = actions.map(a => ({
    label: a,
    data: rows.map(r => r[a] || 0),
    backgroundColor: ACTION_COLORS[a],
    borderColor: ACTION_COLORS[a],
    borderWidth: 1,
    stack: 'actions'
  }));

  d2Charts.actionByDay = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom' },
        tooltip: { mode: 'index', intersect: false }
      },
      scales: {
        x: { stacked: true, title: { display: true, text: 'Date' } },
        y: { stacked: true, beginAtZero: true, title: { display: true, text: 'Alerts' } }
      }
    }
  });
}

async function loadDetectionActivity(days) {
  d2CurrentDays = days || d2CurrentDays || 7;
  try {
    const data = await get(`/admin/insights/detection-activity?days=${d2CurrentDays}`);
    if (!data || data.message) {
      console.warn('loadDetectionActivity: unexpected response', data);
      return;
    }
    const totalEl = document.getElementById('d2-total');
    if (totalEl) totalEl.textContent = (data.totalAlerts != null) ? data.totalAlerts : '—';

    renderD2Rules(data.ruleFiringRate || []);
    renderD2Models(data.modelFiringRate || []);
    renderD2Scatter(data.scatter || []);
    renderD2ActionByDay(data.actionByDay || []);
  } catch (e) {
    console.error('loadDetectionActivity error:', e);
  }
}

function startD2AutoRefresh() {
  if (d2RefreshTimer) clearInterval(d2RefreshTimer);
  d2RefreshTimer = setInterval(() => {
    const view = document.getElementById('view-detection');
    if (view && !view.classList.contains('hidden')) {
      loadDetectionActivity(d2CurrentDays);
    }
  }, 30000);
}

function stopD2AutoRefresh() {
  if (d2RefreshTimer) { clearInterval(d2RefreshTimer); d2RefreshTimer = null; }
  // Tear down chart instances so re-entry rebuilds cleanly with fresh data.
  ['rules', 'models', 'scatter', 'actionByDay'].forEach(k => {
    if (d2Charts[k]) { d2Charts[k].destroy(); d2Charts[k] = null; }
  });
}

function setupD2WindowSelector() {
  if (d2Wired) return;
  const root = document.getElementById('d2-window');
  if (!root) return;
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-days]');
    if (!btn) return;
    document.querySelectorAll('#d2-window button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    loadDetectionActivity(parseInt(btn.dataset.days, 10));
  });
  d2Wired = true;
}

// =====================================================================
// D3 — Geo & Device (Leaflet map + cities bar + TOD heatmap + tables)
// =====================================================================
function d3RiskColor(score) {
  const s = Number(score) || 0;
  return s >= 7 ? '#dc2626' : s >= 4 ? '#d97706' : '#16a34a';
}

function d3EscapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Lazy-load Leaflet CSS + JS from CDN.
async function ensureLeaflet() {
  if (d3LeafletLoaded && typeof L !== 'undefined') return;
  // Inject CSS if not already present.
  if (!document.querySelector('link[data-leaflet="1"]')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    link.setAttribute('data-leaflet', '1');
    document.head.appendChild(link);
  }
  // Inject JS if not already present.
  if (typeof L === 'undefined') {
    await new Promise((resolve, reject) => {
      const existing = document.querySelector('script[data-leaflet="1"]');
      if (existing) {
        if (existing.dataset.loaded === '1') return resolve();
        existing.addEventListener('load', () => resolve());
        existing.addEventListener('error', reject);
        return;
      }
      const s = document.createElement('script');
      s.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
      s.async = true;
      s.setAttribute('data-leaflet', '1');
      s.addEventListener('load', () => { s.dataset.loaded = '1'; resolve(); });
      s.addEventListener('error', reject);
      document.head.appendChild(s);
    });
  }
  d3LeafletLoaded = true;
}

function d3ClearMapLayers() {
  if (!d3Map) return;
  d3MapLayers.markers.forEach(m => { try { d3Map.removeLayer(m); } catch (_) {} });
  d3MapLayers.polylines.forEach(p => { try { d3Map.removeLayer(p); } catch (_) {} });
  d3MapLayers.markers = [];
  d3MapLayers.polylines = [];
}

function renderD3Map(recentGeoEvents, impossibleTravel) {
  if (typeof L === 'undefined') return;
  const mapEl = document.getElementById('d3-map');
  if (!mapEl) return;

  if (!d3Map) {
    d3Map = L.map('d3-map', { worldCopyJump: true }).setView([20, 0], 2);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap',
      maxZoom: 18
    }).addTo(d3Map);
  } else {
    // If returning to view, ensure proper sizing.
    setTimeout(() => { try { d3Map.invalidateSize(); } catch (_) {} }, 50);
  }

  d3ClearMapLayers();

  (recentGeoEvents || []).forEach(ev => {
    if (typeof ev.lat !== 'number' || typeof ev.lon !== 'number') return;
    const m = L.circleMarker([ev.lat, ev.lon], {
      radius: 5,
      fillColor: d3RiskColor(ev.latestRiskScore),
      color: '#fff',
      weight: 1,
      fillOpacity: 0.85
    });
    m.bindPopup(
      `<strong>${d3EscapeHtml(ev.username || 'unknown')}</strong><br>` +
      `${d3EscapeHtml(ev.eventType || '')}<br>` +
      `${d3EscapeHtml(ev.city || '')}${ev.country ? ', ' + d3EscapeHtml(ev.country) : ''}<br>` +
      `Risk: <strong style="color:${d3RiskColor(ev.latestRiskScore)}">${ev.latestRiskScore || 0}</strong><br>` +
      `<span style="color:#64748b">${new Date(ev.timestamp).toLocaleString()}</span>`
    );
    m.addTo(d3Map);
    d3MapLayers.markers.push(m);
  });

  (impossibleTravel || []).forEach(r => {
    if (typeof r.fromLat !== 'number' || typeof r.toLat !== 'number') return;
    const line = L.polyline([[r.fromLat, r.fromLon], [r.toLat, r.toLon]], {
      color: '#dc2626',
      weight: 2,
      opacity: 0.7
    });
    line.bindPopup(
      `<strong>Impossible travel</strong><br>` +
      `${d3EscapeHtml(r.username || '')}<br>` +
      `${d3EscapeHtml(r.fromCity || '')} → ${d3EscapeHtml(r.toCity || '')}<br>` +
      `Speed: ${Math.round(r.speedKmh)} km/h · Distance: ${Math.round(r.distanceKm)} km`
    );
    line.addTo(d3Map);
    d3MapLayers.polylines.push(line);
  });
}

function renderD3Cities(rows) {
  const ctx = document.getElementById('chart-d3-cities');
  if (!ctx || typeof Chart === 'undefined') return;
  if (d3Charts.cities) { d3Charts.cities.destroy(); d3Charts.cities = null; }
  const labels = rows.map(r => `${r.city || '—'}${r.country ? ', ' + r.country : ''}`);
  const data = rows.map(r => r.events || 0);
  d3Charts.cities = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Events',
        data,
        backgroundColor: '#6366f1',
        borderColor: '#4f46e5',
        borderWidth: 1
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (c) => {
              const r = rows[c.dataIndex] || {};
              return [
                `${r.city || '—'}${r.country ? ', ' + r.country : ''}`,
                `Events: ${r.events || 0}`,
                `Avg risk: ${r.avgRisk || 0}`
              ];
            }
          }
        }
      },
      scales: {
        x: { beginAtZero: true, title: { display: true, text: 'Events' } },
        y: { title: { display: false } }
      }
    }
  });
}

// TOD heatmap: replace the canvas with a manual 7×24 grid of colored cells.
// Each refresh clears the host card and re-renders the grid; the original
// canvas element is preserved (hidden) so the HTML markup stays intact.
function renderD3Tod(cells) {
  const canvas = document.getElementById('chart-d3-tod');
  if (!canvas) return;

  // Find or create the grid container right after the canvas.
  const parent = canvas.parentElement;
  let grid = parent.querySelector('.tod-grid');
  if (grid) grid.remove();

  // Hide the canvas — we render a div-grid instead.
  canvas.style.display = 'none';

  const maxEvents = Math.max(1, ...cells.map(c => c.events || 0));
  const DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  grid = document.createElement('div');
  grid.className = 'tod-grid';

  // Header row: empty corner + 24 hour columns.
  const corner = document.createElement('div');
  corner.className = 'tod-col-header';
  corner.textContent = '';
  grid.appendChild(corner);
  for (let h = 0; h < 24; h++) {
    const c = document.createElement('div');
    c.className = 'tod-col-header';
    c.textContent = String(h);
    grid.appendChild(c);
  }

  // 7 day rows.
  for (let dow = 0; dow < 7; dow++) {
    const lbl = document.createElement('div');
    lbl.className = 'tod-row-label';
    lbl.textContent = DOW_LABELS[dow];
    grid.appendChild(lbl);
    for (let h = 0; h < 24; h++) {
      const cell = cells.find(c => c.dow === dow && c.hour === h) || { events: 0, alerts: 0 };
      const alpha = cell.events > 0 ? Math.min(1, 0.08 + (cell.events / maxEvents) * 0.92) : 0.04;
      const div = document.createElement('div');
      div.className = 'tod-cell';
      div.style.background = `rgba(99,102,241,${alpha.toFixed(3)})`;
      div.title = `${DOW_LABELS[dow]} ${h}:00 — ${cell.events} events, ${cell.alerts} alerts`;
      grid.appendChild(div);
    }
  }

  canvas.insertAdjacentElement('afterend', grid);
}

function renderD3R5Table(rows) {
  const tbody = document.querySelector('#table-d3-r5 tbody');
  if (!tbody) return;
  if (!rows || rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:1rem; color:#64748b;">No impossible-travel events in this window.</td></tr>';
    return;
  }
  tbody.innerHTML = '';
  rows.forEach(r => {
    const tr = document.createElement('tr');
    tr.style.cursor = 'pointer';
    tr.dataset.fromLat = r.fromLat;
    tr.dataset.fromLon = r.fromLon;
    tr.dataset.toLat = r.toLat;
    tr.dataset.toLon = r.toLon;
    tr.innerHTML = `
      <td>${d3EscapeHtml(r.username || r.userId || '')}</td>
      <td>${Math.round(r.speedKmh || 0)} km/h</td>
      <td>${Math.round(r.distanceKm || 0)} km</td>
      <td>${d3EscapeHtml(r.fromCity || '')} → ${d3EscapeHtml(r.toCity || '')}</td>
      <td>${r.toAt ? new Date(r.toAt).toLocaleString() : ''}</td>
    `;
    tr.addEventListener('click', () => {
      if (!d3Map || typeof L === 'undefined') return;
      const fLat = Number(tr.dataset.fromLat), fLon = Number(tr.dataset.fromLon);
      const tLat = Number(tr.dataset.toLat),   tLon = Number(tr.dataset.toLon);
      if ([fLat, fLon, tLat, tLon].every(n => Number.isFinite(n))) {
        d3Map.fitBounds([[fLat, fLon], [tLat, tLon]], { padding: [60, 60] });
      }
    });
    tbody.appendChild(tr);
  });
}

function renderD3DevicesTable(rows) {
  const tbody = document.querySelector('#table-d3-devices tbody');
  if (!tbody) return;
  if (!rows || rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:1rem; color:#64748b;">No devices shared across multiple accounts.</td></tr>';
    return;
  }
  tbody.innerHTML = '';
  rows.forEach(r => {
    const usernames = (r.users || []).map(u => d3EscapeHtml(u.username || '')).join(', ');
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><code>${d3EscapeHtml(r.fingerprintShort || r.deviceFingerprint || '')}</code></td>
      <td>${r.userCount || 0}</td>
      <td>${usernames}</td>
      <td>${r.anyBlocked
        ? '<span style="font-weight:600; color:#dc2626;">Yes</span>'
        : '<span style="color:#16a34a;">No</span>'}</td>
    `;
    tbody.appendChild(tr);
  });
}

async function loadGeoDevice(days) {
  d3CurrentDays = days || d3CurrentDays || 1;
  try {
    await ensureLeaflet();
  } catch (e) {
    console.error('Leaflet failed to load:', e);
  }
  try {
    const data = await get(`/admin/insights/geo-device?days=${d3CurrentDays}`);
    if (!data || data.message) {
      console.warn('loadGeoDevice: unexpected response', data);
      return;
    }
    const countEl = document.getElementById('d3-event-count');
    if (countEl) countEl.textContent = (data.recentGeoEvents || []).length;

    renderD3Map(data.recentGeoEvents || [], data.impossibleTravel || []);
    renderD3Cities(data.topRiskyCities || []);
    renderD3Tod(data.todHeatmap || []);
    renderD3R5Table(data.impossibleTravel || []);
    renderD3DevicesTable(data.sharedDevices || []);
  } catch (e) {
    console.error('loadGeoDevice error:', e);
  }
}

function startD3AutoRefresh() {
  if (d3RefreshTimer) clearInterval(d3RefreshTimer);
  d3RefreshTimer = setInterval(() => {
    const view = document.getElementById('view-geo');
    if (view && !view.classList.contains('hidden')) {
      loadGeoDevice(d3CurrentDays);
    }
  }, 30000);
}

function stopD3AutoRefresh() {
  if (d3RefreshTimer) { clearInterval(d3RefreshTimer); d3RefreshTimer = null; }
  // Destroy Chart.js instances so re-entry rebuilds cleanly; keep the map
  // instance intact (cheap re-entry) but clear its layers.
  ['cities', 'tod'].forEach(k => {
    if (d3Charts[k]) { d3Charts[k].destroy(); d3Charts[k] = null; }
  });
  d3ClearMapLayers();
}

function setupD3WindowSelector() {
  if (d3Wired) return;
  const root = document.getElementById('d3-window');
  if (!root) return;
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-days]');
    if (!btn) return;
    document.querySelectorAll('#d3-window button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    loadGeoDevice(parseInt(btn.dataset.days, 10));
  });
  d3Wired = true;
}

// =========================================================================
// D4 — Fraud Ring Graph (Cytoscape.js, lazy-loaded)
// =========================================================================

// Lazy-load Cytoscape.js from CDN.
async function ensureCytoscape() {
  if (d4CytoscapeLoaded && typeof cytoscape !== 'undefined') return;
  if (typeof cytoscape === 'undefined') {
    await new Promise((resolve, reject) => {
      const existing = document.querySelector('script[data-cytoscape="1"]');
      if (existing) {
        if (existing.dataset.loaded === '1') return resolve();
        existing.addEventListener('load', () => resolve());
        existing.addEventListener('error', reject);
        return;
      }
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/cytoscape@3.28.1/dist/cytoscape.min.js';
      s.async = true;
      s.setAttribute('data-cytoscape', '1');
      s.addEventListener('load', () => { s.dataset.loaded = '1'; resolve(); });
      s.addEventListener('error', reject);
      document.head.appendChild(s);
    });
  }
  d4CytoscapeLoaded = true;
}

// Risk-score → fill color (matches the legend in the muted hint).
function d4FillColor(riskScore, isBlocked) {
  if (isBlocked) return '#dc2626';
  if (riskScore >= 7) return '#f97316';
  if (riskScore >= 4) return '#fbbf24';
  return '#94a3b8';
}

// sharedVia → edge color (purple/cyan/pink).
const D4_EDGE_COLORS = { phone: '#8b5cf6', address: '#06b6d4', device: '#ec4899' };

async function loadFraudRing(minRisk) {
  if (typeof minRisk === 'number') d4MinRisk = minRisk;
  try {
    await ensureCytoscape();
  } catch (e) {
    console.error('Cytoscape failed to load:', e);
    return;
  }
  try {
    const data = await get(`/admin/insights/graph?minRisk=${d4MinRisk}`);
    if (!data || data.message) {
      console.warn('loadFraudRing: unexpected response', data);
      return;
    }
    d4GraphData = data;

    // Update stats line.
    const statsEl = document.getElementById('d4-stats');
    if (statsEl) {
      const s = data.stats || {};
      statsEl.textContent = `${s.componentCount || 0} components · largest ${s.largestComponent || 0} nodes · ${s.totalNodes || 0} total nodes`;
    }

    // Build Cytoscape elements with pre-computed visual attrs.
    const nodes = (data.nodes || []).map(n => ({
      data: {
        id: n.id,
        username: n.username,
        email: n.email,
        riskScore: n.riskScore,
        isBlocked: n.isBlocked,
        clusterSize: n.clusterSize,
        size: 12 + (Number(n.riskScore) || 0) * 4,
        fillColor: d4FillColor(Number(n.riskScore) || 0, !!n.isBlocked)
      }
    }));
    const edges = (data.edges || []).map((e, i) => ({
      data: {
        id: `e${i}-${e.source}-${e.target}-${e.sharedVia}`,
        source: e.source,
        target: e.target,
        sharedVia: e.sharedVia,
        edgeColor: D4_EDGE_COLORS[e.sharedVia] || '#94a3b8'
      }
    }));
    const elements = nodes.concat(edges);

    const container = document.getElementById('d4-graph');
    if (!container) return;

    if (!d4Cy) {
      // eslint-disable-next-line no-undef
      d4Cy = cytoscape({
        container,
        elements,
        style: [
          {
            selector: 'node',
            style: {
              'background-color': 'data(fillColor)',
              'label': 'data(username)',
              'width': 'data(size)',
              'height': 'data(size)',
              'font-size': 10,
              'text-valign': 'bottom',
              'text-margin-y': 4,
              'color': '#1e293b',
              'border-color': '#fff',
              'border-width': 2,
            }
          },
          {
            selector: 'node:selected',
            style: { 'border-color': '#6366f1', 'border-width': 3 }
          },
          {
            selector: 'edge',
            style: {
              'width': 1.5,
              'line-color': 'data(edgeColor)',
              'label': 'data(sharedVia)',
              'font-size': 8,
              'color': '#64748b',
              'text-background-color': '#fff',
              'text-background-opacity': 0.8,
              'curve-style': 'bezier',
              'opacity': 0.5,
            }
          },
        ],
        layout: {
          name: 'cose',
          animate: false,
          fit: true,
          padding: 30,
          nodeRepulsion: () => 8000,
          idealEdgeLength: () => 80
        },
        wheelSensitivity: 0.2
      });

      // Tap a node → open side panel; tap background → close.
      d4Cy.on('tap', 'node', (evt) => {
        const node = evt.target;
        openD4Side(node);
      });
      d4Cy.on('tap', (evt) => {
        if (evt.target === d4Cy) {
          const side = document.getElementById('d4-side');
          if (side) side.classList.add('hidden');
        }
      });
    } else {
      // Reuse instance: replace elements, re-run layout.
      d4Cy.elements().remove();
      d4Cy.add(elements);
      d4Cy.layout({
        name: 'cose',
        animate: false,
        fit: true,
        padding: 30,
        nodeRepulsion: () => 8000,
        idealEdgeLength: () => 80
      }).run();
    }

    // Re-apply edge-type toggle state (purple/cyan/pink) after rebuild.
    applyD4EdgeFilters();
  } catch (e) {
    console.error('loadFraudRing error:', e);
  }
}

function openD4Side(node) {
  const side = document.getElementById('d4-side');
  const nameEl = document.getElementById('d4-side-name');
  const bodyEl = document.getElementById('d4-side-body');
  if (!side || !nameEl || !bodyEl) return;

  const id = node.data('id');
  const username = node.data('username') || '(unknown)';
  const email = node.data('email') || '—';
  const riskScore = Number(node.data('riskScore')) || 0;
  const isBlocked = !!node.data('isBlocked');
  const clusterSize = node.data('clusterSize') || 1;

  let badgeClass = 'low';
  if (riskScore >= 7) badgeClass = 'high';
  else if (riskScore >= 4) badgeClass = 'med';

  nameEl.textContent = username;
  bodyEl.innerHTML = `
    <div style="display:grid; grid-template-columns:max-content 1fr; gap:6px 14px; font-size:13px; color:#334155;">
      <div style="color:#64748b">Email</div><div>${escapeHtml(email)}</div>
      <div style="color:#64748b">Risk score</div><div><span class="risk-badge ${badgeClass}">${riskScore}</span></div>
      <div style="color:#64748b">Blocked</div><div>${isBlocked ? 'Yes' : 'No'}</div>
      <div style="color:#64748b">Cluster size</div><div>${clusterSize}</div>
    </div>
    <div style="margin-top:12px">
      <button class="btn btn-outline btn-sm" id="d4-side-trace">View full trace</button>
    </div>
  `;
  side.classList.remove('hidden');

  const traceBtn = document.getElementById('d4-side-trace');
  if (traceBtn) {
    traceBtn.addEventListener('click', () => {
      if (typeof viewBlockedDetail === 'function') {
        viewBlockedDetail(id, username);
      } else if (typeof window !== 'undefined' && typeof window.viewBlockedDetail === 'function') {
        window.viewBlockedDetail(id, username);
      }
    });
  }
}

function startD4AutoRefresh() {
  if (d4RefreshTimer) clearInterval(d4RefreshTimer);
  d4RefreshTimer = setInterval(() => {
    const view = document.getElementById('view-ring');
    if (view && !view.classList.contains('hidden')) {
      loadFraudRing(d4MinRisk);
    }
  }, 30000);
}

function stopD4AutoRefresh() {
  if (d4RefreshTimer) { clearInterval(d4RefreshTimer); d4RefreshTimer = null; }
  // Keep d4Cy alive to avoid re-layout cost; just clear elements next entry.
}

function applyD4EdgeFilters() {
  if (!d4Cy) return;
  Object.entries(d4EdgeFilters).forEach(([kind, visible]) => {
    d4Cy.edges(`[sharedVia = "${kind}"]`).style('display', visible ? 'element' : 'none');
  });
}

function setupD4Controls() {
  if (d4Wired) return;
  const slider = document.getElementById('d4-min-risk');
  const sliderValue = document.getElementById('d4-min-risk-value');
  const refreshBtn = document.getElementById('d4-refresh');
  const closeBtn = document.getElementById('d4-side-close');

  if (slider && sliderValue) {
    slider.addEventListener('input', () => {
      d4MinRisk = parseInt(slider.value, 10) || 0;
      sliderValue.textContent = d4MinRisk;
    });
    slider.addEventListener('change', () => {
      loadFraudRing(d4MinRisk);
    });
  }
  ['phone', 'address', 'device'].forEach(kind => {
    const cb = document.getElementById(`d4-edge-${kind}`);
    if (!cb) return;
    cb.addEventListener('change', () => {
      d4EdgeFilters[kind] = cb.checked;
      applyD4EdgeFilters();
    });
  });
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => loadFraudRing(d4MinRisk));
  }
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      const side = document.getElementById('d4-side');
      if (side) side.classList.add('hidden');
    });
  }
  d4Wired = true;
}

function createOrderRowWithModal(transformedOrder, fullOrder) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td>#${transformedOrder.id}</td>
    <td>${transformedOrder.customer}</td>
    <td>${transformedOrder.status}</td>
    <td>${transformedOrder.date}</td>
    <td>${transformedOrder.amount}</td>
    <td style="text-align: center;">
      <span style="font-weight: bold; padding: 4px 10px; border-radius: 999px; font-size: 0.85rem; 
        background: ${transformedOrder.riskScore >= 7 ? '#fee2e2' : transformedOrder.riskScore >= 4 ? '#fef3c7' : '#dcfce7'}; 
        color: ${transformedOrder.riskScore >= 7 ? '#dc2626' : transformedOrder.riskScore >= 4 ? '#d97706' : '#16a34a'};">
        ${transformedOrder.riskScore}
      </span>
    </td>
    <td>${transformedOrder.delivery}</td>
    <td><button class="btn-details" style="padding: 0.25rem 0.75rem; font-size: 0.875rem; cursor: pointer;">Details</button></td>
  `;

  const btn = tr.querySelector('.btn-details');
  btn.addEventListener('click', () => {
    openOrderDetailsModal(fullOrder, transformedOrder);
  });

  return tr;
}

function injectOrderDetailsModal() {
  const modalHtml = `
    <div id="order-details-modal" style="display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 1000; align-items: center; justify-content: center;">
      <div style="background: white; padding: 2rem; border-radius: 8px; width: 90%; max-width: 600px; max-height: 90vh; overflow-y: auto; position: relative;">
        <button id="close-modal-btn" style="position: absolute; top: 1rem; right: 1rem; background: none; border: none; font-size: 1.5rem; cursor: pointer;">&times;</button>
        <h2 style="margin-top: 0;">Order Details</h2>
        <div id="modal-content"></div>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', modalHtml);

  document.getElementById('close-modal-btn').addEventListener('click', () => {
    document.getElementById('order-details-modal').style.display = 'none';
  });

  // Close on outside click
  document.getElementById('order-details-modal').addEventListener('click', (e) => {
    if (e.target.id === 'order-details-modal') {
      document.getElementById('order-details-modal').style.display = 'none';
    }
  });
}

function openOrderDetailsModal(order, transformed) {
  const modal = document.getElementById('order-details-modal');
  const content = document.getElementById('modal-content');

  const itemsHtml = order.items && order.items.length > 0
    ? order.items.map(item => `
        <tr style="border-bottom: 1px solid #eee;">
          <td style="padding: 0.5rem;">${item.quantity || 1}x ${item.name || 'Unknown Item'}</td>
          <td style="padding: 0.5rem; text-align: center;">${item.quantity || 1}</td>
          <td style="padding: 0.5rem; text-align: right;">₹${(item.price || 0).toFixed(0)}</td>
          <td style="padding: 0.5rem; text-align: right;">₹${((item.price || 0) * (item.quantity || 1)).toFixed(0)}</td>
        </tr>
      `).join('')
    : '<tr><td colspan="4" style="text-align: center; padding: 1rem;">No items found</td></tr>';

  // Create items summary for display
  const itemsSummary = order.items && order.items.length > 0
    ? order.items.map(item => `${item.quantity || 1}x ${item.name || 'Item'}`).join(', ')
    : 'No items';

  // Format expected delivery date
  let expectedDeliveryText = 'Not yet scheduled';
  if (order.expectedDeliveryDate) {
    const deliveryDate = new Date(order.expectedDeliveryDate);
    expectedDeliveryText = deliveryDate.toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric'
    });
  }

  // Format actual delivery date
  let actualDeliveryText = null;
  if (order.actualDeliveryDate) {
    const actualDate = new Date(order.actualDeliveryDate);
    actualDeliveryText = actualDate.toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric'
    });
  }

  content.innerHTML = `
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-bottom: 1.5rem;">
      <div><strong>Order ID:</strong> #${transformed.id}</div>
      <div><strong>Date:</strong> ${transformed.date}</div>
      <div><strong>Customer:</strong> ${transformed.customer}</div>
      <div><strong>Status:</strong> <span style="padding: 0.25rem 0.5rem; background: #eee; border-radius: 4px;">${transformed.status}</span></div>
      <div><strong>Total:</strong> ${transformed.amount}</div>
      <div><strong>Risk Score:</strong> 
        <span style="font-weight: bold; padding: 2px 8px; border-radius: 999px; font-size: 0.85rem; 
          background: ${transformed.riskScore >= 7 ? '#fee2e2' : transformed.riskScore >= 4 ? '#fef3c7' : '#dcfce7'}; 
          color: ${transformed.riskScore >= 7 ? '#dc2626' : transformed.riskScore >= 4 ? '#d97706' : '#16a34a'};">
          ${transformed.riskScore}
        </span>
      </div>
      <div><strong>Payment Method:</strong> ${transformed.paymentMethod}</div>
      <div><strong>Items:</strong> ${itemsSummary}</div>
      <div><strong>Expected Delivery:</strong> ${expectedDeliveryText}</div>
      ${actualDeliveryText ? `<div><strong>Actual Delivery:</strong> ${actualDeliveryText}</div>` : ''}
    </div>
    
    <h3 style="font-size: 1.1rem; border-bottom: 2px solid #eee; padding-bottom: 0.5rem;">Items</h3>
    <table style="width: 100%; border-collapse: collapse;">
      <thead>
        <tr style="background: #f9f9f9;">
          <th style="padding: 0.5rem; text-align: left;">Item</th>
          <th style="padding: 0.5rem; text-align: center;">Qty</th>
          <th style="padding: 0.5rem; text-align: right;">Price</th>
          <th style="padding: 0.5rem; text-align: right;">Subtotal</th>
        </tr>
      </thead>
      <tbody>
        ${itemsHtml}
      </tbody>
      <tfoot>
        <tr style="font-weight: bold; border-top: 2px solid #eee;">
          <td colspan="3" style="padding: 0.75rem; text-align: right;">Total:</td>
          <td style="padding: 0.75rem; text-align: right;">${transformed.amount}</td>
        </tr>
      </tfoot>
    </table>
  `;

  modal.style.display = 'flex';
}

// ===================================
// FILTERING FUNCTIONALITY
// ===================================

function categorizeOrder(order) {
  // Failed = Rejected
  if (order.status === 'Rejected') {
    return 'failed';
  }

  // Delayed Delivery = Order was delivered late
  if (order.status === 'Delayed Delivery') {
    return 'delayed';
  }

  // On-Time = Delivered without delay
  if (order.status === 'Delivered') {
    if (!order.delayHours || order.delayHours <= 0) {
      return 'ontime';
    } else {
      return 'delayed';
    }
  }

  // Delayed = Past expected delivery date but not delivered
  if (order.expectedDeliveryDate && order.status !== 'Delivered') {
    const expectedDate = new Date(order.expectedDeliveryDate);
    const now = new Date();
    if (now > expectedDate) {
      return 'delayed';
    }
  }

  // Default: pending/in-progress
  return 'other';
}

function setupFilterButtons() {
  const filterButtons = document.querySelectorAll('.filter-btn');

  filterButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      // Update active state
      filterButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      // Get filter value and render
      const filter = btn.dataset.filter;
      renderFilteredOrders(filter);
    });
  });
}

function renderFilteredOrders(filter) {
  currentFilter = filter;
  const ordersTable = document.getElementById('orders-table').querySelector('tbody');

  if (!ordersTable) return;

  // Filter orders based on category
  let filteredOrders = allOrders;

  if (filter !== 'all') {
    filteredOrders = allOrders.filter(orderObj => {
      const category = categorizeOrder(orderObj.raw);
      return category === filter;
    });
  }

  // Clear table
  ordersTable.innerHTML = '';

  // Render filtered orders
  if (filteredOrders.length > 0) {
    filteredOrders.forEach(orderObj => {
      ordersTable.appendChild(createOrderRowWithModal(orderObj.transformed, orderObj.raw));
    });
  } else {
    const filterLabels = {
      all: 'orders',
      ontime: 'on-time orders',
      delayed: 'delayed orders',
      failed: 'failed orders'
    };
    ordersTable.innerHTML = `<tr><td colspan="8" style="text-align: center; padding: 2rem;">No ${filterLabels[filter]} found</td></tr>`;
  }
}

// ===============================
// NAVIGATION LOGIC
// ===============================
function setupNavigation() {
  console.log('Initializing Admin Navigation...');
  const navIds = ['nav-dashboard', 'nav-orders', 'nav-analytics', 'nav-users', 'nav-blocked', 'nav-detection', 'nav-geo', 'nav-ring', 'nav-playground', 'nav-feedback', 'nav-demo-data', 'nav-account'];
  const viewIds = ['view-dashboard', 'view-orders', 'view-analytics', 'view-users', 'view-blocked', 'view-detection', 'view-geo', 'view-ring', 'view-playground', 'view-feedback', 'view-demo-data', 'view-account'];

  navIds.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        const viewName = id.replace('nav-', '');
        console.log('Navigating to:', viewName);
        switchView(viewName);
      });
    } else {
      console.warn(`Navigation element not found: ${id}`);
    }
  });

  function switchView(viewName) {
    // 1. Update Navigation Links
    navIds.forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        if (id === `nav-${viewName}`) {
          el.classList.add('active');
        } else {
          el.classList.remove('active');
        }
      }
    });

    // 2. Update Content Views
    viewIds.forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        if (id === `view-${viewName}`) {
          el.classList.remove('hidden');
        } else {
          el.classList.add('hidden');
        }
      }
    });

    // 3. Trigger view-specific loads
    if (viewName === 'dashboard') {
      if (typeof loadFraudOverview === 'function') loadFraudOverview();
      if (typeof startD1AutoRefresh === 'function') startD1AutoRefresh();
    } else {
      if (typeof stopD1AutoRefresh === 'function') stopD1AutoRefresh();
    }
    if (viewName === 'detection') {
      if (typeof setupD2WindowSelector === 'function') setupD2WindowSelector();
      if (typeof loadDetectionActivity === 'function') loadDetectionActivity(d2CurrentDays);
      if (typeof startD2AutoRefresh === 'function') startD2AutoRefresh();
    } else {
      if (typeof stopD2AutoRefresh === 'function') stopD2AutoRefresh();
    }
    if (viewName === 'geo') {
      if (typeof setupD3WindowSelector === 'function') setupD3WindowSelector();
      if (typeof loadGeoDevice === 'function') loadGeoDevice(d3CurrentDays);
      if (typeof startD3AutoRefresh === 'function') startD3AutoRefresh();
    } else {
      if (typeof stopD3AutoRefresh === 'function') stopD3AutoRefresh();
    }
    if (viewName === 'ring') {
      if (typeof setupD4Controls === 'function') setupD4Controls();
      if (typeof loadFraudRing === 'function') loadFraudRing(d4MinRisk);
      if (typeof startD4AutoRefresh === 'function') startD4AutoRefresh();
    } else {
      if (typeof stopD4AutoRefresh === 'function') stopD4AutoRefresh();
    }
    if (viewName === 'analytics') {
      if (typeof renderAnalyticsBarChart === 'function') renderAnalyticsBarChart();
    } else if (viewName === 'users') {
      if (typeof loadUsersData === 'function') loadUsersData();
    } else if (viewName === 'blocked') {
      if (typeof loadBlockedUsersData === 'function') loadBlockedUsersData();
      if (typeof startBlockedUsersAutoRefresh === 'function') startBlockedUsersAutoRefresh();
    } else if (viewName === 'playground') {
      if (typeof initInferencePlayground === 'function') initInferencePlayground();
    } else if (viewName === 'feedback') {
      if (typeof loadFeedbackData === 'function') loadFeedbackData();
    } else if (viewName === 'demo-data') {
      setupSeedButtons();
      setupSyntheticSeedControls();
    }
  }
}

let seedButtonsWired = false;
function setupSeedButtons() {
  if (seedButtonsWired) return;
  seedButtonsWired = true;
  const out = document.getElementById('seed-output');
  const writeOutput = (obj) => {
    if (!out) return;
    out.style.display = 'block';
    out.textContent = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
  };

  const seedBtn = document.getElementById('btn-seed-run');
  if (seedBtn) {
    seedBtn.addEventListener('click', async () => {
      seedBtn.disabled = true;
      const original = seedBtn.textContent;
      seedBtn.textContent = 'Seeding…';
      writeOutput('Running POST /api/admin/seed …');
      try {
        const result = await post('/admin/seed', {});
        writeOutput(result);
        if (typeof showToast === 'function') showToast('Reseed complete', result.message || 'Done');
      } catch (err) {
        writeOutput({ error: String(err) });
      } finally {
        seedBtn.disabled = false;
        seedBtn.textContent = original;
      }
    });
  }

  const resetBtn = document.getElementById('btn-seed-reset');
  if (resetBtn) {
    resetBtn.addEventListener('click', async () => {
      const ok = window.confirm(
        'This wipes ALL users, products, orders, fraud alerts, and EventLog rows, then re-seeds from CSVs.\n\nYou will be logged out. Continue?'
      );
      if (!ok) return;
      resetBtn.disabled = true;
      const original = resetBtn.textContent;
      resetBtn.textContent = 'Resetting…';
      writeOutput('Running POST /api/admin/seed/reset …');
      try {
        const result = await post('/admin/seed/reset', {});
        writeOutput(result);
        // Forcibly drop client-side auth; the admin row was wiped & recreated, so the JWT is invalid.
        localStorage.removeItem('authToken');
        localStorage.removeItem('user');
        if (typeof showToast === 'function') showToast('Demo data reset', 'Logging you out — sign back in as admin@trackeasy.com / password123');
        setTimeout(() => { window.location.href = '/login.html'; }, 1800);
      } catch (err) {
        writeOutput({ error: String(err) });
        resetBtn.disabled = false;
        resetBtn.textContent = original;
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Synthetic seed data (dashboards D1-D4)
// ---------------------------------------------------------------------------
let syntheticSeedWired = false;
function setupSyntheticSeedControls() {
  if (syntheticSeedWired) return;
  syntheticSeedWired = true;

  const out = document.getElementById('synthetic-seed-output');
  const writeOutput = (obj) => {
    if (!out) return;
    out.style.display = 'block';
    out.textContent = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
  };
  const appendOutput = (line) => {
    if (!out) return;
    out.style.display = 'block';
    out.textContent = (out.textContent ? out.textContent + '\n' : '') + line;
  };

  const allButtons = () => document.querySelectorAll('#card-synthetic-seed button');
  const setBusy = (busy, label) => {
    allButtons().forEach(b => { b.disabled = busy; });
    if (label) appendOutput(label);
  };

  // Preset buttons
  document.querySelectorAll('#card-synthetic-seed button[data-preset]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const name = btn.getAttribute('data-preset');
      const original = btn.textContent;
      writeOutput(`Generating "${name}" preset… (this may take 10–30s)`);
      setBusy(true);
      btn.textContent = 'Generating…';
      try {
        const result = await post(`/admin/seed/synthetic/preset/${name}`, {});
        writeOutput(result);
        if (typeof showToast === 'function' && result && !result.error) {
          showToast('Synthetic seed generated', `${name} preset — ${result.durationMs || '?'} ms`);
        }
      } catch (err) {
        writeOutput({ error: String(err) });
      } finally {
        setBusy(false);
        btn.textContent = original;
      }
    });
  });

  // Custom form toggle
  const toggleBtn = document.getElementById('btn-toggle-custom-seed');
  const form = document.getElementById('form-custom-seed');
  if (toggleBtn && form) {
    toggleBtn.addEventListener('click', () => {
      form.classList.toggle('hidden');
    });
  }

  // Custom form submit
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const ringSizeRaw = String(fd.get('ringSize') || '').trim();
      const ringSize = ringSizeRaw.split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n) && n > 0);
      const opts = {
        userCount: parseInt(fd.get('userCount'), 10),
        alertCount: parseInt(fd.get('alertCount'), 10),
        eventCount: parseInt(fd.get('eventCount'), 10),
        daysBack: parseInt(fd.get('daysBack'), 10),
        ringCount: parseInt(fd.get('ringCount'), 10),
        ringSize,
        actionMix: {
          allow: parseFloat(fd.get('mixAllow')),
          warning: parseFloat(fd.get('mixWarning')),
          requires_otp: parseFloat(fd.get('mixOtp')),
          block: parseFloat(fd.get('mixBlock')),
        },
      };

      // Client-side validation
      const errs = [];
      if (!Number.isFinite(opts.alertCount) || opts.alertCount <= 0 || opts.alertCount > 10000) errs.push('alertCount must be 1–10000');
      if (!Number.isFinite(opts.daysBack) || opts.daysBack <= 0 || opts.daysBack > 365) errs.push('daysBack must be 1–365');
      if (!ringSize.length && opts.ringCount > 0) errs.push('ringSize must list at least one size when ringCount > 0');
      const am = opts.actionMix;
      const sum = (am.allow || 0) + (am.warning || 0) + (am.requires_otp || 0) + (am.block || 0);
      if (Math.abs(sum - 1.0) > 0.01) errs.push(`actionMix must sum to 1.0 (±0.01), got ${sum.toFixed(3)}`);

      if (errs.length) {
        writeOutput({ errors: errs });
        return;
      }

      writeOutput('Generating custom seed… (this may take 10–30s)');
      setBusy(true);
      const submit = form.querySelector('button[type="submit"]');
      const submitOriginal = submit ? submit.textContent : '';
      if (submit) submit.textContent = 'Generating…';
      try {
        const result = await post('/admin/seed/synthetic', opts);
        writeOutput(result);
        if (typeof showToast === 'function' && result && !result.error) {
          showToast('Synthetic seed generated', `custom — ${result.durationMs || '?'} ms`);
        }
      } catch (err) {
        writeOutput({ error: String(err) });
      } finally {
        setBusy(false);
        if (submit) submit.textContent = submitOriginal;
      }
    });
  }

  // Clear synthetic-only button
  const clearBtn = document.getElementById('btn-clear-synthetic');
  if (clearBtn) {
    clearBtn.addEventListener('click', async () => {
      const ok = window.confirm(
        'Delete every record tagged synthetic:true (synthetic users, alerts, events, orders).\n\nCSV-seeded demo data is NOT touched. Continue?'
      );
      if (!ok) return;
      const original = clearBtn.textContent;
      writeOutput('Clearing synthetic data…');
      setBusy(true);
      clearBtn.textContent = 'Clearing…';
      try {
        const result = await del('/admin/seed/synthetic');
        writeOutput(result);
        if (typeof showToast === 'function' && result && !result.error) {
          showToast('Synthetic data cleared', 'OK');
        }
      } catch (err) {
        writeOutput({ error: String(err) });
      } finally {
        setBusy(false);
        clearBtn.textContent = original;
      }
    });
  }
}

let blockedUsersPollTimer = null;

function startBlockedUsersAutoRefresh() {
  stopBlockedUsersAutoRefresh();
  blockedUsersPollTimer = setInterval(() => {
    const view = document.getElementById('view-blocked');
    if (view && !view.classList.contains('hidden')) {
      loadBlockedUsersData();
    } else {
      stopBlockedUsersAutoRefresh();
    }
  }, 5000);
}

function stopBlockedUsersAutoRefresh() {
  if (blockedUsersPollTimer) {
    clearInterval(blockedUsersPollTimer);
    blockedUsersPollTimer = null;
  }
}

async function loadBlockedUsersData() {
  const tbody = document.getElementById('blocked-users-tbody');
  if (!tbody) return;
  if (!tbody.innerHTML.trim() || tbody.innerHTML.includes('Loading')) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding:2rem;">Loading...</td></tr>`;
  }
  try {
    const users = await get('/manager/blocked-users');
    const refreshBtn = document.getElementById('refresh-blocked-btn');
    if (refreshBtn) refreshBtn.textContent = 'Refresh (last: ' + new Date().toLocaleTimeString() + ')';
    if (!Array.isArray(users) || users.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding:2rem; color:#6b7280;">No blocked users.</td></tr>`;
      return;
    }
    const now = Date.now();
    tbody.innerHTML = users.map(u => {
      const blockedAt = u.blockedAt ? new Date(u.blockedAt) : (u.updatedAt ? new Date(u.updatedAt) : null);
      const blockedUntil = u.blockedUntil ? new Date(u.blockedUntil) : null;
      let untilCell;
      if (!blockedUntil) {
        untilCell = `<span style="color:#6b7280;">— (manual / permanent)</span>`;
      } else {
        const msLeft = blockedUntil.getTime() - now;
        if (msLeft <= 0) {
          untilCell = `<span style="color:#16a34a;">expired (will auto-clear on next request)</span>`;
        } else {
          const sec = Math.ceil(msLeft / 1000);
          untilCell = `<span style="color:#d97706;">in ${sec}s (${blockedUntil.toLocaleTimeString()})</span>`;
        }
      }
      return `
        <tr>
          <td style="font-weight:500;">${u.username}</td>
          <td>${u.email}</td>
          <td><span style="text-transform:capitalize; background:#f3f4f6; padding:0.2rem 0.5rem; border-radius:4px;">${u.role}</span></td>
          <td style="max-width:300px;">${u.blockReason || '—'}</td>
          <td>${blockedAt ? blockedAt.toLocaleString() : '—'}</td>
          <td>${untilCell}</td>
          <td>
            <div style="display:flex; gap:0.4rem; flex-wrap:wrap;">
              <button onclick="viewBlockedDetail('${u._id}', '${(u.username || '').replace(/'/g, "\\'")}')"
                      style="background:#3b82f6; color:#fff; border:none; padding:0.4rem 0.7rem; border-radius:4px; cursor:pointer; font-size:0.82rem;">View Details</button>
              <button onclick="unblockUserFromList('${u._id}')" style="background:#16a34a; color:#fff; border:none; padding:0.4rem 0.85rem; border-radius:4px; cursor:pointer; font-size:0.85rem;">Unblock</button>
            </div>
          </td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding:2rem; color:#dc2626;">Error loading blocked users: ${err.message}</td></tr>`;
  }
}

async function unblockUserFromList(userId) {
  try {
    const result = await put(`/admin/users/${userId}/toggle-block`, {});
    if (typeof showToast === 'function') showToast('User unblocked', result.message || 'Done');
    loadBlockedUsersData();
  } catch (err) {
    alert('Failed to unblock: ' + (err.message || 'Unknown error'));
  }
}

// =========================================================================
// BLOCK DETAIL VIEW — replays the saved decision trace, Playground-style.
// =========================================================================
function closeBlockDetail() {
  const overlay = document.getElementById('block-detail-overlay');
  if (overlay) overlay.style.display = 'none';
}

async function viewBlockedDetail(userId, username) {
  const overlay = document.getElementById('block-detail-overlay');
  const body = document.getElementById('bd-body');
  const title = document.getElementById('bd-title');
  if (!overlay || !body) return;
  overlay.style.display = 'block';
  title.textContent = `Block decision trace — ${username || userId}`;
  body.innerHTML = '<div style="text-align:center; padding:2rem; color:#6b7280;">Loading decision trace…</div>';
  try {
    const data = await get(`/admin/blocked-detail/${userId}`);
    body.innerHTML = renderBlockDetail(data);
  } catch (err) {
    body.innerHTML = `<div style="color:#dc2626; padding:1rem;">Failed to load details: ${err.message || 'unknown error'}</div>`;
  }
}

function renderBlockDetail(data) {
  if (!data || !data.user) return '<div style="color:#dc2626;">No data.</div>';
  const u = data.user;
  const a = data.alert;
  const trace = a && a.decisionTrace;

  // Header summary card
  const blockedAt = u.blockedAt ? new Date(u.blockedAt).toLocaleString() : '—';
  const blockedUntil = u.blockedUntil ? new Date(u.blockedUntil) : null;
  const now = Date.now();
  const remainSec = blockedUntil ? Math.max(0, Math.ceil((blockedUntil.getTime() - now) / 1000)) : null;
  const cooldownStr = !blockedUntil ? '— (manual / permanent)' :
    (remainSec <= 0 ? 'expired (will auto-clear on next request)' : `${remainSec}s remaining (until ${blockedUntil.toLocaleTimeString()})`);
  const reason = u.blockReason || (a && a.violationReason) || '—';

  let header = `
    <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:1rem; padding:1rem; background:#f9fafb; border-radius:8px; margin-bottom:1.25rem;">
      <div><div style="font-size:0.75rem; color:#6b7280;">User</div><div style="font-weight:600;">${escapeHtml(u.username || '')}</div><div style="font-size:0.82rem; color:#6b7280;">${escapeHtml(u.email || '')}</div></div>
      <div><div style="font-size:0.75rem; color:#6b7280;">Risk Score</div><div style="font-size:1.5rem; font-weight:700; color:${a && a.riskScore > 8 ? '#dc2626' : a && a.riskScore > 6 ? '#d97706' : '#16a34a'};">${a ? a.riskScore : '—'} <span style="font-size:0.85rem; color:#6b7280;">/ 10</span></div></div>
      <div><div style="font-size:0.75rem; color:#6b7280;">Blocked At</div><div style="font-weight:500;">${blockedAt}</div></div>
      <div><div style="font-size:0.75rem; color:#6b7280;">Auto-Unblock</div><div style="font-weight:500;">${cooldownStr}</div></div>
      <div style="grid-column: span 2;"><div style="font-size:0.75rem; color:#6b7280;">Reason</div><div style="font-weight:500; word-break:break-word;">${escapeHtml(reason)}</div></div>
    </div>
  `;

  if (!trace) {
    return header + `
      <div style="padding:1rem; background:#fef9c3; border-radius:8px; color:#713f12;">
        <strong>No decision trace stored for this block.</strong>
        <div style="margin-top:0.5rem; font-size:0.9rem;">
          This usually means one of: (a) the block predates the decision-trace feature, (b) the user was blocked manually by an admin/manager (no fraud-evaluation ran), or (c) the original alert errored out before the trace could be saved.
          New auto-blocks will store the full trace going forward.
        </div>
      </div>
    `;
  }

  // ----- Flowchart / decision tree -----
  let flow = '<div style="display:flex; flex-direction:column; gap:0.4rem;">';
  (trace.flow || []).forEach((step, idx) => {
    const isFinal = step.kind === 'final';
    const isAggregate = step.kind === 'aggregate';
    const isStart = step.kind === 'start';
    const fired = !!step.fired;
    const colour = isFinal ? (step.detail === 'block' ? '#dc2626' : step.detail === 'allow' ? '#16a34a' : '#d97706') :
                   isAggregate ? '#0f172a' :
                   isStart ? '#3b82f6' :
                   fired ? '#dc2626' : '#9ca3af';
    const bg = fired || isFinal || isAggregate || isStart ? colour + '18' : '#fff';
    const icon = isStart ? '▶' : isFinal ? '⏹' : isAggregate ? '∑' : (fired ? '●' : '○');
    flow += `
      <div style="display:flex; align-items:flex-start; gap:0.7rem;">
        <div style="display:flex; flex-direction:column; align-items:center; min-width:24px;">
          <div style="width:24px; height:24px; border-radius:50%; background:${colour}; color:#fff; display:flex; align-items:center; justify-content:center; font-weight:700; font-size:0.75rem;">${icon}</div>
          ${idx < trace.flow.length - 1 ? `<div style="width:2px; flex:1; min-height:14px; background:${colour};"></div>` : ''}
        </div>
        <div style="flex:1; padding:0.55rem 0.85rem; background:${bg}; border-left:3px solid ${colour}; border-radius:5px; margin-bottom:0.2rem;">
          <div style="font-weight:${fired || isFinal || isAggregate ? '600' : '400'}; color:${fired || isFinal || isAggregate ? '#0f172a' : '#6b7280'}; font-size:0.92rem;">${escapeHtml(step.label)}</div>
          <div style="font-size:0.78rem; color:${fired || isFinal ? colour : '#6b7280'}; margin-top:1px; font-family:monospace;">${escapeHtml(step.detail || '')}</div>
        </div>
      </div>
    `;
  });
  flow += '</div>';

  // ----- Aggregate banner (Playground-style) -----
  const ag = trace.aggregate || {};
  const action = ag.action || 'unknown';
  const colour = action === 'block' ? '#dc2626' : action === 'requires_otp' ? '#d97706' : action === 'warning' ? '#ca8a04' : '#16a34a';
  const icon = action === 'block' ? '🚫' : action === 'requires_otp' ? '⚠️' : action === 'warning' ? '⚠' : '✅';
  const aggHtml = `
    <div style="border:2px solid ${colour}; border-radius:10px; padding:1rem 1.25rem; background:${colour}10; margin-bottom:1.25rem;">
      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.5rem;">
        <div style="font-size:1.1rem; font-weight:700; color:${colour};">${icon} Action: ${String(action).toUpperCase()}</div>
        <div style="font-family:monospace; font-size:0.95rem;">Risk score (capped 0-10): <strong>${ag.riskScore != null ? ag.riskScore : '—'}</strong> &nbsp;|&nbsp; raw sum: ${ag.rawSum != null ? ag.rawSum : '—'}</div>
      </div>
      ${(ag.reasons || []).length ? `
        <div style="margin-top:0.7rem;">
          <div style="font-weight:600; margin-bottom:0.2rem;">Reasons:</div>
          <ul style="margin:0 0 0 1.25rem; padding:0;">
            ${ag.reasons.map(r => `<li style="margin:2px 0;">${escapeHtml(r)}</li>`).join('')}
          </ul>
        </div>` : ''}
    </div>
  `;

  // ----- Rules cards -----
  const rulesHtml = (trace.rules || []).map(r => {
    const fired = r.fired;
    const border = fired ? '#dc2626' : '#d1d5db';
    const bg = fired ? '#fef2f2' : '#fff';
    const badge = fired
      ? `<span style="background:#dc2626; color:#fff; padding:2px 8px; border-radius:99px; font-size:0.7rem; font-weight:600; white-space:nowrap;">FIRED${r.points ? ' +' + r.points : ''}</span>`
      : `<span style="background:#e5e7eb; color:#6b7280; padding:2px 8px; border-radius:99px; font-size:0.7rem; font-weight:500;">no</span>`;
    return `
      <div style="border:1px solid ${border}; border-radius:8px; padding:0.75rem; background:${bg}; font-size:0.85rem; min-width:0; overflow:hidden;">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:0.5rem; margin-bottom:0.4rem;">
          <strong style="word-break:break-word; line-height:1.3;">[${r.id}] ${escapeHtml(r.name)}</strong>
          ${badge}
        </div>
        <div style="color:#6b7280; font-size:0.78rem; margin-bottom:0.3rem;">${escapeHtml(r.origin || '')}</div>
        <pre style="font-family:monospace; background:#f3f4f6; padding:0.45rem 0.55rem; border-radius:4px; font-size:0.78rem; margin:0 0 0.4rem 0; white-space:pre-wrap; word-break:break-word; overflow-wrap:anywhere;">${escapeHtml(r.formula || '')}</pre>
        <pre style="font-family:monospace; font-size:0.76rem; margin:0; padding:0.4rem 0.5rem; background:#fafafa; border:1px solid #e5e7eb; border-radius:4px; white-space:pre-wrap; word-break:break-word; overflow-wrap:anywhere;">${escapeHtml(JSON.stringify(r.inputs, null, 2))}</pre>
      </div>
    `;
  }).join('');

  // ----- Models cards -----
  const modelsHtml = (trace.models || []).map(m => {
    const fired = m.fired;
    const border = fired ? '#dc2626' : '#3b82f6';
    const bg = fired ? '#fef2f2' : '#eff6ff';
    let badge = `<span style="background:#3b82f6; color:#fff; padding:2px 8px; border-radius:99px; font-size:0.72rem; font-weight:600;">CALLED</span>`;
    if (fired) badge = `<span style="background:#dc2626; color:#fff; padding:2px 8px; border-radius:99px; font-size:0.72rem; font-weight:600;">FIRED${m.points ? ' +' + m.points : ''}</span>`;
    const stepsHtml = (m.transformation || []).map(s => `<div style="margin:3px 0; padding-left:0.4rem; border-left:2px solid #cbd5e1;">${escapeHtml(s)}</div>`).join('');
    return `
      <div style="border:1px solid ${border}; border-left:4px solid ${border}; border-radius:8px; padding:1rem; background:${bg};">
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.5rem; margin-bottom:0.6rem;">
          <div>
            <strong style="font-size:1rem;">[${m.id}] ${escapeHtml(m.name)}</strong>
            ${m.points ? `<span style="margin-left:0.5rem; color:#6b7280; font-size:0.82rem;">contributes +${m.points} when fired</span>` : ''}
          </div>
          ${badge}
        </div>
        <div style="font-family:monospace; font-size:0.8rem; color:#475569; margin-bottom:0.5rem;">${escapeHtml(m.endpoint || '')}</div>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:1rem; margin-top:0.5rem;">
          <div>
            <div style="font-weight:600; margin-bottom:0.3rem; font-size:0.85rem;">Transformation</div>
            <div style="font-size:0.77rem; line-height:1.45;">${stepsHtml || '<em>None</em>'}</div>
          </div>
          <div>
            <div style="font-weight:600; margin-bottom:0.3rem; font-size:0.85rem;">Model returned</div>
            <pre style="background:#0f172a; color:#86efac; padding:0.6rem; border-radius:5px; font-size:0.75rem; margin:0; max-height:200px; overflow:auto; white-space:pre-wrap; word-break:break-word; overflow-wrap:anywhere;">${escapeHtml(JSON.stringify(m.output || null, null, 2))}</pre>
            ${m.threshold != null ? `<div style="margin-top:0.4rem; font-size:0.78rem; color:#6b7280;">Fires when output > <strong>${m.threshold}</strong></div>` : ''}
          </div>
        </div>
        ${m.note ? `<div style="margin-top:0.6rem; padding:0.4rem 0.6rem; background:#fef9c3; border-radius:4px; font-size:0.78rem; color:#713f12;">📝 ${escapeHtml(m.note)}</div>` : ''}
      </div>
    `;
  }).join('');

  // ----- SHAP bars -----
  let shapHtml = '<em style="color:#6b7280; font-size:0.85rem;">No XAI explanation stored.</em>';
  const expl = (ag && ag.explanation) || (a && a.explanation);
  if (Array.isArray(expl) && expl.length) {
    const sorted = expl.slice().sort((x, y) => Math.abs(y.contribution) - Math.abs(x.contribution));
    const maxMag = Math.max.apply(null, sorted.map(e => Math.abs(e.contribution)).concat(0.01));
    shapHtml = sorted.map(item => {
      const positive = item.contribution >= 0;
      const widthPct = Math.min(100, (Math.abs(item.contribution) / maxMag) * 100);
      return `
        <div style="display:grid; grid-template-columns:120px 1fr 80px; gap:10px; align-items:center; margin:6px 0; font-size:0.9rem;">
          <span style="font-family:monospace;">${escapeHtml(item.feature)}</span>
          <div style="background:#e5e7eb; height:14px; border-radius:3px; overflow:hidden;">
            <div style="background:${positive ? '#dc2626' : '#16a34a'}; width:${widthPct}%; height:100%;"></div>
          </div>
          <span style="text-align:right; font-family:monospace;">${positive ? '+' : ''}${Number(item.contribution).toFixed(2)}</span>
        </div>
      `;
    }).join('');
  }

  return `
    ${header}
    ${aggHtml}
    <h4 style="margin:1.2rem 0 0.6rem 0; font-size:1rem;">Decision flow (top → bottom)</h4>
    ${flow}
    <h4 style="margin:1.5rem 0 0.6rem 0; font-size:1rem;">Rule layer (deterministic)</h4>
    <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(320px, 1fr)); gap:0.75rem;">${rulesHtml}</div>
    <h4 style="margin:1.5rem 0 0.6rem 0; font-size:1rem;">ML models</h4>
    <div style="display:flex; flex-direction:column; gap:1rem;">${modelsHtml}</div>
    <h4 style="margin:1.5rem 0 0.6rem 0; font-size:1rem;">Master brain — feature contributions (SHAP-style)</h4>
    <div style="background:#f9fafb; padding:1rem; border-radius:8px;">${shapHtml}</div>
    <h4 style="margin:1.5rem 0 0.6rem 0; font-size:1rem;">Captured order &amp; context</h4>
    <pre style="background:#0f172a; color:#e2e8f0; padding:1rem; border-radius:8px; font-size:0.82rem; overflow:auto; white-space:pre-wrap; word-break:break-word; overflow-wrap:anywhere;">${escapeHtml(JSON.stringify({ simulatedOrder: trace.simulatedOrder, context: trace.context, evaluatedAt: trace.evaluatedAt }, null, 2))}</pre>
  `;
}

if (typeof window !== 'undefined') {
  window.loadBlockedUsersData = loadBlockedUsersData;
  window.unblockUserFromList = unblockUserFromList;
  window.viewBlockedDetail = viewBlockedDetail;
  window.closeBlockDetail = closeBlockDetail;
}

// =========================================================================
// INFERENCE PLAYGROUND
// =========================================================================
let playgroundInited = false;

async function initInferencePlayground() {
  if (playgroundInited) return;
  playgroundInited = true;
  const fillSelect = (id, opts, defaultVal) => {
    const sel = document.getElementById(id);
    if (!sel) return;
    sel.innerHTML = opts.map(v => `<option value="${v}"${v == defaultVal ? ' selected' : ''}>${v}</option>`).join('');
  };
  fillSelect('pg-items', [1, 2, 3, 5, 8, 12, 20, 30, 50], 2);
  fillSelect('pg-qty', [1, 2, 3, 5, 8, 10, 20, 50], 1);
  fillSelect('pg-amount', [200, 500, 800, 1500, 3000, 5000, 10000, 25000, 50000, 100000, 250000], 800);
  fillSelect('pg-hour', Array.from({ length: 24 }, (_, i) => i), new Date().getHours());

  // Load customers into dropdown
  try {
    const users = await get('/admin/users');
    const customers = (users || []).filter(u => u.role === 'customer');
    const sel = document.getElementById('pg-customer');
    if (sel) {
      sel.innerHTML = customers.map(u => `<option value="${u._id}">${u.username} — ${u.email}</option>`).join('');
    }
  } catch (e) {
    console.error('Could not load customers for playground:', e);
  }
}

async function runInferencePlayground() {
  const customerId = document.getElementById('pg-customer').value;
  if (!customerId) { alert('Pick a customer first'); return; }
  const itemCount = parseInt(document.getElementById('pg-items').value, 10);
  const qty = parseInt(document.getElementById('pg-qty').value, 10);
  const totalAmount = parseInt(document.getElementById('pg-amount').value, 10);
  const paymentMethod = document.getElementById('pg-method').value;
  const hour = parseInt(document.getElementById('pg-hour').value, 10);

  // Build a fake items array — just `itemCount` placeholder items each with `qty`
  const items = Array.from({ length: itemCount }, (_, i) => ({ name: `Item ${i + 1}`, price: Math.round(totalAmount / itemCount), quantity: qty }));

  const btn = document.getElementById('pg-run');
  if (btn) { btn.disabled = true; btn.textContent = 'Running…'; }
  try {
    const res = await post('/admin/inference-playground', {
      customerId,
      simulatedOrder: { items, totalAmount, paymentMethod, hour }
    });
    renderPlaygroundResult(res);
  } catch (e) {
    alert('Inference failed: ' + (e.message || 'unknown'));
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Run Inference'; }
  }
}

function renderPlaygroundResult(res) {
  const wrap = document.getElementById('pg-result');
  if (!wrap || !res || !res.aggregate) return;
  wrap.style.display = 'block';

  // Aggregate banner
  const action = res.aggregate.action;
  const colour = action === 'block' ? '#dc2626' : action === 'requires_otp' ? '#d97706' : action === 'warning' ? '#ca8a04' : '#16a34a';
  const icon = action === 'block' ? '🚫' : action === 'requires_otp' ? '⚠️' : action === 'warning' ? '⚠' : '✅';
  const aggHtml = `
    <div style="border:2px solid ${colour}; border-radius:10px; padding:1rem 1.25rem; background:${colour}10;">
      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.5rem;">
        <div style="font-size:1.1rem; font-weight:700; color:${colour};">${icon} Action: ${action.toUpperCase()}</div>
        <div style="font-family:monospace; font-size:0.95rem;">Risk score (capped 0-10): <strong>${res.aggregate.riskScore}</strong> &nbsp;|&nbsp; raw sum: ${res.aggregate.rawSum}</div>
      </div>
      ${(res.aggregate.reasons || []).length ? `
        <div style="margin-top:0.7rem;">
          <div style="font-weight:600; margin-bottom:0.2rem;">Reasons:</div>
          <ul style="margin:0 0 0 1.25rem; padding:0;">
            ${res.aggregate.reasons.map(r => `<li style="margin:2px 0;">${r}</li>`).join('')}
          </ul>
        </div>` : ''}
    </div>
  `;
  document.getElementById('pg-aggregate').innerHTML = aggHtml;

  // Rules
  const rulesEl = document.getElementById('pg-rules');
  rulesEl.style.gridTemplateColumns = 'repeat(auto-fit, minmax(320px, 1fr))';
  rulesEl.innerHTML = res.rules.map(r => {
    const fired = r.fired;
    const border = fired ? '#dc2626' : '#d1d5db';
    const bg = fired ? '#fef2f2' : '#fff';
    const badge = fired
      ? `<span style="background:#dc2626; color:#fff; padding:2px 8px; border-radius:99px; font-size:0.7rem; font-weight:600; white-space:nowrap;">FIRED${r.points ? ' +' + r.points : ''}</span>`
      : `<span style="background:#e5e7eb; color:#6b7280; padding:2px 8px; border-radius:99px; font-size:0.7rem; font-weight:500;">no</span>`;
    return `
      <div style="border:1px solid ${border}; border-radius:8px; padding:0.75rem; background:${bg}; font-size:0.85rem; min-width:0; overflow:hidden;">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:0.5rem; margin-bottom:0.4rem;">
          <strong style="word-break:break-word; line-height:1.3;">[${r.id}] ${r.name}</strong>
          ${badge}
        </div>
        <div style="color:#6b7280; font-size:0.78rem; margin-bottom:0.3rem;">${r.origin}</div>
        <pre style="font-family:monospace; background:#f3f4f6; padding:0.45rem 0.55rem; border-radius:4px; font-size:0.78rem; margin:0 0 0.4rem 0; white-space:pre-wrap; word-break:break-word; overflow-wrap:anywhere;">${escapeHtml(r.formula)}</pre>
        <pre style="font-family:monospace; font-size:0.76rem; margin:0; padding:0.4rem 0.5rem; background:#fafafa; border:1px solid #e5e7eb; border-radius:4px; white-space:pre-wrap; word-break:break-word; overflow-wrap:anywhere;">${escapeHtml(JSON.stringify(r.inputs, null, 2))}</pre>
      </div>
    `;
  }).join('');

  // Models
  const modelsEl = document.getElementById('pg-models');
  modelsEl.innerHTML = res.models.map(m => {
    const fired = m.fired;
    const skipped = m.skipped;
    const border = fired ? '#dc2626' : skipped ? '#a3a3a3' : '#3b82f6';
    const bg = fired ? '#fef2f2' : skipped ? '#fafafa' : '#eff6ff';
    let badge = `<span style="background:#3b82f6; color:#fff; padding:2px 8px; border-radius:99px; font-size:0.72rem; font-weight:600;">CALLED</span>`;
    if (fired) badge = `<span style="background:#dc2626; color:#fff; padding:2px 8px; border-radius:99px; font-size:0.72rem; font-weight:600;">FIRED${m.points ? ' +' + m.points : ''}</span>`;
    if (skipped) badge = `<span style="background:#a3a3a3; color:#fff; padding:2px 8px; border-radius:99px; font-size:0.72rem; font-weight:600;">SKIPPED</span>`;
    if (m.error) badge = `<span style="background:#f59e0b; color:#fff; padding:2px 8px; border-radius:99px; font-size:0.72rem; font-weight:600;">ERROR</span>`;
    const stepsHtml = (m.transformation || []).map((s, i) => `<div style="margin:3px 0; padding-left:0.4rem; border-left:2px solid #cbd5e1;">${escapeHtml(s)}</div>`).join('');
    return `
      <div style="border:1px solid ${border}; border-left:4px solid ${border}; border-radius:8px; padding:1rem; background:${bg};">
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.5rem; margin-bottom:0.6rem;">
          <div>
            <strong style="font-size:1rem;">[${m.id}] ${m.name}</strong>
            ${m.points ? `<span style="margin-left:0.5rem; color:#6b7280; font-size:0.82rem;">contributes +${m.points} when fired</span>` : ''}
          </div>
          ${badge}
        </div>
        <div style="font-family:monospace; font-size:0.8rem; color:#475569; margin-bottom:0.5rem;">${m.endpoint}</div>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:1rem; margin-top:0.5rem;">
          <div>
            <div style="font-weight:600; margin-bottom:0.3rem; font-size:0.85rem;">Transformation</div>
            <div style="font-size:0.77rem; line-height:1.45;">${stepsHtml || '<em>None</em>'}</div>
          </div>
          <div>
            <div style="font-weight:600; margin-bottom:0.3rem; font-size:0.85rem;">Sent to model</div>
            <pre style="background:#0f172a; color:#e2e8f0; padding:0.6rem; border-radius:5px; font-size:0.75rem; margin:0; max-height:200px; overflow:auto; white-space:pre-wrap; word-break:break-word; overflow-wrap:anywhere;">${escapeHtml(JSON.stringify(m.input, null, 2))}</pre>
            <div style="font-weight:600; margin:0.6rem 0 0.3rem 0; font-size:0.85rem;">Model returned</div>
            <pre style="background:#0f172a; color:#86efac; padding:0.6rem; border-radius:5px; font-size:0.75rem; margin:0; max-height:200px; overflow:auto; white-space:pre-wrap; word-break:break-word; overflow-wrap:anywhere;">${escapeHtml(JSON.stringify(m.output || m.error || m.skipReason || null, null, 2))}</pre>
            ${m.threshold != null ? `<div style="margin-top:0.4rem; font-size:0.78rem; color:#6b7280;">Fires when output > <strong>${m.threshold}</strong></div>` : ''}
          </div>
        </div>
        ${m.note ? `<div style="margin-top:0.6rem; padding:0.4rem 0.6rem; background:#fef9c3; border-radius:4px; font-size:0.78rem; color:#713f12;">📝 ${m.note}</div>` : ''}
      </div>
    `;
  }).join('');

  // SHAP bars
  const shapEl = document.getElementById('pg-shap');
  if (Array.isArray(res.aggregate.explanation) && res.aggregate.explanation.length) {
    const sorted = res.aggregate.explanation.slice().sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
    const maxMag = Math.max.apply(null, sorted.map(e => Math.abs(e.contribution)).concat(0.01));
    shapEl.innerHTML = sorted.map(item => {
      const positive = item.contribution >= 0;
      const widthPct = Math.min(100, (Math.abs(item.contribution) / maxMag) * 100);
      return `
        <div style="display:grid; grid-template-columns:120px 1fr 80px; gap:10px; align-items:center; margin:6px 0; font-size:0.9rem;">
          <span style="font-family:monospace;">${item.feature}</span>
          <div style="background:#e5e7eb; height:14px; border-radius:3px; overflow:hidden;">
            <div style="background:${positive ? '#dc2626' : '#16a34a'}; width:${widthPct}%; height:100%;"></div>
          </div>
          <span style="text-align:right; font-family:monospace;">${positive ? '+' : ''}${Number(item.contribution).toFixed(2)}</span>
        </div>
      `;
    }).join('');
  } else {
    shapEl.innerHTML = '<em style="color:#6b7280; font-size:0.85rem;">No XAI explanation returned (model may have errored).</em>';
  }

  // Context
  document.getElementById('pg-context').textContent = JSON.stringify({
    customer: res.customer, simulatedOrder: res.simulatedOrder, context: res.context
  }, null, 2);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

if (typeof window !== 'undefined') {
  window.runInferencePlayground = runInferencePlayground;
  window.initInferencePlayground = initInferencePlayground;
}

// ===============================
// FEEDBACK LOGIC
// ===============================
async function loadFeedbackData() {
  const list = document.getElementById('feedback-list');
  if (!list) return;

  list.innerHTML = renderLoader();

  try {
    const orders = await get('/orders/vendor-orders');
    // Filter orders with feedback
    const feedbackOrders = orders.filter(o => o.feedback && o.feedback.rating);

    if (feedbackOrders.length === 0) {
      list.innerHTML = '<p>No feedback received yet.</p>';
      return;
    }

    list.innerHTML = feedbackOrders.map(order => `
      <div style="border-bottom: 1px solid #eee; padding: 1rem 0;">
        <div style="display: flex; justify-content: space-between; margin-bottom: 0.5rem;">
          <strong>Order #${order._id.slice(-6)}</strong>
          <span style="color: #ffc107; font-size: 1.2rem;">${'★'.repeat(order.feedback.rating)}${'☆'.repeat(5 - order.feedback.rating)}</span>
        </div>
        <p style="margin: 0.5rem 0; color: #555;">"${order.feedback.comment || 'No comment'}"</p>
        <div style="font-size: 0.85rem; color: #999;">
          By ${order.customer?.username || 'Customer'} on ${new Date(order.feedback.createdAt).toLocaleDateString()}
        </div>
      </div>
    `).join('');

  } catch (e) {
    console.error('Error loading feedback:', e);
    list.innerHTML = '<p>Error loading feedback.</p>';
  }
}

// ===============================
// ACCOUNT LOGIC
// ===============================
function loadAccountData() {
  const accountName = document.getElementById('account-name');
  const accountEmail = document.getElementById('account-email');
  const accountRole = document.getElementById('account-role');

  if (!accountName || !accountEmail || !accountRole) return;

  try {
    const userStr = localStorage.getItem('user');
    if (userStr) {
      const user = JSON.parse(userStr);
      accountName.textContent = user.username || 'N/A';
      accountEmail.textContent = user.email || 'N/A';
      accountRole.textContent = user.role || 'N/A';
    }
  } catch (e) {
    console.error('Error loading account data:', e);
  }
}

function setupPasswordChange() {
  const toggleBtn = document.getElementById('toggle-password-btn');
  const formContainer = document.getElementById('password-form-container');
  const form = document.getElementById('change-password-form');

  if (toggleBtn && formContainer) {
    toggleBtn.addEventListener('click', () => {
      formContainer.classList.toggle('hidden');
      const icon = toggleBtn.querySelector('span');
      if (icon) {
        icon.textContent = formContainer.classList.contains('hidden') ? '▼' : '▲';
      }
    });
  }

  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const oldPassword = document.getElementById('old-password').value;
    const newPassword = document.getElementById('new-password').value;

    try {
      await post('/auth/change-password', { oldPassword, newPassword });
      alert('Password updated successfully!');
      form.reset();
      if (formContainer) {
        formContainer.classList.add('hidden');
        const icon = toggleBtn.querySelector('span');
        if (icon) icon.textContent = '▼';
      }
    } catch (error) {
      console.error('Password change error:', error);
      alert('Failed to update password: ' + (error.message || 'Unknown error'));
    }
  });
}

// ===============================
// ANALYTICS BAR CHART
// ===============================
function renderAnalyticsBarChart() {
  const chartContainer = document.getElementById('analytics-bar-chart');
  if (!chartContainer) return;

  // Count orders by status from allOrdersRaw
  let pending = 0, accepted = 0, packed = 0, onBoard = 0, delivered = 0, delayedDelivery = 0, rejected = 0;

  allOrdersRaw.forEach(order => {
    switch (order.status) {
      case 'Pending': pending++; break;
      case 'Accepted': accepted++; break;
      case 'Packed': packed++; break;
      case 'On Board': onBoard++; break;
      case 'Delivered': delivered++; break;
      case 'Delayed Delivery': delayedDelivery++; break;
      case 'Rejected': rejected++; break;
    }
  });

  const data = [
    { label: 'Pending', value: pending, color: '#f59e0b' },
    { label: 'Accepted', value: accepted, color: '#3b82f6' },
    { label: 'Packed', value: packed, color: '#8b5cf6' },
    { label: 'On Board', value: onBoard, color: '#06b6d4' },
    { label: 'Delivered', value: delivered, color: '#22c55e' },
    { label: 'Delayed Delivery', value: delayedDelivery, color: '#8B0000' },
    { label: 'Rejected', value: rejected, color: '#ef4444' }
  ];

  const maxValue = Math.max(...data.map(d => d.value), 1);
  const total = allOrdersRaw.length;

  const barsHtml = data.map(item => {
    const percentage = maxValue > 0 ? (item.value / maxValue * 100) : 0;
    const countPercent = total > 0 ? ((item.value / total) * 100).toFixed(1) : 0;
    return `
      <div style="display: flex; align-items: center; margin-bottom: 1rem;">
        <div style="width: 130px; font-size: 0.9rem; color: #333; font-weight: 500;">${item.label}</div>
        <div style="flex: 1; background: #f3f4f6; border-radius: 4px; height: 32px; margin: 0 1rem; position: relative; overflow: hidden;">
          <div style="width: ${percentage}%; height: 100%; background: ${item.color}; border-radius: 4px; transition: width 0.5s ease;"></div>
        </div>
        <div style="width: 80px; text-align: right; font-size: 0.9rem; font-weight: 600; color: ${item.color};">
          ${item.value} <span style="color: #666; font-weight: 400;">(${countPercent}%)</span>
        </div>
      </div>
    `;
  }).join('');

  chartContainer.innerHTML = `
    <div style="padding: 1rem;">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem; padding-bottom: 1rem; border-bottom: 1px solid #eee;">
        <div>
          <span style="font-size: 2.5rem; font-weight: 700; color: #333;">${total}</span>
          <span style="font-size: 1rem; color: #666; margin-left: 0.5rem;">Total Orders</span>
        </div>
        <div style="display: flex; gap: 1.5rem;">
          <div style="text-align: center;">
            <div style="font-size: 1.5rem; font-weight: 700; color: #22c55e;">${delivered}</div>
            <div style="font-size: 0.75rem; color: #666;">On-Time</div>
          </div>
          <div style="text-align: center;">
            <div style="font-size: 1.5rem; font-weight: 700; color: #8B0000;">${delayedDelivery}</div>
            <div style="font-size: 0.75rem; color: #666;">Delayed</div>
          </div>
          <div style="text-align: center;">
            <div style="font-size: 1.5rem; font-weight: 700; color: #ef4444;">${rejected}</div>
            <div style="font-size: 0.75rem; color: #666;">Rejected</div>
          </div>
        </div>
      </div>
      <h4 style="margin-bottom: 1rem; color: #333; font-size: 1rem;">Order Status Distribution</h4>
      ${barsHtml}
    </div>
  `;
}

// ===============================
// USER MANAGEMENT
// ===============================
async function loadUsersData() {
  const tbody = document.getElementById('users-tbody');
  if (!tbody) return;

  tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; padding: 2rem;">Loading users...</td></tr>`;

  try {
    const users = await get('/admin/users');

    if (users.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; padding: 2rem;">No users found.</td></tr>`;
      return;
    }

    tbody.innerHTML = users.map(user => {
      const joinDate = new Date(user.createdAt).toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric'
      });

        const statusBadge = user.isBlocked
        ? '<span style="background: #fee2e2; color: #dc2626; padding: 0.25rem 0.75rem; border-radius: 999px; font-size: 0.8rem; font-weight: 500;">Blocked</span>'
        : '<span style="background: #dcfce7; color: #16a34a; padding: 0.25rem 0.75rem; border-radius: 999px; font-size: 0.8rem; font-weight: 500;">Active</span>';

      const riskColor = user.riskScore > 6 ? '#dc2626' : user.riskScore > 3 ? '#f59e0b' : '#16a34a';

      const buttonText = user.isBlocked ? 'Unblock' : 'Block';
      const buttonColor = user.isBlocked ? '#22c55e' : '#ef4444';

      // Don't show block button for admin users
      const blockBtn = user.role === 'admin'
        ? ''
        : `<button onclick="toggleBlockUser('${user._id}')" style="background: ${buttonColor}; color: white; border: none; padding: 0.4rem 0.8rem; border-radius: 4px; cursor: pointer; font-size: 0.85rem;">${buttonText}</button>`;

      // Details button for non-admin users
      const detailsBtn = user.role === 'admin'
        ? '<span style="color: #999; font-size: 0.8rem;">-</span>'
        : `<button onclick="showUserDetails('${user._id}')" style="background: #3b82f6; color: white; border: none; padding: 0.4rem 0.8rem; border-radius: 4px; cursor: pointer; font-size: 0.85rem; margin-right: 0.5rem;">Details</button>`;

      return `
        <tr>
          <td style="font-weight: 500;">${user.username}</td>
          <td>${user.email}</td>
          <td><span style="text-transform: capitalize; background: #f3f4f6; padding: 0.25rem 0.5rem; border-radius: 4px;">${user.role}</span></td>
          <td style="text-align: center;">
            <span style="font-weight: bold; padding: 4px 10px; border-radius: 999px; font-size: 0.8rem; 
              background: ${user.riskScore >= 7 ? '#fee2e2' : user.riskScore >= 4 ? '#fef3c7' : '#dcfce7'}; 
              color: ${user.riskScore >= 7 ? '#dc2626' : user.riskScore >= 4 ? '#d97706' : '#16a34a'};">
              ${user.riskScore || 0}
            </span>
          </td>
          <td>${statusBadge}</td>
          <td>${joinDate}</td>
          <td>${detailsBtn}${blockBtn}</td>
        </tr>
      `;
    }).join('');

  } catch (error) {
    console.error('Load users error:', error);
    tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; padding: 2rem; color: red;">Error loading users: ${error.message}</td></tr>`;
  }
}

// Toggle block/unblock user
async function toggleBlockUser(userId) {
  try {
    const result = await put(`/admin/users/${userId}/toggle-block`, {});
    alert(result.message);
    loadUsersData(); // Refresh the list
  } catch (error) {
    console.error('Toggle block error:', error);
    alert('Failed to update user status: ' + (error.message || 'Unknown error'));
  }
}

// Show user details modal
async function showUserDetails(userId) {
  try {
    const details = await get(`/admin/users/${userId}/details`);

    const joinDate = new Date(details.joinedDate).toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'long',
      year: 'numeric'
    });

    let detailsContent = `
      <div style="margin-bottom: 1rem; padding-bottom: 1rem; border-bottom: 1px solid #eee;">
        <h4 style="margin: 0 0 0.5rem 0; color: #333;">${details.username}</h4>
        <p style="margin: 0; color: #666;">${details.email}</p>
        <p style="margin: 0.5rem 0 0 0;">
          <span style="text-transform: capitalize; background: #f3f4f6; padding: 0.25rem 0.75rem; border-radius: 4px; font-size: 0.9rem;">${details.role}</span>
        </p>
      </div>
      <div style="margin-bottom: 1rem;">
        <strong style="color: #333;">Risk Score:</strong>
        <span style="font-weight: bold; padding: 2px 10px; border-radius: 999px; font-size: 0.9rem; margin-left: 0.5rem;
          background: ${details.riskScore >= 7 ? '#fee2e2' : details.riskScore >= 4 ? '#fef3c7' : '#dcfce7'}; 
          color: ${details.riskScore >= 7 ? '#dc2626' : details.riskScore >= 4 ? '#d97706' : '#16a34a'};">
          ${details.riskScore || 0}
        </span>
      </div>

      ${(() => {
        // Human-readable list of rules that fired (from FraudAlert.violationReason).
        // This is what the user *actually* wants — not the abstract dimension contributions.
        const reasonsRaw = details.violationReason && details.violationReason !== 'No anomalies detected'
          ? details.violationReason : null;
        if (!reasonsRaw) return '';
        const reasons = String(reasonsRaw).split('|').map(s => s.trim()).filter(Boolean);
        const headerColour = (details.riskScore || 0) > 8 ? '#dc2626' : (details.riskScore || 0) > 6 ? '#d97706' : '#ca8a04';
        const blockBanner = details.isBlocked ? `
          <div style="margin-bottom:0.75rem; padding:0.55rem 0.75rem; background:#fee2e2; border-left:4px solid #dc2626; border-radius:4px; font-size:0.82rem; color:#7f1d1d;">
            🚫 <strong>Account blocked</strong> ${details.blockedUntil ? '— auto-unblock at ' + new Date(details.blockedUntil).toLocaleString() : '(manual block)'}
          </div>` : '';
        const viewTraceBtn = details.isBlocked ? `
          <div style="margin-top:0.7rem;">
            <button onclick="closeUserDetailsModal && closeUserDetailsModal(); viewBlockedDetail('${details._id}', '${(details.username || '').replace(/'/g, "\\'")}');"
                    style="background:#3b82f6; color:#fff; border:none; padding:0.45rem 0.9rem; border-radius:5px; cursor:pointer; font-size:0.82rem;">
              View full decision trace →
            </button>
          </div>` : '';
        return `
        <div style="margin-bottom: 1.25rem; background:#fef2f2; padding:1rem; border-radius:8px; border:1px solid #fecaca;">
          <h5 style="margin:0 0 0.5rem 0; font-size:0.85rem; color:${headerColour}; text-transform:uppercase; letter-spacing:0.025em;">Why was this user flagged?</h5>
          ${blockBanner}
          <ul style="margin:0; padding:0 0 0 1.1rem; color:#0f172a; font-size:0.88rem; line-height:1.55;">
            ${reasons.map(r => `<li style="margin:2px 0;">${String(r).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</li>`).join('')}
          </ul>
          ${viewTraceBtn}
        </div>
        `;
      })()}
      ${(() => {
        // Stored explanation may be: an array of {feature, contribution},
        // a wrapper object {final_prob, base_value, explanation: [...]},
        // null, or some legacy shape. Normalise before mapping.
        let arr = details.explanation;
        if (arr && !Array.isArray(arr) && Array.isArray(arr.explanation)) arr = arr.explanation;
        if (!Array.isArray(arr) || !arr.length) return '';
        return `
        <div style="margin-bottom: 1.5rem; background: #f9fafb; padding: 1rem; border-radius: 8px; border: 1px solid #e5e7eb;">
          <h5 style="margin: 0 0 0.75rem 0; font-size: 0.85rem; color: #4b5563; text-transform: uppercase; letter-spacing: 0.025em;">AI Risk Breakdown (XAI) — which signal dimension drove the score</h5>
          <div style="display: flex; flex-direction: column; gap: 0.5rem;">
            ${arr.map(exp => {
              const contribution = Number(exp.contribution) || 0;
              const percentage = Math.min(100, Math.max(5, Math.abs(contribution) * 10));
              const color = contribution > 0 ? '#ef4444' : '#22c55e';
              const featureName = String(exp.feature || '');
              const label = featureName.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase());
              return `
                <div style="display: flex; align-items: center; gap: 0.75rem;">
                  <div style="width: 100px; font-size: 0.75rem; color: #374151; white-space: nowrap;">${label}</div>
                  <div style="flex: 1; height: 8px; background: #e5e7eb; border-radius: 4px; position: relative; overflow: hidden;">
                    <div style="position: absolute; left: 0; width: ${percentage}%; height: 100%; background: ${color}; border-radius: 4px;"></div>
                  </div>
                  <div style="width: 45px; text-align: right; font-size: 0.75rem; font-weight: 600; color: ${color};">${contribution > 0 ? '+' : ''}${contribution}</div>
                </div>
              `;
            }).join('')}
          </div>
          <p style="margin: 0.75rem 0 0 0; font-size: 0.7rem; color: #6b7280; font-style: italic;">* Contribution of each feature to the overall 0-10 risk score.</p>
        </div>
        `;
      })()}

      <div style="margin-bottom: 1rem;">
        <strong style="color: #333;">Date of Joining:</strong>
        <span style="color: #666; margin-left: 0.5rem;">${joinDate}</span>
      </div>
    `;

    if (details.role === 'vendor' && details.vendorInfo) {
      const v = details.vendorInfo;

      // Build products table with edit buttons
      const productsTableHtml = v.products && v.products.length > 0
        ? v.products.map(product => `
            <tr style="border-bottom: 1px solid #eee;">
              <td style="padding: 0.5rem; font-weight: 500;">${product.name}</td>
              <td style="padding: 0.5rem;">₹${product.cost.toLocaleString()}</td>
              <td style="padding: 0.5rem;">${product.brand}</td>
              <td style="padding: 0.5rem;">${product.category}</td>
              <td style="padding: 0.5rem;">
                <button onclick="editProduct('${product._id}', '${product.name}', ${product.cost}, '${product.brand}', '${product.category}', '${product.image}')" 
                  style="background: #3b82f6; color: white; border: none; padding: 0.3rem 0.6rem; border-radius: 4px; cursor: pointer; font-size: 0.75rem;">
                  Edit
                </button>
              </td>
            </tr>
          `).join('')
        : '<tr><td colspan="5" style="text-align: center; padding: 1rem; color: #999;">No products yet</td></tr>';

      // Build order history table
      const ordersTableHtml = v.orders && v.orders.length > 0
        ? v.orders.map(order => {
          const orderDate = new Date(order.date).toLocaleDateString('en-GB', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric'
          });
          const statusColor = order.status === 'Delivered' ? '#22c55e'
            : order.status === 'Delayed Delivery' ? '#8B0000'
              : order.status === 'Rejected' ? '#ef4444'
                : '#f59e0b';
          return `
              <tr style="border-bottom: 1px solid #eee;">
                <td style="padding: 0.5rem; font-weight: 500;">#${order.orderId.toString().slice(-6)}</td>
                <td style="padding: 0.5rem;">${order.customerName}</td>
                <td style="padding: 0.5rem;">${orderDate}</td>
                <td style="padding: 0.5rem; font-weight: 600;">₹${order.amount.toLocaleString()}</td>
                <td style="padding: 0.5rem;">
                  <span style="background: ${statusColor}20; color: ${statusColor}; padding: 0.2rem 0.5rem; border-radius: 4px; font-size: 0.75rem;">${order.status}</span>
                </td>
              </tr>
            `;
        }).join('')
        : '<tr><td colspan="5" style="text-align: center; padding: 1rem; color: #999;">No orders yet</td></tr>';

      detailsContent += `
        <div style="background: #f8f9fa; padding: 1rem; border-radius: 8px;">
          <h5 style="margin: 0 0 1rem 0; color: #333; font-size: 1rem;">Vendor Statistics</h5>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-bottom: 1rem;">
            <div style="text-align: center; padding: 0.75rem; background: white; border-radius: 6px;">
              <div style="font-size: 1.5rem; font-weight: 700; color: #3b82f6;">${v.totalProducts}</div>
              <div style="font-size: 0.8rem; color: #666;">Total Products</div>
            </div>
            <div style="text-align: center; padding: 0.75rem; background: white; border-radius: 6px;">
              <div style="font-size: 1.5rem; font-weight: 700; color: #8b5cf6;">${v.totalOrders}</div>
              <div style="font-size: 0.8rem; color: #666;">Total Orders</div>
            </div>
            <div style="text-align: center; padding: 0.75rem; background: white; border-radius: 6px;">
              <div style="font-size: 1.5rem; font-weight: 700; color: #22c55e;">₹${v.totalSales.toLocaleString()}</div>
              <div style="font-size: 0.8rem; color: #666;">Total Sales</div>
            </div>
            <div style="text-align: center; padding: 0.75rem; background: white; border-radius: 6px;">
              <div style="font-size: 1.5rem; font-weight: 700; color: #f59e0b;">₹${v.commission.toLocaleString()}</div>
              <div style="font-size: 0.8rem; color: #666;">Commission (10%)</div>
            </div>
          </div>
          
          <div style="margin-bottom: 1rem;">
            <h6 style="margin: 0 0 0.5rem 0; color: #333; font-size: 0.9rem;">Products (${v.totalProducts}):</h6>
            <div style="background: white; border-radius: 6px; max-height: 200px; overflow-y: auto;">
              <table style="width: 100%; border-collapse: collapse; font-size: 0.85rem;">
                <thead style="background: #f3f4f6; position: sticky; top: 0;">
                  <tr>
                    <th style="padding: 0.5rem; text-align: left; color: #333;">Name</th>
                    <th style="padding: 0.5rem; text-align: left; color: #333;">Price</th>
                    <th style="padding: 0.5rem; text-align: left; color: #333;">Brand</th>
                    <th style="padding: 0.5rem; text-align: left; color: #333;">Category</th>
                    <th style="padding: 0.5rem; text-align: left; color: #333;">Action</th>
                  </tr>
                </thead>
                <tbody>
                  ${productsTableHtml}
                </tbody>
              </table>
            </div>
          </div>
          
          <div style="margin-top: 1rem;">
            <h6 style="margin: 0 0 0.5rem 0; color: #333; font-size: 0.9rem;">Order History:</h6>
            <div style="background: white; border-radius: 6px; max-height: 250px; overflow-y: auto;">
              <table style="width: 100%; border-collapse: collapse; font-size: 0.85rem;">
                <thead style="background: #f3f4f6; position: sticky; top: 0;">
                  <tr>
                    <th style="padding: 0.5rem; text-align: left; color: #333;">ID</th>
                    <th style="padding: 0.5rem; text-align: left; color: #333;">Customer</th>
                    <th style="padding: 0.5rem; text-align: left; color: #333;">Date</th>
                    <th style="padding: 0.5rem; text-align: left; color: #333;">Amount</th>
                    <th style="padding: 0.5rem; text-align: left; color: #333;">Status</th>
                  </tr>
                </thead>
                <tbody>
                  ${ordersTableHtml}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      `;
    } else if (details.role === 'customer' && details.customerInfo) {
      const c = details.customerInfo;

      // Build orders list
      const ordersListHtml = c.orders && c.orders.length > 0
        ? c.orders.map(order => {
          const orderDate = new Date(order.date).toLocaleDateString('en-GB', {
            day: '2-digit',
            month: 'short',
            year: 'numeric'
          });
          const statusColor = order.status === 'Delivered' ? '#22c55e'
            : order.status === 'Delayed Delivery' ? '#8B0000'
              : order.status === 'Rejected' ? '#ef4444'
                : '#f59e0b';
          return `
              <div style="display: flex; justify-content: space-between; align-items: center; padding: 0.5rem 0; border-bottom: 1px solid #eee;">
                <div>
                  <span style="font-weight: 500; color: #333;">#${order.orderId.slice(-6)}</span>
                  <span style="color: #999; font-size: 0.8rem; margin-left: 0.5rem;">${orderDate}</span>
                </div>
                <div style="display: flex; align-items: center; gap: 0.75rem;">
                  <span style="font-weight: 600; color: #333;">₹${order.amount.toLocaleString()}</span>
                  <span style="background: ${statusColor}20; color: ${statusColor}; padding: 0.15rem 0.5rem; border-radius: 4px; font-size: 0.75rem;">${order.status}</span>
                </div>
              </div>
            `;
        }).join('')
        : '<p style="color: #999; text-align: center; padding: 1rem;">No orders yet</p>';

      detailsContent += `
        <div style="background: #f8f9fa; padding: 1rem; border-radius: 8px;">
          <h5 style="margin: 0 0 1rem 0; color: #333; font-size: 1rem;">Customer Statistics</h5>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-bottom: 1rem;">
            <div style="text-align: center; padding: 0.75rem; background: white; border-radius: 6px;">
              <div style="font-size: 1.5rem; font-weight: 700; color: #3b82f6;">${c.totalOrders}</div>
              <div style="font-size: 0.8rem; color: #666;">Total Orders</div>
            </div>
            <div style="text-align: center; padding: 0.75rem; background: white; border-radius: 6px;">
              <div style="font-size: 1.5rem; font-weight: 700; color: #22c55e;">₹${c.totalSpent.toLocaleString()}</div>
              <div style="font-size: 0.8rem; color: #666;">Total Spent</div>
            </div>
          </div>
          <div style="margin-top: 1rem;">
            <h6 style="margin: 0 0 0.5rem 0; color: #333; font-size: 0.9rem;">All Orders:</h6>
            <div style="background: white; border-radius: 6px; padding: 0.5rem; max-height: 200px; overflow-y: auto;">
              ${ordersListHtml}
            </div>
          </div>
        </div>
      `;
    }

    // Create and show modal
    const existingModal = document.getElementById('user-details-modal');
    if (existingModal) existingModal.remove();

    const modal = document.createElement('div');
    modal.id = 'user-details-modal';
    modal.innerHTML = `
      <div style="position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 1000;">
        <div style="background: white; padding: 1.5rem; border-radius: 12px; max-width: 500px; width: 90%; max-height: 80vh; overflow-y: auto; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.1);">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
            <h3 style="margin: 0; color: #333;">User Details</h3>
            <button onclick="document.getElementById('user-details-modal').remove()" style="background: none; border: none; font-size: 1.5rem; cursor: pointer; color: #666;">&times;</button>
          </div>
          ${detailsContent}
        </div>
      </div>
    `;
    document.body.appendChild(modal);

  } catch (error) {
    console.error('Show user details error:', error);
    alert('Failed to load user details: ' + (error.message || 'Unknown error'));
  }
}

// Edit product function
async function editProduct(id, name, cost, brand, category, image) {
  // Create edit modal
  const existingEditModal = document.getElementById('edit-product-modal');
  if (existingEditModal) existingEditModal.remove();

  const editModal = document.createElement('div');
  editModal.id = 'edit-product-modal';
  editModal.innerHTML = `
    <div style="position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 1100;">
      <div style="background: white; padding: 1.5rem; border-radius: 12px; max-width: 450px; width: 90%; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.1);">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
          <h3 style="margin: 0; color: #333;">Edit Product</h3>
          <button onclick="document.getElementById('edit-product-modal').remove()" style="background: none; border: none; font-size: 1.5rem; cursor: pointer; color: #666;">&times;</button>
        </div>
        <form id="edit-product-form">
          <div style="margin-bottom: 1rem;">
            <label style="display: block; margin-bottom: 0.25rem; color: #333; font-weight: 500;">Name</label>
            <input type="text" id="edit-name" value="${name}" style="width: 100%; padding: 0.5rem; border: 1px solid #ddd; border-radius: 4px; box-sizing: border-box;">
          </div>
          <div style="margin-bottom: 1rem;">
            <label style="display: block; margin-bottom: 0.25rem; color: #333; font-weight: 500;">Price (₹)</label>
            <input type="number" id="edit-cost" value="${cost}" style="width: 100%; padding: 0.5rem; border: 1px solid #ddd; border-radius: 4px; box-sizing: border-box;">
          </div>
          <div style="margin-bottom: 1rem;">
            <label style="display: block; margin-bottom: 0.25rem; color: #333; font-weight: 500;">Brand</label>
            <input type="text" id="edit-brand" value="${brand}" style="width: 100%; padding: 0.5rem; border: 1px solid #ddd; border-radius: 4px; box-sizing: border-box;">
          </div>
          <div style="margin-bottom: 1rem;">
            <label style="display: block; margin-bottom: 0.25rem; color: #333; font-weight: 500;">Category</label>
            <input type="text" id="edit-category" value="${category}" style="width: 100%; padding: 0.5rem; border: 1px solid #ddd; border-radius: 4px; box-sizing: border-box;">
          </div>
          <div style="margin-bottom: 1rem;">
            <label style="display: block; margin-bottom: 0.25rem; color: #333; font-weight: 500;">Image URL</label>
            <input type="text" id="edit-image" value="${image}" style="width: 100%; padding: 0.5rem; border: 1px solid #ddd; border-radius: 4px; box-sizing: border-box;">
          </div>
          <div style="display: flex; gap: 0.5rem; justify-content: flex-end;">
            <button type="button" onclick="document.getElementById('edit-product-modal').remove()" style="padding: 0.5rem 1rem; border: 1px solid #ddd; background: white; border-radius: 4px; cursor: pointer;">Cancel</button>
            <button type="submit" style="padding: 0.5rem 1rem; border: none; background: #22c55e; color: white; border-radius: 4px; cursor: pointer;">Save Changes</button>
          </div>
        </form>
      </div>
    </div>
  `;
  document.body.appendChild(editModal);

  // Handle form submission
  document.getElementById('edit-product-form').addEventListener('submit', async (e) => {
    e.preventDefault();

    const updatedProduct = {
      name: document.getElementById('edit-name').value,
      cost: parseFloat(document.getElementById('edit-cost').value),
      brand: document.getElementById('edit-brand').value,
      category: document.getElementById('edit-category').value,
      image: document.getElementById('edit-image').value
    };

    try {
      const result = await put(`/admin/products/${id}`, updatedProduct);
      alert(result.message);
      document.getElementById('edit-product-modal').remove();
      // Refresh the user details modal
      document.getElementById('user-details-modal').remove();
    } catch (error) {
      console.error('Edit product error:', error);
      alert('Failed to update product: ' + (error.message || 'Unknown error'));
    }
  });
}

// Expose to window for onclick handlers
window.toggleBlockUser = toggleBlockUser;
window.showUserDetails = showUserDetails;
window.editProduct = editProduct;

// Setup and Polling for Notification Bell
async function setupNotifications() {
  const bell = document.getElementById('notif-bell-container');
  const dropdown = document.getElementById('notif-dropdown');
  const closeBtn = document.getElementById('close-notif-btn');

  if (!bell || !dropdown) return;

  bell.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.classList.toggle('active');
  });

  if (closeBtn) {
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdown.classList.remove('active');
    });
  }

  bell.addEventListener('click', () => {
    const icon = bell.querySelector('.bell-icon');
    if (icon) icon.classList.remove('pulse');
  });

  document.addEventListener('click', () => {
    dropdown.classList.remove('active');
  });

  dropdown.addEventListener('click', (e) => {
    e.stopPropagation();
  });

  // Refresh notifications every 10 seconds
  setInterval(loadNotifications, 10000);
}

function showToast(title, message) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.innerHTML = `
    <div class="toast-icon">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
        <line x1="12" y1="9" x2="12" y2="13"></line>
        <line x1="12" y1="17" x2="12.01" y2="17"></line>
      </svg>
    </div>
    <div class="toast-content">
      <div class="toast-title">${title}</div>
      <div class="toast-message">${message}</div>
    </div>
    <button class="toast-close">&times;</button>
  `;
  container.prepend(toast);

  const closeBtn = toast.querySelector('.toast-close');
  closeBtn.addEventListener('click', () => {
    toast.classList.add('hide');
    setTimeout(() => toast.remove(), 300);
  });

  setTimeout(() => {
    if (toast.parentElement) {
      toast.classList.add('hide');
      setTimeout(() => toast.remove(), 300);
    }
  }, 6000);
}

async function loadNotifications() {
  const badge = document.getElementById('notif-badge');
  const list = document.getElementById('notif-list');
  const bellIcon = document.querySelector('.bell-icon');

  if (!badge || !list) return;

  try {
    const blockedUsers = await get('/manager/blocked-users'); // Admin has access
    
    if (blockedUsers && Array.isArray(blockedUsers) && blockedUsers.length > 0) {
      badge.textContent = blockedUsers.length;
      badge.style.display = 'block';

      let newBlocks = [];
      blockedUsers.forEach(user => {
        const uid = user._id ? user._id.toString() : user.username;
        if (!lastBlockedUserIds.has(uid)) {
          if (!firstLoad) newBlocks.push(user);
          lastBlockedUserIds.add(uid);
        }
      });

      if (newBlocks.length > 0) {
        newBlocks.forEach(user => {
          showToast('Critical: User Blocked', `${user.username} was blocked. Reason: ${user.blockReason || 'Unusual activity'}`);
        });
        if (bellIcon) bellIcon.classList.add('pulse');
      }

      firstLoad = false;
      list.innerHTML = blockedUsers.map(user => {
        const blockDate = new Date(user.updatedAt).toLocaleString('en-GB', {
          day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
        });
        return `
          <div class="notification-item">
            <div class="notif-user">${user.username} (${user.role})</div>
            <div class="notif-reason">${user.blockReason || 'No reason provided'}</div>
            <div class="notif-time">${blockDate}</div>
          </div>
        `;
      }).join('');
    } else {
      badge.textContent = '0';
      badge.style.display = 'none';
      list.innerHTML = '<div class="notif-empty">No blocked users found</div>';
      firstLoad = false;
    }
  } catch (e) {
    console.error('Error loading notifications:', e);
  }
}

// Auto-init when DOM ready
document.addEventListener('DOMContentLoaded', () => {
  const root = document.getElementById('view-dashboard');
  if (root) initAdminDashboard();
});
