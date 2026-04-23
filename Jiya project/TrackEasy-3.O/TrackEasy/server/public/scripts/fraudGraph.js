let cy;

document.addEventListener('DOMContentLoaded', () => {
    loadGraph();
});

async function loadGraph() {
    try {
        const res = await fetch('http://localhost:5002/api/fraud/graph-data');
        const elements = await res.json();

        cy = cytoscape({
            container: document.getElementById('cy'),
            elements: elements,
            style: [
                {
                    selector: 'node',
                    style: {
                        'label': 'data(label)',
                        'background-color': (ele) => ele.data('isBlocked') ? '#d9534f' : '#3498db',
                        'color': '#333',
                        'font-size': '12px',
                        'text-valign': 'bottom',
                        'text-halign': 'center',
                        'width': '30px',
                        'height': '30px',
                        'border-width': 2,
                        'border-color': '#fff',
                        'text-margin-y': 5
                    }
                },
                {
                    selector: 'edge',
                    style: {
                        'width': 2,
                        'line-color': '#ccc',
                        'label': 'data(label)',
                        'font-size': '10px',
                        'color': '#666',
                        'curve-style': 'bezier',
                        'target-arrow-shape': 'triangle',
                        'target-arrow-color': '#ccc',
                        'text-rotation': 'autorotate',
                        'text-margin-y': -10
                    }
                },
                {
                    selector: ':selected',
                    style: {
                        'background-color': '#f1c40f',
                        'line-color': '#f1c40f',
                        'target-arrow-color': '#f1c40f',
                        'border-color': '#f39c12',
                        'border-width': 3
                    }
                }
            ],
            layout: {
                name: 'cose',
                animate: true,
                padding: 50,
                nodeRepulsion: 4000,
                idealEdgeLength: 100
            }
        });

        cy.on('tap', 'node', (evt) => {
            const node = evt.target;
            const data = node.data();
            document.getElementById('graph-details').innerHTML = `
                <div style="display:flex; align-items:center; gap:10px;">
                    <div style="background:${data.isBlocked ? '#d9534f' : '#3498db'}; width:12px; height:12px; border-radius:50%;"></div>
                    <strong>User:</strong> ${data.label} (${data.id})
                </div>
                <strong>Status:</strong> ${data.isBlocked ? '<span style="color:#d9534f">Blocked</span>' : '<span style="color:#5cb85c">Active</span>'}<br>
                <button class="action-btn" onclick="highlightCluster('${data.id}')" style="margin-top:8px; font-size:11px; background:#2c3e50;">Inspect Neighbors</button>
            `;
            document.getElementById('block-cluster-btn').style.display = 'none';
        });

        cy.on('tap', 'edge', (evt) => {
            const edge = evt.target;
            document.getElementById('graph-details').innerHTML = `
                <div style="color:#666; font-size:0.9rem;">
                    <strong>Relationship:</strong> Shared <span style="color:#2c3e50; font-weight:bold;">${edge.data('label')}</span><br>
                    <strong>Connected:</strong> ${edge.source().data('label')} ↔ ${edge.target().data('label')}
                </div>
            `;
        });

    } catch (error) {
        console.error('Failed to load graph:', error);
        document.getElementById('cy').innerHTML = '<div style="padding:20px; color:red;">Failed to connect to Fraud Service (Port 5002)</div>';
    }
}

window.loadGraph = loadGraph;

window.highlightCluster = (nodeId) => {
    const node = cy.getElementById(nodeId);
    // Get the connected component (entire fraud ring)
    const collection = node.predecessors().union(node.successors()).union(node);
    
    cy.elements().unselect();
    collection.select();
    
    // Zoom to fit the ring
    cy.animate({
        fit: {
            eles: collection,
            padding: 50
        }
    }, { duration: 500 });

    const userIds = collection.nodes().map(n => n.id());
    const unblockedIds = collection.nodes().filter(n => !n.data('isBlocked')).map(n => n.id());

    document.getElementById('graph-details').innerHTML += `
        <div style="margin-top:10px; padding:12px; background:#fffbe6; border:1px solid #ffe58f; border-radius:4px; font-size:0.9rem;">
            🕸️ <strong>Fraud Ring Identified:</strong><br>
            - ${userIds.length} connected accounts found.<br>
            - ${unblockedIds.length} accounts are currently active.
        </div>
    `;
    
    if (unblockedIds.length > 0) {
        document.getElementById('block-cluster-btn').style.display = 'inline-block';
        window.selectedClusterIds = unblockedIds;
    } else {
        document.getElementById('block-cluster-btn').style.display = 'none';
    }
};

window.blockSelectedCluster = async () => {
    if (!window.selectedClusterIds || window.selectedClusterIds.length === 0) return;
    
    const count = window.selectedClusterIds.length;
    if (!confirm(`🚨 MASS BLOCK ALERT: Are you SURE you want to block all ${count} accounts in this fraud ring?`)) return;
    
    try {
        const res = await fetch('http://localhost:5002/api/fraud/bulk-block', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userIds: window.selectedClusterIds })
        });
        
        if (res.ok) {
            alert(`Success: ${count} accounts in the fraud ring have been locked down.`);
            loadGraph();
            if (window.fetchAlerts) fetchAlerts();
            document.getElementById('block-cluster-btn').style.display = 'none';
            document.getElementById('graph-details').innerHTML = '<i>Cluster blocked. Refreshing graph...</i>';
        }
    } catch (e) {
        console.error('Bulk block error:', e);
        alert('Failed to execute mass block.');
    }
};
