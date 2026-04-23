require('dotenv').config();
const mongoose = require('mongoose');
const Product = require('../models/Product');
const products = require('./products_to_add.json');

mongoose.connect(process.env.MONGODB_URI)
  .then(async () => {
    console.log('Connected to MongoDB. Starting seed...');

    try {
      for (const productData of products) {
        // Convert to proper Mongoose ObjectId format from the JSON payload
        productData.vendor = new mongoose.Types.ObjectId(productData.vendor);

        const newProduct = new Product(productData);
        await newProduct.save();
        console.log(`Added product: ${newProduct.name}`);
      }
      console.log('Successfully seeded all products.');
    } catch (err) {
      console.error('Error during seeding:', err);
    } finally {
      mongoose.disconnect();
    }
  })
  .catch(err => {
    console.error('Initial Connection Error', err);
  });
