export function renderLoader() {
  return `<div class="loader" style="padding:1rem;text-align:center">Loading…</div>`;
}

export function createCard(title, value) {
  const el = document.createElement('div');
  el.className = 'card';
  el.style.padding = '1rem';
  el.style.background = '#fff';
  el.style.borderRadius = '6px';
  el.style.boxShadow = '0 1px 3px rgba(0,0,0,0.06)';
  el.innerHTML = `<div class="card-title" style="font-weight:600">${title}</div><div class="card-value" style="font-size:1.4rem">${value}</div>`;
  return el;
}

export function createTableRow(order, withActions = false, onStatusChange = null) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td>${order.id}</td>
    <td>${order.customer || '-'}</td>
    <td>${order.status || '-'}</td>
    <td>${order.date || '-'}</td>
    <td>${order.amount || '-'}</td>
    <td>${order.delivery || '-'}</td>
    <td></td>
  `;

  if (withActions && onStatusChange) {
    const actionsTd = tr.children[6];
    const select = document.createElement('select');
    const statuses = ['Packed', 'On Board', 'Delivered'];

    statuses.forEach(s => {
      const option = document.createElement('option');
      option.value = s;
      option.textContent = s;
      if (order.status === s) option.selected = true;
      select.appendChild(option);
    });

    select.addEventListener('change', async (e) => {
      const newStatus = e.target.value;
      select.disabled = true;
      try {
        await onStatusChange(order.id, newStatus);
      } catch (err) {
        alert('Failed to update status');
        select.value = order.status; // Revert
      } finally {
        select.disabled = false;
      }
    });

    actionsTd.appendChild(select);
  }

  return tr;
}
