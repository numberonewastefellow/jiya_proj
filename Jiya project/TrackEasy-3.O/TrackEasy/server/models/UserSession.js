const mongoose = require('mongoose');

const userSessionSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    ipAddress: {
        type: String,
        required: true
    },
    deviceType: {
        type: String,
        required: true
    },
    browser: {
        type: String,
        required: true
    },
    location: {
        type: String,
        required: true
    },
    loginTime: {
        type: Date,
        default: Date.now
    }
}, {
    timestamps: true
});

module.exports = mongoose.model('UserSession', userSessionSchema);
