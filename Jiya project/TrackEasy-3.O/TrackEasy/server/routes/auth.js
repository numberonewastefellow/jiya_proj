const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const authMiddleware = require('../middleware/auth');

// Signup Route
router.post('/signup', async (req, res) => {
    try {
        const { username, email, password, role, phoneNumber, deviceFingerprint } = req.body;

        // Validate input
        if (!username || !email || !password || !role || !phoneNumber) {
            return res.status(400).json({
                success: false,
                message: 'Please provide all required fields including phone number'
            });
        }

        // Validate role
        if (!['customer', 'vendor', 'admin', 'manager'].includes(role.toLowerCase())) {
            return res.status(400).json({
                success: false,
                message: 'Role must be either customer, vendor, admin or manager'
            });
        }

        // Check if user already exists
        const existingUser = await User.findOne({
            $or: [
                { email: email.toLowerCase() },
                { username },
                { phoneNumber }
            ]
        });

        if (existingUser) {
            let message = 'User already exists';
            if (existingUser.email === email.toLowerCase()) message = 'This email is already registered';
            else if (existingUser.username === username) message = 'This username is already taken';
            else if (existingUser.phoneNumber === phoneNumber) message = 'This phone number is already registered';

            return res.status(400).json({
                success: false,
                message: message
            });
        }

        // Hash password
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        // Create new user
        const user = new User({
            username,
            email,
            password: hashedPassword,
            role: role.toLowerCase(),
            phoneNumber,
            deviceFingerprint // Store initial fingerprint
        });

        await user.save();

        res.status(201).json({
            success: true,
            message: 'User registered successfully'
        });
    } catch (error) {
        console.error('Signup error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error during registration'
        });
    }
});

// Login Route
router.post('/login', async (req, res) => {
    try {
        const { email, password, deviceFingerprint } = req.body;

        // Validate input
        if (!email || !password) {
            return res.status(400).json({
                success: false,
                message: 'Please provide email and password'
            });
        }

        // Check if user exists
        const user = await User.findOne({ email: email.toLowerCase() });
        if (!user) {
            return res.status(401).json({
                success: false,
                message: 'Invalid credentials'
            });
        }

        // Check if user is already blocked
        if (user.isBlocked) {
            return res.status(403).json({
                success: false,
                message: 'Your account has been blocked. Please contact support.'
            });
        }

        // Verify password
        const isPasswordValid = await bcrypt.compare(password, user.password);
        if (!isPasswordValid) {
            user.failedLoginAttempts = (user.failedLoginAttempts || 0) + 1;
            
            if (user.failedLoginAttempts >= 5) {
                user.isBlocked = true;
                user.blockReason = '5 consecutive failed login attempts';
                await user.save();
                return res.status(403).json({
                    success: false,
                    message: 'Your account has been blocked due to 5 consecutive failed login attempts.'
                });
            }
            
            await user.save();
            return res.status(401).json({
                success: false,
                message: `Invalid credentials. ${5 - user.failedLoginAttempts} attempts remaining.`
            });
        }

        // Reset failed login attempts on success
        if (user.failedLoginAttempts > 0 || (deviceFingerprint && !user.deviceFingerprint)) {
            user.failedLoginAttempts = 0;
            if (deviceFingerprint && !user.deviceFingerprint) {
                user.deviceFingerprint = deviceFingerprint;
            }
            await user.save();
        }

        // Generate JWT token
        const token = jwt.sign(
            { userId: user._id, role: user.role },
            process.env.JWT_SECRET,
            { expiresIn: '7d' }
        );

        // Notify Fraud Service about the login event
        try {
            // Use axios if available, otherwise fallback to fetch or skip
            const eventData = {
                userId: user._id,
                eventType: 'login',
                ipAddress: req.ip || req.connection.remoteAddress,
                deviceFingerprint: deviceFingerprint || req.headers['device-fingerprint'] || 'unknown',
                deviceType: req.headers['user-agent'] || 'unknown',
                location: 'unknown'
            };

            if (typeof fetch !== 'undefined') {
                await fetch('http://localhost:5002/api/fraud/log-event', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(eventData)
                }).catch(e => console.error('Fraud log-event failed:', e.message));
            } else {
                console.warn('fetch is not defined in this Node environment. Skipping login tracking.');
            }
        } catch (err) {
            console.error('Fraud service unreachable for login tracking', err.message);
        }

        res.json({
            success: true,
            message: 'Login successful',
            token,
            user: {
                id: user._id,
                username: user.username,
                email: user.email,
                role: user.role
            }
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error: ' + error.message
        });
    }
});

// Verify Token Route (Protected)
router.get('/verify', authMiddleware, async (req, res) => {
    try {
        const user = await User.findById(req.userId).select('-password');
        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        res.json({
            success: true,
            user: {
                id: user._id,
                username: user.username,
                email: user.email,
                role: user.role,
                phoneNumber: user.phoneNumber,
                address: user.address
            }
        });
    } catch (error) {
        console.error('Verify error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error during verification'
        });
    }
});

// Change Password Route
router.post('/change-password', authMiddleware, async (req, res) => {
    try {
        const { oldPassword, newPassword } = req.body;

        if (!oldPassword || !newPassword) {
            return res.status(400).json({
                success: false,
                message: 'Please provide both old and new passwords'
            });
        }

        if (newPassword.length < 6) {
            return res.status(400).json({
                success: false,
                message: 'New password must be at least 6 characters long'
            });
        }

        const user = await User.findById(req.userId);
        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        // Verify old password
        const isMatch = await bcrypt.compare(oldPassword, user.password);
        if (!isMatch) {
            return res.status(400).json({
                success: false,
                message: 'Incorrect old password'
            });
        }

        // Hash new password
        const salt = await bcrypt.genSalt(10);
        user.password = await bcrypt.hash(newPassword, salt);
        await user.save();

        res.json({
            success: true,
            message: 'Password updated successfully'
        });
    } catch (error) {
        console.error('Change password error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error during password change'
        });
    }
});

// Update Profile Route
router.put('/profile', authMiddleware, async (req, res) => {
    try {
        const { phoneNumber, address } = req.body;
        const updates = {};

        if (phoneNumber) {
            if (!/^\d{10}$/.test(phoneNumber)) {
                return res.status(400).json({
                    success: false,
                    message: 'Phone number must be exactly 10 digits'
                });
            }
            
            // Check if phone number is already taken by another user
            const existingUser = await User.findOne({ phoneNumber, _id: { $ne: req.userId } });
            if (existingUser) {
                return res.status(400).json({
                    success: false,
                    message: 'This phone number is already in use by another account'
                });
            }
            
            updates.phoneNumber = phoneNumber;
        }

        if (address) {
            if (address.trim().length === 0) {
                return res.status(400).json({
                    success: false,
                    message: 'Address cannot be empty'
                });
            }
            updates.address = address.trim();
        }

        const user = await User.findByIdAndUpdate(
            req.userId,
            { $set: updates },
            { new: true, runValidators: true }
        ).select('-password');

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        res.json({
            success: true,
            message: 'Profile updated successfully',
            user: {
                id: user._id,
                username: user.username,
                email: user.email,
                role: user.role,
                phoneNumber: user.phoneNumber,
                address: user.address
            }
        });
    } catch (error) {
        console.error('Profile update error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error during profile update'
        });
    }
});

// Register Passkey Route (Mock/Simulated)
router.post('/register-passkey', authMiddleware, async (req, res) => {
    try {
        const user = await User.findById(req.userId);
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });

        // SIMULATION: Create a random Passkey ID and Public Key
        user.passkeyId = `pk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        user.passkeyPublicKey = `key-${Math.random().toString(36).slice(2)}`;
        await user.save();

        res.json({ success: true, message: 'Passkey registered successfully' });
    } catch (error) {
        console.error('Passkey registration error:', error);
        res.status(500).json({ success: false, message: 'Server error during passkey registration' });
    }
});

module.exports = router;
