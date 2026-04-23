const mongoose = require('mongoose');
const User = require('./models/User');
const Product = require('./models/Product');
const Order = require('./models/Order');
require('dotenv').config();

const checkData = async () => {
    try {
        await mongoose.connect(process.env.MONGODB_URI);

        const userCount = await User.countDocuments();
        const productCount = await Product.countDocuments();
        const orderCount = await Order.countDocuments();

        console.log('--- Data Status ---');
        console.log(`Users: ${userCount}`);
        console.log(`Products: ${productCount}`);
        console.log(`Orders: ${orderCount}`);
        console.log('-------------------');

        if (userCount === 0 && productCount === 0 && orderCount === 0) {
            console.log('Result: No data present.');
        } else {
            console.log('Result: Data exists in the application.');
        }

    } catch (error) {
        console.error('Error checking data:', error);
    } finally {
        await mongoose.disconnect();
    }
};

checkData();
