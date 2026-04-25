const express = require('express');
const router = express.Router();
const Order = require('../models/Order');
const authMiddleware = require('../middleware/auth');
const FraudAlert = require('../models/FraudAlert');

// Manager Summary Endpoint
router.get('/summary', authMiddleware, async (req, res) => {
    try {
        if (req.userRole !== 'manager' && req.userRole !== 'admin') {
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
        console.error('Manager summary error:', error);
        res.status(500).json({ message: 'Error fetching manager summary' });
    }
});

// Analytics endpoints (placeholders)
router.get('/analytics/delivery-trend', authMiddleware, async (req, res) => {
    try {
        if (req.userRole !== 'manager' && req.userRole !== 'admin') {
            return res.status(403).json({ message: 'Access denied' });
        }
        res.json({ trend: [] });
    } catch (error) {
        res.status(500).json({ message: 'Error fetching delivery trend' });
    }
});

router.get('/analytics/vendor-performance', authMiddleware, async (req, res) => {
    try {
        if (req.userRole !== 'manager' && req.userRole !== 'admin') {
            return res.status(403).json({ message: 'Access denied' });
        }
        res.json({ vendors: [] });
    } catch (error) {
        res.status(500).json({ message: 'Error fetching vendor performance' });
    }
});

router.get('/analytics/payment-failures', authMiddleware, async (req, res) => {
    try {
        if (req.userRole !== 'manager' && req.userRole !== 'admin') {
            return res.status(403).json({ message: 'Access denied' });
        }
        res.json({ failures: [] });
    } catch (error) {
        res.status(500).json({ message: 'Error fetching payment failures' });
    }
});

// ===============================
// USER MANAGEMENT ENDPOINTS
// ===============================
const User = require('../models/User');

// Get all users (manager and admin)
router.get('/users', authMiddleware, async (req, res) => {
    try {
        if (req.userRole !== 'manager' && req.userRole !== 'admin') {
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

// Get only blocked users (for notification bell)
router.get('/blocked-users', authMiddleware, async (req, res) => {
    try {
        if (req.userRole !== 'manager' && req.userRole !== 'admin') {
            return res.status(403).json({ message: 'Access denied' });
        }

        const blockedUsers = await User.find({ isBlocked: true })
            .select('username email role blockReason blockedAt blockedUntil updatedAt')
            .sort({ updatedAt: -1 });

        res.json(blockedUsers);
    } catch (error) {
        console.error('Get blocked users error:', error);
        res.status(500).json({ message: 'Error fetching blocked users' });
    }
});

// Toggle user block status (manager and admin)
router.put('/users/:id/toggle-block', authMiddleware, async (req, res) => {
    try {
        if (req.userRole !== 'manager' && req.userRole !== 'admin') {
            return res.status(403).json({ message: 'Access denied' });
        }

        const user = await User.findById(req.params.id);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        // Prevent blocking themselves
        if (user._id.toString() === req.userId) {
            return res.status(400).json({ message: 'Cannot block yourself' });
        }
        
        // Optionally, prevent manager from blocking an admin
        if (req.userRole === 'manager' && user.role === 'admin') {
            return res.status(403).json({ message: 'Managers cannot block admins' });
        }

        // Toggle blocked status
        user.isBlocked = !user.isBlocked;
        if (user.isBlocked) {
            user.blockReason = 'Manually blocked by ' + req.userRole;
            user.blockedAt = new Date();
            user.blockedUntil = null; // manual blocks are permanent
        } else {
            user.blockReason = null;
            user.blockedAt = null;
            user.blockedUntil = null;
            user.failedLoginAttempts = 0;
            user.failedOTPAttempts = 0;
        }
        await user.save();

        res.json({
            message: user.isBlocked ? 'User blocked successfully' : 'User unblocked successfully',
            user: {
                _id: user._id,
                username: user.username,
                email: user.email,
                role: user.role,
                isBlocked: user.isBlocked,
                blockReason: user.blockReason
            }
        });
    } catch (error) {
        console.error('Toggle block error:', error);
        res.status(500).json({ message: 'Error updating user status' });
    }
});

// Get detailed user info 
router.get('/users/:id/details', authMiddleware, async (req, res) => {
    try {
        if (req.userRole !== 'manager' && req.userRole !== 'admin') {
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
            const products = await Product.find({ vendor: user._id });
            const vendorProductIds = products.map(p => p._id.toString());
            const vendorProductNames = products.map(p => p.name.toLowerCase());

            let allOrders = await Order.find({}).populate('customer', 'username').sort({ createdAt: -1 });

            const vendorOrders = allOrders.filter(order => {
                if (!order.items || order.items.length === 0) return false;

                return order.items.some(item => {
                    if (item.productId && vendorProductIds.includes(item.productId.toString())) {
                        return true;
                    }
                    if (item.name && vendorProductNames.includes(item.name.toLowerCase())) {
                        return true;
                    }
                    return false;
                });
            });

            const deliveredOrders = vendorOrders.filter(o =>
                o.status === 'Delivered' || o.status === 'Delayed Delivery'
            );
            const totalSales = deliveredOrders.reduce((sum, order) => sum + (order.totalAmount || 0), 0);
            const commission = totalSales * 0.10; // 10% commission

            const ordersList = vendorOrders.map(order => ({
                orderId: order.orderId || order._id.toString().slice(-6),
                customerName: order.customer?.username || 'Unknown',
                amount: order.totalAmount || 0,
                status: order.status,
                date: order.createdAt
            }));

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
            const customerOrders = await Order.find({ customer: user._id }).sort({ createdAt: -1 });
            const totalSpent = customerOrders
                .filter(o => o.status === 'Delivered' || o.status === 'Delayed Delivery')
                .reduce((sum, order) => sum + (order.totalAmount || 0), 0);

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

        // Fetch latest risk score for this specific user
        const latestAlert = await FraudAlert.findOne({ userId: user._id }).sort({ createdAt: -1 });
        details.riskScore = latestAlert ? latestAlert.riskScore : 0;

        res.json(details);
    } catch (error) {
        console.error('Get user details error:', error);
        res.status(500).json({ message: 'Error fetching user details' });
    }
});

// Update product
router.put('/products/:id', authMiddleware, async (req, res) => {
    try {
        if (req.userRole !== 'manager' && req.userRole !== 'admin') {
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
