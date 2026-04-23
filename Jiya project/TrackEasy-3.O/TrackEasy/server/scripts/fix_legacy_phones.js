const mongoose = require('mongoose');
const User = require('../models/User');
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

async function fixLegacyUsers() {
    try {
        console.log('Connecting to MongoDB...');
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('Connected.');

        const usersToUpdate = await User.find({ 
            $or: [
                { phoneNumber: { $exists: false } },
                { phoneNumber: null },
                { phoneNumber: "" }
            ]
        });

        console.log(`Found ${usersToUpdate.length} legacy users without a phone number.`);

        let count = 0;
        for (const user of usersToUpdate) {
            // Assign a unique dummy 10-digit phone number using the last 7 of their ID appended to '000'
            const idStr = user._id.toString();
            const dummyPhone = '000' + idStr.substring(idStr.length - 7);
            
            await User.updateOne({ _id: user._id }, { $set: { phoneNumber: dummyPhone } });
            count++;
        }

        console.log(`Successfully assigned dummy phone numbers to ${count} users.`);
    } catch (error) {
        console.error('Error migrating users:', error);
    } finally {
        await mongoose.disconnect();
        console.log('Disconnected.');
    }
}

fixLegacyUsers();
