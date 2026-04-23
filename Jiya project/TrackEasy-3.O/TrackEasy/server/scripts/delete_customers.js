const mongoose = require('mongoose');
const User = require('../models/User');
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

async function clearCustomers() {
    try {
        console.log('Connecting to MongoDB...');
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('Connected.');

        const result = await User.deleteMany({ role: 'customer' });
        console.log(`Successfully deleted ${result.deletedCount} customer accounts from the database.`);
    } catch (error) {
        console.error('Error deleting customers:', error);
    } finally {
        await mongoose.disconnect();
        console.log('Disconnected.');
    }
}

clearCustomers();
