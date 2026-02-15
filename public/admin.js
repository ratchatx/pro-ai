let currentUserId = null;
let currentMode = 'ai';
let pollInterval = null;

async function loadChats() {
    try {
        const response = await fetch('/api/admin/chats');
        const users = await response.json();
        
        const listContainer = document.getElementById('user-list');
        listContainer.innerHTML = '';

        if (users.length === 0) {
            listContainer.innerHTML = '<p class="text-center text-muted mt-3">No conversations yet.</p>';
            return;
        }

        users.forEach(u => {
            const div = document.createElement('div');
            div.className = `user-item ${currentUserId === u.userId ? 'active' : ''}`;
            div.onclick = () => selectUser(u.userId);
            
            const time = u.lastActive ? new Date(u.lastActive).toLocaleTimeString() : '';
            const preview = u.lastMessage ? u.lastMessage.substring(0, 30) + '...' : 'No messages';
            
            div.innerHTML = `
                <div class="d-flex justify-content-between">
                    <strong>${u.userId.substring(0, 8)}...</strong>
                    <small>${time}</small>
                </div>
                <div class="small text-muted text-truncate">${preview}</div>
                <div class="mt-1">
                    <span class="badge ${u.mode === 'manual' ? 'bg-success' : 'bg-primary'}">${u.mode}</span>
                </div>
            `;
            listContainer.appendChild(div);
        });
    } catch (e) {
        console.error("Failed to load chats", e);
    }
}

async function selectUser(userId) {
    currentUserId = userId;
    document.getElementById('current-user-name').innerText = `User: ${userId}`;
    document.getElementById('controls').style.display = 'block';
    
    // Refresh list highlight
    loadChats(); // to update active class

    await loadHistory();
    document.getElementById('reply-form').style.display = 'block';
    
    // Start polling for new messages for this user
    if (pollInterval) clearInterval(pollInterval);
    pollInterval = setInterval(loadHistory, 3000);
}

async function loadHistory() {
    if (!currentUserId) return;
    
    try {
        const response = await fetch(`/api/admin/chats/${currentUserId}`);
        const data = await response.json();
        
        currentMode = data.mode;
        updateModeUI();

        const container = document.getElementById('messages-container');
        // Simple diff check could be better, but for now re-render
        // To prevent scrolling up, we only append if we are at bottom? 
        // For simplicity, just wipe and render carefully or just overwrite.
        // Overwriting is easiest for prototype.
        const wasAtBottom = container.scrollHeight - container.scrollTop === container.clientHeight;

        container.innerHTML = '';
        
        data.messages.forEach(msg => {
            const div = document.createElement('div');
            // unify admin/assistant classes
            const roleClass = msg.role; 
            div.className = `message ${roleClass}`;
            
            const time = new Date(msg.timestamp).toLocaleTimeString();
            
            div.innerHTML = `
                <div class="bubble ${roleClass}">
                    ${msg.content}
                </div>
                <div class="small text-muted text-end" style="font-size:0.7em;">${msg.role} • ${time}</div>
            `;
            container.appendChild(div);
        });

        if (wasAtBottom) {
             container.scrollTop = container.scrollHeight;
        }
    } catch (e) {
        console.error("Failed to load history", e);
    }
}

function updateModeUI() {
    const display = document.getElementById('mode-display');
    const btn = document.getElementById('mode-btn');
    
    display.innerText = currentMode.toUpperCase();
    if (currentMode === 'ai') {
        display.className = "text-primary";
        btn.innerText = "Switch to Manual (Take Over)";
        btn.className = "btn btn-sm btn-warning";
    } else {
        display.className = "text-success";
        btn.innerText = "Switch to AI";
        btn.className = "btn btn-sm btn-outline-primary";
    }
}

async function toggleMode() {
    if (!currentUserId) return;
    
    const newMode = currentMode === 'ai' ? 'manual' : 'ai';
    
    try {
        await fetch(`/api/admin/chats/${currentUserId}/mode`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: newMode })
        });
        currentMode = newMode;
        updateModeUI();
        loadChats(); // refresh sidebar badges
    } catch (e) {
        alert("Failed to toggle mode");
    }
}

document.getElementById('reply-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!currentUserId) return;

    const input = document.getElementById('admin-input');
    const text = input.value.trim();
    if (!text) return;

    // Optimistic UI update
    // Actually better to wait for server
    input.value = '';

    try {
        const res = await fetch(`/api/admin/chats/${currentUserId}/reply`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: text })
        });
        if (!res.ok) throw new Error("Failed");
        
        // Reload history immediately
        await loadHistory();
        
        // If we are in AI mode, maybe we should switch to Manual automatically?
        // User asked "go in and answer instead of AI". Usually implies taking control.
        if (currentMode === 'ai') {
            if(confirm("Switch to Manual mode to stop AI from replying?")) {
                toggleMode();
            }
        }
    } catch (e) {
        alert("Failed to send message: " + e.message);
    }
});

// Initial load
loadChats();
// Poll Sidebar every 5s
setInterval(loadChats, 5000);
