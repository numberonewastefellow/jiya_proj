# Technology Stack

This document outlines the technologies used in the TrackEasy application, including their purpose, implementation details, and relevant code snippets from the codebase.

## Backend Technologies

### 1. Node.js & Express
**Purpose:** Application Server & Web Framework
**Implementation:** Express is used to set up the server, configure middleware (CORS, JSON parsing), and define routes.
**Code Example:** `server/server.js`
```javascript
const express = require('express');
const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Start server
const PORT = process.env.PORT || 5001;
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
});
```

### 2. MongoDB & Mongoose
**Purpose:** Database & Object Modeling
**Implementation:** Mongoose connects to MongoDB and defines schemas for data validation.
**Code Example:** `server/server.js` (Connection)
```javascript
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('✅ Connected to MongoDB'))
    .catch((err) => console.error('❌ MongoDB connection error:', err));
```
**Code Example:** `server/models/User.js` (Schema)
```javascript
const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    role: { type: String, enum: ['customer', 'vendor', 'admin'] }
});
```

### 3. JWT (JSON Web Tokens)
**Purpose:** Stateless Authentication
**Implementation:** Tokens are signed upon login and verified in middleware to protect routes.
**Code Example:** `server/routes/auth.js` (Sign)
```javascript
const token = jwt.sign(
    { userId: user._id, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
);
```
**Code Example:** `server/middleware/auth.js` (Verify)
```javascript
const token = req.header('Authorization')?.replace('Bearer ', '');
const decoded = jwt.verify(token, process.env.JWT_SECRET);
req.userId = decoded.userId;
```

### 4. Bcryptjs
**Purpose:** Password Security
**Implementation:** Hashes passwords before saving and compares hashes during login.
**Code Example:** `server/routes/auth.js`
```javascript
// Hash password
const salt = await bcrypt.genSalt(10);
const hashedPassword = await bcrypt.hash(password, salt);

// Compare password
const isPasswordValid = await bcrypt.compare(password, user.password);
```

### 5. Redis
**Purpose:** Caching
**Implementation:** Caches product data to reduce database load. Invalidates cache on updates.
**Code Example:** `server/routes/shop.js`
```javascript
// Check Cache
const cachedProducts = await redisClient.get(cacheKey);
if (cachedProducts) return res.json(JSON.parse(cachedProducts));

// Set Cache
await redisClient.set(cacheKey, JSON.stringify(products), { EX: 3600 });
```

### 6. Multer
**Purpose:** File Uploads
**Implementation:** Handles `multipart/form-data` for uploading product images.
**Code Example:** `server/routes/shop.js`
```javascript
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'public/images/uploads'),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage: storage });
```

### 7. Dotenv
**Purpose:** Configuration
**Implementation:** Loads environment variables from `.env`.
**Code Example:** `server/server.js`
```javascript
require('dotenv').config();
// Usage: process.env.MONGODB_URI
```

## Frontend Technologies

### 1. Fetch API (Vanilla JS)
**Purpose:** API Interaction
**Implementation:** Used to make HTTP requests to the backend, handling headers and authentication.
**Code Example:** `server/public/scripts/api.js`
```javascript
export async function get(path) {
  const token = localStorage.getItem('authToken');
  const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
  
  const res = await fetch(`/api${path}`, {
    method: 'GET',
    headers: headers
  });
  return res.json();
}
```

### 2. HTML5 & CSS3
**Purpose:** Structure & Styling
**Implementation:** Standard HTML files for structure and CSS for styling without frameworks.
**Code Example:** `server/public/index.html`
```html
<!DOCTYPE html>
<html lang="en">
<head>
    <link rel="stylesheet" href="styles/styles.css">
</head>
<body>
    <!-- Content -->
</body>
</html>
```
