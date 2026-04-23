const express = require('express');
const router = express.Router();
const Product = require('../models/Product');
const User = require('../models/User');
const authMiddleware = require('../middleware/auth');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const redisClient = require('../utils/redisClient');

// Configure Multer Storage
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadPath = 'public/images/uploads';
        // Ensure directory exists
        if (!fs.existsSync(uploadPath)) {
            fs.mkdirSync(uploadPath, { recursive: true });
        }
        cb(null, uploadPath);
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname);
    }
});

const upload = multer({ storage: storage });

// Get products - Vendors see their own, Customers see all
router.get('/products', authMiddleware, async (req, res) => {
    try {
        let query = {};
        let cacheKey = 'products:all';

        // Vendors see only their own products
        if (req.userRole === 'vendor') {
            query.vendor = req.userId;
            cacheKey = `products:vendor:${req.userId}`;
        }

        // Check Redis Cache
        const cachedProducts = await redisClient.get(cacheKey);
        if (cachedProducts) {
            console.log('Redis Cache Hit:', cacheKey);
            return res.json(JSON.parse(cachedProducts));
        }

        const products = await Product.find(query).populate('vendor', 'username');

        // Set Redis Cache (Expire in 1 hour)
        await redisClient.set(cacheKey, JSON.stringify(products), { EX: 3600 });
        console.log('Redis Cache Miss:', cacheKey);

        res.json(products);
    } catch (error) {
        console.error('Error fetching products:', error);
        res.status(500).json({ message: 'Error fetching products' });
    }
});

// Add new product (Vendor only) - Links product to vendor
// Add new product (Vendor only) - Links product to vendor
router.post('/products', authMiddleware, upload.single('image'), async (req, res) => {
    try {
        if (req.userRole !== 'vendor' && req.userRole !== 'admin') {
            return res.status(403).json({ message: 'Access denied' });
        }

        const { name, cost, brand, category } = req.body;

        if (!name || !cost || !brand || !category) {
            return res.status(400).json({ message: 'All text fields are required' });
        }

        let imagePath = '';
        if (req.file) {
            imagePath = '/images/uploads/' + req.file.filename;
        } else {
            return res.status(400).json({ message: 'Image file is required' });
        }

        // Link product to the vendor who creates it
        const product = new Product({
            name,
            cost,
            brand,
            category,
            image: imagePath,
            vendor: req.userId
        });
        await product.save();

        // Invalidate Cache
        await redisClient.del('products:all');
        await redisClient.del(`products:vendor:${req.userId}`);

        res.status(201).json({ message: 'Product added successfully', product });
    } catch (error) {
        console.error('Add product error:', error);
        res.status(500).json({ message: 'Error adding product' });
    }
});

// Update product (Vendor/Admin only)
// Update product (Vendor/Admin only)
router.put('/products/:id', authMiddleware, upload.single('image'), async (req, res) => {
    try {
        if (req.userRole !== 'vendor' && req.userRole !== 'admin') {
            return res.status(403).json({ message: 'Access denied' });
        }

        const { name, cost, brand, category } = req.body;
        let query = { _id: req.params.id };

        if (req.userRole === 'vendor') {
            query.vendor = req.userId;
        }

        const product = await Product.findOne(query);

        if (!product) {
            return res.status(404).json({ message: 'Product not found or access denied' });
        }

        product.name = name || product.name;
        product.cost = cost || product.cost;
        product.brand = brand || product.brand;
        product.category = category || product.category;

        if (req.file) {
            product.image = '/images/uploads/' + req.file.filename;
        }

        await product.save();

        // Invalidate Cache
        await redisClient.del('products:all');
        if (req.userRole === 'vendor') {
            await redisClient.del(`products:vendor:${req.userId}`);
        } else {
            // Admin updated it, we might need to find the vendorId to invalidate their cache too
            // For now, let's just invalidate the specific vendor logic if we know the vendor
            if (product.vendor) {
                await redisClient.del(`products:vendor:${product.vendor}`);
            }
        }

        res.json({ message: 'Product updated successfully', product });
    } catch (error) {
        console.error('Update product error:', error);
        res.status(500).json({ message: 'Error updating product' });
    }
});

// Delete product (Vendor/Admin only) - Vendors can only delete their own
router.delete('/products/:id', authMiddleware, async (req, res) => {
    try {
        if (req.userRole !== 'vendor' && req.userRole !== 'admin') {
            return res.status(403).json({ message: 'Access denied' });
        }

        let query = { _id: req.params.id };

        // Vendors can only delete their own products
        if (req.userRole === 'vendor') {
            query.vendor = req.userId;
        }

        const product = await Product.findOneAndDelete(query);

        if (!product) {
            return res.status(404).json({ message: 'Product not found or access denied' });
        }

        res.json({ message: 'Product deleted successfully' });

        // Invalidate Cache
        await redisClient.del('products:all');
        if (req.userRole === 'vendor') {
            await redisClient.del(`products:vendor:${req.userId}`);
        } else if (product.vendor) {
            await redisClient.del(`products:vendor:${product.vendor}`);
        }
    } catch (error) {
        console.error('Delete product error:', error);
        res.status(500).json({ message: 'Error deleting product' });
    }
});

// Assign existing products to a vendor (one-time migration)
router.post('/assign-products', authMiddleware, async (req, res) => {
    try {
        if (req.userRole !== 'admin') {
            return res.status(403).json({ message: 'Admin access required' });
        }

        const { vendorId } = req.body;

        if (!vendorId) {
            return res.status(400).json({ message: 'Vendor ID is required' });
        }

        // Assign all products without a vendor to the specified vendor
        const result = await Product.updateMany(
            { vendor: { $exists: false } },
            { $set: { vendor: vendorId } }
        );

        // Also update products with null vendor
        const result2 = await Product.updateMany(
            { vendor: null },
            { $set: { vendor: vendorId } }
        );

        res.json({
            message: 'Products assigned successfully',
            assignedCount: result.modifiedCount + result2.modifiedCount
        });
    } catch (error) {
        console.error('Assign products error:', error);
        res.status(500).json({ message: 'Error assigning products' });
    }
});

module.exports = router;
