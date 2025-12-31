document.addEventListener('DOMContentLoaded', function() {
  const loginView = document.getElementById('login-view');
  const loggedInView = document.getElementById('logged-in-view');
  const loginForm = document.getElementById('login-form');
  const googleLoginBtn = document.getElementById('google-login-btn');
  const logoutBtn = document.getElementById('logout-btn');
  const errorMessage = document.getElementById('error-message');
  const loginBtn = document.getElementById('login-btn');

  function showLoggedIn() {
    loginView.style.display = 'none';
    loggedInView.style.display = 'block';
  }

  function showLogin() {
    loggedInView.style.display = 'none';
    loginView.style.display = 'block';
    errorMessage.textContent = '';
  }

  // Check storage for token
  chrome.storage.local.get(['token'], function(result) {
    if (result.token) {
      showLoggedIn();
    } else {
      showLogin();
    }
  });

  // Handle Credentials Login
  loginForm.addEventListener('submit', function(event) {
    event.preventDefault();
    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;

    if (!email || !password) {
      errorMessage.textContent = 'Please fill in all fields.';
      return;
    }

    loginBtn.textContent = 'Logging in...';
    loginBtn.disabled = true;
    errorMessage.textContent = '';

    chrome.runtime.sendMessage({
      type: 'extension_login',
      data: { email, password }
    }, function(response) {
      loginBtn.textContent = 'Log In';
      loginBtn.disabled = false;

      if (response && response.success) {
        showLoggedIn();
      } else {
        errorMessage.textContent = (response && response.message) || 'Login failed.';
      }
    });
  });

  // Handle Google Login
  googleLoginBtn.addEventListener('click', function() {
    errorMessage.textContent = '';
    
    chrome.runtime.sendMessage({ type: 'google_login' }, function(response) {
      if (response && response.success) {
        showLoggedIn();
      } else {
        errorMessage.textContent = (response && response.message) || 'Google sign-in failed.';
      }
    });
  });

  // Handle Logout
  logoutBtn.addEventListener('click', function() {
    chrome.storage.local.remove('token', function() {
      showLogin();
    });
  });
});