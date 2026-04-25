const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    username: {
        type: String,
        required: [true, 'Username is required'],
        unique: true,
        trim: true,
        minlength: [3, 'Username must be at least 3 characters long']
    },
    email: {
        type: String,
        required: [true, 'Email is required'],
        unique: true,
        lowercase: true,
        trim: true,
        match: [/^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/, 'Please provide a valid email address']
    },
    password: {
        type: String,
        required: [true, 'Password is required'],
        minlength: [6, 'Password must be at least 6 characters long']
    },
    role: {
        type: String,
        required: [true, 'Role is required'],
        enum: {
            values: ['customer', 'vendor', 'admin', 'manager'],
            message: 'Role must be either customer, vendor, admin or manager'
        },
        lowercase: true
    },
    phoneNumber: {
        type: String,
        required: [true, 'Phone number is required'],
        unique: true,
        trim: true,
        match: [/^\d{10}$/, 'Please provide a valid 10-digit phone number']
    },
    address: {
        type: String,
        trim: true
    },
    otp: {
        type: String
    },
    otpExpiry: {
        type: Date
    },
    failedOTPAttempts: {
        type: Number,
        default: 0
    },
    failedLoginAttempts: {
        type: Number,
        default: 0
    },
    blockReason: {
        type: String
    },
    isBlocked: {
        type: Boolean,
        default: false
    },
    blockedAt: {
        type: Date
    },
    blockedUntil: {
        type: Date
    },
    deviceFingerprint: {
        type: String,
        trim: true
    },
    passkeyId: {
        type: String,
        trim: true
    },
    passkeyPublicKey: {
        type: String,
        trim: true
    },
    lastCheckoutDuration: {
        type: Number, // in milliseconds
        default: 60000 // default 60s
    }
}, {
    timestamps: true
});

module.exports = mongoose.model('User', userSchema);
