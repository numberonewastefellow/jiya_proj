const mongoose = require('mongoose');
const Order = require('./models/Order');
const User = require('./models/User');
require('dotenv').config();

async function checkOrders() {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('Connected to MongoDB');

        const orderCount = await Order.countDocuments();
        console.log(`Total Orders in DB: ${orderCount}`);

        if (orderCount > 0) {
            const orders = await Order.find({}).populate('customer');
            console.log('First Order Sample:', JSON.stringify(orders[0], null, 2));
        } else {
            console.log('No orders found in the database.');
        }

        const adminUser = await User.findOne({ email: 'admin@example.com' });
        if (adminUser) {
            console.log('Admin user exists:', adminUser.email, adminUser.role);
        } else {
            console.log('Admin user NOT found.');
        }

    } catch (error) {
        console.error('Error:', error);
    } finally {
        await mongoose.disconnect();
    }
}

checkOrders();
