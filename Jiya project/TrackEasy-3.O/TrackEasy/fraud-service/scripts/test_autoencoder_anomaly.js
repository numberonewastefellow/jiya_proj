async function testAutoencoder() {
    const userId = '660f6b4d3269894e68e7d9b1'; // Sample User ID
    const fraudUrl = 'http://localhost:5002/api/fraud';
    
    console.log('--- Testing Autoencoder Anomaly Detection ---');

    try {
        // 1. Evaluate a "Normal" transaction
        console.log('\n[Case 1] Evaluating a NORMAL transaction ($500, 2 items)...');
        const normalRes = await fetch(`${fraudUrl}/evaluate-transaction`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId,
                transactionDetails: { totalSum: 500, items: [{}, {}] }
            })
        });
        const normalData = await normalRes.json();
        console.log('Result:', JSON.stringify(normalData, null, 2));

        // 2. Evaluate an "Abnormal" transaction
        console.log('\n[Case 2] Evaluating an ANOMALY transaction ($500,000, 500 items)...');
        const anomalyRes = await fetch(`${fraudUrl}/evaluate-transaction`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId,
                transactionDetails: { totalSum: 500000, items: new Array(500).fill({}) }
            })
        });
        const anomalyData = await anomalyRes.json();
        console.log('Result:', JSON.stringify(anomalyData, null, 2));

        if (anomalyData.reasons.some(r => r.includes('Unsupervised anomaly'))) {
            console.log('\n✅ TEST PASSED: Autoencoder correctly identified the outlier!');
        } else {
            console.log('\n❌ TEST FAILED: Autoencoder did NOT flag the outlier.');
            console.log('Note: Ensure you have run "node scripts/export_transaction_data.js" and "python ml/train_autoencoder.py" first.');
        }
    } catch (error) {
        console.error('\n❌ TEST ERROR:', error.message);
    }
}

testAutoencoder();
