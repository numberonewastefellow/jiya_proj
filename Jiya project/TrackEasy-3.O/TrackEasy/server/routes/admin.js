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
// D1 — Fraud Overview Insights proxy
// Drives the admin Dashboard (#view-dashboard).
// ===============================
router.get('/insights/overview', authMiddleware, async (req, res) => {
    if (req.userRole !== 'admin') return res.status(403).json({ message: 'Access denied' });
    try {
        const fraudUrl = process.env.FRAUD_SERVICE_URL || 'http://localhost:5002';
        const response = await fetch(`${fraudUrl}/api/fraud/insights/overview`);
        const data = await response.json();
        res.status(response.status).json(data);
    } catch (err) {
        console.error('Insights overview proxy error:', err);
        res.status(500).json({ message: 'Insights overview proxy failed', error: err.message });
    }
});

// ===============================
// D2 — Detection Activity Insights proxy
// Drives the admin Detection Activity view (#view-detection).
// Forwards ?days=7|30|90 to the fraud-service.
// ===============================
router.get('/insights/detection-activity', authMiddleware, async (req, res) => {
    if (req.userRole !== 'admin') return res.status(403).json({ message: 'Access denied' });
    try {
        const fraudUrl = process.env.FRAUD_SERVICE_URL || 'http://localhost:5002';
        const days = req.query.days ? `?days=${encodeURIComponent(req.query.days)}` : '';
        const response = await fetch(`${fraudUrl}/api/fraud/insights/detection-activity${days}`);
        const data = await response.json();
        res.status(response.status).json(data);
    } catch (err) {
        console.error('Insights detection-activity proxy error:', err);
        res.status(500).json({ message: 'Insights detection-activity proxy failed', error: err.message });
    }
});

// ===============================
// D3 — Geo & Device Insights proxy
// Drives the admin Geo & Device view (#view-geo).
// Forwards ?days=1|7|30 to the fraud-service.
// ===============================
router.get('/insights/geo-device', authMiddleware, async (req, res) => {
    if (req.userRole !== 'admin') return res.status(403).json({ message: 'Access denied' });
    try {
        const fraudUrl = process.env.FRAUD_SERVICE_URL || 'http://localhost:5002';
        const days = req.query.days ? `?days=${encodeURIComponent(req.query.days)}` : '';
        const response = await fetch(`${fraudUrl}/api/fraud/insights/geo-device${days}`);
        const data = await response.json();
        res.status(response.status).json(data);
    } catch (err) {
        console.error('Insights geo-device proxy error:', err);
        res.status(500).json({ message: 'Insights geo-device proxy failed', error: err.message });
    }
});

// ===============================
// D4 — Fraud Ring Graph proxy
// Drives the admin Fraud Ring view (#view-ring).
// Forwards ?minRisk=0..10 and (optional) ?days=all|7|30|90 to the fraud-service.
// ===============================
router.get('/insights/graph', authMiddleware, async (req, res) => {
    if (req.userRole !== 'admin') return res.status(403).json({ message: 'Access denied' });
    try {
        const fraudUrl = process.env.FRAUD_SERVICE_URL || 'http://localhost:5002';
        const qs = [];
        if (req.query.minRisk !== undefined) qs.push(`minRisk=${encodeURIComponent(req.query.minRisk)}`);
        if (req.query.days !== undefined)    qs.push(`days=${encodeURIComponent(req.query.days)}`);
        const query = qs.length > 0 ? `?${qs.join('&')}` : '';
        const response = await fetch(`${fraudUrl}/api/fraud/insights/graph${query}`);
        const data = await response.json();
        res.status(response.status).json(data);
    } catch (err) {
        console.error('Insights graph proxy error:', err);
        res.status(500).json({ message: 'Insights graph proxy failed', error: err.message });
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

// ---------------------------------------------------------------------------
// Demo-data seeding (admin only)
//   POST /api/admin/seed         — idempotent upsert (safe)
//   POST /api/admin/seed/reset   — wipe Users/Products/Orders/FraudAlerts/EventLog, then reseed
// Both delegate to scripts/seed.js. The caller's admin JWT is preserved across
// the operation (we do NOT delete the calling admin until after the wipe, and
// the seed recreates an admin row from users.csv before responding).
// ---------------------------------------------------------------------------
const { runSeed, seedReset, validate } = require('../scripts/seed');

router.post('/seed', authMiddleware, async (req, res) => {
    if (req.userRole !== 'admin') return res.status(403).json({ message: 'Access denied' });
    try {
        const result = await runSeed({ verbose: false });
        const errors = await validate(result);
        if (errors.length) {
            return res.status(500).json({ message: 'Seed completed with validation errors', errors, summary: result.summary });
        }
        res.json({ message: 'Seed completed', summary: result.summary });
    } catch (err) {
        console.error('Seed endpoint error:', err);
        res.status(500).json({ message: 'Seed failed', error: err.message });
    }
});

router.post('/seed/reset', authMiddleware, async (req, res) => {
    if (req.userRole !== 'admin') return res.status(403).json({ message: 'Access denied' });
    try {
        const result = await seedReset();
        const errors = await validate(result);
        const note = 'Demo data reset. Your current admin session is now invalid because the user row was wiped — log in again as admin@trackeasy.com / password123.';
        if (errors.length) {
            return res.status(500).json({ message: 'Reset completed with validation errors', errors, summary: result.summary, note });
        }
        res.json({ message: 'Demo data reset + reseeded', summary: result.summary, note });
    } catch (err) {
        console.error('Seed reset endpoint error:', err);
        res.status(500).json({ message: 'Seed reset failed', error: err.message });
    }
});

// ---------------------------------------------------------------------------
// Synthetic seed data (for dashboards D1-D4)
//   POST   /admin/seed/synthetic                — generate with custom opts
//   POST   /admin/seed/synthetic/preset/:name   — generate with light/medium/heavy
//   DELETE /admin/seed/synthetic                — wipe all { synthetic: true } rows
// All four affected models carry synthetic:true so this cannot remove CSV data.
// ---------------------------------------------------------------------------
const { generate: generateSynthetic, PRESETS: SYNTHETIC_PRESETS } = require('../scripts/seedSynthetic');
const EventLog = require('../models/EventLog');

function validateSyntheticOpts(opts) {
    const errs = [];
    if (typeof opts !== 'object' || !opts) {
        errs.push('Body must be an object');
        return errs;
    }
    const reqd = ['userCount', 'alertCount', 'eventCount', 'daysBack', 'ringCount', 'ringSize', 'actionMix'];
    for (const k of reqd) {
        if (opts[k] === undefined || opts[k] === null) errs.push(`Missing field: ${k}`);
    }
    if (errs.length) return errs;
    if (typeof opts.alertCount !== 'number' || opts.alertCount <= 0) errs.push('alertCount must be > 0');
    if (opts.alertCount > 10000) errs.push('alertCount must be <= 10000');
    if (typeof opts.daysBack !== 'number' || opts.daysBack <= 0) errs.push('daysBack must be > 0');
    if (opts.daysBack > 365) errs.push('daysBack must be <= 365');
    if (typeof opts.userCount !== 'number' || opts.userCount <= 0) errs.push('userCount must be > 0');
    if (typeof opts.eventCount !== 'number' || opts.eventCount < 0) errs.push('eventCount must be >= 0');
    if (typeof opts.ringCount !== 'number' || opts.ringCount < 0) errs.push('ringCount must be >= 0');
    if (!Array.isArray(opts.ringSize) || opts.ringSize.some(n => typeof n !== 'number' || n < 1)) {
        errs.push('ringSize must be array of positive integers');
    }
    const am = opts.actionMix;
    if (!am || typeof am !== 'object') {
        errs.push('actionMix must be an object');
    } else {
        const sum = (am.allow || 0) + (am.warning || 0) + (am.requires_otp || 0) + (am.block || 0);
        if (Math.abs(sum - 1.0) > 0.01) errs.push(`actionMix must sum to 1.0 (±0.01), got ${sum.toFixed(3)}`);
    }
    return errs;
}

router.post('/seed/synthetic', authMiddleware, async (req, res) => {
    if (req.userRole !== 'admin') return res.status(403).json({ message: 'Access denied' });
    try {
        const opts = req.body || {};
        const errs = validateSyntheticOpts(opts);
        if (errs.length) return res.status(400).json({ message: 'Invalid seed options', errors: errs });
        const result = await generateSynthetic(opts);
        res.json({ message: 'Synthetic seed generated', ...result });
    } catch (err) {
        console.error('Synthetic seed error:', err);
        res.status(500).json({ message: 'Synthetic seed failed', error: err.message });
    }
});

router.post('/seed/synthetic/preset/:name', authMiddleware, async (req, res) => {
    if (req.userRole !== 'admin') return res.status(403).json({ message: 'Access denied' });
    try {
        const name = String(req.params.name || '').toLowerCase();
        const preset = SYNTHETIC_PRESETS[name];
        if (!preset) return res.status(404).json({ message: `Unknown preset: ${name}` });
        const result = await generateSynthetic(preset);
        res.json({ message: `Synthetic seed (${name}) generated`, preset: name, ...result });
    } catch (err) {
        console.error('Synthetic preset seed error:', err);
        res.status(500).json({ message: 'Synthetic seed (preset) failed', error: err.message });
    }
});

router.delete('/seed/synthetic', authMiddleware, async (req, res) => {
    if (req.userRole !== 'admin') return res.status(403).json({ message: 'Access denied' });
    try {
        const [u, a, e, o] = await Promise.all([
            User.deleteMany({ synthetic: true }),
            FraudAlert.deleteMany({ synthetic: true }),
            EventLog.deleteMany({ synthetic: true }),
            Order.deleteMany({ synthetic: true }),
        ]);
        res.json({
            message: 'Synthetic data cleared',
            deleted: {
                users: u.deletedCount || 0,
                alerts: a.deletedCount || 0,
                events: e.deletedCount || 0,
                orders: o.deletedCount || 0,
            }
        });
    } catch (err) {
        console.error('Synthetic seed delete error:', err);
        res.status(500).json({ message: 'Synthetic seed delete failed', error: err.message });
    }
});

module.exports = router;
