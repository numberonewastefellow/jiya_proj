// customerDashboard.js: Customer dashboard logic
import { get, post, put } from './api.js';
import { renderLoader } from './ui.js';
import { getBrowserFingerprint } from './fingerprint.js';

// Global state
let allProducts = [];
let cart = [];
let myOrders = [];

export async function initCustomerDashboard() {
  initRealtimeNotifications();
  initThemeSupport();
  setupNavigation();
  loadDashboardData();

  loadShopData();
  loadAccountData();
  setupPasswordChange();

  // Set personalized title
  try {
    const userStr = localStorage.getItem('user');
    if (userStr) {
      const user = JSON.parse(userStr);
      const titleEl = document.getElementById('page-title');
      if (titleEl && user.username) {
        titleEl.textContent = `${user.username}'s Dashboard`;
      }
      // Top-bar "Hello, {name}" greeting (shop redesign)
      const nameEl = document.getElementById('te-account-name');
      if (nameEl && user.username) {
        nameEl.textContent = user.username;
      }
    }
  } catch (e) { console.error('Error setting title:', e); }

  // Expose functions to window for HTML onclick handlers
  window.filterProducts = filterProducts;
  window.addToCart = addToCart;
  window.placeOrder = placeOrder;
  window.removeFromCart = removeFromCart;
  window.openFeedbackModal = openFeedbackModal;
  window.togglePaymentForms = togglePaymentForms;
  window.handlePayment = handlePayment;
  window.closeOtpModal = closeOtpModal;
  window.closeFraudBlockModal = closeFraudBlockModal;
  window.toggleFraudDetailsPanel = toggleFraudDetailsPanel;
  window.registerPasskey = registerPasskey;
  window.verifyWithFingerprint = verifyWithFingerprint;
  window.verifyWithPasskey = verifyWithPasskey;
  // Geo simulator picker — exposed for the cart "Shopping from" card
  window.teGeoApplyPreset = teGeoApplyPreset;
  window.teGeoApplyManual = teGeoApplyManual;
  window.teGeoApplyPin = teGeoApplyPin;
  window.teGeoReset = teGeoReset;
  window.teGeoToggleAdvanced = teGeoToggleAdvanced;
  window.teGeoTogglePin = teGeoTogglePin;

  initOTPForm();
  initGeoPicker();
  handlePaymentReturn();
}

// =============================================================================
// GEO SIMULATOR PICKER  ("Shopping from" card on the cart page)
// =============================================================================
// All synthetic geo selection lives in localStorage under 'simulatedLocation'.
// When nothing is picked the server falls back to the real IP→GeoIP path.
// The picker is purely additive — every helper is null-safe so it can run on
// any page (the picker DOM only exists on the cart view).
// =============================================================================
const TE_GEO_KEY = 'simulatedLocation';
const TE_GEO_PRESETS = [
  { id: 'mumbai',    label: 'Mumbai, India',     flag: '🇮🇳', lat: 19.0760,  lon: 72.8777,  city: 'Mumbai',     country: 'IN' },
  { id: 'delhi',     label: 'Delhi, India',      flag: '🇮🇳', lat: 28.6139,  lon: 77.2090,  city: 'Delhi',      country: 'IN' },
  { id: 'newyork',   label: 'New York, USA',     flag: '🗽', lat: 40.7128,  lon: -74.0060, city: 'New York',   country: 'US' },
  { id: 'london',    label: 'London, UK',        flag: '🇬🇧', lat: 51.5074,  lon: -0.1278,  city: 'London',     country: 'GB' },
  { id: 'tokyo',     label: 'Tokyo, Japan',      flag: '🗾', lat: 35.6762,  lon: 139.6503, city: 'Tokyo',      country: 'JP' },
  { id: 'sydney',    label: 'Sydney, Australia', flag: '🦘', lat: -33.8688, lon: 151.2093, city: 'Sydney',     country: 'AU' },
  { id: 'saopaulo',  label: 'São Paulo, Brazil', flag: '🇧🇷', lat: -23.5505, lon: -46.6333, city: 'São Paulo',  country: 'BR' },
  { id: 'capetown',  label: 'Cape Town, S.Africa', flag: '🇿🇦', lat: -33.9249, lon: 18.4241, city: 'Cape Town', country: 'ZA' },
  { id: 'dubai',     label: 'Dubai, UAE',        flag: '🇦🇪', lat: 25.2048,  lon: 55.2708,  city: 'Dubai',      country: 'AE' },
  { id: 'singapore', label: 'Singapore',         flag: '🇸🇬', lat: 1.3521,   lon: 103.8198, city: 'Singapore',  country: 'SG' }
];
// Compact built-in Indian PIN → city lat/lon map for the demo. ~30 entries.
const TE_GEO_PIN_MAP = {
  '400001': { city: 'Mumbai',     lat: 18.9388,  lon: 72.8354 },
  '110001': { city: 'New Delhi',  lat: 28.6263,  lon: 77.2231 },
  '560001': { city: 'Bangalore',  lat: 12.9784,  lon: 77.5994 },
  '600001': { city: 'Chennai',    lat: 13.0823,  lon: 80.2755 },
  '700001': { city: 'Kolkata',    lat: 22.5615,  lon: 88.3470 },
  '500001': { city: 'Hyderabad',  lat: 17.3833,  lon: 78.4737 },
  '380001': { city: 'Ahmedabad',  lat: 23.0258,  lon: 72.5873 },
  '411001': { city: 'Pune',       lat: 18.5159,  lon: 73.8516 },
  '302001': { city: 'Jaipur',     lat: 26.9162,  lon: 75.8208 },
  '226001': { city: 'Lucknow',    lat: 26.8467,  lon: 80.9462 },
  '482001': { city: 'Jabalpur',   lat: 23.1815,  lon: 79.9864 },
  '160001': { city: 'Chandigarh', lat: 30.7333,  lon: 76.7794 },
  '462001': { city: 'Bhopal',     lat: 23.2599,  lon: 77.4126 },
  '440001': { city: 'Nagpur',     lat: 21.1458,  lon: 79.0882 },
  '682001': { city: 'Kochi',      lat: 9.9312,   lon: 76.2673 },
  '781001': { city: 'Guwahati',   lat: 26.1445,  lon: 91.7362 },
  '751001': { city: 'Bhubaneswar',lat: 20.2961,  lon: 85.8245 },
  '800001': { city: 'Patna',      lat: 25.5941,  lon: 85.1376 },
  '530001': { city: 'Visakhapatnam', lat: 17.6868, lon: 83.2185 },
  '395001': { city: 'Surat',      lat: 21.1702,  lon: 72.8311 }
};

function getSimulatedLocation() {
  try {
    const raw = localStorage.getItem(TE_GEO_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!Number.isFinite(Number(obj.lat)) || !Number.isFinite(Number(obj.lon))) return null;
    return obj;
  } catch (e) { return null; }
}

function setSimulatedLocation(loc) {
  if (!loc) {
    localStorage.removeItem(TE_GEO_KEY);
  } else {
    localStorage.setItem(TE_GEO_KEY, JSON.stringify(loc));
  }
  refreshGeoPickerStatus();
}

function refreshGeoPickerStatus() {
  const cur = getSimulatedLocation();
  const chip = document.getElementById('te-geo-status');
  const resetBtn = document.getElementById('te-geo-reset');
  if (!chip) return;
  if (cur) {
    chip.innerHTML = `<strong>📍 Ordering from:</strong> ${cur.city}${cur.country ? ', ' + cur.country : ''} <small>(${cur.lat.toFixed(4)}, ${cur.lon.toFixed(4)})</small>`;
    chip.classList.add('te-geo-status--active');
    if (resetBtn) resetBtn.style.display = 'inline-flex';
  } else {
    chip.innerHTML = `<strong>📍 Ordering from:</strong> Real location (IP based)`;
    chip.classList.remove('te-geo-status--active');
    if (resetBtn) resetBtn.style.display = 'none';
  }
}

function initGeoPicker() {
  // Populate the preset <select> options if the picker is on the page.
  const sel = document.getElementById('te-geo-preset-select');
  if (sel && sel.options.length <= 1) {
    TE_GEO_PRESETS.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = `${p.flag}  ${p.label}`;
      sel.appendChild(opt);
    });
  }
  refreshGeoPickerStatus();
}

function teGeoApplyPreset() {
  const sel = document.getElementById('te-geo-preset-select');
  const id = sel && sel.value;
  const preset = TE_GEO_PRESETS.find(p => p.id === id);
  if (!preset) return;
  setSimulatedLocation({
    lat: preset.lat,
    lon: preset.lon,
    city: preset.city,
    country: preset.country,
    source: 'preset:' + preset.id
  });
}

function teGeoApplyManual() {
  const lat = parseFloat(document.getElementById('te-geo-lat').value);
  const lon = parseFloat(document.getElementById('te-geo-lon').value);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return alert('Enter valid numeric lat/lon');
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return alert('Lat must be -90..90, lon must be -180..180');
  setSimulatedLocation({ lat, lon, city: 'Manual', country: 'XX', source: 'manual' });
}

function teGeoApplyPin() {
  const pin = (document.getElementById('te-geo-pin').value || '').trim();
  const hit = TE_GEO_PIN_MAP[pin];
  if (!hit) return alert(`PIN ${pin} is not in the demo lookup. Try one of: ${Object.keys(TE_GEO_PIN_MAP).slice(0,5).join(', ')}…  or use Advanced lat/lon.`);
  setSimulatedLocation({ lat: hit.lat, lon: hit.lon, city: hit.city, country: 'IN', source: 'pin:' + pin });
}

function teGeoReset() { setSimulatedLocation(null); }

function teGeoToggleAdvanced() {
  const el = document.getElementById('te-geo-advanced');
  if (el) el.classList.toggle('te-collapsed');
}
function teGeoTogglePin() {
  const el = document.getElementById('te-geo-pin-row');
  if (el) el.classList.toggle('te-collapsed');
}

function setupNavigation() {
  const navDashboard = document.getElementById('nav-dashboard');
  const navShop = document.getElementById('nav-shop');

  const navOrders = document.getElementById('nav-orders');
  const navAccount = document.getElementById('nav-account');

  const viewDashboard = document.getElementById('view-dashboard');
  const viewShop = document.getElementById('view-shop');

  const viewOrders = document.getElementById('view-orders');
  const viewAccount = document.getElementById('view-account');
  const pageTitle = document.getElementById('page-title');

  navDashboard.addEventListener('click', (e) => {
    e.preventDefault();
    switchView('dashboard');
    loadDashboardData(); // Refresh dashboard when switching to tab
  });

  navShop.addEventListener('click', (e) => {
    e.preventDefault();
    switchView('shop');
  });

  navOrders.addEventListener('click', (e) => {
    e.preventDefault();
    switchView('orders');
    loadMyOrders(); // Refresh orders when switching to tab
  });

  navAccount.addEventListener('click', (e) => {
    e.preventDefault();
    switchView('account');
  });

  function switchView(view) {
    // Update Nav
    navDashboard.classList.remove('active');
    navShop.classList.remove('active');
    navOrders.classList.remove('active');
    navAccount.classList.remove('active');

    // Update Views
    viewDashboard.classList.add('hidden');
    viewShop.classList.add('hidden');
    viewOrders.classList.add('hidden');
    viewAccount.classList.add('hidden');
    const viewCheckout = document.getElementById('view-checkout');
    if (viewCheckout) viewCheckout.classList.add('hidden');
    const viewCart = document.getElementById('view-cart');
    if (viewCart) viewCart.classList.add('hidden');

    // Body-class modes drive the AI-themed top bar / dark backdrop
    document.body.classList.remove('te-shop-mode', 'te-cart-mode');

    if (view === 'dashboard') {
      navDashboard.classList.add('active');
      viewDashboard.classList.remove('hidden');
      pageTitle.textContent = 'Customer Dashboard';
    } else if (view === 'shop') {
      navShop.classList.add('active');
      viewShop.classList.remove('hidden');
      pageTitle.textContent = 'Shop Products';
      document.body.classList.add('te-shop-mode');
    } else if (view === 'cart') {
      // The cart view is reached via the new top-bar cart icon. The Shop nav
      // pill stays highlighted because the cart is logically part of shopping.
      navShop.classList.add('active');
      if (viewCart) viewCart.classList.remove('hidden');
      pageTitle.textContent = 'Shopping Cart';
      document.body.classList.add('te-cart-mode');
      // Re-render the cart so the count + summary fields are fresh.
      try { renderCart(); } catch (_) { /* renderCart is hoisted at module scope */ }
      // Refresh the geo-simulator chip in case localStorage changed elsewhere.
      try { initGeoPicker(); } catch (_) {}
    } else if (view === 'orders') {
      navOrders.classList.add('active');
      viewOrders.classList.remove('hidden');
      pageTitle.textContent = 'My Orders';
    } else if (view === 'account') {
      if (navAccount) navAccount.classList.add('active');
      if (viewAccount) {
        viewAccount.classList.remove('hidden');
        viewAccount.style.display = 'block';
      }
      pageTitle.textContent = 'My Account';
      loadAccountData();
    } else if (view === 'checkout') {
      if (viewCheckout) viewCheckout.classList.remove('hidden');
      pageTitle.textContent = 'Checkout';
    }
  }

  // Expose switchView to window so other functions can use it (e.g. Cancel button)
  window.switchView = switchView;
}

// ===============================
// REAL-TIME & THEME LOGIC
// ===============================
function initRealtimeNotifications() {
  const userStr = localStorage.getItem('user');
  if (!userStr) return;
  const user = JSON.parse(userStr);
  const userId = user.id || user._id;

  const socket = io();

  socket.on('connect', () => {
    console.log('📡 Connected to Socket.io for real-time updates');
    socket.emit('join', userId);
  });

  socket.on('statusUpdate', (data) => {
    console.log('🔔 Status Update Received:', data);
    showRealtimeNotification(data.message);
    loadDashboardData();
    if (document.getElementById('view-orders').classList.contains('hidden') === false) {
      loadMyOrders();
    }
  });

  socket.on('disconnect', () => {
    console.log('📡 Disconnected from Socket.io');
  });
}

function showRealtimeNotification(message) {
  const container = document.body;
  const noti = document.createElement('div');
  noti.className = 'realtime-noti glass-card';
  noti.innerHTML = `
    <div style="font-size: 1.5rem;">🔔</div>
    <div>
      <p style="margin: 0; font-weight: bold;">Order Update</p>
      <p style="margin: 0; font-size: 0.85rem; opacity: 0.9;">${message}</p>
    </div>
  `;
  container.appendChild(noti);
  
  // Play sound if possible
  try { new Audio('/ping.mp3').play(); } catch(e) {}

  setTimeout(() => {
    noti.style.animation = 'slideNotify 0.5s reverse forwards';
    setTimeout(() => noti.remove(), 500);
  }, 5000);
}

function initThemeSupport() {
  const themeToggle = document.getElementById('theme-toggle');
  const currentTheme = localStorage.getItem('theme') || 'light';
  
  document.documentElement.setAttribute('data-theme', currentTheme);
  if (themeToggle) {
    themeToggle.checked = currentTheme === 'dark';
    themeToggle.addEventListener('change', (e) => {
      const targetTheme = e.target.checked ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', targetTheme);
      localStorage.setItem('theme', targetTheme);
    });
  }
}

// ===============================
// DASHBOARD LOGIC
// ===============================
async function loadDashboardData() {
  const timelineSection = document.getElementById('order-timeline-section');
  const trackingSection = document.getElementById('tracking-section');

  if (!timelineSection) return;

  try {
    const orders = await get('/orders/my-orders');
    renderOrderTimeline(timelineSection, orders);
    enableLiveTracking(trackingSection, orders);
  } catch (e) {
    console.error('Dashboard error:', e);
  }
}

function renderOrderTimeline(section, orders) {
  if (!orders || orders.length === 0) {
    section.innerHTML = '<div style="padding: 1rem;">No recent activity.</div>';
    return;
  }
  const recent = orders.slice(0, 5);
  const html = recent.map(order => `
    <div style="padding: 0.5rem; margin-bottom: 0.5rem; border-left: 3px solid var(--color-primary);">
      <strong>#${order._id.slice(-6)}</strong> - ${order.status} 
      <span style="color: var(--color-muted);">(${new Date(order.createdAt).toLocaleDateString()})</span>
    </div>
  `).join('');
  section.innerHTML = `<div class='order-timeline'><h3>Recent Activity</h3>${html}</div>`;
}

function enableLiveTracking(section, orders) {
  if (!section) return;
  const activeOrders = orders.filter(o => o.status !== 'Delivered' && o.status !== 'Delayed Delivery');
  if (activeOrders.length === 0) {
    section.innerHTML = '<div style="padding: 1rem;">No active orders to track.</div>';
    return;
  }
  section.innerHTML = `<div style="padding: 1rem;">
    <strong>Live Tracking</strong><br>
    <small>You have ${activeOrders.length} active order(s).</small>
  </div>`;
}

// ===============================
// SHOP LOGIC
// ===============================
async function loadShopData() {
  try {
    allProducts = await get('/shop/products');
    renderProducts(allProducts);
  } catch (e) {
    console.error('Shop error:', e);
  }
}

function renderProducts(products) {
  const list = document.getElementById('product-list');
  if (!list) return;
  list.innerHTML = products.map(p => `
    <div class="item" style="color: white;">
      <img src="${p.image}" alt="${p.name}">
      <p style="color: white;"><strong>${p.name}</strong></p>
      <p style="color: #ccc;">Brand: ${p.brand}</p>
      <p style="color: #ccc;">Category: ${p.category}</p>
      <p style="color: white; font-weight: bold; font-size: 1.1em;">₹${p.cost}</p>
      <button class="add-to-cart-btn" onclick="addToCart('${p.name}', ${p.cost}, '${p.image}')">Add to Cart</button>
    </div>
  `).join('');
}

function filterProducts(category) {
  // Update active button
  document.querySelectorAll('.category').forEach(btn => btn.classList.remove('active'));
  event.target.classList.add('active');

  if (category === 'all') {
    renderProducts(allProducts);
  } else {
    renderProducts(allProducts.filter(p => p.category === category));
  }
}

function addToCart(name, price, image) {
  const existing = cart.find(item => item.name === name);
  if (existing) {
    existing.quantity++;
    existing.totalPrice = existing.quantity * existing.price;
  } else {
    cart.push({ name, price, image, quantity: 1, totalPrice: price });
  }
  renderCart();

  // Notify Fraud Service about the Add to Cart event
  try {
    const userStr = localStorage.getItem('user');
    if (userStr) {
      const user = JSON.parse(userStr);
      fetch('http://localhost:5002/api/fraud/log-event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: user.id || user._id,
          eventType: 'add_to_cart',
          productDetails: { name, price }
        })
      });
    }
  } catch (e) {
    console.error('Error logging add_to_cart event', e);
  }
}

function removeFromCart(index) {
  const item = cart[index];
  if (item) {
    logBehavioralEvent('remove_from_cart', { productDetails: { name: item.name } });
  }
  cart.splice(index, 1);
  renderCart();
}

function renderCart() {
  const tbody = document.getElementById('cart-items');
  const totalSpan = document.getElementById('cart-total');
  if (!tbody || !totalSpan) return;

  // Top-bar badge + cart-view summary fields (added by the shop redesign)
  const badge = document.getElementById('te-cart-count');
  const summaryItems = document.getElementById('te-summary-items');
  const subtitle = document.getElementById('te-cart-subtitle');
  const proceedBtn = document.getElementById('te-proceed-btn');

  if (cart.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="te-empty">Cart is empty — add some products first.</td></tr>';
    totalSpan.textContent = '0';
    if (badge) badge.textContent = '0';
    if (summaryItems) summaryItems.textContent = '0';
    if (subtitle) subtitle.textContent = 'Your cart is empty';
    if (proceedBtn) proceedBtn.disabled = true;
    return;
  }

  let total = 0;
  let qtyCount = 0;
  tbody.innerHTML = cart.map((item, index) => {
    total += item.totalPrice;
    qtyCount += item.quantity;
    return `
      <tr>
        <td><img src="${item.image}" class="cart-img" alt=""></td>
        <td><strong>${item.name}</strong></td>
        <td>₹${item.price}</td>
        <td>${item.quantity}</td>
        <td>₹${item.totalPrice}</td>
        <td><button class="te-remove" onclick="removeFromCart(${index})" aria-label="Remove ${item.name}">Remove</button></td>
      </tr>
    `;
  }).join('');
  totalSpan.textContent = total;
  if (badge) badge.textContent = String(qtyCount);
  if (summaryItems) summaryItems.textContent = String(qtyCount);
  if (subtitle) subtitle.textContent = `${qtyCount} item${qtyCount === 1 ? '' : 's'} in your cart · subtotal ₹${total}`;
  if (proceedBtn) proceedBtn.disabled = false;
}

// ===============================
// CHECKOUT LOGIC
// ===============================
function placeOrder() {
  if (cart.length === 0) return alert('Cart is empty!');
  
  logBehavioralEvent('checkout_attempt', { cartSize: cart.length });

  const totalAmount = cart.reduce((sum, item) => sum + item.totalPrice, 0);
  const totalEl = document.getElementById('checkout-total');
  if (totalEl) totalEl.textContent = totalAmount;

  switchView('checkout');
}

function togglePaymentForms() {
  const method = document.querySelector('input[name="paymentOption"]:checked').value;
  document.getElementById('card-form').classList.add('hidden');
  document.getElementById('upi-form').classList.add('hidden');

  if (method === 'Card') {
    document.getElementById('card-form').classList.remove('hidden');
  } else if (method === 'UPI') {
    document.getElementById('upi-form').classList.remove('hidden');
  }
}

async function handlePayment() {
  const method = document.querySelector('input[name="paymentOption"]:checked').value;
  const totalAmount = cart.reduce((sum, item) => sum + item.totalPrice, 0);

  // Mock Validation
  if (method === 'Card') {
    const cardNum = document.querySelector('#card-form input[placeholder="0000 0000 0000 0000"]').value;
    if (cardNum.length < 16) return alert('Invalid Card Number');
  } else if (method === 'UPI') {
    const upiProvider = document.getElementById('upi-provider').value;
    const upiId = document.getElementById('upi-id-input').value;
    
    if (!upiProvider) return alert('Please select a UPI App (PhonePe, GPay, or Paytm)');
    if (!upiId.includes('@')) return alert('Invalid UPI ID');
    
    // REDIRECT FLOW FOR PHONEPE
    if (upiProvider === 'PhonePe') {
      const biometricsData = window.biometrics ? window.biometrics.getMetrics() : null;
      localStorage.setItem('pendingOrderCart', JSON.stringify(cart));
      localStorage.setItem('pendingPaymentMethod', 'UPI (PhonePe)');
      localStorage.setItem('pendingBiometrics', JSON.stringify(biometricsData));
      
      window.location.href = `phonepe-mock.html?amount=${totalAmount}`;
      return; 
    }

    console.log(`Processing UPI payment via ${upiProvider} for ID: ${upiId}`);
  }

  try {
    const honeypot = document.getElementById('order-confirm-bypass')?.value || "";
    const biometricsData = window.biometrics ? window.biometrics.getMetrics() : null;
    
    const response = await post('/orders', {
      items: cart,
      totalAmount,
      paymentMethod: method,
      biometrics: biometricsData,
      hp_trap: honeypot.length > 0, // will be true if a bot filled it
      simulatedLocation: getSimulatedLocation() // demo picker; null when "Real location"
    });

    if (response.requiresOTP) {
        const demoBanner = document.getElementById('otp-demo-banner');
        const demoCode = document.getElementById('otp-demo-code');
        if (response.demoMode && response.demoOtp) {
            if (demoCode) demoCode.textContent = response.demoOtp;
            if (demoBanner) demoBanner.style.display = 'block';
        } else if (demoBanner) {
            demoBanner.style.display = 'none';
        }
        populateFraudDetailsPanel('otp-fraud-details', response, 'warning');
        document.getElementById('otp-modal').classList.remove('hidden');
        document.getElementById('otp-modal').style.display = 'flex';
        return; // Stop flow and wait for OTP
    }

    if (response.blocked) {
        populateFraudDetailsPanel('block-fraud-details', response, 'block');
        const blockMessageEl = document.getElementById('fraud-block-message');
        if (blockMessageEl && response.message) blockMessageEl.textContent = response.message;
        const modal = document.getElementById('fraud-block-modal');
        if (modal) {
          modal.classList.remove('hidden');
          modal.style.display = 'flex';
        }
        logPaymentFailure(method);
        return;
    }

    if (response.success || response.order) {
      const orderId = response.order?._id || 'Success';
      alert(`Payment Successful via ${method}! Order Placed. (Order ID: ${orderId.slice(-6)})`);
      logBehavioralEvent('payment_success', { method });
      cart = [];
      renderCart();
      loadMyOrders();
      switchView('orders');
    } else {
      alert('Order failed: ' + (response.message || 'Unknown error. Check server logs.'));
      logPaymentFailure(method);
    }
  } catch (e) {
    console.error('Payment error:', e);
    // Log exception based payment failures to the fraud service
    if (e.message && e.message.includes('paused for security review')) {
        alert('Transaction blocked due to high security risk.');
    } else {
        alert('Payment processing failed: ' + (e.message || 'Unknown error'));
        logPaymentFailure(method);
    }
  }
}

function initOTPForm() {
  const otpForm = document.getElementById('otp-form');
  if (otpForm) {
    otpForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const otp = document.getElementById('otp-input').value;
      const method = document.querySelector('input[name="paymentOption"]:checked').value;
      const totalAmount = cart.reduce((sum, item) => sum + item.totalPrice, 0);

      try {
        const fingerprint = await getBrowserFingerprint();
        const response = await post('/orders/verify-otp-and-place-order', {
          otp,
          items: cart,
          totalAmount,
          paymentMethod: method,
          deviceFingerprint: fingerprint
        });

        if (response.success) {
          alert('OTP Verified & Payment Successful! Order Placed.');
          logBehavioralEvent('payment_success', { method: 'OTP Verified ' + method });
          cart = [];
          renderCart();
          loadMyOrders();
          closeOtpModal();
          switchView('orders');
        } else {
          if (response.accountBlocked) {
            alert('Account Suspended: Too many failed OTP attempts. You will be logged out.');
            closeOtpModal();
            localStorage.removeItem('authToken');
            localStorage.removeItem('user');
            window.location.href = '/index.html';
          } else {
            if (response.showAlternative) {
              document.getElementById('alt-verification').classList.remove('hidden');
              alert('OTP failed 2 times. You can now use Fingerprint or Passkey verification.');
            }
            alert(response.message || 'Invalid OTP');
          }
        }
      } catch (err) {
        console.error(err);
        alert('OTP verification failed.');
      }
    });
  }
}

function closeOtpModal() {
  const modal = document.getElementById('otp-modal');
  if (modal) {
    modal.classList.add('hidden');
    modal.style.display = 'none';
  }
  const otpInput = document.getElementById('otp-input');
  if (otpInput) otpInput.value = '';
}

function closeFraudBlockModal() {
  const modal = document.getElementById('fraud-block-modal');
  if (modal) {
    modal.classList.add('hidden');
    modal.style.display = 'none';
  }
}

function toggleFraudDetailsPanel(panelId) {
  const panel = document.getElementById(panelId);
  if (!panel) return;
  const body = panel.querySelector('[data-role="body"]');
  const toggle = panel.querySelector('[data-role="toggle"]');
  if (!body) return;
  const open = body.style.display !== 'none';
  body.style.display = open ? 'none' : 'block';
  if (toggle) toggle.innerHTML = open ? '&#x25BC;' : '&#x25B2;';
}

function populateFraudDetailsPanel(panelId, response, kind) {
  const panel = document.getElementById(panelId);
  if (!panel) return;

  panel.onclick = null;
  const header = panel.querySelector('[data-role="header"]');
  if (header) header.onclick = () => toggleFraudDetailsPanel(panelId);

  const scoreBadge = panel.querySelector('[data-role="score-badge"]');
  if (scoreBadge) {
    if (typeof response.riskScore === 'number') {
      scoreBadge.textContent = 'Risk ' + response.riskScore + '/10';
      scoreBadge.style.display = 'inline';
    } else {
      scoreBadge.style.display = 'none';
    }
  }

  const reasonsList = panel.querySelector('[data-role="reasons-list"]');
  if (reasonsList) {
    reasonsList.innerHTML = '';
    const reasons = []
      .concat(Array.isArray(response.serverReasons) ? response.serverReasons : [])
      .concat(Array.isArray(response.reasons) ? response.reasons : []);
    if (reasons.length === 0 && response.message) reasons.push(response.message);
    if (reasons.length === 0) reasons.push('Transaction flagged by the fraud detection system.');
    reasons.forEach((r) => {
      const li = document.createElement('li');
      li.style.marginBottom = '4px';
      li.textContent = r;
      reasonsList.appendChild(li);
    });
  }

  const explanationSection = panel.querySelector('[data-role="explanation-section"]');
  const explanationBars = panel.querySelector('[data-role="explanation-bars"]');
  if (explanationSection && explanationBars) {
    if (Array.isArray(response.explanation) && response.explanation.length > 0) {
      explanationBars.innerHTML = '';
      const sorted = response.explanation
        .slice()
        .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
      const maxMagnitude = Math.max.apply(null, sorted.map(e => Math.abs(e.contribution)).concat(0.01));
      sorted.forEach((item) => {
        const positive = item.contribution >= 0;
        const widthPct = Math.min(100, (Math.abs(item.contribution) / maxMagnitude) * 100);
        const row = document.createElement('div');
        row.style.cssText = 'display:grid; grid-template-columns:110px 1fr 64px; gap:10px; align-items:center; margin:6px 0; font-size:0.88rem;';
        const nameEl = document.createElement('span');
        nameEl.style.cssText = 'font-family:monospace;';
        nameEl.textContent = item.feature;
        const barWrap = document.createElement('div');
        barWrap.style.cssText = 'background:#f3f4f6; height:12px; border-radius:3px; overflow:hidden;';
        const bar = document.createElement('div');
        bar.style.cssText = 'height:100%; width:' + widthPct + '%; background:' + (positive ? '#dc2626' : '#16a34a') + ';';
        barWrap.appendChild(bar);
        const valueEl = document.createElement('span');
        valueEl.style.cssText = 'text-align:right; font-family:monospace; font-size:0.85rem;';
        valueEl.textContent = (positive ? '+' : '') + Number(item.contribution).toFixed(2);
        row.appendChild(nameEl);
        row.appendChild(barWrap);
        row.appendChild(valueEl);
        explanationBars.appendChild(row);
      });
      explanationSection.style.display = 'block';
    } else {
      explanationSection.style.display = 'none';
    }
  }

  const body = panel.querySelector('[data-role="body"]');
  const toggle = panel.querySelector('[data-role="toggle"]');
  if (body && toggle) {
    const autoOpen = kind === 'block';
    body.style.display = autoOpen ? 'block' : 'none';
    toggle.innerHTML = autoOpen ? '&#x25B2;' : '&#x25BC;';
  }

  panel.style.display = 'block';
}

async function logBehavioralEvent(eventType, payload = {}) {
  try {
    const userStr = localStorage.getItem('user');
    if (userStr) {
      const user = JSON.parse(userStr);
      fetch('http://localhost:5002/api/fraud/log-event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: user.id || user._id,
          eventType: eventType,
          ...payload
        })
      });
    }
  } catch (e) {
    console.error(`Error logging ${eventType}:`, e);
  }
}

// Helper function to log payment failures to the new Fraud Service
function logPaymentFailure(method) {
  try {
    const userStr = localStorage.getItem('user');
    if (userStr) {
      const user = JSON.parse(userStr);
      fetch('http://localhost:5002/api/fraud/log-event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: user.id || user._id,
          eventType: 'payment_failed',
          paymentMethod: method
        })
      });
    }
  } catch (e) {
    console.error('Error logging payment_failed event', e);
  }
}

// ===============================
// ALTERNATIVE VERIFICATION
// ===============================
async function registerPasskey() {
  const btn = document.getElementById('reg-passkey-btn');
  btn.disabled = true;
  btn.textContent = 'Registering...';

  try {
    // SIMULATION: In a real app, this would use navigator.credentials.create
    // For this project, we'll simulate the biometric prompt delay
    await new Promise(resolve => setTimeout(resolve, 1500));
    
    const response = await post('/auth/register-passkey', { 
      deviceInfo: navigator.userAgent 
    });

    if (response.success) {
      alert('Passkey registered successfully! You can now use it for secure verification.');
      loadAccountData();
    } else {
      alert('Passkey registration failed: ' + response.message);
    }
  } catch (err) {
    console.error(err);
    alert('Passkey registration error.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Register';
  }
}

async function verifyWithFingerprint() {
  const fingerprint = await getBrowserFingerprint();
  const method = document.querySelector('input[name="paymentOption"]:checked').value;
  
  try {
    const response = await post('/orders/verify-alternative', {
      type: 'fingerprint',
      fingerprint,
      items: cart,
      totalAmount: cart.reduce((sum, item) => sum + item.totalPrice, 0),
      paymentMethod: method
    });

    if (response.success) {
      alert('Fingerprint Verified! Order Placed.');
      finalizeOrder();
    } else {
      alert(response.message || 'Fingerprint verification failed.');
    }
  } catch (err) {
    console.error(err);
    alert('Verification error.');
  }
}

async function verifyWithPasskey() {
  const method = document.querySelector('input[name="paymentOption"]:checked').value;
  
  try {
    // SIMULATION: Biometric prompt
    const confirm = window.confirm("Verify with your device Passkey (FaceID/TouchID)?");
    if (!confirm) return;

    const response = await post('/orders/verify-alternative', {
      type: 'passkey',
      items: cart,
      totalAmount: cart.reduce((sum, item) => sum + item.totalPrice, 0),
      paymentMethod: method
    });

    if (response.success) {
      alert('Passkey Verified! Order Placed.');
      finalizeOrder();
    } else {
      alert(response.message || 'Passkey verification failed. Please ensure you have a registered passkey.');
    }
  } catch (err) {
    console.error(err);
    alert('Passkey verification error.');
  }
}

function finalizeOrder() {
  cart = [];
  renderCart();
  loadMyOrders();
  closeOtpModal();
  switchView('orders');
  document.getElementById('alt-verification').classList.add('hidden');
}

// ===============================
async function loadMyOrders() {
  try {
    const orders = await get('/orders/my-orders');
    renderMyOrders(orders);
  } catch (e) {
    console.error('My Orders error:', e);
    const list = document.getElementById('my-orders-list');
    if (list) list.innerHTML = `<p style="color: #ef4444; padding: 1rem;">Error loading orders: ${e.message}. Please try refreshing the page.</p>`;
  }
}

function renderMyOrders(orders) {
  const list = document.getElementById('my-orders-list');
  if (!list) return;

  if (orders.length === 0) {
    list.innerHTML = '<p>No orders found.</p>';
    return;
  }

  list.innerHTML = orders.map(order => {
    // Format expected delivery date
    let deliveryDateText = 'Not yet scheduled';
    if (order.expectedDeliveryDate) {
      const deliveryDate = new Date(order.expectedDeliveryDate);
      deliveryDateText = deliveryDate.toLocaleDateString('en-GB', {
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

    return `
      <div class="order-card te-order-card">
      <div class="order-header te-order-header">
        <span class="te-order-id"><strong>Order #${order._id.slice(-6)}</strong></span>
        <span class="status-badge te-status-badge status-${order.status.replace(' ', '.')}">${order.status}</span>
      </div>
      <div class="te-order-body">
        <p><span class="te-meta-label">Date:</span> ${new Date(order.createdAt).toLocaleString()}</p>
        <p><span class="te-meta-label">Total:</span> ₹${order.totalAmount}</p>
        <p><span class="te-meta-label">Items:</span> ${order.items.map(i => `${i.quantity}x ${i.name}`).join(', ')}</p>
        <p><strong>Expected Delivery:</strong> ${deliveryDateText}</p>
        ${actualDeliveryText ? `<p><strong>Actual Delivery:</strong> ${actualDeliveryText}</p>` : ''}
        ${(order.status === 'Delivered' || order.status === 'Delayed Delivery') && !order.feedback ?
        `<button onclick="openFeedbackModal('${order._id}')" class="btn-primary te-rate-btn">Rate Order</button>` :
        order.feedback ? `<p class="te-rated"><strong>Rated:</strong> ${order.feedback.rating}/5 ★</p>` : ''}
      </div>
    </div>
      `;
  }).join('');
}

// ===============================
// FEEDBACK LOGIC
// ===============================
// ===============================
// FEEDBACK LOGIC
// ===============================
function openFeedbackModal(orderId) {
  const modal = document.getElementById('feedback-modal');
  const orderIdInput = document.getElementById('feedback-order-id');
  const closeBtn = document.querySelector('.close-modal');
  const form = document.getElementById('feedback-form');
  const ratingLabel = document.getElementById('rating-label');
  const commentInput = document.getElementById('feedback-comment');
  const charCount = document.getElementById('char-count');
  const ratingInputs = document.querySelectorAll('input[name="rating"]');

  if (!modal || !orderIdInput) return;

  orderIdInput.value = orderId;
  modal.classList.add('flex');
  modal.classList.remove('hidden');

  // Reset form and UI
  form.reset();
  ratingLabel.textContent = '';
  charCount.textContent = '0';
  charCount.style.color = '#666';

  // Rating Label Logic
  const labels = {
    '1': 'Very Bad',
    '2': 'Bad',
    '3': 'Average',
    '4': 'Good',
    '5': 'Very Good'
  };

  ratingInputs.forEach(input => {
    input.addEventListener('change', () => {
      ratingLabel.textContent = labels[input.value];
    });
  });

  // Character Count Logic
  commentInput.oninput = () => {
    const len = commentInput.value.length;
    charCount.textContent = len;
    if (len < 10 || len > 200) {
      charCount.style.color = 'red';
    } else {
      charCount.style.color = 'green';
    }
  };

  closeBtn.onclick = () => {
    modal.classList.remove('flex');
    modal.classList.add('hidden');
  };

  window.onclick = (event) => {
    if (event.target == modal) {
      modal.classList.remove('flex');
      modal.classList.add('hidden');
    }
  };

  form.onsubmit = async (e) => {
    e.preventDefault();
    const rating = document.querySelector('input[name="rating"]:checked')?.value;
    const comment = commentInput.value.trim();

    if (!rating) {
      alert('Please select a rating');
      return;
    }

    if (comment.length < 10) {
      alert('Comment must be at least 10 characters long.');
      return;
    }

    if (comment.length > 200) {
      alert('Comment must not exceed 200 characters.');
      return;
    }

    try {
      await post(`/ orders / ${orderId}/feedback`, { rating, comment });
      alert('Feedback submitted successfully!');
      modal.classList.remove('flex');
      modal.classList.add('hidden');
      loadMyOrders(); // Refresh to show "Rated" status
    } catch (error) {
      console.error('Feedback error:', error);
      alert('Failed to submit feedback: ' + (error.message || 'Unknown error'));
    }
  };
}

// ===============================
// ACCOUNT LOGIC
// ===============================
async function loadAccountData() {
  console.log('🔄 Loading account data...');
  const accountName = document.getElementById('account-name');
  const accountEmail = document.getElementById('account-email');
  const accountRole = document.getElementById('account-role');

  if (!accountName || !accountEmail || !accountRole) {
    console.error('❌ Account elements not found in DOM');
    return;
  }

  try {
    const response = await get('/auth/verify');
    console.log('👤 Profile response:', response);
    
    if (response && response.user) {
      const user = response.user;
      accountName.textContent = user.username || 'N/A';
      accountEmail.textContent = user.email || 'N/A';
      accountRole.textContent = user.role || 'N/A';

      const phoneInput = document.getElementById('account-phone');
      const addressInput = document.getElementById('account-address');

      if (phoneInput) phoneInput.value = user.phoneNumber || '';
      if (addressInput) addressInput.value = user.address || '';
      
      const passkeyStatus = document.getElementById('passkey-status');
      const passkeyBtn = document.getElementById('reg-passkey-btn');
      if (user.passkeyId) {
        passkeyStatus.textContent = 'Passkey Registered ✅';
        passkeyStatus.style.color = '#166534';
        if (passkeyBtn) passkeyBtn.textContent = 'Re-Register';
      }
      
      localStorage.setItem('user', JSON.stringify(user));
      console.log('✅ Account data loaded successfully');
    } else {
      throw new Error('User data missing in response');
    }
  } catch (e) {
    console.warn('⚠️ Server fetch failed, using local storage:', e);
    const userStr = localStorage.getItem('user');
    if (userStr) {
      const user = JSON.parse(userStr);
      accountName.textContent = user.username || 'N/A';
      accountEmail.textContent = user.email || 'N/A';
      accountRole.textContent = user.role || 'N/A';
    }
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

async function updateProfile() {
  const phoneInput = document.getElementById('account-phone');
  const addressInput = document.getElementById('account-address');

  const phoneNumber = phoneInput.value.trim();
  const address = addressInput.value.trim();

  // Validation
  if (phoneNumber && !/^\d{10}$/.test(phoneNumber)) {
    return alert('Phone number must be exactly 10 digits');
  }

  if (address.length === 0) {
    return alert('Address cannot be empty');
  }

  try {
    const result = await put('/auth/profile', { phoneNumber, address });

    if (result.success) {
      alert('Profile updated successfully!');
      // Update local storage
      const user = JSON.parse(localStorage.getItem('user'));
      user.phoneNumber = result.user.phoneNumber;
      user.address = result.user.address;
      localStorage.setItem('user', JSON.stringify(user));
    } else {
      alert('Failed to update profile: ' + result.message);
    }
  } catch (error) {
    console.error('Profile update error:', error);
    alert('Error updating profile: ' + (error.message || 'Unknown error'));
  }
}

async function handlePaymentReturn() {
  const params = new URLSearchParams(window.location.search);
  const status = params.get('payment');
  const provider = params.get('provider');

  if (!status) return;

  // Clean URL immediately to prevent re-triggering on refresh
  window.history.replaceState({}, document.title, window.location.pathname);

  if (status === 'success') {
    const savedCart = localStorage.getItem('pendingOrderCart');
    const method = localStorage.getItem('pendingPaymentMethod') || 'UPI';

    if (!savedCart) {
      console.warn('No pending cart found for successful payment');
      return;
    }

    try {
      const cartToPlace = JSON.parse(savedCart);
      const totalAmount = cartToPlace.reduce((sum, item) => sum + item.totalPrice, 0);

      const savedBiometrics = localStorage.getItem('pendingBiometrics');
      const bioData = savedBiometrics ? JSON.parse(savedBiometrics) : null;

      // Official order placement call (now with Biometrics!)
      const response = await post('/orders', {
        items: cartToPlace,
        totalAmount,
        paymentMethod: method,
        biometrics: bioData,
        simulatedLocation: getSimulatedLocation()
      });

      if (response.success || response.order) {
        alert(`Success: Payment received via ${provider}! Your order has been placed.`);
        localStorage.removeItem('pendingOrderCart');
        localStorage.removeItem('pendingPaymentMethod');
        localStorage.removeItem('pendingBiometrics');
        
        // Refresh UI
        cart = [];
        renderCart();
        loadMyOrders();
        
        // Use a timeout to ensure navigation works after the alert
        setTimeout(() => {
            if (typeof window.switchView === 'function') {
                window.switchView('orders');
            }
        }, 100);
      } else {
        alert('Payment was successful but order creation failed. Please contact support.');
      }
    } catch (e) {
      console.error('Callback error:', e);
      alert('An error occurred while confirming your order.');
    }
  } else if (status === 'failed') {
    alert(`Payment via ${provider} was cancelled or failed. Please try again.`);
    // Re-show checkout if possible
    setTimeout(() => {
        if (typeof window.switchView === 'function') {
            window.switchView('checkout');
        }
    }, 100);
  }
}

// Expose to window
window.updateProfile = updateProfile;
window.handlePaymentReturn = handlePaymentReturn;

if (typeof document !== 'undefined' && document.readyState !== 'loading') {
  initCustomerDashboard();
} else {
  document.addEventListener('DOMContentLoaded', initCustomerDashboard);
}
