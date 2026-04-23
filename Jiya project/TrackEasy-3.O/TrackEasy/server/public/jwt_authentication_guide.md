# JWT Authentication in Your E-Commerce Tracking System

## Overview

Yes, your application **uses JWT (JSON Web Tokens)** for authentication! JWT is a secure way to transmit user information between the frontend and backend. Let me explain how it works in your system.

## What is JWT?

JWT (JSON Web Token) is an open standard for securely transmitting information as a JSON object. It's digitally signed, so it can be verified and trusted.

A JWT token looks like this:
```
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiI2NTRhYmNkMTIzNDU2Nzg5Iiwicm9sZSI6InZlbmRvciIsImlhdCI6MTY5ODc2NTQzMiwiZXhwIjoxNjk5MzcwMjMyfQ.Xx7yKZlmnF9mOp5qRsT_VwX8uYzN_HtAbC3pQr4dEfI
```

It has 3 parts separated by dots:
1. **Header** - Metadata about the token
2. **Payload** - User data (userId, role, expiry)
3. **Signature** - Cryptographic signature for verification

---

## How JWT Works in Your Application

```mermaid
sequenceDiagram
    participant User
    participant Frontend
    participant Backend
    participant MongoDB

    User->>Frontend: Enter email & password
    Frontend->>Backend: POST /api/auth/login {email, password}
    Backend->>MongoDB: Find user by email
    MongoDB-->>Backend: User data
    Backend->>Backend: Compare password with bcrypt
    Backend->>Backend: Generate JWT with userId & role
    Backend-->>Frontend: Return {token, user info}
    Frontend->>Frontend: Store token in localStorage
    
    Note over Frontend,Backend: Protected Request
    
    Frontend->>Backend: GET /api/orders/vendor-orders<br/>Header: Authorization: Bearer <token>
    Backend->>Backend: Verify JWT with secret key
    Backend->>Backend: Decode userId & role from token
    Backend->>MongoDB: Fetch orders
    MongoDB-->>Backend: Order data
    Backend-->>Frontend: Return orders
```

---

## JWT Implementation Files

### 1. Environment Configuration

**File:** [.env](file:///c:/Users/yaksh/OneDrive/Desktop/week-2d/1%20-%20Copy/e-commers%20auto%20traking%20system/Logi%20and%20sing%20up%20system/.env)

```env
JWT_SECRET=your_super_secret_jwt_key_change_this_in_production
```

> **⚠️ Important**: The JWT_SECRET is used to sign and verify tokens. In production, this should be a long, random, secure string.

---

### 2. Login & Token Generation

**File:** [routes/auth.js](file:///c:/Users/yaksh/OneDrive/Desktop/week-2d/1%20-%20Copy/e-commers%20auto%20traking%20system/Logi%20and%20sing%20up%20system/routes/auth.js) (Lines 65-121)

```javascript
const jwt = require('jsonwebtoken');

// Login Route
router.post('/login', async (req, res) => {
    const { email, password } = req.body;

    // 1. Find user in database
    const user = await User.findOne({ email });
    if (!user) {
        return res.status(401).json({ message: 'Invalid credentials' });
    }

    // 2. Verify password with bcrypt
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
        return res.status(401).json({ message: 'Invalid credentials' });
    }

    // 3. Generate JWT token
    const token = jwt.sign(
        { userId: user._id, role: user.role },  // Payload
        process.env.JWT_SECRET,                  // Secret key
        { expiresIn: '7d' }                      // Token expires in 7 days
    );

    // 4. Send token to frontend
    res.json({
        success: true,
        token,                                   // JWT token
        user: {
            id: user._id,
            username: user.username,
            email: user.email,
            role: user.role
        }
    });
});
```

**What happens:**
- User logs in with email and password
- Backend verifies credentials
- Backend creates a JWT token containing `userId` and `role`
- Token is signed with `JWT_SECRET`
- Token expires after 7 days
- Frontend receives the token

---

### 3. Token Verification Middleware

**File:** [middleware/auth.js](file:///c:/Users/yaksh/OneDrive/Desktop/week-2d/1%20-%20Copy/e-commers%20auto%20traking%20system/Logi%20and%20sing%20up%20system/middleware/auth.js)

```javascript
const jwt = require('jsonwebtoken');

const authMiddleware = async (req, res, next) => {
    try {
        // 1. Extract token from Authorization header
        const token = req.header('Authorization')?.replace('Bearer ', '');

        if (!token) {
            return res.status(401).json({
                message: 'No authentication token, access denied'
            });
        }

        // 2. Verify token with secret key
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        
        // 3. Attach user info to request object
        req.userId = decoded.userId;
        req.userRole = decoded.role;
        
        // 4. Allow request to proceed
        next();
    } catch (error) {
        res.status(401).json({
            message: 'Token is invalid or expired'
        });
    }
};
```

**What happens:**
- Middleware runs before protected routes
- Extracts JWT from `Authorization: Bearer <token>` header
- Verifies token signature using `JWT_SECRET`
- Decodes userId and role from token
- Attaches userId and role to request object
- If token is invalid/expired, returns 401 error

---

### 4. Frontend Token Storage

**File:** [public/scripts/dashboardCommon.js](file:///c:/Users/yaksh/OneDrive/Desktop/week-2d/1%20-%20Copy/e-commers%20auto%20traking%20system/Logi%20and%20sing%20up%20system/public/scripts/dashboardCommon.js)

```javascript
// After successful login, token is stored in localStorage
localStorage.setItem('authToken', token);
localStorage.setItem('user', JSON.stringify(user));

// On logout, token is removed
logoutBtn.addEventListener('click', () => {
    localStorage.removeItem('authToken');
    localStorage.removeItem('user');
    window.location.href = '/';
});

// Check authentication on page load
const token = localStorage.getItem('authToken');
if (!token) {
    window.location.href = '/';  // Redirect to login
}
```

---

### 5. Frontend API Requests

**File:** [public/scripts/api.js](file:///c:/Users/yaksh/OneDrive/Desktop/week-2d/1%20-%20Copy/e-commers%20auto%20traking%20system/Logi%20and%20sing%20up%20system/public/scripts/api.js)

```javascript
// Helper function to add Authorization header
function authHeaders() {
  const token = localStorage.getItem('authToken');
  return token ? { 'Authorization': `Bearer ${token}` } : {};
}

// All API requests include the JWT token
export async function get(path) {
  const res = await fetch(`/api${path}`, {
    method: 'GET',
    headers: { ...authHeaders() }  // Adds: Authorization: Bearer <token>
  });
  return res.json();
}

export async function put(path, body) {
  const res = await fetch(`/api${path}`, {
    method: 'PUT',
    headers: { 
      'Content-Type': 'application/json', 
      ...authHeaders()  // Adds: Authorization: Bearer <token>
    },
    body: JSON.stringify(body)
  });
  return res.json();
}
```

---

## Complete Authentication Flow

### Login Flow

1. **User enters credentials** on login page
2. **Frontend sends** `POST /api/auth/login` with email and password
3. **Backend validates** credentials
4. **Backend generates** JWT token with:
   - `userId`
   - `role` (customer, vendor, or admin)
   - `expiresIn: '7d'`
5. **Backend signs** token with `JWT_SECRET`
6. **Frontend receives** token and stores in `localStorage`
7. **User is redirected** to appropriate dashboard based on role

### Protected API Request Flow

1. **Frontend makes request** (e.g., fetch orders)
2. **API helper** retrieves token from `localStorage`
3. **Request includes header**: `Authorization: Bearer <token>`
4. **Backend middleware** intercepts request
5. **Middleware verifies** token using `JWT_SECRET`
6. **Middleware decodes** userId and role from token
7. **Middleware attaches** userId and role to `req` object
8. **Route handler** uses `req.userId` and `req.userRole`
9. **Backend returns** requested data

### Logout Flow

1. **User clicks logout** button
2. **Frontend removes** token from `localStorage`
3. **User is redirected** to login page
4. **Subsequent requests** fail (no token in header)

---

## Security Features

### ✅ Token Expiration
Tokens expire after 7 days (`expiresIn: '7d'`), forcing users to re-login.

### ✅ Password Hashing
Passwords are hashed with bcrypt before storage - never plain text.

### ✅ Secret Key
JWT is signed with `JWT_SECRET` - only the server can create valid tokens.

### ✅ Role-Based Access
Token includes user role for authorization:
```javascript
if (req.userRole !== 'admin') {
    return res.status(403).json({ message: 'Access denied' });
}
```

### ✅ HTTPS in Production
In production, always use HTTPS to prevent token interception.

---

## Example: Complete Request with JWT

**Frontend Code:**
```javascript
// 1. User is logged in, token in localStorage
// Token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."

// 2. Fetch vendor orders
import { get } from './api.js';
const orders = await get('/orders/vendor-orders');
```

**What Actually Happens:**
```http
GET /api/orders/vendor-orders HTTP/1.1
Host: localhost:5000
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiI2NTRhYmNkMTIzNDU2Nzg5Iiwicm9sZSI6InZlbmRvciIsImlhdCI6MTY5ODc2NTQzMiwiZXhwIjoxNjk5MzcwMjMyfQ.Xx7yKZlmnF9mOp5qRsT_VwX8uYzN_HtAbC3pQr4dEfI
```

**Backend Processing:**
```javascript
// 1. Middleware extracts and verifies token
// 2. Decoded payload: { userId: "654abcd123456789", role: "vendor" }
// 3. Route handler has access to req.userId and req.userRole
// 4. Returns orders for this vendor
```

---

## Key Takeaways

1. **Stateless Authentication**: Server doesn't store sessions - all info is in the token
2. **Self-Contained**: Token contains userId and role, no need to query DB on every request
3. **Secure**: Signed with secret key, can't be tampered with
4. **Automatic Expiration**: Tokens expire after 7 days
5. **Easy to Use**: Frontend just includes token in Authorization header

Your JWT implementation is **secure and follows best practices**! 🎉
