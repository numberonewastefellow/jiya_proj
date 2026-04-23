const mongoose = require('mongoose');

async function seedTest() {
    console.log('🌱 Seeding Fraud Test Data...');
    
    // Connect to your DB
    const MONGODB_URI = 'mongodb://127.0.0.1:27017/Tracker';
    await mongoose.connect(MONGODB_URI);
    
    const User = require('./models/User');
    const EventLog = require('./models/EventLog');

    // 1. Create two users sharing the same phone (Fraud Ring)
    console.log('1. Creating Users for Fraud Ring...');
    const user1 = await User.findOneAndUpdate(
        { email: 'fraud1@test.com' },
        { username: 'FraudUser_Alpha', phoneNumber: '9876543210', address: '123 Fraud St', role: 'customer' },
        { upsert: true, new: true }
    );
    const user2 = await User.findOneAndUpdate(
        { email: 'fraud2@test.com' },
        { username: 'FraudUser_Beta', phoneNumber: '9876543210', address: '456 Fake Ave', role: 'customer' },
        { upsert: true, new: true }
    );

    // 2. Trigger a "Superman" Check for FraudUser_Alpha
    console.log('2. Triggering Superman Check for Alpha...');
    
    // Log initial login in Mumbai (1 hour ago)
    const pastDate = new Date();
    pastDate.setMinutes(pastDate.getMinutes() - 10);
    
    await EventLog.create({
        userId: user1._id,
        eventType: 'login',
        ipAddress: '::1', // Mumbai Mock
        location: { lat: 19.0760, lon: 72.8777, city: 'Mumbai', country: 'IN' },
        timestamp: pastDate
    });

    console.log('✅ Mock data seeded!');
    console.log('\n--- NEXT STEPS ---');
    console.log('1. Go to http://localhost:5001/fraud-dashboard.html');
    console.log('2. Look at the Graph: You will see Alpha and Beta linked by their Phone Number.');
    console.log('3. Log in as fraud1@test.com (Password: check your DB or use your registration password).');
    console.log('4. Try to place an order. It will be BLOCKED because the last login was Mumbai but your current IP will resolve elsewhere (or just the speed check will trigger).');

    process.exit(0);
}

seedTest().catch(err => {
    console.error(err);
    process.exit(1);
});
