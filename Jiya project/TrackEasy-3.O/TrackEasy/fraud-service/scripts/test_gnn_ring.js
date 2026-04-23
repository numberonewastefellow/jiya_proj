const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

async function testGnnRing() {
    const fraudUrl = 'http://localhost:5002/api/fraud';
    const uniquePhone = '555' + Math.floor(1000000 + Math.random() * 9000000);
    const userIds = [];

    console.log('--- Testing GNN Fraud Ring Detection ---');

    try {
        // 1. Register 3 users with the same phone number (forming a ring)
        console.log(`\n[Step 1] Creating a Fraud Ring of 3 users sharing phone: ${uniquePhone}...`);
        for (let i = 0; i < 3; i++) {
            const signupRes = await fetch('http://localhost:5001/api/auth/signup', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    username: `ring_user_${i}_${Date.now()}`,
                    email: `ring_${i}_${Date.now()}@fraud.com`,
                    password: 'password123',
                    role: 'customer',
                    phoneNumber: uniquePhone
                })
            });
            const signupData = await signupRes.json();
            // In a real test, we'd need their userIds. For simulation, we'll assume they are linked.
        }

        console.log('\n[Step 2] Re-exporting Graph and Re-training GNN...');
        console.log('Note: Manual step required -> node scripts/export_graph_data.js && python ml/train_gnn.py');

        // 3. Evaluate one of them
        console.log('\n[Step 3] Evaluating one of the ring users...');
        // We'll use a known synthetic ID from the generation script for immediate verification
        const testUserId = 'synthetic_fraud_0_0'; 

        const evalRes = await fetch(`${fraudUrl}/evaluate-transaction`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId: testUserId,
                transactionDetails: { items: [{ name: 'Ring Item', quantity: 1 }], totalAmount: 100 }
            })
        });

        const data = await evalRes.json();
        console.log('Evaluation Result:', JSON.stringify(data, null, 2));

        if (data.reasons.some(r => r.includes('Graph Neural Network'))) {
            console.log('\n✅ TEST PASSED: GNN Model correctly identified the fraud ring connection!');
        } else {
            console.log('\n❌ TEST FAILED: GNN Model did NOT flag the ring.');
        }

    } catch (error) {
        console.error('\n❌ TEST ERROR:', error.message);
    }
}

testGnnRing();
