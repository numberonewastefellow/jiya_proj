const mongoose = require('mongoose');
const User = require('./models/User');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const updateVendor = async () => {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('✅ Connected to MongoDB');

        // 1. Find vendor1
        const vendor = await User.findOne({ username: 'vendor1' });

        if (!vendor) {
            console.log('❌ Vendor1 user not found! Please run add_products.js first.');
            return;
        }

        // 2. Check for email conflict (unless it's the same user)
        const emailUser = await User.findOne({ email: 'vendor@gmail.com' });
        if (emailUser && emailUser._id.toString() !== vendor._id.toString()) {
            console.log('⚠️  User with email vendor@gmail.com already exists. Deleting conflict...');
            await User.deleteOne({ _id: emailUser._id });
        }

        // 3. Update Credentials
        const hashedPassword = await bcrypt.hash('123456', 10);
        vendor.email = 'vendor@gmail.com';
        vendor.password = hashedPassword;

        await vendor.save();
        console.log('✅ Vendor1 credentials updated successfully.');
        console.log('   Email: vendor@gmail.com');
        console.log('   Password: [UPDATED]');

    } catch (err) {
        console.error('❌ Error updating vendor:', err);
    } finally {
        await mongoose.disconnect();
        console.log('🔌 Disconnected from MongoDB');
    }
};

updateVendor();
