// public/app.js

const API_BASE = 'http://localhost:3000/api';

// --- Tab Navigation ---
function showTab(tabId) {
    document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(el => el.classList.remove('active'));
    
    document.getElementById(tabId).classList.add('active');
    document.querySelector(`button[onclick="showTab('${tabId}')"]`).classList.add('active');

    if (tabId === 'files') loadFiles();
    if (tabId === 'collections') loadCollections();
}

// --- File Management ---

async function loadFiles() {
    const res = await fetch(`${API_BASE}/files`);
    const files = await res.json();
    const tbody = document.getElementById('fileList');
    tbody.innerHTML = '';

    files.forEach(file => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${file.originalName}</td>
            <td><span class="status-badge ${file.status}">${file.status}</span></td>
            <td class="actions-col">
                <div class="btn-group">
                    <button class="action-btn" title="Convert to Text" onclick="convertFile('${file.id}')">
                        <i class="fa-solid fa-file-lines"></i> Convert
                    </button>
                    ${file.status !== 'raw' ? `
                    <button class="action-btn" title="Edit Content" onclick="openEditor('${file.id}')">
                        <i class="fa-solid fa-pen-to-square"></i> Edit
                    </button>
                    <button class="action-btn" title="Add to Vector DB" onclick="embedFile('${file.id}')">
                        <i class="fa-solid fa-database"></i> Embed
                    </button>` : ''}
                    <button class="action-btn" style="color: var(--danger);" title="Delete File" onclick="deleteFile('${file.id}')">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            </td>
        `;
        tbody.appendChild(tr);
    });
    
    document.getElementById('fileCount').innerText = files.length;
}

async function uploadFiles() {
    const fileInput = document.getElementById('fileInput');
    if (fileInput.files.length === 0) return alert("Select files first");

    const formData = new FormData();
    for (let file of fileInput.files) {
        formData.append('files', file);
    }
    
    const btn = document.querySelector('.upload-actions .btn-primary');
    const originalText = btn.innerHTML;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Uploading...';
    btn.disabled = true;

    try {
        const res = await fetch(`${API_BASE}/upload`, {
            method: 'POST',
            body: formData
        });
        if (res.ok) {
            loadFiles();
            fileInput.value = '';
        } else {
             alert('Upload failed');
        }
    } catch (e) {
        alert('Upload failed');
    } finally {
        btn.innerHTML = originalText;
        btn.disabled = false;
    }
}

async function deleteFile(id) {
    if (!confirm("Are you sure you want to delete this file? This will remove it from the system and the vector database.")) return;

    try {
        const res = await fetch(`${API_BASE}/files/${id}`, { method: 'DELETE' });
        if (res.ok) {
            loadFiles();
        } else {
            const data = await res.json();
            alert('Delete failed: ' + (data.error || 'Unknown error'));
        }
    } catch (e) {
        alert('Delete failed: ' + e.message);
    }
}

async function convertFile(id) {
    if (!confirm("This will process the file (Convert + Add to Collection). Continue?")) return;
    
    try {
        // Step 1: Convert
        const res1 = await fetch(`${API_BASE}/convert/${id}`, { method: 'POST' });
        const data1 = await res1.json();
        if (!res1.ok) throw new Error(data1.error || 'Conversion failed');

        // Step 2: Auto-Embed
        const res2 = await fetch(`${API_BASE}/embed/${id}`, { method: 'POST' });
        const data2 = await res2.json();
        if (!res2.ok) throw new Error(data2.error || 'Embedding failed');

        alert('Success! File is ready for chat.');
        loadFiles();
    } catch (e) {
        alert('Process failed: ' + e.message);
    }
}

async function embedFile(id) {
    if (!confirm("This will add the text to Vector DB. Continue?")) return;
    
    try {
        const res = await fetch(`${API_BASE}/embed/${id}`, { method: 'POST' });
        const data = await res.json();
        alert(data.message || data.error);
        loadFiles();
    } catch (e) {
        alert('Embedding failed: ' + e.message);
    }
}

// --- Editor ---

let currentEditingId = null;

async function openEditor(id) {
    currentEditingId = id;
    try {
        const res = await fetch(`${API_BASE}/files/${id}/content`);
        const data = await res.json();
        document.getElementById('markdownEditor').value = data.content || "";
        document.getElementById('editorModal').classList.remove('hidden');
    } catch (e) {
        alert('Failed to load content');
    }
}

function closeEditor() {
    document.getElementById('editorModal').classList.add('hidden');
    currentEditingId = null;
}

async function saveMarkdown() {
    if (!currentEditingId) return;
    const content = document.getElementById('markdownEditor').value;

    try {
        const res = await fetch(`${API_BASE}/files/${currentEditingId}/content`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content })
        });
        if (res.ok) {
            alert('Content saved!');
            closeEditor();
            loadFiles(); // Status might change? No, but good to refresh.
        } else {
            alert('Failed to save');
        }
    } catch (e) {
        alert('Error saving');
    }
}

// --- Collections ---

async function loadCollections() {
    const list = document.getElementById('collectionList');
    list.innerHTML = 'Loading...';
    try {
        const res = await fetch(`${API_BASE}/collections`);
        const collections = await res.json();
        list.innerHTML = '';
        
        if (collections.length === 0) {
            list.innerHTML = '<li>No collections found.</li>';
            return;
        }

        collections.forEach(col => {
            const li = document.createElement('li');
            li.innerHTML = `
                <span>${col.name}</span>
                <button class="action-btn" style="color:red;" onclick="deleteCollection('${col.name}')">Delete</button>
            `;
            list.appendChild(li);
        });
    } catch (e) {
        list.innerHTML = 'Error loading collections.';
    }
}

async function deleteCollection(name) {
    if (!confirm(`Are you sure you want to delete collection "${name}"? This cannot be undone.`)) return;
    
    try {
        const res = await fetch(`${API_BASE}/collections/${name}`, { method: 'DELETE' });
        if (res.ok) {
            loadCollections();
        } else {
            alert('Delete failed');
        }
    } catch (e) {
        alert('Error deleting');
    }
}

// --- Chat ---

let chatHistoryState = []; // [{role: 'user', content: ...}...]

function handleChatKey(e) {
    if (e.key === 'Enter') sendMessage();
}

async function sendMessage() {
    const input = document.getElementById('chatInput');
    const text = input.value.trim();
    if (!text) return;

    // Add User Message to UI
    appendMessage('user', text);
    input.value = '';

    // Add strict loading state
    const loadingId = appendMessage('assistant', 'Thinking...');
    
    try {
        const res = await fetch(`${API_BASE}/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message: text,
                history: chatHistoryState
            })
        });

        const data = await res.json();
        
        // Remove loading
        const loadingEl = document.getElementById(loadingId);
        if (loadingEl) loadingEl.remove();

        if (data.role === 'assistant') {
            appendMessage('assistant', data.content);
            // Update history
            chatHistoryState.push({ role: 'user', content: text });
            chatHistoryState.push({ role: 'assistant', content: data.content });
        } else {
            const errorMsg = data.error || 'Unknown error';
            const details = data.details ? `\nDetails: ${data.details}` : '';
            appendMessage('system', `Error: ${errorMsg}${details}`);
        }

    } catch (e) {
        appendMessage('system', 'Connection failed.');
    }
}

function appendMessage(role, text) {
    const container = document.getElementById('chatHistory');
    const div = document.createElement('div');
    div.className = `message ${role}`;
    div.innerText = text;
    // Simple ID generator for removing loading later
    const id = 'msg-' + Date.now();
    div.id = id;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
    return id;
}

// Initial Load
document.addEventListener('DOMContentLoaded', () => {
    loadFiles();
});
