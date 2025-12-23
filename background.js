chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'login') {
    const { username, password } = request.data;

    fetch('https://api.enhancivity.com/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ username, password })
    })
    .then(response => {
      if (!response.ok) {
        throw new Error('Network response was not ok');
      }
      return response.json();
    })
    .then(data => {
      if (data.token) {
        chrome.storage.local.set({ token: data.token, apiBaseUrl: 'https://api.enhancivity.com' }, () => {
          sendResponse({ success: true });
        });
      } else {
        sendResponse({ success: false, message: 'Invalid credentials' });
      }
    })
    .catch(error => {
      console.error('Login failed:', error);
      sendResponse({ success: false, message: 'Login failed. Please try again.' });
    });

    return true;
  } else if (request.type === 'check_session_cookie') {
    // Try production first
    chrome.cookies.get({ url: 'https://enhancivity.com', name: 'session' }, (cookie) => {
      if (cookie) {
        chrome.storage.local.set({ token: cookie.value, apiBaseUrl: 'https://enhancivity.com' }, () => {
          sendResponse({ success: true, token: cookie.value });
        });
      } else {
        // Try localhost
        chrome.cookies.get({ url: 'http://localhost:3000', name: 'session' }, (localCookie) => {
          if (localCookie) {
            chrome.storage.local.set({ token: localCookie.value, apiBaseUrl: 'http://localhost:3000' }, () => {
              sendResponse({ success: true, token: localCookie.value });
            });
          } else {
            sendResponse({ success: false });
          }
        });
      }
    });
    return true; 
  } else if (request.type === 'create_todo') {
    chrome.storage.local.get(['apiBaseUrl'], (result) => {
      const baseUrl = result.apiBaseUrl || 'https://enhancivity.com';
      
      fetch(`${baseUrl}/api/todos`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
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
        sendResponse({ success: false, error: 'Network error or server unreachable.' });
      });
    });
    return true;
  } else if (request.type === 'analyze_text') {
    chrome.storage.local.get(['apiBaseUrl'], (result) => {
      const baseUrl = result.apiBaseUrl || 'https://enhancivity.com';
      
      fetch(`${baseUrl}/api/todos/analyze`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Include token if stored, though the API currently relies on cookies. 
          // If the extension has the token stored, we could add it to Authorization header if needed.
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
        sendResponse({ success: false, error: 'Network error or server unreachable.' });
      });
    });
    return true;
  }
});
