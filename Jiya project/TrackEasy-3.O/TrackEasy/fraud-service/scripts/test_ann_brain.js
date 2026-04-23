async function testMasterBrain() {
    const userId = 'synthetic_fraud_0_0'; // This user is already linked in the GNN ring
    const fraudUrl = 'http://localhost:5002/api/fraud';
    
    console.log('--- Testing ANN Master Brain Ensemble ---');

    try {
        // 1. Log suspicious behavior (trigger LSTM)
        console.log('\n[Step 1] Triggering LSTM: Logging rapid suspicious events...');
        for(let i=0; i<8; i++) {
            await fetch(`${fraudUrl}/log-event`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId, eventType: 'payment_failed', ipAddress: '127.0.0.1' })
            });
        }

        // 2. Evaluate (trigger GNN + LSTM + Autoencoder)
        console.log('\n[Step 2] Evaluating Transaction (Triggering GNN + LSTM + Autoencoder)...');
        const evalRes = await fetch(`${fraudUrl}/evaluate-transaction`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId,
                transactionDetails: { totalSum: 15000, items: new Array(15).fill({}) } // Anomalous amount/size
            })
        });

        const data = await evalRes.json();
        console.log('Final Result:', JSON.stringify(data, null, 2));

        if (data.reasons.some(r => r.includes('ANN Master Brain'))) {
            console.log('\n✅ TEST PASSED: Master Brain correctly ensembled all signals!');
        } else {
            console.log('\n❌ TEST FAILED: Master Brain did not reach the threshold.');
            console.log('Note: Ensure you have run:')
            console.log('1. node scripts/export_ann_features.js');
            console.log('2. python ml/train_ann.py');
        }
    } catch (error) {
        console.error('\n❌ TEST ERROR:', error.message);
    }
}

testMasterBrain();
