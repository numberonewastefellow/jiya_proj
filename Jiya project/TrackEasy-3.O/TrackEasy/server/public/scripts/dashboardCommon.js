// Common helpers for dashboards: auth check and logout
document.addEventListener('DOMContentLoaded', () => {
  const logoutBtn = document.getElementById('logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
      localStorage.removeItem('authToken');
      localStorage.removeItem('user');
      window.location.href = '/';
    });
  }

  // Redirect to login if not authenticated
  const token = localStorage.getItem('authToken');
  if (!token) {
    // Allow access to index.html itself
    if (!window.location.pathname.endsWith('/')) {
      // Not authenticated, go to login page
      window.location.href = '/';
    }
  }
});

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
