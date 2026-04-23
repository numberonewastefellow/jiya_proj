import { getBrowserFingerprint } from './scripts/fingerprint.js';
const API_URL = '/api/auth';

// Get DOM elements
const loginForm = document.getElementById('loginForm');
const signupForm = document.getElementById('signupForm');
const showSignupBtn = document.getElementById('showSignup');
const showLoginBtn = document.getElementById('showLogin');
const loginFormElement = document.getElementById('loginFormElement');
const signupFormElement = document.getElementById('signupFormElement');

// Toggle between login and signup forms
showSignupBtn.addEventListener('click', (e) => {
    e.preventDefault();
    loginForm.classList.add('hidden');
    signupForm.classList.remove('hidden');
    clearMessages();
});

showLoginBtn.addEventListener('click', (e) => {
    e.preventDefault();
    signupForm.classList.add('hidden');
    loginForm.classList.remove('hidden');
    clearMessages();
});

// Handle Login
loginFormElement.addEventListener('submit', async (e) => {
    e.preventDefault();

    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;
    const errorDiv = document.getElementById('loginError');
    const loader = document.getElementById('loginLoader');
    const submitBtn = loginFormElement.querySelector('.btn');

    // Clear previous errors
    errorDiv.classList.remove('show');

    // Basic validation
    if (!email || !password) {
        showError(errorDiv, 'Please fill in all fields');
        return;
    }

    const emailRegex = /^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/;
    if (!emailRegex.test(email)) {
        showError(errorDiv, 'Please enter a valid email address');
        return;
    }

    // Show loader
    loader.classList.add('active');
    submitBtn.disabled = true;

    try {
        const fingerprint = await getBrowserFingerprint();
        const biometricsData = window.biometrics ? window.biometrics.getMetrics() : null;
        
        const response = await fetch(`${API_URL}/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ 
                email, 
                password, 
                deviceFingerprint: fingerprint,
                biometrics: biometricsData
            })
        });

        const data = await response.json();

        if (data.success) {
            // Store token in localStorage
            localStorage.setItem('authToken', data.token);
            localStorage.setItem('user', JSON.stringify(data.user));

            // Redirect based on user role
            const role = data.user.role;
            
            // Show Breach Alert if present
            if (data.breachAlert) {
                alert(data.breachAlert);
            }

            if (role === 'customer') {
                window.location.href = '/customer-dashboard.html';
            } else if (role === 'vendor') {
                window.location.href = '/vendor-dashboard.html';
            } else if (role === 'manager') {
                window.location.href = '/manager-dashboard.html';
            } else if (role === 'admin') {
                window.location.href = '/admin-dashboard.html';
            } else {
                // Fallback to generic dashboard
                window.location.href = '/dashboard.html';
            }
        } else {
            showError(errorDiv, data.message || 'Login failed');
        }
    } catch (error) {
        console.error('Login error:', error);
        showError(errorDiv, 'Network error. Please check if the server is running.');
    } finally {
        loader.classList.remove('active');
        submitBtn.disabled = false;
    }
});

// Handle Signup
signupFormElement.addEventListener('submit', async (e) => {
    e.preventDefault();

    const username = document.getElementById('signupUsername').value.trim();
    const email = document.getElementById('signupEmail').value.trim();
    const phoneNumber = document.getElementById('signupPhone').value.trim();
    const password = document.getElementById('signupPassword').value;
    const confirmPassword = document.getElementById('signupConfirmPassword').value;
    const role = document.getElementById('signupRole').value;
    const errorDiv = document.getElementById('signupError');
    const successDiv = document.getElementById('signupSuccess');
    const loader = document.getElementById('signupLoader');
    const submitBtn = signupFormElement.querySelector('.btn');

    // Clear previous messages
    errorDiv.classList.remove('show');
    successDiv.classList.remove('show');

    // Basic validation
    if (!username || !email || !password || !confirmPassword || !role) {
        showError(errorDiv, 'Please fill in all fields');
        return;
    }

    if (username.length < 3) {
        showError(errorDiv, 'Username must be at least 3 characters');
        return;
    }

    if (password.length < 6) {
        showError(errorDiv, 'Password must be at least 6 characters');
        return;
    }

    if (password !== confirmPassword) {
        showError(errorDiv, 'Passwords do not match');
        return;
    }

    // Email validation
    const emailRegex = /^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/;
    if (!emailRegex.test(email)) {
        showError(errorDiv, 'Please enter a valid email address');
        return;
    }

    // Phone validation
    if (!/^\d{10}$/.test(phoneNumber)) {
        showError(errorDiv, 'Please enter a valid 10-digit phone number');
        return;
    }

    // Show loader
    loader.classList.add('active');
    submitBtn.disabled = true;

    try {
        const fingerprint = await getBrowserFingerprint();
        const response = await fetch(`${API_URL}/signup`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ username, email, phoneNumber, password, role, deviceFingerprint: fingerprint })
        });

        const data = await response.json();

        if (data.success) {
            showSuccess(successDiv, 'Account created successfully! Redirecting to login...');
            signupFormElement.reset();

            // Switch to login after 2 seconds
            setTimeout(() => {
                signupForm.classList.add('hidden');
                loginForm.classList.remove('hidden');
                document.getElementById('loginEmail').value = email;
            }, 2000);
        } else {
            showError(errorDiv, data.message || 'Signup failed');
        }
    } catch (error) {
        console.error('Signup error:', error);
        showError(errorDiv, 'Network error. Please check if the server is running.');
    } finally {
        loader.classList.remove('active');
        submitBtn.disabled = false;
    }
});

// Helper functions
function showError(element, message) {
    element.textContent = message;
    element.classList.add('show');
}

function showSuccess(element, message) {
    element.textContent = message;
    element.classList.add('show');
}

function togglePasswordVisibility(inputId) {
    const input = document.getElementById(inputId);
    const eyeClosed = document.getElementById(`${inputId}-eye-closed`);
    const eyeOpen = document.getElementById(`${inputId}-eye-open`);

    if (input.type === 'password') {
        input.type = 'text';
        eyeClosed.classList.add('hidden');
        eyeOpen.classList.remove('hidden');
    } else {
        input.type = 'password';
        eyeClosed.classList.remove('hidden');
        eyeOpen.classList.add('hidden');
    }
}
window.togglePasswordVisibility = togglePasswordVisibility;

function clearMessages() {
    document.querySelectorAll('.error-message, .success-message').forEach(el => {
        el.classList.remove('show');
    });
}

// Check if user is already logged in
window.addEventListener('DOMContentLoaded', () => {
    const token = localStorage.getItem('authToken');
    if (token && window.location.pathname === '/') {
        // Verify token is still valid
        fetch(`${API_URL}/verify`, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        })
            .then(response => response.json())
            .then(data => {
                if (data.success) {
                    // Redirect based on user role
                    const role = data.user.role;
                    if (role === 'customer') {
                        window.location.href = '/customer-dashboard.html';
                    } else if (role === 'vendor') {
                        window.location.href = '/vendor-dashboard.html';
                    } else if (role === 'manager') {
                        window.location.href = '/manager-dashboard.html';
                    } else if (role === 'admin') {
                        window.location.href = '/admin-dashboard.html';
                    } else {
                        window.location.href = '/dashboard.html';
                    }
                } else {
                    localStorage.removeItem('authToken');
                    localStorage.removeItem('user');
                }
            })
            .catch(() => {
                localStorage.removeItem('authToken');
                localStorage.removeItem('user');
            });
    }
});
