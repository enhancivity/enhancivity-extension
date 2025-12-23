// Enhancivity Content Script

let iconElement = null;
let formElement = null;
let currentSelection = '';
let shadowHost = null;
let shadowRoot = null;

function countWords(str) {
  return str.trim().split(/\s+/).filter(word => word.length > 0).length;
}

function getShadowRoot() {
  if (!shadowHost) {
    shadowHost = document.createElement('div');
    shadowHost.id = 'enhancivity-extension-host';
    Object.assign(shadowHost.style, {
      position: 'fixed',
      top: '0',
      left: '0',
      width: '100%',
      height: '100%',
      zIndex: '2147483647',
      pointerEvents: 'none',
      overflow: 'visible',
      display: 'block',
      margin: '0',
      padding: '0',
      border: 'none'
    });
    // Append to documentElement (<html>) to avoid body issues
    document.documentElement.appendChild(shadowHost);
    shadowRoot = shadowHost.attachShadow({ mode: 'open' });
    
    // Inject Styles for Spinner
    const style = document.createElement('style');
    style.textContent = `
      @keyframes spin {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
      }
      .enh-spinner {
        border: 3px solid rgba(137, 125, 240, 0.3);
        border-radius: 50%;
        border-top: 3px solid #897df0;
        width: 24px;
        height: 24px;
        animation: spin 1s linear infinite;
        margin-bottom: 12px;
      }
    `;
    shadowRoot.appendChild(style);

  } else if (!shadowHost.isConnected) {
    document.documentElement.appendChild(shadowHost);
  }
  return shadowRoot;
}

function removeIcon() {
  if (iconElement) {
    iconElement.remove();
    iconElement = null;
  }
}

function removeForm() {
  if (formElement) {
    formElement.remove();
    formElement = null;
  }
}

function handleSelection() {
  setTimeout(() => {
    if (formElement) return;

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
       removeIcon();
       return;
    }

    const selectedText = selection.toString();
    removeIcon();

    if (selectedText && countWords(selectedText) >= 5) {
      try {
        // Check if extension context is valid
        if (!chrome.runtime?.id) {
          // Extension context invalidated, remove listeners
          document.removeEventListener('mouseup', handleSelection, { capture: true });
          document.removeEventListener('keyup', handleSelection, { capture: true });
          return;
        }

        currentSelection = selectedText;
        const range = selection.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        createIcon(rect);
      } catch (e) {
        console.error('Enhancivity: Error getting selection range', e);
      }
    }
  }, 10);
}

function createIcon(rect) {
  iconElement = document.createElement('div');
  iconElement.id = 'enhancivity-floating-icon';
  
  const iconSize = 32;
  Object.assign(iconElement.style, {
    position: 'absolute',
    top: `${rect.bottom + 5}px`,
    left: `${rect.right + 5}px`,
    zIndex: '2147483647',
    cursor: 'pointer',
    width: `${iconSize}px`,
    height: `${iconSize}px`,
    borderRadius: '50%',
    backgroundColor: '#06070e',
    boxShadow: '0 2px 5px rgba(0,0,0,0.2)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    transition: 'transform 0.2s ease',
    pointerEvents: 'auto'
  });

  const img = document.createElement('img');
  img.src = chrome.runtime.getURL('images/icon48.png');
  Object.assign(img.style, { width: '20px', height: '20px', pointerEvents: 'none' });
  
  iconElement.appendChild(img);
  iconElement.onmouseenter = () => iconElement.style.transform = 'scale(1.1)';
  iconElement.onmouseleave = () => iconElement.style.transform = 'scale(1)';

  iconElement.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openTodoForm(rect);
  });

  getShadowRoot().appendChild(iconElement);
}

function openTodoForm(rect) {
  removeIcon();

  formElement = document.createElement('div');
  formElement.id = 'enhancivity-todo-form';
  
  Object.assign(formElement.style, {
    position: 'fixed',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    width: '400px',
    backgroundColor: '#06070e',
    color: '#ffffff',
    padding: '24px',
    borderRadius: '12px',
    boxShadow: '0 10px 25px rgba(0,0,0,0.5)',
    zIndex: '2147483647',
    fontFamily: "'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
    pointerEvents: 'auto'
  });

  // --- Header (Draggable) ---
  const header = document.createElement('div');
  Object.assign(header.style, {
    cursor: 'move',
    padding: '0 0 10px 0',
    borderBottom: '1px solid #1e2545',
    marginBottom: '8px',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center'
  });
  
  const formTitle = document.createElement('h3');
  formTitle.textContent = 'Create New Task';
  Object.assign(formTitle.style, {
    margin: '0',
    fontSize: '20px',
    background: 'linear-gradient(135deg, #897df0, #fdbbf5)',
    webkitBackgroundClip: 'text',
    webkitTextFillColor: 'transparent',
    pointerEvents: 'none'
  });
  
  header.appendChild(formTitle);
  formElement.appendChild(header);

  // --- Drag Logic ---
  let isDragging = false;
  let currentX; let currentY; let initialX; let initialY;
  let xOffset = 0; let yOffset = 0;

  header.addEventListener('mousedown', dragStart);

  function dragStart(e) {
    if (e.target === header || e.target.parentElement === header) {
      initialX = e.clientX - xOffset;
      initialY = e.clientY - yOffset;
      isDragging = true;
      window.addEventListener('mousemove', drag);
      window.addEventListener('mouseup', dragEnd);
    }
  }

  function drag(e) {
    if (isDragging) {
      e.preventDefault();
      currentX = e.clientX - initialX;
      currentY = e.clientY - initialY;
      xOffset = currentX;
      yOffset = currentY;
      setTranslate(currentX, currentY, formElement);
    }
  }

  function setTranslate(xPos, yPos, el) {
    el.style.transform = `translate(calc(-50% + ${xPos}px), calc(-50% + ${yPos}px))`;
  }

  function dragEnd(e) {
    initialX = currentX;
    initialY = currentY;
    isDragging = false;
    window.removeEventListener('mousemove', drag);
    window.removeEventListener('mouseup', dragEnd);
  }

  // --- Content Container (Holds Spinner or Form) ---
  const contentContainer = document.createElement('div');
  contentContainer.style.display = 'flex';
  contentContainer.style.flexDirection = 'column';
  contentContainer.style.gap = '16px';
  formElement.appendChild(contentContainer);

  getShadowRoot().appendChild(formElement);

  // --- 1. Show Loading State with Cancel ---
  const loadingView = document.createElement('div');
  Object.assign(loadingView.style, {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '30px 0',
    color: '#a1a1aa'
  });

  const spinner = document.createElement('div');
  spinner.className = 'enh-spinner';
  
  const loadingText = document.createElement('span');
  loadingText.textContent = 'Analyzing task details...';
  loadingText.style.fontSize = '14px';
  loadingText.style.marginBottom = '20px';

  const cancelLoadingBtn = document.createElement('button');
  cancelLoadingBtn.textContent = 'Cancel';
  Object.assign(cancelLoadingBtn.style, {
    padding: '8px 16px',
    borderRadius: '6px',
    border: '1px solid #473180',
    backgroundColor: 'transparent',
    color: '#a1a1aa',
    cursor: 'pointer',
    fontSize: '12px',
    marginTop: '10px'
  });
  
  cancelLoadingBtn.onclick = () => {
    // Note: Chrome message passing doesn't support generic aborts, 
    // but we can at least stop listening/close UI.
    removeForm();
  };

  loadingView.appendChild(spinner);
  loadingView.appendChild(loadingText);
  loadingView.appendChild(cancelLoadingBtn);
  contentContainer.appendChild(loadingView);

  // --- 2. Request Data ---
  const pageTitle = document.title || 'Untitled Page';
  
  chrome.runtime.sendMessage({ 
    type: 'analyze_text', 
    data: { 
      text: currentSelection,
      pageTitle: pageTitle
    } 
  }, (response) => {
    // --- 3. Hide Loading, Show Form ---
    // If user closed form while loading, stop.
    if (!formElement || !formElement.isConnected) return;

    contentContainer.innerHTML = ''; // Clear loading view

    // Defaults
    let titleVal = pageTitle;
    let descVal = currentSelection;
    let priorityVal = 'MEDIUM';
    let dateVal = new Date().toISOString().split('T')[0];

    // Override with AI data if successful
    if (response && response.success && response.data) {
      const aiData = response.data;
      if (aiData.title) titleVal = aiData.title;
      if (aiData.description) descVal = aiData.description;
      if (aiData.priority) priorityVal = aiData.priority;
      if (aiData.dueDate) dateVal = aiData.dueDate;
    } else {
      console.log('Enhancivity: AI Analysis failed, using defaults.', response?.error);
    }

    renderFormFields(titleVal, descVal, priorityVal, dateVal);
  });

  function renderFormFields(titleVal, descVal, priorityVal, dateVal) {
    // Helper to create inputs
    const createInputGroup = (labelText, inputType, id, value = '', isTextarea = false, options = []) => {
      const group = document.createElement('div');
      group.style.display = 'flex';
      group.style.flexDirection = 'column';
      group.style.gap = '6px';

      const label = document.createElement('label');
      label.textContent = labelText;
      label.setAttribute('for', id);
      Object.assign(label.style, { fontSize: '12px', fontWeight: '600', color: '#a1a1aa' });
      group.appendChild(label);

      let input;
      const inputStyles = {
        padding: '10px',
        borderRadius: '6px',
        border: '1px solid #2d365f',
        backgroundColor: '#1b1424',
        color: 'white',
        fontFamily: 'inherit',
        fontSize: '14px',
        outline: 'none',
        width: '100%',
        boxSizing: 'border-box'
      };

      if (isTextarea) {
        input = document.createElement('textarea');
        input.rows = 4;
        input.style.resize = 'vertical';
      } else if (inputType === 'select') {
        input = document.createElement('select');
        options.forEach(opt => {
          const option = document.createElement('option');
          option.value = opt.value;
          option.textContent = opt.label;
          input.appendChild(option);
        });
      } else {
        input = document.createElement('input');
        input.type = inputType;
      }

      input.id = id;
      input.value = value;
      Object.assign(input.style, inputStyles);
      
      input.onfocus = () => input.style.borderColor = '#897df0';
      input.onblur = () => input.style.borderColor = '#2d365f';

      group.appendChild(input);
      return { group, input };
    };

    const { group: titleGroup, input: titleInput } = createInputGroup('Task Title', 'text', 'enh-title', titleVal);
    contentContainer.appendChild(titleGroup);

    const { group: descGroup, input: descInput } = createInputGroup('Description', 'text', 'enh-desc', descVal, true);
    contentContainer.appendChild(descGroup);

    const { group: priorityGroup, input: priorityInput } = createInputGroup('Priority', 'select', 'enh-priority', priorityVal, false, [
      { value: 'HIGH', label: 'High' },
      { value: 'MEDIUM', label: 'Medium' },
      { value: 'LOW', label: 'Low' }
    ]);
    contentContainer.appendChild(priorityGroup);

    const { group: dateGroup, input: dateInput } = createInputGroup('Due Date', 'date', 'enh-date', dateVal);
    contentContainer.appendChild(dateGroup);

    // Buttons
    const btnGroup = document.createElement('div');
    Object.assign(btnGroup.style, { display: 'flex', gap: '12px', marginTop: '8px' });

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    Object.assign(cancelBtn.style, {
      flex: '1',
      padding: '10px',
      borderRadius: '6px',
      border: '1px solid #473180',
      backgroundColor: 'transparent',
      color: 'white',
      cursor: 'pointer',
      fontWeight: '600'
    });
    cancelBtn.onclick = removeForm;

    const saveBtn = document.createElement('button');
    saveBtn.textContent = 'Create Task';
    Object.assign(saveBtn.style, {
      flex: '1',
      padding: '10px',
      borderRadius: '6px',
      border: 'none',
      background: 'linear-gradient(135deg, #897df0, #fdbbf5)',
      color: '#06070e',
      cursor: 'pointer',
      fontWeight: '600'
    });

    saveBtn.onclick = () => {
      const data = {
        title: titleInput.value,
        description: descInput.value,
        priority: priorityInput.value,
        dueDate: dateInput.value
      };

      saveBtn.textContent = 'Saving...';
      saveBtn.disabled = true;

      chrome.runtime.sendMessage({ type: 'create_todo', data }, (response) => {
        if (response && response.success) {
          removeForm();
          alert('Task created successfully!');
        } else {
          saveBtn.textContent = 'Create Task';
          saveBtn.disabled = false;
          alert('Error: ' + (response.error || 'Unknown error'));
        }
      });
    };

    btnGroup.appendChild(cancelBtn);
    btnGroup.appendChild(saveBtn);
    contentContainer.appendChild(btnGroup);
  }
}

// Event listeners
document.addEventListener('mouseup', handleSelection, { capture: true });
document.addEventListener('keyup', (e) => {
  if (e.key.includes('Arrow') || e.key === 'Shift') {
    handleSelection();
  }
}, { capture: true });

document.addEventListener('scroll', () => {
  removeIcon();
}, { passive: true });

document.addEventListener('selectionchange', () => {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) {
    removeIcon();
  }
});