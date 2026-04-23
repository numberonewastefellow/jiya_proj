// managerDashboard.js: Manager dashboard logic
import { get, post, put } from './api.js';
import { createCard, createTableRow, renderLoader } from './ui.js';

// Global state
let allOrders = [];
let allOrdersRaw = [];
let currentFilter = 'all';
let lastBlockedUserIds = new Set();
let firstLoad = true;

export async function initManagerDashboard() {
  const cardGrid = document.getElementById('summary-cards');
  const ordersTable = document.getElementById('orders-table').querySelector('tbody');
  if (cardGrid) cardGrid.innerHTML = renderLoader();
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
    // Fetch summary data
    const summary = await fetchManagerSummary();
    if (cardGrid) {
      cardGrid.innerHTML = '';
      renderSummaryCards(cardGrid, summary);
    }

    // Load charts (placeholders)
    await loadManagerCharts();

    console.log('Manager Dashboard Initializing...');
    // Inject modal if not exists
    if (!document.getElementById('order-details-modal')) {
      injectOrderDetailsModal();
    }

    // Fetch and display orders
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
    console.error('Manager dashboard error:', e);
    if (cardGrid) cardGrid.innerHTML = `<div class="error-message">Error loading summary: ${e.message}</div>`;
    if (ordersTable) ordersTable.innerHTML = `<tr><td colspan="7" class="error-message">Error loading orders: ${e.message}</td></tr>`;
  }
}

async function fetchManagerSummary() {
  // Fetch from /api/manager/summary
  return get('/manager/summary');
}

function transformOrderForTable(order) {
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

async function loadManagerCharts() {
  try {
    const deliveryTrend = await get('/manager/analytics/delivery-trend');
    const trendElement = document.getElementById('chart-delivery-trend');
    if (deliveryTrend && deliveryTrend.trend && deliveryTrend.trend.length > 0) {
      trendElement.textContent = `Delivery Trend: ${deliveryTrend.trend.length} data points`;
    } else if (trendElement) {
      trendElement.textContent = '';
    }
    const vendorPerf = await get('/manager/analytics/vendor-performance');
    const vendorElement = document.getElementById('chart-vendor-performance');
    if (vendorPerf && vendorPerf.vendors && vendorPerf.vendors.length > 0) {
      vendorElement.textContent = `Vendor Performance: ${vendorPerf.vendors.length} vendors`;
    } else if (vendorElement) {
      vendorElement.textContent = '';
    }
    const paymentFailures = await get('/manager/analytics/payment-failures');
    const failureElement = document.getElementById('chart-failure-reasons');
    if (paymentFailures && paymentFailures.failures && paymentFailures.failures.length > 0) {
      failureElement.textContent = `Payment Failures: ${paymentFailures.failures.length} failures`;
    } else if (failureElement) {
      failureElement.textContent = '';
    }
  } catch (e) {
    console.error('Error loading charts:', e);
    const d = document.getElementById('chart-delivery-trend'); if (d) d.textContent = 'Error loading chart';
    const v = document.getElementById('chart-vendor-performance'); if (v) v.textContent = 'Error loading chart';
    const f = document.getElementById('chart-failure-reasons'); if (f) f.textContent = 'Error loading chart';
  }
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

  const itemsSummary = order.items && order.items.length > 0
    ? order.items.map(item => `${item.quantity || 1}x ${item.name || 'Item'}`).join(', ')
    : 'No items';

  let expectedDeliveryText = 'Not yet scheduled';
  if (order.expectedDeliveryDate) {
    const deliveryDate = new Date(order.expectedDeliveryDate);
    expectedDeliveryText = deliveryDate.toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric'
    });
  }

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

function categorizeOrder(order) {
  if (order.status === 'Rejected') {
    return 'failed';
  }

  if (order.status === 'Delayed Delivery') {
    return 'delayed';
  }

  if (order.status === 'Delivered') {
    if (!order.delayHours || order.delayHours <= 0) {
      return 'ontime';
    } else {
      return 'delayed';
    }
  }

  if (order.expectedDeliveryDate && order.status !== 'Delivered') {
    const expectedDate = new Date(order.expectedDeliveryDate);
    const now = new Date();
    if (now > expectedDate) {
      return 'delayed';
    }
  }

  return 'other';
}

function setupFilterButtons() {
  const filterButtons = document.querySelectorAll('.filter-btn');

  filterButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      filterButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      const filter = btn.dataset.filter;
      renderFilteredOrders(filter);
    });
  });
}

function renderFilteredOrders(filter) {
  currentFilter = filter;
  const ordersTable = document.getElementById('orders-table').querySelector('tbody');

  if (!ordersTable) return;

  let filteredOrders = allOrders;

  if (filter !== 'all') {
    filteredOrders = allOrders.filter(orderObj => {
      const category = categorizeOrder(orderObj.raw);
      return category === filter;
    });
  }

  ordersTable.innerHTML = '';

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

function setupNavigation() {
  const navDashboard = document.getElementById('nav-dashboard');
  const navOrders = document.getElementById('nav-orders');
  const navAnalytics = document.getElementById('nav-analytics');
  const navFeedback = document.getElementById('nav-feedback');
  const navAccount = document.getElementById('nav-account');

  const viewDashboard = document.getElementById('view-dashboard');
  const viewOrders = document.getElementById('view-orders');
  const viewAnalytics = document.getElementById('view-analytics');
  const viewUsers = document.getElementById('view-users');
  const viewFeedback = document.getElementById('view-feedback');
  const viewAccount = document.getElementById('view-account');
  const navUsers = document.getElementById('nav-users');

  if (!navDashboard) return;

  navDashboard.addEventListener('click', (e) => {
    e.preventDefault();
    switchView('dashboard');
  });

  navOrders.addEventListener('click', (e) => {
    e.preventDefault();
    switchView('orders');
  });

  navAnalytics.addEventListener('click', (e) => {
    e.preventDefault();
    switchView('analytics');
  });

  navUsers.addEventListener('click', (e) => {
    e.preventDefault();
    switchView('users');
  });

  navFeedback.addEventListener('click', (e) => {
    e.preventDefault();
    switchView('feedback');
  });

  navAccount.addEventListener('click', (e) => {
    e.preventDefault();
    switchView('account');
  });

  function switchView(view) {
    navDashboard.classList.remove('active');
    navOrders.classList.remove('active');
    navAnalytics.classList.remove('active');
    navUsers.classList.remove('active');
    navFeedback.classList.remove('active');
    navAccount.classList.remove('active');

    viewDashboard.classList.add('hidden');
    viewOrders.classList.add('hidden');
    viewAnalytics.classList.add('hidden');
    viewUsers.classList.add('hidden');
    viewFeedback.classList.add('hidden');
    viewAccount.classList.add('hidden');

    if (view === 'dashboard') {
      navDashboard.classList.add('active');
      viewDashboard.classList.remove('hidden');
    } else if (view === 'orders') {
      navOrders.classList.add('active');
      viewOrders.classList.remove('hidden');
    } else if (view === 'analytics') {
      navAnalytics.classList.add('active');
      viewAnalytics.classList.remove('hidden');
      renderAnalyticsBarChart();
    } else if (view === 'users') {
      navUsers.classList.add('active');
      viewUsers.classList.remove('hidden');
      loadUsersData();
    } else if (view === 'account') {
      navAccount.classList.add('active');
      viewAccount.classList.remove('hidden');
    } else if (view === 'feedback') {
      navFeedback.classList.add('active');
      viewFeedback.classList.remove('hidden');
      loadFeedbackData();
    }
  }
}

async function loadFeedbackData() {
  const list = document.getElementById('feedback-list');
  if (!list) return;

  list.innerHTML = renderLoader();

  try {
    const orders = await get('/orders/vendor-orders');
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

function renderAnalyticsBarChart() {
  const chartContainer = document.getElementById('analytics-bar-chart');
  if (!chartContainer) return;

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

async function loadUsersData() {
  const tbody = document.getElementById('users-tbody');
  if (!tbody) return;

  tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; padding: 2rem;">Loading users...</td></tr>`;

  try {
    const users = await get('/manager/users');

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

      const blockBtn = user.role === 'admin' || user.role === 'manager'
        ? ''
        : `<button onclick="toggleBlockUser('${user._id}')" style="background: ${buttonColor}; color: white; border: none; padding: 0.4rem 0.8rem; border-radius: 4px; cursor: pointer; font-size: 0.85rem;">${buttonText}</button>`;

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

async function toggleBlockUser(userId) {
  try {
    const result = await put(`/manager/users/${userId}/toggle-block`, {});
    alert(result.message);
    loadUsersData(); 
  } catch (error) {
    console.error('Toggle block error:', error);
    alert('Failed to update user status: ' + (error.message || 'Unknown error'));
  }
}

async function showUserDetails(userId) {
  try {
    const details = await get(`/manager/users/${userId}/details`);

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
      <div style="margin-bottom: 1rem;">
        <strong style="color: #333;">Date of Joining:</strong>
        <span style="color: #666; margin-left: 0.5rem;">${joinDate}</span>
      </div>
    `;

    if (details.role === 'vendor' && details.vendorInfo) {
      const v = details.vendorInfo;

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

async function editProduct(id, name, cost, brand, category, image) {
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
      const result = await put(`/manager/products/${id}`, updatedProduct);
      alert(result.message);
      document.getElementById('edit-product-modal').remove();
      document.getElementById('user-details-modal').remove();
    } catch (error) {
      console.error('Edit product error:', error);
      alert('Failed to update product: ' + (error.message || 'Unknown error'));
    }
  });
}

window.toggleBlockUser = toggleBlockUser;
window.showUserDetails = showUserDetails;
window.editProduct = editProduct;

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

  // Refresh notifications every 10 seconds for more "real-time" feel
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

  // Auto remove after 6 seconds
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
    const blockedUsers = await get('/manager/blocked-users');
    
    if (blockedUsers && Array.isArray(blockedUsers) && blockedUsers.length > 0) {
      badge.textContent = blockedUsers.length;
      badge.style.display = 'block';

      // Identify new blocked users
      let newBlocks = [];
      blockedUsers.forEach(user => {
        const uid = user._id ? user._id.toString() : user.username;
        if (!lastBlockedUserIds.has(uid)) {
          if (!firstLoad) {
            newBlocks.push(user);
          }
          lastBlockedUserIds.add(uid);
        }
      });

      if (newBlocks.length > 0) {
        newBlocks.forEach(user => {
          showToast(`Critical: User Blocked`, `${user.username} was blocked. Reason: ${user.blockReason || 'Unusual activity'}`);
        });
        if (bellIcon) bellIcon.classList.add('pulse');
      }

      firstLoad = false;

      list.innerHTML = blockedUsers.map(user => {
        const blockDate = new Date(user.updatedAt).toLocaleString('en-GB', {
          day: '2-digit',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit'
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

if (typeof document !== 'undefined' && document.readyState !== 'loading') {
  const root = document.getElementById('summary-cards');
  if (root) initManagerDashboard();
}
