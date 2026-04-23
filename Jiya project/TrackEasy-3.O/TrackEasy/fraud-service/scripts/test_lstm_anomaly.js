const axios = require('axios');

async function testDeepAnomaly() {
    const userId = '660f6b4d3269894e68e7d9b1'; // Sample User ID
    const fraudUrl = 'http://localhost:5002/api/fraud';
    
    console.log('--- Testing Deep Learning Behavioral Anomaly ---');

    try {
        // 1. Log a burst of suspicious events (10 failed payments)
        console.log('\n[Step 1] Simulating a BOT: Logging 10 rapid payment failures...');
        for(let i=0; i<10; i++) {
            await fetch(`${fraudUrl}/log-event`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    userId,
                    eventType: 'payment_failed',
                    ipAddress: '127.0.0.1'
                })
            });
        }

        // 2. Evaluate with the Deep Learning model
        console.log('\n[Step 2] Evaluating transaction risk...');
        const evalRes = await fetch(`${fraudUrl}/evaluate-transaction`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId,
                transactionDetails: { items: [{ name: 'Suspicious Item', quantity: 1 }], totalAmount: 500 }
            })
        });

        const data = await evalRes.json();
        console.log('Evaluation Result:', JSON.stringify(data, null, 2));

        if (data.reasons.some(r => r.includes('Deep Learning'))) {
            console.log('\n✅ TEST PASSED: LSTM Model correctly identified the behavioral anomaly!');
        } else {
            console.log('\n❌ TEST FAILED: LSTM Model did NOT flag the sequence.');
            console.log('Note: Ensure you have run "node scripts/generate_behavior_data.js" and "python ml/train_lstm.py" first.');
        }
    } catch (error) {
        console.error('\n❌ TEST ERROR:', error.message);
    }
}

testDeepAnomaly();
