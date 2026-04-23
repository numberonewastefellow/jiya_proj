// vendorDashboard.js: Vendor dashboard logic
import { get, patch, put, post, del } from './api.js';
import { createTableRow, renderLoader } from './ui.js';

export async function initVendorDashboard() {
  const ordersSection = document.getElementById('vendor-orders');
  const alertsSection = document.getElementById('alerts-section');

  if (!ordersSection || !alertsSection) return;

  setupNavigation();
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
    }
  } catch (e) { console.error('Error setting title:', e); }

  // Inject date picker modal if not exists
  if (!document.getElementById('delivery-date-modal')) {
    injectDeliveryDateModal();
  }

  ordersSection.innerHTML = renderLoader();
  alertsSection.innerHTML = '';

  try {
    let orders = await fetchVendorOrders();
    const transformedOrders = Array.isArray(orders) ? orders.map(transformOrderForTable) : [];
    renderOrdersList(ordersSection, transformedOrders);
    renderAlerts(alertsSection, transformedOrders);

    // Render Performance Chart
    renderPerformanceChart(orders);
  } catch (e) {
    console.error('Vendor dashboard error:', e);
    ordersSection.innerHTML = `<div class="error-message">Error loading orders: ${e.message}</div>`;
  }
}

async function fetchVendorOrders() {
  return await get('/orders/vendor-orders');
}

function transformOrderForTable(order) {
  const customerName = order.customerId?.username || order.customerId?.email || 'Customer';
  let totalAmount = order.totalAmount || 0;

  // Format expected delivery date
  let expectedDelivery = 'Not yet scheduled';
  if (order.expectedDeliveryDate) {
    const deliveryDate = new Date(order.expectedDeliveryDate);
    expectedDelivery = deliveryDate.toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric'
    });
  }

  // Format actual delivery date
  let actualDelivery = null;
  if (order.actualDeliveryDate) {
    const actualDate = new Date(order.actualDeliveryDate);
    actualDelivery = actualDate.toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric'
    });
  }

  return {
    id: order._id,
    displayId: order._id.slice(-6),
    customer: customerName,
    customerEmail: order.customerId?.email || 'N/A',
    status: order.status,
    date: new Date(order.createdAt).toLocaleDateString(),
    amount: `₹${totalAmount}`,
    items: order.items,
    paymentMethod: order.paymentMethod,
    expectedDelivery: expectedDelivery,
    actualDelivery: actualDelivery
  };
}

function renderOrdersList(parent, orders) {
  parent.innerHTML = '';
  if (orders.length === 0) {
    parent.innerHTML = '<div style="padding: 2rem; text-align: center;">No active orders.</div>';
    return;
  }

  // Separate Active and History
  const active = orders.filter(o => !['Rejected', 'Delivered', 'Delayed Delivery'].includes(o.status));
  const history = orders.filter(o => ['Rejected', 'Delivered', 'Delayed Delivery'].includes(o.status));

  if (active.length > 0) {
    const table = createTable(active);
    parent.appendChild(table);
  }

  if (history.length > 0) {
    const historyHeader = document.createElement('h3');
    historyHeader.textContent = 'Order History';
    historyHeader.style.marginTop = '2rem';
    parent.appendChild(historyHeader);

    const table = createTable(history, false); // No actions for history
    parent.appendChild(table);
  }
}

function createTable(orders, interactive = true) {
  const table = document.createElement('table');
  table.className = 'vendor-table';
  table.innerHTML = `
    <thead>
      <tr>
        <th>ID</th>
        <th>Customer</th>
        <th>Date</th>
        <th>Amount</th>
        <th>Status</th>
        <th>Actions</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;

  const tbody = table.querySelector('tbody');
  orders.forEach(order => {
    const tr = document.createElement('tr');
    tr.style.cursor = 'pointer';
    tr.innerHTML = `
      <td>#${order.displayId}</td>
      <td>${order.customer}</td>
      <td>${order.date}</td>
      <td>${order.amount}</td>
      <td><span class="status-badge status-${order.status.replace(' ', '.')}">${order.status}</span></td>
      <td class="actions-cell"></td>
    `;

    if (interactive) {
      const actionsCell = tr.querySelector('.actions-cell');
      renderActions(actionsCell, order);
    }

    // Add click event to show/hide details
    tr.addEventListener('click', (e) => {
      // Don't toggle if clicking on action buttons
      if (e.target.tagName === 'BUTTON') return;

      const existingDetails = tr.nextElementSibling;
      if (existingDetails && existingDetails.classList.contains('order-details-row')) {
        existingDetails.remove();
      } else {
        const detailsRow = createOrderDetailsRow(order);
        tr.insertAdjacentElement('afterend', detailsRow);
      }
    });

    tbody.appendChild(tr);
  });

  return table;
}

function createOrderDetailsRow(order) {
  const detailsRow = document.createElement('tr');
  detailsRow.className = 'order-details-row';
  detailsRow.innerHTML = `
    <td colspan="6" style="background: rgba(0,0,0,0.05); padding: 1rem;">
      <div style="max-width: 800px;">
        <h4 style="margin-top: 0; color: #333;">Order Details</h4>
        <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 1rem; margin-bottom: 1rem;">
          <div><strong>Order ID:</strong> #${order.id}</div>
          <div><strong>Status:</strong> ${order.status}</div>
          <div><strong>Customer:</strong> ${order.customer}</div>
          <div><strong>Email:</strong> ${order.customerEmail}</div>
          <div><strong>Date:</strong> ${order.date}</div>
          <div><strong>Payment Method:</strong> ${order.paymentMethod || 'COD'}</div>
          <div><strong>Expected Delivery:</strong> ${order.expectedDelivery}</div>
          ${order.actualDelivery ? `<div><strong>Actual Delivery:</strong> ${order.actualDelivery}</div>` : ''}
        </div>
        <h5 style="margin-bottom: 0.5rem;">Items:</h5>
        <table style="width: 100%; border-collapse: collapse; background: white;">
          <thead>
            <tr style="background: #f8f9fa;">
              <th style="padding: 0.5rem; text-align: left; border: 1px solid #ddd;">Image</th>
              <th style="padding: 0.5rem; text-align: left; border: 1px solid #ddd;">Item</th>
              <th style="padding: 0.5rem; text-align: center; border: 1px solid #ddd;">Quantity</th>
              <th style="padding: 0.5rem; text-align: right; border: 1px solid #ddd;">Price</th>
              <th style="padding: 0.5rem; text-align: right; border: 1px solid #ddd;">Total</th>
            </tr>
          </thead>
          <tbody>
            ${order.items && order.items.length > 0
      ? order.items.map(item => `
                <tr>
                  <td style="padding: 0.5rem; border: 1px solid #ddd; text-align: center; width: 60px;">
                    <img src="${item.image || '/images/placeholder.png'}" alt="${item.name}" style="width: 40px; height: 40px; object-fit: cover; border-radius: 4px;">
                  </td>
                  <td style="padding: 0.5rem; border: 1px solid #ddd;">${item.name || 'Unknown Item'}</td>
                  <td style="padding: 0.5rem; text-align: center; border: 1px solid #ddd;">${item.quantity || 1}</td>
                  <td style="padding: 0.5rem; text-align: right; border: 1px solid #ddd;">₹${(item.price || 0).toFixed(2)}</td>
                  <td style="padding: 0.5rem; text-align: right; border: 1px solid #ddd;">₹${((item.price || 0) * (item.quantity || 1)).toFixed(2)}</td>
                </tr>
              `).join('')
      : '<tr><td colspan="5" style="padding: 0.5rem; text-align: center; border: 1px solid #ddd;">No items</td></tr>'
    }
          </tbody>
          <tfoot>
            <tr style="background: #f8f9fa; font-weight: bold;">
              <td colspan="4" style="padding: 0.5rem; text-align: right; border: 1px solid #ddd;">Total:</td>
              <td style="padding: 0.5rem; text-align: right; border: 1px solid #ddd;">${order.amount}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </td>
  `;
  return detailsRow;
}

function renderActions(container, order) {
  if (order.status === 'Pending') {
    const acceptBtn = document.createElement('button');
    acceptBtn.textContent = 'Accept';
    acceptBtn.className = 'btn-accept';
    acceptBtn.onclick = () => showDeliveryDateModal(order.id);

    const rejectBtn = document.createElement('button');
    rejectBtn.textContent = 'Reject';
    rejectBtn.className = 'btn-reject';
    rejectBtn.onclick = () => updateStatus(order.id, 'Rejected');

    container.appendChild(acceptBtn);
    container.appendChild(rejectBtn);
  } else {
    // Sequential Flow
    const flow = ['Accepted', 'Packed', 'On Board', 'Delivered'];
    const currentIndex = flow.indexOf(order.status);

    if (currentIndex !== -1 && currentIndex < flow.length - 1) {
      const nextStatus = flow[currentIndex + 1];
      const nextBtn = document.createElement('button');
      nextBtn.textContent = `Mark ${nextStatus}`;
      nextBtn.className = 'btn-next';
      nextBtn.onclick = () => updateStatus(order.id, nextStatus);
      container.appendChild(nextBtn);
    }
  }
}

async function updateStatus(orderId, status, expectedDeliveryDate = null) {
  try {
    const body = { status };
    if (expectedDeliveryDate) {
      body.expectedDeliveryDate = expectedDeliveryDate;
    }
    await put(`/orders/${orderId}/status`, body);
    initVendorDashboard(); // Refresh
  } catch (e) {
    alert(e.message || 'Failed to update status');
  }
}

function injectDeliveryDateModal() {
  const modalHtml = `
    <div id="delivery-date-modal" style="display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.6); z-index: 2000; align-items: center; justify-content: center;">
      <div style="background: white; padding: 2rem; border-radius: 8px; width: 90%; max-width: 400px; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
        <h3 style="margin-top: 0; color: #333;">Set Expected Delivery Date</h3>
        <p style="color: #666; font-size: 0.9rem;">Please select when you expect to deliver this order:</p>
        <input type="date" id="delivery-date-input" style="width: 100%; padding: 0.75rem; border: 1px solid #ddd; border-radius: 4px; font-size: 1rem; margin-bottom: 1rem;" />
        <div style="display: flex; gap: 0.5rem; justify-content: flex-end;">
          <button id="cancel-delivery-date" style="padding: 0.5rem 1rem; background: #6c757d; color: white; border: none; border-radius: 4px; cursor: pointer;">Cancel</button>
          <button id="confirm-delivery-date" style="padding: 0.5rem 1rem; background: #28a745; color: white; border: none; border-radius: 4px; cursor: pointer;">Confirm</button>
        </div>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', modalHtml);

  // Set minimum date to today
  const dateInput = document.getElementById('delivery-date-input');
  const today = new Date().toISOString().split('T')[0];
  dateInput.min = today;
  dateInput.value = today;

  // Cancel button
  document.getElementById('cancel-delivery-date').addEventListener('click', () => {
    document.getElementById('delivery-date-modal').style.display = 'none';
  });

  // Close on outside click
  document.getElementById('delivery-date-modal').addEventListener('click', (e) => {
    if (e.target.id === 'delivery-date-modal') {
      document.getElementById('delivery-date-modal').style.display = 'none';
    }
  });
}

function showDeliveryDateModal(orderId) {
  const modal = document.getElementById('delivery-date-modal');
  const confirmBtn = document.getElementById('confirm-delivery-date');

  // Remove previous click listeners by cloning
  const newConfirmBtn = confirmBtn.cloneNode(true);
  confirmBtn.parentNode.replaceChild(newConfirmBtn, confirmBtn);

  // Add new click listener
  newConfirmBtn.addEventListener('click', () => {
    const dateInput = document.getElementById('delivery-date-input');
    const selectedDate = dateInput.value;

    if (!selectedDate) {
      alert('Please select a delivery date');
      return;
    }

    modal.style.display = 'none';
    updateStatus(orderId, 'Accepted', selectedDate);
  });

  modal.style.display = 'flex';
}

function renderAlerts(container, orders) {
  const pending = orders.filter(o => o.status === 'Pending').length;
  if (pending > 0) {
    container.innerHTML = `<div class="alert-pending">${pending} new order(s) pending approval!</div>`;
  }
}

// ===============================
// NAVIGATION LOGIC
// ===============================
function setupNavigation() {
  const navDashboard = document.getElementById('nav-dashboard');
  const navProducts = document.getElementById('nav-products');
  const navPerformance = document.getElementById('nav-performance');
  const navFeedback = document.getElementById('nav-feedback');
  const navAccount = document.getElementById('nav-account');

  const viewDashboard = document.getElementById('view-dashboard');
  const viewProducts = document.getElementById('view-products');
  const viewPerformance = document.getElementById('view-performance');
  const viewFeedback = document.getElementById('view-feedback');
  const viewAccount = document.getElementById('view-account');

  if (!navDashboard) return;

  navDashboard.addEventListener('click', (e) => {
    e.preventDefault();
    switchView('dashboard');
  });

  if (navProducts) {
    navProducts.addEventListener('click', (e) => {
      e.preventDefault();
      switchView('products');
    });
  }

  navPerformance.addEventListener('click', (e) => {
    e.preventDefault();
    switchView('performance');
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
    // Update Nav
    navDashboard.classList.remove('active');
    if (navProducts) navProducts.classList.remove('active');
    navPerformance.classList.remove('active');
    navFeedback.classList.remove('active');
    navAccount.classList.remove('active');

    // Update Views
    viewDashboard.classList.add('hidden');
    if (viewProducts) viewProducts.classList.add('hidden');
    viewPerformance.classList.add('hidden');
    viewFeedback.classList.add('hidden');
    viewAccount.classList.add('hidden');

    if (view === 'dashboard') {
      navDashboard.classList.add('active');
      viewDashboard.classList.remove('hidden');
    } else if (view === 'products') {
      if (navProducts) navProducts.classList.add('active');
      if (viewProducts) viewProducts.classList.remove('hidden');
      loadProductsData();
    } else if (view === 'performance') {
      navPerformance.classList.add('active');
      viewPerformance.classList.remove('hidden');
    } else if (view === 'account') {
      navAccount.classList.add('active');
      viewAccount.classList.remove('hidden');
    } else if (view === 'feedback') {
      navFeedback.classList.add('active');
      viewFeedback.classList.remove('hidden');
      loadFeedbackData();
    }
  }

  // Setup Add Product button and form
  const addProductBtn = document.getElementById('add-product-btn');
  const addProductFormContainer = document.getElementById('add-product-form-container');
  const cancelAddProduct = document.getElementById('cancel-add-product');
  const addProductForm = document.getElementById('add-product-form');

  if (addProductBtn && addProductFormContainer) {
    addProductBtn.addEventListener('click', () => {
      addProductFormContainer.classList.remove('hidden');
    });
  }

  if (cancelAddProduct && addProductFormContainer) {
    cancelAddProduct.addEventListener('click', () => {
      addProductFormContainer.classList.add('hidden');
      if (addProductForm) addProductForm.reset();
    });
  }

  if (addProductForm) {
    addProductForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      await addNewProduct();
    });
  }
}

// ===============================
// PRODUCTS LOGIC
// ===============================
async function loadProductsData() {
  const list = document.getElementById('products-list');
  if (!list) return;

  list.innerHTML = renderLoader();

  try {
    const products = await get('/shop/products');

    if (!products || products.length === 0) {
      list.innerHTML = '<p style="color: #666; text-align: center; padding: 2rem;">No products yet. Click "+ Add Product" to add your first product.</p>';
      return;
    }

    const tableHtml = `
      <table style="width: 100%; border-collapse: collapse; font-size: 0.9rem;">
        <thead style="background: #f3f4f6;">
          <tr>
            <th style="padding: 0.75rem; text-align: left;">Image</th>
            <th style="padding: 0.75rem; text-align: left;">Name</th>
            <th style="padding: 0.75rem; text-align: left;">Price</th>
            <th style="padding: 0.75rem; text-align: left;">Brand</th>
            <th style="padding: 0.75rem; text-align: left;">Category</th>
            <th style="padding: 0.75rem; text-align: left;">Action</th>
          </tr>
        </thead>
        <tbody>
          ${products.map(p => `
            <tr style="border-bottom: 1px solid #eee;">
              <td style="padding: 0.75rem;"><img src="${p.image}" alt="${p.name}" style="width: 50px; height: 50px; object-fit: cover; border-radius: 4px;"></td>
              <td style="padding: 0.75rem; font-weight: 500;">${p.name}</td>
              <td style="padding: 0.75rem;">₹${p.cost.toLocaleString()}</td>
              <td style="padding: 0.75rem;">${p.brand}</td>
              <td style="padding: 0.75rem;">${p.category}</td>
              <td style="padding: 0.75rem;">
                <button onclick="editProduct('${p._id}')" style="background: #3b82f6; color: white; border: none; padding: 0.4rem 0.8rem; border-radius: 4px; cursor: pointer; font-size: 0.8rem; margin-right: 5px;">Edit</button>
                <button onclick="deleteProduct('${p._id}', '${p.name}')" style="background: #ef4444; color: white; border: none; padding: 0.4rem 0.8rem; border-radius: 4px; cursor: pointer; font-size: 0.8rem;">Remove</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;

    list.innerHTML = tableHtml;
  } catch (e) {
    console.error('Load products error:', e);
    list.innerHTML = `<div class="error-message">Error loading products: ${e.message}</div>`;
  }
}

let currentProductId = null; // Track which product is being edited

async function addNewProduct() { // This function acts as saveProduct now
  const name = document.getElementById('product-name').value;
  const cost = document.getElementById('product-cost').value;
  const brand = document.getElementById('product-brand').value;
  const category = document.getElementById('product-category').value;
  const imageInput = document.getElementById('product-image');

  if (!name || !cost || !brand || !category) {
    alert('Please fill all text fields');
    return;
  }

  if (!currentProductId && imageInput.files.length === 0) {
    alert('Please select an image for the new product');
    return;
  }

  const formData = new FormData();
  formData.append('name', name);
  formData.append('cost', cost);
  formData.append('brand', brand);
  formData.append('category', category);

  if (imageInput.files.length > 0) {
    formData.append('image', imageInput.files[0]);
  }

  try {
    if (currentProductId) {
      // Update existing
      await put(`/shop/products/${currentProductId}`, formData);
      alert('Product updated successfully!');
      currentProductId = null; // Reset
    } else {
      // Create new
      await post('/shop/products', formData);
      alert('Product added successfully!');
    }

    document.getElementById('add-product-form').reset();
    document.getElementById('add-product-form-container').classList.add('hidden');
    document.getElementById('image-preview-container').style.display = 'none';

    // Reset form title and button text
    document.querySelector('#add-product-form-container h4').textContent = 'Add New Product';
    document.querySelector('#add-product-form button[type="submit"]').textContent = 'Save Product';

    loadProductsData();
  } catch (e) {
    console.error('Save product error:', e);
    alert('Failed to save product: ' + (e.message || 'Unknown error'));
  }
}

async function editProduct(productId) {
  try {
    const products = await get('/shop/products');
    const product = products.find(p => p._id === productId);

    if (!product) {
      alert('Product not found in list. Please refresh.');
      return;
    }

    // Populate form
    // Populate form
    document.getElementById('product-name').value = product.name;
    document.getElementById('product-cost').value = product.cost;
    document.getElementById('product-brand').value = product.brand;
    document.getElementById('product-category').value = product.category;

    // Show preview
    const previewContainer = document.getElementById('image-preview-container');
    const previewImage = document.getElementById('image-preview');
    if (product.image) {
      previewImage.src = product.image;
      previewContainer.style.display = 'block';
    } else {
      previewContainer.style.display = 'none';
    }

    // Set state for edit
    currentProductId = productId;

    // Show form with updated title
    const formContainer = document.getElementById('add-product-form-container');
    formContainer.classList.remove('hidden');
    document.querySelector('#add-product-form-container h4').textContent = 'Edit Product';
    document.querySelector('#add-product-form button[type="submit"]').textContent = 'Update Product';

    // Scroll to form
    formContainer.scrollIntoView({ behavior: 'smooth' });

  } catch (e) {
    console.error('Edit product error:', e);
    alert('Error preparing edit: ' + e.message);
  }
}

// Ensure cancel button resets state
document.getElementById('cancel-add-product').addEventListener('click', () => {
  currentProductId = null;
  document.querySelector('#add-product-form-container h4').textContent = 'Add New Product';
  document.querySelector('#add-product-form button[type="submit"]').textContent = 'Save Product';
  document.getElementById('image-preview-container').style.display = 'none';
});

window.editProduct = editProduct;


async function deleteProduct(productId, productName) {
  if (!confirm(`Are you sure you want to remove "${productName}"?`)) {
    return;
  }

  try {
    const result = await del(`/shop/products/${productId}`);
    alert(result.message || 'Product removed successfully!');
    loadProductsData();
  } catch (e) {
    console.error('Delete product error:', e);
    alert('Failed to remove product: ' + (e.message || 'Unknown error'));
  }
}

// Expose deleteProduct to window for onclick handlers
window.deleteProduct = deleteProduct;

// ===============================
// FEEDBACK LOGIC
// ===============================
async function loadFeedbackData() {
  const list = document.getElementById('feedback-list');
  if (!list) return;

  list.innerHTML = renderLoader();

  try {
    const orders = await fetchVendorOrders();
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

// Expose to window
window.updateProfile = updateProfile;

// ===============================
// CHART LOGIC
// ===============================
function renderPerformanceChart(orders) {
  const chartContainer = document.getElementById('chart-vendor-performance');
  if (!chartContainer) return;

  // Calculate Stats
  let delivered = 0;
  let rejected = 0;
  let delayed = 0;
  let pending = 0;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  orders.forEach(order => {
    if (order.status === 'Delivered') {
      delivered++;
    } else if (order.status === 'Delayed Delivery') {
      delayed++; // Count delayed deliveries separately
    } else if (order.status === 'Rejected') {
      rejected++;
    } else {
      // Check for delay (order not yet delivered but past expected date)
      let isDelayed = false;
      if (order.expectedDeliveryDate) {
        const deliveryDate = new Date(order.expectedDeliveryDate);
        if (deliveryDate < today) {
          isDelayed = true;
        }
      }

      if (isDelayed) {
        delayed++;
      } else {
        pending++; // Includes Pending, Accepted, Packed, On Board (if not delayed)
      }
    }
  });

  const total = delivered + rejected + delayed + pending;

  if (total === 0) {
    chartContainer.innerHTML = '<p style="text-align:center; padding: 2rem; color: #666;">No data available for chart.</p>';
    return;
  }

  // Calculate percentages and angles
  const data = [
    { label: 'Delivered', value: delivered, color: '#28a745' }, // Green
    { label: 'Rejected', value: rejected, color: '#dc3545' },   // Red
    { label: 'Delayed Delivery', value: delayed, color: '#8B0000' },     // Dark Red
    { label: 'In Progress/Packed/On Board', value: pending, color: '#ffc107' }  // Yellow
  ].filter(d => d.value > 0);

  let cumulativePercent = 0;

  const svgContent = data.map(slice => {
    const startPercent = cumulativePercent;
    const slicePercent = slice.value / total;
    cumulativePercent += slicePercent;
    const endPercent = cumulativePercent;

    // Calculate coordinates
    const x1 = Math.cos(2 * Math.PI * startPercent);
    const y1 = Math.sin(2 * Math.PI * startPercent);
    const x2 = Math.cos(2 * Math.PI * endPercent);
    const y2 = Math.sin(2 * Math.PI * endPercent);

    // Determine if the slice is more than 50%
    const largeArcFlag = slicePercent > 0.5 ? 1 : 0;

    // SVG Path command
    const pathData = `M 0 0 L ${x1} ${y1} A 1 1 0 ${largeArcFlag} 1 ${x2} ${y2} Z`;

    return `<path d="${pathData}" fill="${slice.color}" stroke="white" stroke-width="0.02"></path>`;
  }).join('');

  // Legend with percentages
  const legendHtml = data.map(slice => {
    const percentage = ((slice.value / total) * 100).toFixed(1);
    return `
    <div style="display: flex; align-items: center; gap: 5px; font-size: 0.9rem;">
      <span style="width: 12px; height: 12px; background: ${slice.color}; display: inline-block; border-radius: 2px;"></span>
      <span>${slice.label}: ${slice.value} (${percentage}%)</span>
    </div>
  `;
  }).join('');

  // Calculate delivery efficiency (On-time vs Delayed)
  const totalDelivered = delivered + delayed; // All completed deliveries
  const efficiencyRate = totalDelivered > 0 ? ((delivered / totalDelivered) * 100).toFixed(1) : 0;
  const delayRate = totalDelivered > 0 ? ((delayed / totalDelivered) * 100).toFixed(1) : 0;

  // Efficiency status color and message
  let efficiencyColor, efficiencyStatus;
  if (efficiencyRate >= 90) {
    efficiencyColor = '#28a745'; // Green
    efficiencyStatus = 'Excellent';
  } else if (efficiencyRate >= 75) {
    efficiencyColor = '#17a2b8'; // Blue
    efficiencyStatus = 'Good';
  } else if (efficiencyRate >= 50) {
    efficiencyColor = '#ffc107'; // Yellow
    efficiencyStatus = 'Needs Improvement';
  } else {
    efficiencyColor = '#dc3545'; // Red
    efficiencyStatus = 'Critical';
  }

  // Efficiency section HTML
  const efficiencyHtml = totalDelivered > 0 ? `
    <div style="width: 100%; margin-top: 1rem; padding: 1rem; background: #f8f9fa; border-radius: 8px;">
      <h4 style="margin: 0 0 0.75rem 0; color: #333; font-size: 1rem; text-align: center;">Delivery Efficiency</h4>
      <div style="display: flex; justify-content: center; gap: 2rem; flex-wrap: wrap;">
        <div style="text-align: center;">
          <div style="font-size: 2rem; font-weight: bold; color: #28a745;">${efficiencyRate}%</div>
          <div style="font-size: 0.85rem; color: #666;">On-Time Delivery</div>
          <div style="font-size: 0.75rem; color: #999;">(${delivered} orders)</div>
        </div>
        <div style="text-align: center;">
          <div style="font-size: 2rem; font-weight: bold; color: #8B0000;">${delayRate}%</div>
          <div style="font-size: 0.85rem; color: #666;">Delayed Delivery</div>
          <div style="font-size: 0.75rem; color: #999;">(${delayed} orders)</div>
        </div>
      </div>
      <div style="text-align: center; margin-top: 1rem;">
        <span style="padding: 0.5rem 1rem; background: ${efficiencyColor}; color: white; border-radius: 20px; font-size: 0.9rem; font-weight: 500;">
          Efficiency Status: ${efficiencyStatus}
        </span>
      </div>
    </div>
  ` : '';

  chartContainer.innerHTML = `
    <div style="display: flex; flex-direction: column; align-items: center; gap: 1rem; border: 1px solid #ddd; padding: 1.5rem; border-radius: 8px; background: #fff; box-shadow: 0 2px 4px rgba(0,0,0,0.05);">
      <h3 style="margin: 0 0 0.5rem 0; color: #333; font-size: 1.1rem;">Order Status Distribution</h3>
      <svg viewBox="-1 -1 2 2" style="transform: rotate(-90deg); width: 360px; height: 360px;">
        ${svgContent}
      </svg>
      <div style="display: flex; gap: 1rem; flex-wrap: wrap; justify-content: center;">
        ${legendHtml}
      </div>
      ${efficiencyHtml}
    </div>
  `;
}

if (typeof document !== 'undefined' && document.readyState !== 'loading') {
  initVendorDashboard();
}
