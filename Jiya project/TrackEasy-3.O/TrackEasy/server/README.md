# 🔐 Full-Fledged Login & Signup System

A modern, secure authentication system built with Node.js, Express, MongoDB, and JWT tokens. Features a beautiful, responsive UI with glassmorphism effects and smooth animations.

## ✨ Features

- **Secure Authentication**: JWT-based authentication with bcrypt password hashing
- **User Registration**: Create new accounts with validation
- **User Login**: Authenticate existing users
- **Protected Routes**: Dashboard accessible only to authenticated users
- **Beautiful UI**: Modern glassmorphism design with smooth animations
- **Responsive Design**: Works perfectly on all devices
- **Form Validation**: Client-side and server-side validation
- **Error Handling**: Comprehensive error messages and user feedback

## 🛠️ Tech Stack

### Backend
- **Node.js** - Runtime environment
- **Express.js** - Web framework
- **MongoDB** - Database
- **Mongoose** - MongoDB ODM
- **JWT** - JSON Web Tokens for authentication
- **bcryptjs** - Password hashing
- **dotenv** - Environment configuration
- **CORS** - Cross-origin resource sharing

### Frontend
- **HTML5** - Structure
- **CSS3** - Styling with modern effects
- **Vanilla JavaScript** - Client-side logic
- **Google Fonts (Inter)** - Typography

## 📋 Prerequisites

Before running this application, make sure you have:

- **Node.js** (v14 or higher) installed
- **MongoDB** installed and running locally
- **npm** or **yarn** package manager

## 🚀 Getting Started

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

The `.env` file is already created with default settings:

```env
MONGODB_URI=mongodb://localhost:27017/auth-system
JWT_SECRET=your_super_secret_jwt_key_change_this_in_production
PORT=5001
```

**Important**: Change the `JWT_SECRET` to a strong random string in production!

### 3. Start MongoDB

Make sure MongoDB is running on your system:

```bash
# Windows (if installed as service)
net start MongoDB

# macOS/Linux
mongod
```

### 4. Run the Application

**Development mode** (with auto-restart):
```bash
npm run dev
```

**Production mode**:
```bash
npm start
```

The server will start at `http://localhost:5001`

## 📡 API Endpoints

### Authentication Endpoints

#### POST `/api/auth/signup`
Register a new user

**Request Body:**
```json
{
  "username": "johndoe",
  "email": "john@example.com",
  "password": "password123"
}
```

**Response:**
```json
{
  "success": true,
  "message": "User registered successfully"
}
```

#### POST `/api/auth/login`
Login an existing user

**Request Body:**
```json
{
  "email": "john@example.com",
  "password": "password123"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Login successful",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": "...",
    "username": "johndoe",
    "email": "john@example.com"
  }
}
```

#### GET `/api/auth/verify`
Verify JWT token (Protected Route)

**Headers:**
```
Authorization: Bearer <token>
```

**Response:**
```json
{
  "success": true,
  "user": {
    "id": "...",
    "username": "johndoe",
    "email": "john@example.com"
  }
}
```

## 📁 Project Structure

```
login/
├── models/
│   └── User.js              # User model with Mongoose schema
├── routes/
│   └── auth.js              # Authentication routes
├── middleware/
│   └── auth.js              # JWT verification middleware
├── public/
│   ├── index.html           # Login/Signup page
│   ├── dashboard.html       # Protected dashboard
│   ├── styles.css           # CSS styling
│   └── app.js               # Frontend JavaScript
├── .env                     # Environment variables
├── server.js                # Express server setup
├── package.json             # Dependencies and scripts
└── README.md                # Documentation
```

## 🎨 UI Features

- **Glassmorphism Effects**: Modern frosted glass design
- **Animated Background**: Floating gradient shapes
- **Smooth Transitions**: Hover effects and animations
- **Form Validation**: Real-time feedback
- **Loading Indicators**: Visual feedback during API calls
- **Responsive Layout**: Mobile-first design

## 🔒 Security Features

- **Password Hashing**: Bcrypt with salt rounds
- **JWT Tokens**: Secure authentication tokens (7-day expiry)
- **Input Validation**: Server-side and client-side validation
- **Protected Routes**: Middleware-based route protection
- **CORS Configuration**: Controlled cross-origin access

## 🧪 Testing the Application

1. **Start the server**: `npm run dev`
2. **Open browser**: Navigate to `http://localhost:5001`
3. **Create account**: Click "Sign up here" and fill the form
4. **Login**: Use your credentials to log in
5. **View dashboard**: You'll be redirected to the protected dashboard
6. **Logout**: Click logout to clear session

## 📝 Development Notes

- JWT tokens are stored in `localStorage`
- Password minimum length: 6 characters
- Username minimum length: 3 characters
- Email validation uses regex pattern
- MongoDB connection uses local instance by default

## 🤝 Contributing

Feel free to fork this project and submit pull requests for improvements!

## 📄 License

ISC License - Feel free to use this project for learning and development.

---

Built with ❤️ using Node.js, Express, MongoDB, and modern web technologies
