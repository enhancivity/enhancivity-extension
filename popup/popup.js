document.addEventListener('DOMContentLoaded', function() {
  const loginView = document.getElementById('login-view');
  const loggedInView = document.getElementById('logged-in-view');
  const loginBtn = document.getElementById('login-btn');
  const logoutBtn = document.getElementById('logout-btn');

  function showLoggedIn() {
    loginView.style.display = 'none';
    loggedInView.style.display = 'block';
  }

  function showLogin() {
    loggedInView.style.display = 'none';
    loginView.style.display = 'block';
  }

  // Check for session cookie immediately
  chrome.runtime.sendMessage({ type: 'check_session_cookie' }, function(response) {
    if (response && response.success) {
      showLoggedIn();
    } else {
      // Check if we have a token stored locally from previous manual login
      chrome.storage.local.get(['token'], function(result) {
        if (result.token) {
          showLoggedIn();
        } else {
          showLogin();
        }
      });
    }
  });

  if (loginBtn) {
    loginBtn.addEventListener('click', function() {
      chrome.tabs.create({ url: 'https://enhancivity.com/signin' });
    });
  }

  logoutBtn.addEventListener('click', function() {
    // For now, just clear local token and show login view
    // In a full implementation, this might also delete the cookie
    chrome.storage.local.remove('token', function() {
      showLogin();
    });
  });
});
