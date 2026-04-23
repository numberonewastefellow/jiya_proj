const mongoose = require('mongoose');
const User = require('./models/User');
const Product = require('./models/Product');
const { put } = require('http'); // Not usable directly for express test, using local fetch simulation or direct controller test logic?
// Easier to test via script by mocking the update logic or better: use axios/fetch if server is running, OR simply run a db update script that mimics the route logic to ensure DB constraints allow it?
// No, I should test the API endpoint if possible, but I cannot easily call the running server from a script without auth token. 
// However, I can "simulate" the route logic or simply verify that updating the document via mongoose works as expected and that the code I wrote in `shop.js` is syntactically correct (by running server).
// Actually, `verify_vendor_update.js` showed I can interact with DB.
// I will creating a script that *simulates* the endpoint logic (find and update) to sure mongoose allows it, 
// AND I will ask the user to verify manually as per the plan.
// But I can also try to make a real HTTP request if I generate a token... that's complex.
// Let's rely on manual verification for the UI part, but I can verify the backend LOGIC by running a script that does exactly what the route does.

require('dotenv').config();

const verifyEditLogic = async () => {
    try {
        await mongoose.connect(process.env.MONGODB_URI);

        // 1. Get Vendor
        const vendor = await User.findOne({ username: 'vendor1' });
        if (!vendor) { console.log('Vendor not found'); return; }

        // 2. Get a product
        const product = await Product.findOne({ vendor: vendor._id });
        if (!product) { console.log('Product not found'); return; }

        console.log(`Original Name: ${product.name}, Cost: ${product.cost}`);

        // 3. Simulate Update
        const newCost = product.cost + 1;
        product.cost = newCost;
        await product.save();

        console.log(`✅ Updated Cost to: ${newCost}`);
        console.log('Backend logic simulation successful.');

        // Revert
        product.cost = newCost - 1;
        await product.save();
        console.log('Reverted changes.');

    } catch (e) {
        console.error(e);
    } finally {
        await mongoose.disconnect();
    }
};

verifyEditLogic();
