const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
require('dotenv').config();

const MONGO_URI = "mongodb://localhost:27017/Tracker";

async function recoverAdmin() {
    try {
        await mongoose.connect(MONGO_URI);
        console.log('Connected to MongoDB');

        const adminUser = await User.findOne({ role: 'admin' });

        const newPassword = 'admin123';
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(newPassword, salt);

        if (adminUser) {
            console.log(`Found existing admin: ${adminUser.email}`);
            adminUser.password = hashedPassword;
            adminUser.phoneNumber = '9999999999'; // Ensure valid phone for validation
            await adminUser.save();
            console.log('--- CREDENTIALS RESET ---');
            console.log(`Email: ${adminUser.email}`);
            console.log(`Password: ${newPassword}`);
        } else {
            console.log('No admin found. Creating new admin...');
            const newAdmin = new User({
                username: 'system_admin',
                email: 'admin@trackeasy.com',
                password: hashedPassword,
                role: 'admin',
                phoneNumber: '9999999999'
            });
            await newAdmin.save();
            console.log('--- NEW ADMIN CREATED ---');
            console.log('Email: admin@trackeasy.com');
            console.log(`Password: ${newPassword}`);
        }

        mongoose.connection.close();
    } catch (error) {
        console.error('Error:', error);
        process.exit(1);
    }
}

recoverAdmin();
