const mongoose = require('mongoose');
const User = require('./models/User');
const Product = require('./models/Product');
require('dotenv').config();

const verifyUpdate = async () => {
    try {
        await mongoose.connect(process.env.MONGODB_URI);

        // Check Vendor
        const vendor = await User.findOne({ username: 'vendor1' });
        if (!vendor) {
            console.log('❌ Vendor1 NOT found.');
            return;
        }

        if (vendor.email === 'vendor@gmail.com') {
            console.log('✅ Vendor email updated to vendor@gmail.com');
        } else {
            console.log(`❌ Vendor email mismatch: ${vendor.email}`);
        }

        // Check Products Link
        const products = await Product.find({ vendor: vendor._id });
        console.log(`✅ Found ${products.length} products linked to vendor1.`);

        if (products.length === 6) {
            console.log('✅ All products still correctly linked.');
        } else {
            console.log('❌ Product count mismatch.');
        }

    } catch (error) {
        console.error('Error verifying:', error);
    } finally {
        await mongoose.disconnect();
    }
};

verifyUpdate();
