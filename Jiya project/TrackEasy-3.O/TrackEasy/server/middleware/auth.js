const jwt = require('jsonwebtoken');
const User = require('../models/User');

const authMiddleware = async (req, res, next) => {
    try {
        // Get token from header
        const token = req.header('Authorization')?.replace('Bearer ', '');

        if (!token) {
            return res.status(401).json({
                success: false,
                message: 'No authentication token, access denied'
            });
        }

        // Verify token
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.userId = decoded.userId;
        // Attach role when present so routes can perform role checks
        if (decoded.role) req.userRole = decoded.role;

        // Check if user is blocked or has been deleted
        const user = await User.findById(decoded.userId);
        if (!user) {
            return res.status(401).json({
                success: false,
                message: 'User account not found. Please log in again.'
            });
        }

        // Note: isBlocked is NOT checked here. Blocked users are allowed to log in,
        // browse, and view their dashboard. The block is enforced only at order-placement
        // routes (see server/routes/orders.js).

        next();
    } catch (error) {
        res.status(401).json({
            success: false,
            message: 'Token is invalid or expired'
        });
    }
};

module.exports = authMiddleware;
