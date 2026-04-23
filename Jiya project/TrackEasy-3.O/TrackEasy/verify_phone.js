async function testUniqueness() {
    const baseUrl = 'http://localhost:5001/api/auth';
    const uniqueId = Date.now();
    const randomPhone = Math.floor(1000000000 + Math.random() * 9000000000).toString();
    
    const user1 = {
        username: `user1_${uniqueId}`,
        email: `user1_${uniqueId}@test.com`,
        password: 'password123',
        role: 'customer',
        phoneNumber: randomPhone
    };

    const user2 = {
        username: `user2_${uniqueId}`,
        email: `user2_${uniqueId}@test.com`,
        password: 'password123',
        role: 'customer',
        phoneNumber: randomPhone // Same random phone number
    };

    try {
        console.log(`--- Step 1: Registering User 1 with ${randomPhone} ---`);
        const res1 = await fetch(`${baseUrl}/signup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(user1)
        });
        const data1 = await res1.json();
        console.log('User 1 Response:', data1);

        if (!data1.success) {
            console.log('User 1 registration failed unexpectedly.');
            return;
        }

        console.log('\n--- Step 2: Attempting to Register User 2 with same phone ---');
        const res2 = await fetch(`${baseUrl}/signup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(user2)
        });
        const data2 = await res2.json();
        console.log('User 2 Response (Expected Error):', data2);

        if (data2.message === 'This phone number is already registered') {
            console.log('\n✅ TEST PASSED: Unique phone number constraint is working!');
        } else {
            console.log('\n❌ TEST FAILED: Unexpected response:', data2);
        }
    } catch (error) {
        console.error('Test failed due to network error:', error.message);
    }
}

testUniqueness();
