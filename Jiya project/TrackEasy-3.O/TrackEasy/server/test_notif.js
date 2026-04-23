const mongoose = require('mongoose');
const User = require('./models/User');

async function test() {
    await mongoose.connect('mongodb://localhost:27017/Tracker');
    
    // Create a user if not exists
    let user = await User.findOne({ email: 'notiftest@test.com' });
    if (!user) {
        user = new User({
            username: 'NotificationTester',
            email: 'notiftest@test.com',
            password: 'password123',
            role: 'customer'
        });
        await user.save();
    }
    
    // Unblock first to ensure we can "re-block" and trigger the notification
    user.isBlocked = false;
    await user.save();
    
    console.log('User created/reset.');
    
    // Wait a bit, then block
    setTimeout(async () => {
        console.log('Blocking user now...');
        user.isBlocked = true;
        user.blockReason = 'Automated Fraud Detection - Impossible Travel Speed';
        await user.save();
        console.log('User blocked.');
        process.exit(0);
    }, 5000); 
}

test().catch(err => {
    console.error(err);
    process.exit(1);
});
