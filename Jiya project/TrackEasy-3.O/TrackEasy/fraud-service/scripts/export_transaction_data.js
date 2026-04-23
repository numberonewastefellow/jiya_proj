const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const Order = require('../../server/models/Order');

const OUTPUT_PATH = path.join(__dirname, '../ml/normal_transactions.csv');

async function exportData() {
    try {
        console.log('🚀 Connecting to MongoDB...');
        await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/trackeasy');

        console.log('📊 Fetching normal order data...');
        let orders = [];
        try {
            orders = await Order.find({ status: { $ne: 'Rejected' }, totalAmount: { $lt: 20000 } }).limit(500);
        } catch (dbErr) {
            console.warn('⚠️ Could not fetch from DB, using synthetic data only.');
        }

        const data = [];
        
        // Features: [totalAmount, itemCount, hourOfDay, dayOfWeek]
        orders.forEach(order => {
            const date = new Date(order.createdAt || Date.now());
            data.push({
                amount: order.totalSum || 0,
                items: order.items ? order.items.length : 0,
                hour: date.getHours(),
                day: date.getDay()
            });
        });

        // GENERATE SYNTHETIC NORMAL DATA (To ensure we have enough for training)
        console.log('🧪 Seeding synthetic normal transactions...');
        for(let i=0; i<1000; i++) {
            data.push({
                amount: 500 + Math.random() * 2000,
                items: 1 + Math.floor(Math.random() * 5),
                hour: 9 + Math.floor(Math.random() * 12), // Daytime
                day: 1 + Math.floor(Math.random() * 5)     // Weekdays
            });
        }

        const csv = 'amount,items,hour,day\n' + data.map(d => `${d.amount},${d.items},${d.hour},${d.day}`).join('\n');
        fs.writeFileSync(OUTPUT_PATH, csv);

        console.log(`✅ Data exported to ${OUTPUT_PATH}`);
        await mongoose.disconnect();
    } catch (err) {
        console.error('❌ Export failed:', err);
    }
}

exportData();
