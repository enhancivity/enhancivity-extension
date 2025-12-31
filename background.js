const API_BASE_URL = 'https://enhancivity.com';
// const API_BASE_URL = 'http://localhost:3000'; // Uncomment for local dev

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'extension_login') {
    const { email, password } = request.data;

    fetch(`${API_BASE_URL}/api/auth/extension/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    })
    .then(response => response.json())
    .then(data => {
      if (data.success) {
        chrome.storage.local.set({ token: data.token, apiBaseUrl: API_BASE_URL }, () => {
          sendResponse({ success: true });
        });
      } else {
        sendResponse({ success: false, message: data.error || 'Login failed' });
      }
    })
    .catch(error => {
      console.error('Login error:', error);
      sendResponse({ success: false, message: 'Network error' });
    });
    return true;

  } else if (request.type === 'google_login') {
    chrome.identity.getAuthToken({ interactive: true }, function(token) {
      if (chrome.runtime.lastError || !token) {
        console.error('Google Auth Error:', chrome.runtime.lastError);
        sendResponse({ success: false, message: 'Google sign-in canceled or failed.' });
        return;
      }

      // Exchange Google token for App session
      fetch(`${API_BASE_URL}/api/auth/extension/google`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ access_token: token })
      })
      .then(response => response.json())
      .then(data => {
        if (data.success) {
          chrome.storage.local.set({ token: data.token, apiBaseUrl: API_BASE_URL }, () => {
            sendResponse({ success: true });
          });
        } else {
          sendResponse({ success: false, message: data.error || 'Google login failed on server.' });
        }
      })
      .catch(error => {
        console.error('Google login server error:', error);
        sendResponse({ success: false, message: 'Network error during Google login.' });
      });
    });
    return true;

  } else if (request.type === 'create_todo') {
    chrome.storage.local.get(['token', 'apiBaseUrl'], (result) => {
      const baseUrl = result.apiBaseUrl || API_BASE_URL;
      const token = result.token;

      if (!token) {
        sendResponse({ success: false, error: 'Not logged in' });
        return;
      }
      
      fetch(`${baseUrl}/api/todos`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(request.data)
      })
      .then(response => response.json())
      .then(data => {
        if (data.error) {
          sendResponse({ success: false, error: data.error });
        } else {
          sendResponse({ success: true, data });
        }
      })
      .catch(error => {
        console.error('Create todo failed:', error);
        sendResponse({ success: false, error: 'Network error.' });
      });
    });
    return true;

  } else if (request.type === 'analyze_text') {
    chrome.storage.local.get(['token', 'apiBaseUrl'], (result) => {
      const baseUrl = result.apiBaseUrl || API_BASE_URL;
      const token = result.token;

      if (!token) {
        sendResponse({ success: false, error: 'Not logged in' });
        return;
      }
      
      fetch(`${baseUrl}/api/todos/analyze`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(request.data)
      })
      .then(response => response.json())
      .then(data => {
        if (data.error) {
          sendResponse({ success: false, error: data.error });
        } else {
          sendResponse({ success: true, data });
        }
      })
      .catch(error => {
        console.error('Analyze text failed:', error);
        sendResponse({ success: false, error: 'Network error.' });
      });
    });
    return true;
  }
});