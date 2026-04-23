const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const User = require('../../server/models/User');
const EventLog = require('../../server/models/EventLog');

const OUTPUT_NODES = path.join(__dirname, '../ml/graph_nodes.csv');
const OUTPUT_EDGES = path.join(__dirname, '../ml/graph_edges.csv');

async function exportGraph() {
    try {
        console.log('🚀 Connecting to MongoDB...');
        await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/trackeasy');

        let users = [];
        let logs = [];
        try {
            users = await User.find({ role: 'customer' });
            logs = await EventLog.find({ ipAddress: { $ne: null } });
        } catch (dbErr) {
            console.warn('⚠️ Could not fetch from DB, using synthetic data only.');
        }

        const nodeData = [];
        const edgeData = [];
        const edgeSet = new Set();

        // 1. Prepare Nodes
        users.forEach(user => {
            nodeData.push({
                id: user._id.toString(),
                isBlocked: user.isBlocked ? 1 : 0,
                // Simple feature vector for GNN
                feature1: user.role === 'customer' ? 1 : 0,
                feature2: user.phoneNumber ? 1 : 0
            });
        });

        // 2. Prepare Edges (Same Phone/Address)
        for (let i = 0; i < users.length; i++) {
            for (let j = i + 1; j < users.length; j++) {
                const u1 = users[i];
                const u2 = users[j];
                if ((u1.phoneNumber && u1.phoneNumber === u2.phoneNumber) || 
                    (u1.address && u1.address === u2.address)) {
                    edgeData.push({ source: u1._id.toString(), target: u2._id.toString(), type: 'static' });
                }
            }
        }

        // 3. Prepare Edges (Same IP)
        const ipMap = {};
        logs.forEach(log => {
            if (!log.userId) return;
            const uid = log.userId.toString();
            if (!ipMap[log.ipAddress]) ipMap[log.ipAddress] = new Set();
            ipMap[log.ipAddress].add(uid);
        });

        Object.keys(ipMap).forEach(ip => {
            const userIds = Array.from(ipMap[ip]);
            if (userIds.length > 1) {
                for (let i = 0; i < userIds.length; i++) {
                    for (let j = i + 1; j < userIds.length; j++) {
                        edgeData.push({ source: userIds[i], target: userIds[j], type: 'ip' });
                    }
                }
            }
        });

        // 4. GENERATE SYNTHETIC FRAUD RING (For Training)
        console.log('🛡️ Generating synthetic fraud rings for training...');
        for (let r = 0; r < 5; r++) { // 5 rings
            const ringUsers = [];
            for (let u = 0; u < 8; u++) { // 8 users per ring
                const id = `synthetic_fraud_${r}_${u}`;
                ringUsers.push(id);
                nodeData.push({ id, isBlocked: 1, feature1: 1, feature2: 1 });
            }
            // Connect everyone in the ring
            for (let i = 0; i < ringUsers.length; i++) {
                for (let j = i + 1; j < ringUsers.length; j++) {
                    edgeData.push({ source: ringUsers[i], target: ringUsers[j], type: 'synthetic' });
                }
            }
        }

        // 5. Save to CSV
        const nodeCSV = 'id,isBlocked,f1,f2\n' + nodeData.map(n => `${n.id},${n.isBlocked},${n.feature1},${n.feature2}`).join('\n');
        const edgeCSV = 'source,target,type\n' + edgeData.map(e => `${e.source},${e.target},${e.type}`).join('\n');

        fs.writeFileSync(OUTPUT_NODES, nodeCSV);
        fs.writeFileSync(OUTPUT_EDGES, edgeCSV);

        console.log(`✅ Nodes exported to ${OUTPUT_NODES}`);
        console.log(`✅ Edges exported to ${OUTPUT_EDGES}`);
        
        await mongoose.disconnect();
    } catch (err) {
        console.error('❌ Export failed, but generated synthetic data:', err.message);
    }
}

exportGraph();
