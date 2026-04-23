require('dotenv').config();
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const User = require('../models/User');
const Order = require('../models/Order');

// Clean up MongoDB Extended JSON ($oid, $date) to regular objects
const cleanExtendedJSON = (obj) => {
    if (obj === null || typeof obj !== 'object') {
        return obj;
    }

    if (Array.isArray(obj)) {
        return obj.map(cleanExtendedJSON);
    }

    if (obj.$oid) {
        return new mongoose.Types.ObjectId(obj.$oid);
    }

    if (obj.$date) {
        return new Date(obj.$date);
    }

    const cleaned = {};
    for (const key in obj) {
        cleaned[key] = cleanExtendedJSON(obj[key]);
    }
    return cleaned;
};

mongoose.connect(process.env.MONGODB_URI)
    .then(async () => {
        console.log('Connected to MongoDB. Starting seed...');

        try {
            // Read JSON files
            const usersRaw = fs.readFileSync('c:\\Users\\yaksh\\OneDrive\\Desktop\\Tracker.users.json', 'utf8');
            const ordersRaw = fs.readFileSync('c:\\Users\\yaksh\\OneDrive\\Desktop\\Tracker.orders.json', 'utf8');

            const usersData = cleanExtendedJSON(JSON.parse(usersRaw));
            const ordersData = cleanExtendedJSON(JSON.parse(ordersRaw));

            console.log(`Parsed ${usersData.length} users and ${ordersData.length} orders.`);

            // Insert Users
            for (const userData of usersData) {
                try {
                    // Check if exists
                    const existing = await User.findById(userData._id);
                    if (!existing) {
                        const newUser = new User(userData);
                        await newUser.save();
                        console.log(`Added user: ${newUser.username}`);
                    } else {
                        console.log(`User ${existing.username} already exists, skipping.`);
                    }
                } catch(e) {
                    console.error(`Error saving user ${userData.username}:`, e.message);
                }
            }

            // Insert Orders
            for (const orderData of ordersData) {
                try {
                    const existing = await Order.findById(orderData._id);
                    if (!existing) {
                        const newOrder = new Order(orderData);
                        await newOrder.save();
                        console.log(`Added order: ${newOrder.orderId}`);
                    } else {
                        console.log(`Order ${existing.orderId} already exists, skipping.`);
                    }
                } catch(e) {
                    console.error(`Error saving order ${orderData.orderId}:`, e.message);
                }
            }

            console.log('Successfully seeded users and orders.');
        } catch (err) {
            console.error('Error during seeding:', err);
        } finally {
            mongoose.disconnect();
        }
    })
    .catch(err => {
        console.error('Initial Connection Error', err);
    });
