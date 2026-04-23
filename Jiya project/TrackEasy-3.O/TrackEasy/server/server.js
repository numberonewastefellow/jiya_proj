require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const authRoutes = require('./routes/auth');
const authMiddleware = require('./middleware/auth');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Map UserID to SocketID
const userSockets = new Map();

io.on('connection', (socket) => {
    console.log('🔌 New client connected:', socket.id);

    socket.on('join', (userId) => {
        userSockets.set(userId, socket.id);
        console.log(`👤 User ${userId} joined their private channel`);
    });

    socket.on('disconnect', () => {
        for (const [userId, socketId] of userSockets.entries()) {
            if (socketId === socket.id) {
                userSockets.delete(userId);
                break;
            }
        }
    });
});

// Expose io and userSockets to routes
app.set('io', io);
app.set('userSockets', userSockets);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files from public directory (public assets still accessible)
app.use(express.static(path.join(__dirname, 'public')));

// Protect dashboard pages with server-side auth + role checks
// Admin page: only 'admin' role allowed
app.get('/admin-dashboard.html', authMiddleware, (req, res) => {
    if (req.userRole !== 'admin') {
        return res.status(403).send('Forbidden');
    }
    res.sendFile(path.join(__dirname, 'public', 'admin-dashboard.html'));
});

// Vendor page: allow 'vendor' and 'admin'
app.get('/vendor-dashboard.html', authMiddleware, (req, res) => {
    const role = req.userRole || '';
    if (!(role === 'vendor' || role === 'admin')) {
        return res.status(403).send('Forbidden');
    }
    res.sendFile(path.join(__dirname, 'public', 'vendor-dashboard.html'));
});

// Customer page: allow 'customer' and 'admin'
app.get('/customer-dashboard.html', authMiddleware, (req, res) => {
    const role = req.userRole || '';
    if (!(role === 'customer' || role === 'admin')) {
        return res.status(403).send('Forbidden');
    }
    res.sendFile(path.join(__dirname, 'public', 'customer-dashboard.html'));
});

// Manager page: allow 'manager' and 'admin'
app.get('/manager-dashboard.html', authMiddleware, (req, res) => {
    const role = req.userRole || '';
    if (!(role === 'manager' || role === 'admin')) {
        return res.status(403).send('Forbidden');
    }
    res.sendFile(path.join(__dirname, 'public', 'manager-dashboard.html'));
});

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('✅ Connected to MongoDB'))
    .catch((err) => console.error('❌ MongoDB connection error:', err));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/shop', require('./routes/shop'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/manager', require('./routes/manager'));

// API 404 Handler
app.use('/api/*', (req, res) => {
    res.status(404).json({ message: 'API Endpoint not found' });
});

// Global Error Handler
app.use((err, req, res, next) => {
    console.error(err.stack);
    if (req.path.startsWith('/api')) {
        res.status(500).json({ message: 'Internal Server Error', error: err.message });
    } else {
        next(err);
    }
});

// Serve index.html for root route
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
});
