const userId = '660f6b4d3269894e68e7d9b1'; // Sample User ID

async function runTest() {
    try {
        console.log('--- Testing Geospatial Anomaly ("Superman" Check) ---');

        // 1. Log a baseline event (Mumbai Mock - localhost)
        const logUrl = 'http://localhost:5002/api/fraud/log-event';
        console.log(`\n[Step 1] Logging initial event from Mumbai to ${logUrl}...`);
        
        const logResRaw = await fetch(logUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId: userId,
                eventType: 'login',
                ipAddress: '::1' // Resolves to Mumbai (Mock)
            })
        });
        
        if (!logResRaw.ok) {
            throw new Error(`HTTP error! status: ${logResRaw.status}`);
        }
        
        const logRes = await logResRaw.json();
        console.log('Result:', logRes);

        // 2. Evaluate a transaction from New York (161.185.160.93)
        const evalUrl = 'http://localhost:5002/api/fraud/evaluate-transaction';
        console.log(`\n[Step 2] Evaluating transaction from New York (1 minute later) to ${evalUrl}...`);
        
        const evalResRaw = await fetch(evalUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId: userId,
                ipAddress: '161.185.160.93', // New York IP
                transactionDetails: { items: [{ name: 'Test Product', quantity: 1 }], totalAmount: 100 }
            })
        });
        
        if (!evalResRaw.ok) {
            throw new Error(`HTTP error! status: ${evalResRaw.status}`);
        }

        const evalData = await evalResRaw.json();
        console.log('Result:', JSON.stringify(evalData, null, 2));

        if (evalData.action === 'requires_otp' && evalData.reasons.some(r => r.includes('Geospatial Anomaly'))) {
            console.log('\n✅ TEST PASSED: Superman anomaly correctly detected!');
        } else {
            console.log('\n❌ TEST FAILED: Superman anomaly NOT detected.');
        }
    } catch (error) {
        console.error('\n❌ TEST ERROR:', error);
        process.exit(1);
    }
}

runTest();
