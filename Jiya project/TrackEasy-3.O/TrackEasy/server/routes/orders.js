const express = require('express');
const router = express.Router();
const Order = require('../models/Order');
const Product = require('../models/Product');
const authMiddleware = require('../middleware/auth');
const FraudAlert = require('../models/FraudAlert');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const User = require('../models/User');

// Create Order (Customer)
router.post('/', authMiddleware, async (req, res) => {
    try {
        const { items, totalAmount, paymentMethod } = req.body;

        // --- Velocity-Based Rate Limiting (Average-Based OTP) ---
        const currentOrderQuantity = items.reduce((total, item) => total + (item.quantity || 1), 0);
        
        // Find historical orders for this customer
        const pastOrders = await Order.find({ customer: req.userId });
        
        let averageOrderSize = 3; // Default baseline for new users
        let averageOrderAmount = 10000; // Default baseline baseline ₹ for new users

        if (pastOrders.length > 0) {
            const historicalTotalQuantity = pastOrders.reduce((total, order) => {
                return total + (order.items ? order.items.reduce((sum, item) => sum + (item.quantity || 1), 0) : 0);
            }, 0);
            const historicalTotalAmount = pastOrders.reduce((total, order) => total + order.totalAmount, 0);
            
            averageOrderSize = historicalTotalQuantity / pastOrders.length;
            averageOrderAmount = historicalTotalAmount / pastOrders.length;
        }
        
        const qtyLimit = averageOrderSize;
        const amountSpikeLimit = averageOrderAmount;
        const staticHighValueLimit = 50000; // Any order > ₹50k is high value
        
        let requiresOTP = false;
        let spikeAlert = false;
        
        // --- Security Triggers ---
        if (currentOrderQuantity > qtyLimit) {
            requiresOTP = true;
            spikeAlert = true;
            console.log(`[VELOCITY] Quantity Spike: ${currentOrderQuantity} > ${qtyLimit.toFixed(1)} (Avg)`);
        } else if (totalAmount > staticHighValueLimit) {
            requiresOTP = true;
            spikeAlert = true;
            console.log(`[VELOCITY] High Value detected: ₹${totalAmount} > ₹${staticHighValueLimit}`);
        } else if (totalAmount > amountSpikeLimit) {
            requiresOTP = true;
            spikeAlert = true;
            console.log(`[VELOCITY] Amount Spike: ₹${totalAmount} > ₹${amountSpikeLimit.toFixed(0)} (Avg)`);
        }
        
        if (requiresOTP) {
            console.log(`[VELOCITY ALERT] User: ${req.userId} | Current Qty: ${currentOrderQuantity} (Avg: ${averageOrderSize.toFixed(1)}) | Current Amt: ₹${totalAmount} (Avg: ₹${averageOrderAmount.toFixed(0)}) -> OTP REQUIRED`);
        }
        // ------------------------------------

        // Notify Fraud Service to evaluate the transaction before proceeding
        try {
            if (typeof fetch !== 'undefined') {
                const fraudResponse = await fetch('http://localhost:5002/api/fraud/evaluate-transaction', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        userId: req.userId,
                        ipAddress: req.ip || req.connection.remoteAddress,
                        transactionDetails: { items, totalAmount, paymentMethod },
                        biometrics: req.body.biometrics || null,
                        hp_trap: req.body.hp_trap || false
                    })
                });
                
                if (fraudResponse.ok) {
                    const fraudResult = await fraudResponse.json();
                    
                    if (fraudResult.action === 'block') {
                        return res.status(403).json({
                            success: false,
                            message: "Transaction paused for security review. Your account has been temporarily suspended."
                        });
                    }

                    if (fraudResult.action === 'requires_otp' || fraudResult.action === 'pause') {
                        requiresOTP = true;
                    }
                } else {
                    console.warn(`[FRAUD SERVICE] Returned status ${fraudResponse.status}. Skipping evaluation.`);
                }
            } else {
                console.warn('[FRAUD SERVICE] fetch is not defined. Skipping evaluation.');
            }
        } catch (err) {
            console.error('Fraud service unreachable for transaction evaluation:', err.message);
        }

        if (requiresOTP) {
            const otp = Math.floor(100000 + Math.random() * 900000).toString();
            const otpExpiry = new Date(Date.now() + 5 * 60 * 1000); // 5 mins
            
            const user = await User.findById(req.userId);
            
            if (!user.phoneNumber) {
                return res.status(400).json({ 
                    success: false, 
                    message: "A phone number is required to receive OTP for verification. Please update your profile in the Dashboard." 
                });
            }

            user.otp = otp;
            user.otpExpiry = otpExpiry;
            user.failedOTPAttempts = 0;
            await user.save();
            
            console.log(`\n[SMS MOCK] Address/Fraud Verification OTP for user ${req.userId} is: ${otp}\n`);
            
            // Log fraud alert for the spike if it occurred
            if (spikeAlert) {
                const alert = new FraudAlert({
                    userId: req.userId,
                    riskScore: 8,
                    violationReason: `High value spike: Current ₹${totalAmount} is > 5x Previous. Verification required.`,
                    status: 'Pending'
                });
                await alert.save();
            }
            
            // --- Send Real SMS using Twilio ---
            if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
                try {
                    const twilioClient = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
                    
                    // Prepend +91 country code to the 10-digit number. Change this if you operate in other countries.
                    const toPhoneNumber = `+91${user.phoneNumber}`;
                    
                    await twilioClient.messages.create({
                        body: `TrackEasy Alert: Are you willing to place the order? If yes, please use this verification code to confirm: ${otp}. It will expire in 5 minutes.`,
                        from: process.env.TWILIO_PHONE_NUMBER,
                        to: process.env.TWILIO_VERIFIED_PHONE_NUMBER || toPhoneNumber // Force sending to verified dev number
                    });
                    console.log(`[TWILIO] Real SMS sent successfully to ${toPhoneNumber}`);
                    
                } catch (smsError) {
                    console.error('[TWILIO ERROR] Failed to send SMS:', smsError.message);
                }
            }
            // ----------------------------------
            
            return res.status(403).json({ 
                success: false, 
                requiresOTP: true,
                message: "Verification required due to unusual activity. OTP sent to registered mobile number." 
            });
        }

        let paymentStatus = 'Pending';
        let transactionId = null;

        if (paymentMethod === 'Card' || paymentMethod === 'UPI') {
            paymentStatus = 'Paid';
            transactionId = `MOCK-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        }

        const newOrder = new Order({
            customer: req.userId,
            items,
            totalAmount,
            status: 'Pending',
            paymentStatus,
            paymentMethod: paymentMethod || 'COD',
            transactionId
        });
        await newOrder.save();

        res.json({ order: newOrder, success: true });
        console.log(`[ORDER CREATED] ID: ${newOrder._id} for User: ${req.userId}`);
    } catch (error) {
        console.error('Order creation error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Error creating order: ' + error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
});

// Verify OTP and Place Order
router.post('/verify-otp-and-place-order', authMiddleware, async (req, res) => {
    try {
        const { otp, items, totalAmount, paymentMethod, deviceFingerprint } = req.body;
        const User = require('../models/User');
        const user = await User.findById(req.userId);

        if (!user.otp || !user.otpExpiry) {
            return res.status(400).json({ success: false, message: 'No pending OTP verification found' });
        }

        if (new Date() > user.otpExpiry) {
            return res.status(400).json({ success: false, message: 'OTP has expired. Please try again.' });
        }

        if (user.otp !== otp) {
            user.failedOTPAttempts = (user.failedOTPAttempts || 0) + 1;
            
            // --- USER REQUIREMENT: Store fingerprint on 2nd failure ---
            if (user.failedOTPAttempts === 2 && deviceFingerprint) {
                user.deviceFingerprint = deviceFingerprint;
                console.log(`[THREAT SIGNAL] Device fingerprint added to account ${user._id} after 2 OTP failures: ${deviceFingerprint}`);
            }

            if (user.failedOTPAttempts >= 3) {
                user.isBlocked = true;
                user.otp = null;
                user.otpExpiry = null;
                await user.save();
                return res.status(403).json({ success: false, accountBlocked: true, message: 'Too many failed attempts. Account suspended.' });
            }
            await user.save();
            return res.status(400).json({ 
                success: false, 
                showAlternative: user.failedOTPAttempts === 2,
                message: 'Invalid OTP. Attempts left: ' + (3 - user.failedOTPAttempts) 
            });
        }

        // OTP is valid
        user.otp = null;
        user.otpExpiry = null;
        user.failedOTPAttempts = 0;
        await user.save();

        let paymentStatus = 'Pending';
        let transactionId = null;

        if (paymentMethod === 'Card' || paymentMethod === 'UPI') {
            paymentStatus = 'Paid';
            transactionId = `MOCK-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        }

        const newOrder = new Order({
            customer: req.userId,
            items,
            totalAmount,
            status: 'Pending',
            paymentStatus,
            paymentMethod: paymentMethod || 'COD',
            transactionId
        });
        await newOrder.save();

        res.json({ order: newOrder, success: true });
    } catch (error) {
        console.error('OTP Verification error:', error);
        res.status(500).json({ message: 'Error verifying OTP', error: error.message });
    }
});

// Verify Alternative (Fingerprint / Passkey) and Place Order
router.post('/verify-alternative', authMiddleware, async (req, res) => {
    try {
        const { type, fingerprint, items, totalAmount, paymentMethod } = req.body;
        const User = require('../models/User');
        const user = await User.findById(req.userId);

        if (!user) return res.status(404).json({ success: false, message: 'User not found' });

        if (type === 'fingerprint') {
            if (!user.deviceFingerprint) {
                return res.status(400).json({ success: false, message: 'No fingerprint on file for this account.' });
            }
            if (user.deviceFingerprint !== fingerprint) {
                return res.status(403).json({ success: false, message: 'Fingerprint mismatch. Verification failed.' });
            }
            console.log(`[SECURE AUTH] Fingerprint verified for user ${user._id}`);
        } else if (type === 'passkey') {
            if (!user.passkeyId) {
                return res.status(400).json({ success: false, message: 'No Passkey registered for this account.' });
            }
            // SIMULATION: In a real app, you'd verify the WebAuthn signature here
            console.log(`[SECURE AUTH] Passkey verified for user ${user._id}`);
        } else {
            return res.status(400).json({ success: false, message: 'Invalid verification type.' });
        }

        // Verification successful - Reset OTP failures
        user.failedOTPAttempts = 0;
        user.otp = null;
        user.otpExpiry = null;
        await user.save();

        // Place Order
        let paymentStatus = 'Pending';
        let transactionId = null;
        if (paymentMethod === 'Card' || paymentMethod === 'UPI') {
            paymentStatus = 'Paid';
            transactionId = `SECURE-${Date.now()}`;
        }

        const newOrder = new Order({
            customer: req.userId,
            items,
            totalAmount,
            status: 'Pending',
            paymentStatus,
            paymentMethod: paymentMethod || 'COD',
            transactionId
        });
        await newOrder.save();

        res.json({ success: true, order: newOrder });
    } catch (error) {
        console.error('Alternative verification error:', error);
        res.status(500).json({ success: false, message: 'Server error during alternative verification' });
    }
});

// Get My Orders (Customer)
router.get('/my-orders', authMiddleware, async (req, res) => {
    try {
        const orders = await Order.find({ customer: req.userId }).sort({ createdAt: -1 });
        res.json(orders);
    } catch (error) {
        res.status(500).json({ message: 'Error fetching orders' });
    }
});

// Get Orders (Vendor sees only orders for their products, Admin sees all)
router.get('/vendor-orders', authMiddleware, async (req, res) => {
    try {
        if (req.userRole !== 'vendor' && req.userRole !== 'admin' && req.userRole !== 'manager') {
            return res.status(403).json({ message: 'Access denied' });
        }

        let orders = await Order.find({}).populate('customer', 'username email').sort({ createdAt: -1 });

        if (req.userRole === 'vendor') {
            // Get all product IDs belonging to this vendor
            const vendorProducts = await Product.find({ vendor: req.userId }).select('_id name');
            const vendorProductIds = vendorProducts.map(p => p._id.toString());
            const vendorProductNames = vendorProducts.map(p => p.name.toLowerCase());

            // Filter orders that contain at least one of vendor's products
            orders = orders.filter(order => {
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
        }

        // Attach customer risk score to each order
        const customerIds = [...new Set(orders.map(o => o.customer ? (o.customer._id || o.customer) : null).filter(id => id))];
        const alerts = await FraudAlert.aggregate([
            { $match: { userId: { $in: customerIds } } },
            { $sort: { createdAt: -1 } },
            { $group: { _id: '$userId', riskScore: { $first: '$riskScore' } } }
        ]);
        const riskMap = alerts.reduce((acc, alert) => {
            acc[alert._id.toString()] = alert.riskScore;
            return acc;
        }, {});

        orders.forEach(order => {
            if (order.customer) {
                const cid = order.customer._id ? order.customer._id.toString() : order.customer.toString();
                order.customerRiskScore = riskMap[cid] || 0;
            } else {
                order.customerRiskScore = 0;
            }
        });

        res.json(orders);
    } catch (error) {
        console.error('Vendor orders error:', error);
        res.status(500).json({ message: 'Error fetching vendor orders' });
    }
});

// Update Order Status (Vendor/Admin)
router.put('/:id/status', authMiddleware, async (req, res) => {
    try {
        if (req.userRole !== 'vendor' && req.userRole !== 'admin' && req.userRole !== 'manager') {
            return res.status(403).json({ message: 'Access denied' });
        }

        const { status, expectedDeliveryDate } = req.body;
        const order = await Order.findById(req.params.id);

        if (!order) {
            return res.status(404).json({ message: 'Order not found' });
        }

        // Status Validation Logic
        const current = order.status;

        // 1. Accept/Reject Flow
        if (current === 'Pending') {
            if (status !== 'Accepted' && status !== 'Rejected') {
                return res.status(400).json({ message: 'Pending orders can only be Accepted or Rejected' });
            }
            // When accepting, require expectedDeliveryDate
            if (status === 'Accepted') {
                if (!expectedDeliveryDate) {
                    return res.status(400).json({ message: 'Expected delivery date is required when accepting an order' });
                }
                order.expectedDeliveryDate = new Date(expectedDeliveryDate);
            }
        }
        // 2. Sequential Flow
        else if (current === 'Accepted') {
            if (status !== 'Packed') return res.status(400).json({ message: 'Next status must be Packed' });
        }
        else if (current === 'Packed') {
            if (status !== 'On Board') return res.status(400).json({ message: 'Next status must be On Board' });
        }
        else if (current === 'On Board') {
            if (status !== 'Delivered') return res.status(400).json({ message: 'Next status must be Delivered' });
        }
        else if (current === 'Rejected' || current === 'Delivered') {
            return res.status(400).json({ message: 'Order is closed' });
        }

        // Set actualDeliveryDate when marking as delivered
        if (status === 'Delivered') {
            order.actualDeliveryDate = new Date();

            // Check if delivery is delayed by comparing actual delivery date with expected delivery date
            if (order.expectedDeliveryDate) {
                const expectedDate = new Date(order.expectedDeliveryDate);
                expectedDate.setHours(23, 59, 59, 999); // End of expected delivery day

                if (order.actualDeliveryDate > expectedDate) {
                    // Delivery is late - mark as Delayed Delivery
                    order.status = 'Delayed Delivery';
                } else {
                    order.status = status;
                }
            } else {
                order.status = status;
            }
        } else {
            order.status = status;
        }
        await order.save();

        // [Real-time Ping] Emit status update via Socket.io
        const io = req.app.get('io');
        const userSockets = req.app.get('userSockets');
        const customerSocketId = userSockets[order.customer.toString()];
        
        if (io && customerSocketId) {
            io.to(customerSocketId).emit('statusUpdate', {
                orderId: order._id,
                status: order.status,
                message: `Your order #${order._id.toString().slice(-6)} is now ${order.status}`
            });
        }

        res.json(order);

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error updating order status' });
    }
});

// Submit Feedback (Customer)
router.post('/:id/feedback', authMiddleware, async (req, res) => {
    try {
        const { rating, comment } = req.body;
        const order = await Order.findOne({ _id: req.params.id, customer: req.userId });

        if (!order) {
            return res.status(404).json({ message: 'Order not found or access denied' });
        }

        if (order.status !== 'Delivered' && order.status !== 'Delayed Delivery') {
            return res.status(400).json({ message: 'Feedback can only be submitted for delivered orders' });
        }

        order.feedback = {
            rating,
            comment,
            createdAt: new Date()
        };

        await order.save();
        res.json(order);
    } catch (error) {
        console.error('Feedback submission error:', error);
        res.status(500).json({ message: 'Error submitting feedback' });
    }
});

module.exports = router;
