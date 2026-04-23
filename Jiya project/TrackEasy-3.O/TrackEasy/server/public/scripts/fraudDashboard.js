document.addEventListener('DOMContentLoaded', async () => {
    await fetchAlerts();
});

async function fetchAlerts() {
    const tbody = document.getElementById('alerts-tbody');
    try {
        const res = await fetch('http://localhost:5002/api/fraud/alerts');
        if (!res.ok) throw new Error('Failed to fetch to 5002');
        
        const alerts = await res.json();
        
        if (alerts.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding: 2rem; color: #888;">No fraudulent activity detected 🎉</td></tr>';
            return;
        }

        tbody.innerHTML = alerts.map(alert => {
            // Determine styling
            let scoreClass = 'score-low';
            if (alert.riskScore > 6) scoreClass = 'score-high';
            else if (alert.riskScore > 3) scoreClass = 'score-med';

            let badgeClass = 'badge-pending';
            if (alert.status === 'Resolved' || alert.status === 'Reviewed') badgeClass = 'badge-reviewed';
            if (alert.status === 'Blocked') badgeClass = 'badge-blocked';

            return `
                <tr>
                    <td>${new Date(alert.createdAt).toLocaleString()}</td>
                    <td><strong style="color:#555">${alert.userId?.username || alert.userId || 'Unknown'}</strong></td>
                    <td class="${scoreClass}">${alert.riskScore}</td>
                    <td>${alert.violationReason}</td>
                    <td><span class="${badgeClass}">${alert.status}</span></td>
                    <td>
                        <button onclick="allowUser('${alert._id}')" class="action-btn" style="background:#5cb85c; margin-right:5px;">Allow (Resolve)</button>
                        <button onclick="blockUser('${alert._id}')" class="action-btn" style="background:#d9534f;">Block User</button>
                    </td>
                </tr>
            `;
        }).join('');

    } catch (e) {
        console.error('Failed to fetch alerts', e);
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding: 2rem; color: #d9534f;"><strong>Error Connectting:</strong> The Fraud Service on port 5002 is unreachable. Make sure node fraudServer.js is running!</td></tr>';
    }
}

window.fetchAlerts = fetchAlerts;

window.blockUser = async (alertId) => {
    if (!confirm('Are you sure you want to BLOCK this user? They will not be able to log in anymore.')) return;
    try {
        const res = await fetch(`http://localhost:5002/api/fraud/alerts/${alertId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'Blocked', blockUser: true })
        });
        if (res.ok) {
            alert('User Blocked Successfully. They can no longer log in.');
            await fetchAlerts();
        } else {
            alert('Failed to block user');
        }
    } catch (e) { console.error(e); }
};

window.allowUser = async (alertId) => {
    if (!confirm('Resolve this alert and allow this user?')) return;
    try {
        const res = await fetch(`http://localhost:5002/api/fraud/alerts/${alertId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'Resolved', blockUser: false })
        });
        if (res.ok) {
            alert('Alert Resolved Successfully');
            await fetchAlerts();
        } else {
            alert('Failed to resolve alert');
        }
    } catch (e) { console.error(e); }
};
