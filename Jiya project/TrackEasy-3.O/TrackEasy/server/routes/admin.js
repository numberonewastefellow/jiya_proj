const express = require('express');
const router = express.Router();
const Order = require('../models/Order');
const authMiddleware = require('../middleware/auth');
const FraudAlert = require('../models/FraudAlert');

// Admin Summary Endpoint
router.get('/summary', authMiddleware, async (req, res) => {
    try {
        if (req.userRole !== 'admin') {
            return res.status(403).json({ message: 'Access denied' });
        }

        // Get all orders
        const allOrders = await Order.find({});

        // Calculate summary statistics
        const totalOrders = allOrders.length;

        // Count by actual status
        let onTime = 0;      // Orders with "Delivered" status (on-time)
        let delayed = 0;     // Orders with "Delayed Delivery" status
        let failedPayments = 0;  // Orders with "Rejected" status

        allOrders.forEach(order => {
            if (order.status === 'Delivered') {
                onTime++;
            } else if (order.status === 'Delayed Delivery') {
                delayed++;
            } else if (order.status === 'Rejected') {
                failedPayments++;
            }
        });

        // Count high-risk users (latest risk score > 6)
        const highRiskAlerts = await FraudAlert.aggregate([
            { $sort: { createdAt: -1 } },
            { $group: { _id: '$userId', riskScore: { $first: '$riskScore' } } },
            { $match: { riskScore: { $gt: 6 } } }
        ]);
        const highRiskUsers = highRiskAlerts.length;

        res.json({
            totalOrders,
            onTime,
            delayed,
            failedPayments,
            highRiskUsers
        });
    } catch (error) {
        console.error('Admin summary error:', error);
        res.status(500).json({ message: 'Error fetching admin summary' });
    }
});

// Analytics endpoints (placeholders)
router.get('/analytics/delivery-trend', authMiddleware, async (req, res) => {
    try {
        if (req.userRole !== 'admin') {
            return res.status(403).json({ message: 'Access denied' });
        }
        // Placeholder
        res.json({ trend: [] });
    } catch (error) {
        res.status(500).json({ message: 'Error fetching delivery trend' });
    }
});

router.get('/analytics/vendor-performance', authMiddleware, async (req, res) => {
    try {
        if (req.userRole !== 'admin') {
            return res.status(403).json({ message: 'Access denied' });
        }
        // Placeholder
        res.json({ vendors: [] });
    } catch (error) {
        res.status(500).json({ message: 'Error fetching vendor performance' });
    }
});

router.get('/analytics/payment-failures', authMiddleware, async (req, res) => {
    try {
        if (req.userRole !== 'admin') {
            return res.status(403).json({ message: 'Access denied' });
        }
        // Placeholder
        res.json({ failures: [] });
    } catch (error) {
        res.status(500).json({ message: 'Error fetching payment failures' });
    }
});

// ===============================
// INFERENCE PLAYGROUND (admin demo tool)
// ===============================
router.post('/inference-playground', authMiddleware, async (req, res) => {
    if (req.userRole !== 'admin') return res.status(403).json({ message: 'Access denied' });
    try {
        const { customerId, simulatedOrder } = req.body || {};
        if (!customerId) return res.status(400).json({ message: 'customerId required' });
        const fraudUrl = process.env.FRAUD_SERVICE_URL || 'http://localhost:5002';
        const response = await fetch(`${fraudUrl}/api/fraud/inference-debug`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ customerId, simulatedOrder })
        });
        const data = await response.json();
        res.status(response.status).json(data);
    } catch (err) {
        console.error('Inference playground error:', err);
        res.status(500).json({ message: 'Inference proxy failed', error: err.message });
    }
});

// ===============================
// BLOCKED USER DETAILS (decision trace)
// ===============================
router.get('/blocked-detail/:userId', authMiddleware, async (req, res) => {
    if (req.userRole !== 'admin') return res.status(403).json({ message: 'Access denied' });
    try {
        const fraudUrl = process.env.FRAUD_SERVICE_URL || 'http://localhost:5002';
        const response = await fetch(`${fraudUrl}/api/fraud/block-detail/${encodeURIComponent(req.params.userId)}`);
        const data = await response.json();
        res.status(response.status).json(data);
    } catch (err) {
        console.error('Block detail proxy error:', err);
        res.status(500).json({ message: 'Block detail proxy failed', error: err.message });
    }
});

// ===============================
// USER MANAGEMENT ENDPOINTS
// ===============================
const User = require('../models/User');

// Get all users (admin only)
router.get('/users', authMiddleware, async (req, res) => {
    try {
        if (req.userRole !== 'admin') {
            return res.status(403).json({ message: 'Access denied' });
        }

        const users = await User.find({}).select('-password').sort({ createdAt: -1 }).lean();

        // Fetch latest risk scores for all users
        const alerts = await FraudAlert.aggregate([
            { $sort: { createdAt: -1 } },
            { $group: { _id: '$userId', riskScore: { $first: '$riskScore' } } }
        ]);
        const riskMap = alerts.reduce((acc, alert) => {
            acc[alert._id.toString()] = alert.riskScore;
            return acc;
        }, {});

        users.forEach(user => {
            user.riskScore = riskMap[user._id.toString()] || 0;
        });

        res.json(users);
    } catch (error) {
        console.error('Get users error:', error);
        res.status(500).json({ message: 'Error fetching users' });
    }
});

// Toggle user block status (admin only)
router.put('/users/:id/toggle-block', authMiddleware, async (req, res) => {
    try {
        if (req.userRole !== 'admin') {
            return res.status(403).json({ message: 'Access denied' });
        }

        const user = await User.findById(req.params.id);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        // Prevent admin from blocking themselves
        if (user._id.toString() === req.userId) {
            return res.status(400).json({ message: 'Cannot block yourself' });
        }

        // Toggle blocked status
        user.isBlocked = !user.isBlocked;
        if (user.isBlocked) {
            user.blockReason = user.blockReason || 'Manually blocked by admin';
            user.blockedAt = new Date();
            user.blockedUntil = null; // manual blocks are permanent until manually unblocked
        } else {
            user.blockReason = null;
            user.blockedAt = null;
            user.blockedUntil = null;
            user.failedOTPAttempts = 0;
            user.failedLoginAttempts = 0;
            // Reset reputation: stamp cutoff so old EventLog rows are ignored,
            // and wipe Maniacal-Speed baseline so a fast next checkout doesn't auto-block.
            user.lastUnblockedAt = new Date();
            user.lastCheckoutDuration = null;
        }
        await user.save();

        res.json({
            message: user.isBlocked ? 'User blocked successfully' : 'User unblocked successfully',
            user: {
                _id: user._id,
                username: user.username,
                email: user.email,
                role: user.role,
                isBlocked: user.isBlocked
            }
        });
    } catch (error) {
        console.error('Toggle block error:', error);
        res.status(500).json({ message: 'Error updating user status' });
    }
});

// Get detailed user info (admin only)
router.get('/users/:id/details', authMiddleware, async (req, res) => {
    try {
        if (req.userRole !== 'admin') {
            return res.status(403).json({ message: 'Access denied' });
        }

        const user = await User.findById(req.params.id).select('-password');
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        const Product = require('../models/Product');

        let details = {
            _id: user._id,
            username: user.username,
            email: user.email,
            role: user.role,
            isBlocked: user.isBlocked,
            joinedDate: user.createdAt
        };

        if (user.role === 'vendor') {
            // Get this vendor's products only
            const products = await Product.find({ vendor: user._id });
            const vendorProductIds = products.map(p => p._id.toString());
            const vendorProductNames = products.map(p => p.name.toLowerCase());

            // Get all orders and filter by vendor's products
            let allOrders = await Order.find({}).populate('customer', 'username').sort({ createdAt: -1 });

            // Filter orders that contain at least one of vendor's products
            const vendorOrders = allOrders.filter(order => {
                if (!order.items || order.items.length === 0) return false;

                return order.items.some(item => {
                    // Check by product ID if available
                    if (item.productId && vendorProductIds.includes(item.productId.toString())) {
                        return true;
                    }
                    // Check by product name as fallback
                    if (item.name && vendorProductNames.includes(item.name.toLowerCase())) {
                        return true;
                    }
                    return false;
                });
            });

            // Calculate total sales (from delivered orders)
            const deliveredOrders = vendorOrders.filter(o =>
                o.status === 'Delivered' || o.status === 'Delayed Delivery'
            );
            const totalSales = deliveredOrders.reduce((sum, order) => sum + (order.totalAmount || 0), 0);
            const commission = totalSales * 0.10; // 10% commission

            // Build order history list
            const ordersList = vendorOrders.map(order => ({
                orderId: order.orderId || order._id.toString().slice(-6),
                customerName: order.customer?.username || 'Unknown',
                amount: order.totalAmount || 0,
                status: order.status,
                date: order.createdAt
            }));

            // Build products list with full details
            const productsList = products.map(p => ({
                _id: p._id,
                name: p.name,
                cost: p.cost,
                brand: p.brand,
                category: p.category,
                image: p.image
            }));

            details.vendorInfo = {
                totalProducts: products.length,
                products: productsList,
                totalOrders: vendorOrders.length,
                deliveredOrders: deliveredOrders.length,
                totalSales: totalSales,
                commission: commission,
                orders: ordersList
            };
        } else if (user.role === 'customer') {
            // Get customer's orders (field is 'customer' not 'customerId')
            const customerOrders = await Order.find({ customer: user._id }).sort({ createdAt: -1 });
            const totalSpent = customerOrders
                .filter(o => o.status === 'Delivered' || o.status === 'Delayed Delivery')
                .reduce((sum, order) => sum + (order.totalAmount || 0), 0);

            // Get all order amounts with details
            const ordersList = customerOrders.map(order => ({
                orderId: order.orderId || order._id.toString().slice(-6),
                amount: order.totalAmount || 0,
                status: order.status,
                date: order.createdAt
            }));

            details.customerInfo = {
                totalOrders: customerOrders.length,
                totalSpent: totalSpent,
                orders: ordersList
            };
        }

        // Fetch latest risk score and XAI explanation for this specific user
        const latestAlert = await FraudAlert.findOne({ userId: user._id }).sort({ createdAt: -1 });
        details.riskScore = latestAlert ? latestAlert.riskScore : 0;
        details.explanation = latestAlert ? latestAlert.explanation : null;
        details.violationReason = latestAlert ? latestAlert.violationReason : null;
        details.action = latestAlert ? latestAlert.action : null;
        details.blockReason = user.blockReason || null;
        details.blockedAt = user.blockedAt || null;
        details.blockedUntil = user.blockedUntil || null;

        res.json(details);
    } catch (error) {
        console.error('Get user details error:', error);
        res.status(500).json({ message: 'Error fetching user details' });
    }
});

// Update product (admin only)
router.put('/products/:id', authMiddleware, async (req, res) => {
    try {
        if (req.userRole !== 'admin') {
            return res.status(403).json({ message: 'Access denied' });
        }

        const { name, cost, brand, category, image } = req.body;
        const product = await Product.findByIdAndUpdate(
            req.params.id,
            { name, cost, brand, category, image },
            { new: true }
        );

        if (!product) {
            return res.status(404).json({ message: 'Product not found' });
        }

        res.json({ message: 'Product updated successfully', product });
    } catch (error) {
        console.error('Update product error:', error);
        res.status(500).json({ message: 'Error updating product' });
    }
});

module.exports = router;
