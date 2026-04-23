const mongoose = require('mongoose');
const Product = require('./models/Product');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const verifyImages = async () => {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        const products = await Product.find({});

        console.log(`Checking ${products.length} products for valid image paths...`);

        let allValid = true;
        for (const p of products) {
            // p.image is like "/images/apple.jpg"
            // File system path should be: public/images/apple.jpg
            const relativePath = p.image.startsWith('/') ? p.image.slice(1) : p.image;
            const absolutePath = path.join(__dirname, 'public', relativePath);

            if (fs.existsSync(absolutePath)) {
                console.log(`✅ [${p.name}] Found: ${relativePath}`);
            } else {
                console.log(`❌ [${p.name}] MISSING: ${relativePath} (looked at ${absolutePath})`);
                allValid = false;
            }
        }

        if (allValid) {
            console.log('✅ Success: All product images exist in public/images.');
        } else {
            console.log('❌ Failure: Some images are missing.');
        }

    } catch (error) {
        console.error('Error:', error);
    } finally {
        await mongoose.disconnect();
    }
};

verifyImages();
