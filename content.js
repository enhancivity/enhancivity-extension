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
  // Use setTimeout to allow selection to settle
  setTimeout(() => {
    // If form is open, don't interfere
    if (formElement) return;

    const selection = window.getSelection();
    
    // Basic validation
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
       removeIcon();
       return;
    }

    const selectedText = selection.toString();

    // Remove existing icon on any selection change first
    removeIcon();

    if (selectedText && countWords(selectedText) >= 5) {

      try {
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
  // Position relative to the FIXED host (viewport coordinates)
  iconElement.style.position = 'absolute';
  iconElement.style.top = `${rect.bottom + 5}px`;
  iconElement.style.left = `${rect.right + 5}px`;
  iconElement.style.zIndex = '2147483647';
  iconElement.style.cursor = 'pointer';
  iconElement.style.width = `${iconSize}px`;
  iconElement.style.height = `${iconSize}px`;
  iconElement.style.borderRadius = '50%';
  iconElement.style.backgroundColor = '#06070e';
  iconElement.style.boxShadow = '0 2px 5px rgba(0,0,0,0.2)';
  iconElement.style.display = 'flex';
  iconElement.style.alignItems = 'center';
  iconElement.style.justifyContent = 'center';
  iconElement.style.transition = 'transform 0.2s ease';
  iconElement.style.pointerEvents = 'auto'; // Re-enable pointer events

  const img = document.createElement('img');
  img.src = chrome.runtime.getURL('images/icon48.png');
  img.style.width = '20px';
  img.style.height = '20px';
  img.style.pointerEvents = 'none';
  
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
  removeIcon(); // Remove icon when opening form

  formElement = document.createElement('div');
  formElement.id = 'enhancivity-todo-form';
  
  // Styles for the form container
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
    pointerEvents: 'auto' // Re-enable pointer events
  });

  // Make Drag Logic
  let isDragging = false;
  let currentX;
  let currentY;
  let initialX;
  let initialY;
  let xOffset = 0;
  let yOffset = 0;

  // Header for dragging
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
  
  // Title inside header
  const formTitle = document.createElement('h3');
  formTitle.textContent = 'Create New Task';
  formTitle.style.margin = '0';
  formTitle.style.fontSize = '20px';
  formTitle.style.background = 'linear-gradient(135deg, #897df0, #fdbbf5)';
  formTitle.style.webkitBackgroundClip = 'text';
  formTitle.style.webkitTextFillColor = 'transparent';
  formTitle.style.pointerEvents = 'none'; 
  
  // AI Status Indicator
  const aiStatus = document.createElement('span');
  aiStatus.textContent = '✨ AI Analyzing...';
  Object.assign(aiStatus.style, {
    fontSize: '12px',
    color: '#897df0',
    fontWeight: '600',
    animation: 'pulse 1.5s infinite',
    display: 'none' // Hidden by default, shown when analyzing
  });

  header.appendChild(formTitle);
  header.appendChild(aiStatus);
  formElement.appendChild(header);

  // Drag Event Listeners
  header.addEventListener('mousedown', dragStart);

  function dragStart(e) {
    if (e.target === header || e.target.parentElement === header) {
      initialX = e.clientX - xOffset;
      initialY = e.clientY - yOffset;
      
      isDragging = true;
      
      // Bind move and up to window to handle fast movements/leaving the element
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

  // Form Fields Helper
  const createInputGroup = (labelText, inputType, id, value = '', isTextarea = false, options = []) => {
    const group = document.createElement('div');
    group.style.display = 'flex';
    group.style.flexDirection = 'column';
    group.style.gap = '6px';

    const label = document.createElement('label');
    label.textContent = labelText;
    label.setAttribute('for', id);
    label.style.fontSize = '12px';
    label.style.fontWeight = '600';
    label.style.color = '#a1a1aa';
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
    
    // Focus effect
    input.onfocus = () => input.style.borderColor = '#897df0';
    input.onblur = () => input.style.borderColor = '#2d365f';

    group.appendChild(input);
    return { group, input };
  };

  // Inputs
  const pageTitle = document.title || 'Untitled Page'; 
  const { group: titleGroup, input: titleInput } = createInputGroup('Task Title', 'text', 'enh-title', pageTitle);
  formElement.appendChild(titleGroup);

  const { group: descGroup, input: descInput } = createInputGroup('Description', 'text', 'enh-desc', currentSelection, true);
  formElement.appendChild(descGroup);

  const { group: priorityGroup, input: priorityInput } = createInputGroup('Priority', 'select', 'enh-priority', 'MEDIUM', false, [
    { value: 'HIGH', label: 'High' },
    { value: 'MEDIUM', label: 'Medium' },
    { value: 'LOW', label: 'Low' }
  ]);
  formElement.appendChild(priorityGroup);

  const today = new Date().toISOString().split('T')[0];
  const { group: dateGroup, input: dateInput } = createInputGroup('Due Date', 'date', 'enh-date', today);
  formElement.appendChild(dateGroup);

  // Buttons
  const btnGroup = document.createElement('div');
  btnGroup.style.display = 'flex';
  btnGroup.style.gap = '12px';
  btnGroup.style.marginTop = '8px';

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
  formElement.appendChild(btnGroup);

  getShadowRoot().appendChild(formElement);

  // --- Trigger AI Analysis ---
  aiStatus.style.display = 'block'; // Show "Analyzing..."
  
  chrome.runtime.sendMessage({ 
    type: 'analyze_text', 
    data: { 
      text: currentSelection,
      pageTitle: pageTitle
    } 
  }, (response) => {
    aiStatus.style.display = 'none'; // Hide indicator
    
    if (response && response.success && response.data) {
      // Update form fields with AI data
      const aiData = response.data;
      if (aiData.title) titleInput.value = aiData.title;
      if (aiData.description) descInput.value = aiData.description;
      if (aiData.priority) priorityInput.value = aiData.priority;
      if (aiData.dueDate) dateInput.value = aiData.dueDate;
    } else {
      console.log('Enhancivity: AI Analysis failed or returned no data', response?.error);
    }
  });
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
