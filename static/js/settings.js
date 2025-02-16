// Move these declarations to the top of the file, before any function definitions
let roomEntities = new Map();
let availableEntities = [];

// Add this function at the top with other initialization code
async function initializeSetup() {
    // Get form elements
    const haUrlInput = document.querySelector('input[name="ha_url"]');
    const accessTokenInput = document.querySelector('input[name="access_token"]');
    
    try {
        const response = await fetch('/api/settings/ha');
        if (response.ok) {
            const data = await response.json();
            
            // Prefill the form fields
            if (data.ha_url) {
                haUrlInput.value = data.ha_url;
            }
            if (data.access_token) {
                accessTokenInput.value = data.access_token;
            }
        }
    } catch (error) {
        console.error('Error loading HA settings:', error);
    }
}

// Update initializeTabs function
function initializeTabs() {
    // Hide all tabs except the first one on initial load
    document.querySelectorAll('.tab-content').forEach(content => {
        content.style.display = 'none';
    });
    document.getElementById('connection-tab').style.display = 'block';
    
    const tabs = document.querySelectorAll('.tab-button');
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            // Hide all tabs
            document.querySelectorAll('.tab-content').forEach(content => {
                content.style.display = 'none';
            });
            
            // Remove active class from all tab buttons
            tabs.forEach(t => t.classList.remove('active'));
            
            // Show selected tab and activate button
            const targetTab = document.getElementById(`${tab.dataset.tab}-tab`);
            targetTab.style.display = 'block';
            tab.classList.add('active');
            
            // Load content based on tab
            if (tab.dataset.tab === 'rooms') {
                loadRooms();
            } else if (tab.dataset.tab === 'entities') {
                loadEntitiesStep();
            }
        });
    });
}

// Add this near the top of the file with other initialization code
function initializeModalEvents() {
    const entityModal = document.getElementById('entityModal');
    const closeButton = entityModal.querySelector('.modal-close');
    const cancelButton = entityModal.querySelector('.modal-cancel');
    
    // Close button (X) handler
    closeButton.addEventListener('click', () => {
        entityModal.style.display = 'none';
    });
    
    // Cancel button handler
    cancelButton.addEventListener('click', () => {
        entityModal.style.display = 'none';
    });
    
    // Close modal when clicking outside
    window.addEventListener('click', (e) => {
        if (e.target === entityModal) {
            entityModal.style.display = 'none';
        }
    });
}

// Update the DOMContentLoaded event listener to include the new initialization
document.addEventListener('DOMContentLoaded', () => {
    initializeSetup();
    initializeTabs();
    initializeMobileEvents();
    initializeModalEvents();
    
    // Add event listener for the save button in connection tab
    const saveButton = document.getElementById('nextButton');
    if (saveButton) {
        saveButton.addEventListener('click', testAndSaveConnection);
    }
});

function goToStep(stepNumber, isGoingBack = false) {
    const currentStep = document.querySelector('.setup-step[style*="display: block"]') || 
                       document.querySelector('.setup-step[style*="opacity: 1"]') ||
                       document.getElementById('step1');
    const targetStep = document.getElementById(`step${stepNumber}`);
    
    if (!currentStep || !targetStep) return;
    
    const currentStepNumber = parseInt(currentStep.id.replace('step', ''));
    
    // Don't animate if we're on the same step
    if (currentStepNumber === stepNumber) return;
    
    // Reset next button if going back to step 1
    if (stepNumber === 1) {
        const nextButton = document.getElementById('nextButton');
        if (nextButton) {
            nextButton.disabled = false;
        }
        const statusDiv = document.getElementById('connectionStatus');
        if (statusDiv) {
            statusDiv.classList.remove('show');
            statusDiv.innerHTML = '';
        }
    }
    
    // Update pill lines direction
    document.querySelectorAll('.pill-line').forEach((line, index) => {
        line.classList.remove('active');
        if (isGoingBack) {
            line.classList.add('reverse');
        } else {
            line.classList.remove('reverse');
        }
    });
    
    currentStep.style.display = 'none';
    targetStep.style.display = 'block';
    
    // Update pills
    document.querySelectorAll('.pill').forEach(pill => {
        const pillStep = parseInt(pill.getAttribute('data-step'));
        if (pillStep <= stepNumber) {
            pill.classList.add('active');
        } else {
            pill.classList.remove('active');
        }
    });
    
    // Update connecting lines
    document.querySelectorAll('.pill-line').forEach((line, index) => {
        if (stepNumber === 1) {
            line.classList.remove('active');
        } else if (stepNumber === 2) {
            if (index === 0) line.classList.add('active');
            if (index === 1) line.classList.remove('active');
        } else if (stepNumber === 3) {
            line.classList.add('active');
        }
    });
    
    // Load rooms when going to step 2
    if (stepNumber === 2) {
        loadRooms();
    }
}

// Make sure back buttons pass true for isGoingBack
document.querySelectorAll('.back-button').forEach(button => {
    button.addEventListener('click', (e) => {
        const targetStep = parseInt(e.target.getAttribute('onclick').match(/\d+/)[0]);
        goToStep(targetStep, true);
        e.preventDefault();
    });
});

document.getElementById('roomConfig')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const rooms = Array.from(formData.getAll('rooms[]'));
    
    try {
        const response = await fetch('/api/setup/rooms', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ rooms })
        });
        
        if (response.ok) {
            goToStep(3, false);
            loadEntitiesStep();
        }
    } catch (error) {
        console.error('Error:', error);
    }
});

// Add these functions for room reordering
function initRoomSorting() {
    const roomList = document.getElementById('roomList');
    if (!roomList) return;

    new Sortable(roomList, {
        animation: 150,
        handle: '.room-drag-handle',
        onEnd: async function(evt) {
            // Update room orders after drag
            const rooms = Array.from(roomList.querySelectorAll('.room-entry'));
            const roomOrders = rooms.map((room, index) => {
                const roomId = room.getAttribute('data-room-id');
                return [roomId, index];
            });

            try {
                const response = await fetch('/api/rooms/reorder', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ roomOrders })
                });
                
                if (!response.ok) {
                    console.error('Failed to update room order');
                }
            } catch (error) {
                console.error('Error updating room order:', error);
            }
        }
    });
}

// Update the loadRooms function to include drag handles
async function loadRooms() {
    try {
        const response = await fetch('/api/rooms');
        const rooms = await response.json();
        const roomList = document.getElementById('roomList');
        const addRoomButton = document.querySelector('.add-room');
        
        roomList.innerHTML = ''; // Clear existing rooms
        
        if (rooms.length === 0) {
            // Add single room input without delete button
            const firstRoom = document.createElement('div');
            firstRoom.className = 'room-entry';
            firstRoom.innerHTML = `
                <div class="room-drag-handle">⋮⋮</div>
                <input type="text" name="rooms[]" placeholder="Room Name" required>
            `;
            roomList.appendChild(firstRoom);
            
            // Initially hide add room button
            addRoomButton.style.display = 'none';
            
            // Show add room button when first input gets text
            firstRoom.querySelector('input').addEventListener('input', function() {
                if (this.value.trim()) {
                    addRoomButton.style.display = 'block';
                } else {
                    addRoomButton.style.display = 'none';
                }
            });
        } else {
            // Add existing rooms
            rooms.forEach((room, index) => {
                const roomDiv = document.createElement('div');
                roomDiv.className = 'room-entry';
                roomDiv.setAttribute('data-room-id', room.id);
                roomDiv.innerHTML = `
                    <div class="room-drag-handle">⋮⋮</div>
                    <input type="text" name="rooms[]" value="${room.name}" placeholder="Room Name" required>
                    ${index > 0 || rooms.length > 1 ? `
                        <button type="button" class="delete-room" onclick="deleteRoom(${room.id}, this)">
                            <span>×</span>
                        </button>
                    ` : ''}
                `;
                roomList.appendChild(roomDiv);
            });
            
            // Show add room button since we have existing rooms
            addRoomButton.style.display = 'block';
        }

        // Initialize sorting
        initRoomSorting();

        // Add input event listener for room name changes
        initializeRoomInputs();
    } catch (error) {
        console.error('Error loading rooms:', error);
    }
}

// Update the addRoom function to save automatically
async function addRoom() {
    const roomList = document.getElementById('roomList');
    const roomEntries = roomList.querySelectorAll('.room-entry');
    
    // Add delete button to the previous room if it's the first additional room
    if (roomEntries.length === 1 && !roomEntries[0].querySelector('.delete-room')) {
        const firstRoom = roomEntries[0];
        const deleteButton = document.createElement('button');
        deleteButton.type = 'button';
        deleteButton.className = 'delete-room';
        deleteButton.innerHTML = '<span>×</span>';
        deleteButton.onclick = function() {
            if (roomList.children.length > 1) {
                firstRoom.remove();
            }
        };
        firstRoom.appendChild(deleteButton);
    }
    
    // Create new room entry
    const newRoom = document.createElement('div');
    newRoom.className = 'room-entry';
    newRoom.innerHTML = `
        <div class="room-drag-handle">⋮⋮</div>
        <input type="text" name="rooms[]" placeholder="Room Name" required>
        <button type="button" class="delete-room" onclick="this.closest('.room-entry').remove()">
            <span>×</span>
        </button>
    `;
    roomList.appendChild(newRoom);
    
    // Show the add room button only after the first room has input
    const addRoomButton = document.querySelector('.add-room');
    if (roomEntries.length === 0) {
        addRoomButton.style.display = 'none';
    }
    
    // Focus the new input and add blur event for auto-save
    const input = newRoom.querySelector('input');
    input.focus();
    input.addEventListener('blur', saveRooms);
}

// Add new function to auto-save rooms
async function saveRooms() {
    const formData = new FormData(document.getElementById('roomConfig'));
    const rooms = Array.from(formData.getAll('rooms[]'));
    
    try {
        const response = await fetch('/api/setup/rooms', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ rooms })
        });
        
        if (response.ok) {
            showToast('Room configuration saved', 'success');
        } else {
            showToast('Failed to save room configuration', 'error');
        }
    } catch (error) {
        showToast('Error saving room configuration', 'error');
        console.error('Error:', error);
    }
}

// Add this at the top with other initialization code
function showToast(message, type = 'info') {
    const container = document.querySelector('.toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    
    // Set icon based on type
    let icon = 'info-circle';
    if (type === 'success') icon = 'check-circle';
    if (type === 'error') icon = 'exclamation-circle';
    
    toast.innerHTML = `
        <i class="fas fa-${icon}"></i>
        <span>${message}</span>
    `;
    
    container.appendChild(toast);
    
    // Remove toast after 3 seconds
    setTimeout(() => {
        toast.classList.add('fade-out');
        setTimeout(() => {
            toast.remove();
        }, 300);
    }, 3000);
}

// Update the testAndSaveConnection function
async function testAndSaveConnection() {
    const haUrlInput = document.querySelector('input[name="ha_url"]');
    const accessTokenInput = document.querySelector('input[name="access_token"]');
    const saveButton = document.getElementById('nextButton');
    
    // Disable the save button while testing
    saveButton.disabled = true;
    
    showToast('Testing connection...', 'info');
    
    try {
        const response = await fetch('/api/settings/ha', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                ha_url: haUrlInput.value,
                access_token: accessTokenInput.value
            })
        });
        
        const data = await response.json();
        
        if (response.ok) {
            showToast('Connection successful! Settings saved.', 'success');
        } else {
            showToast(data.error || 'Connection failed', 'error');
            saveButton.disabled = false;
        }
    } catch (error) {
        showToast('Connection failed. Please check your settings.', 'error');
        saveButton.disabled = false;
    }
}

// Update saveEntityConfig function
async function saveEntityConfig() {
    try {
        const entities = [];
        if (roomEntities && roomEntities.size > 0) {
            for (const [roomId, roomEntityList] of roomEntities) {
                const container = document.getElementById(`entity-chips-${roomId}`);
                if (!container) continue;

                // Process each group type with its own order counter
                const groups = ['script', 'climate', 'light', 'switch', 'sensor', 'binary_sensor', 'other'];
                
                // Initialize order counters for each domain
                const domainOrders = {
                    script: 0,
                    climate: 0,
                    light: 0,
                    switch: 0,
                    sensor: 0,
                    binary_sensor: 0,
                    other: 0
                };

                groups.forEach(groupType => {
                    const groupContainer = container.querySelector(`.sortable-group[data-type="${groupType}"]`);
                    if (!groupContainer) return;

                    // Get entities in their current order for this group
                    const groupEntities = Array.from(groupContainer.querySelectorAll('.entity-chip'))
                        .map(chip => {
                            const entityId = chip.dataset.entityId;
                            const entity = roomEntityList.find(e => e.entity_id === entityId);
                            if (entity) {
                                // Use domain-specific order counter
                                const domain = entity.domain;
                                const order = domainOrders[domain] || domainOrders.other;
                                domainOrders[domain] = (domainOrders[domain] || 0) + 1;
                                
                                return {
                                    ...entity,
                                    order: order
                                };
                            }
                            return null;
                        })
                        .filter(Boolean);

                    // Add entities from this group to the main entities array
                    groupEntities.forEach(entity => {
                        const existingEntity = entities.find(e => e.entity_id === entity.entity_id);
                        if (existingEntity) {
                            existingEntity.rooms.push({
                                id: roomId,
                                order: entity.order
                            });
                        } else {
                            entities.push({
                                ...entity,
                                rooms: [{
                                    id: roomId,
                                    order: entity.order
                                }]
                            });
                        }
                    });
                });
            }
        }
        
        const response = await fetch('/api/setup/entities', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ entities })
        });
        
        if (response.ok) {
            showToast('Configuration saved successfully', 'success');
        } else {
            showToast('Failed to save entity configuration', 'error');
        }
    } catch (error) {
        showToast('Error saving entity configuration', 'error');
        console.error('Error:', error);
    }
}

// Update deleteRoom function
async function deleteRoom(roomId, button) {
    try {
        const response = await fetch(`/api/rooms/${roomId}`, {
            method: 'DELETE'
        });
        
        if (response.ok) {
            const roomEntry = button.closest('.room-entry');
            roomEntry.remove();
            
            // If no rooms left, add an empty one
            const roomList = document.getElementById('roomList');
            if (roomList.children.length === 0) {
                addRoom();
            }
            showToast('Room deleted successfully', 'success');
        }
    } catch (error) {
        showToast('Error deleting room', 'error');
        console.error('Error:', error);
    }
}

async function loadEntitiesStep() {
    const roomEntityList = document.getElementById('roomEntityList');
    
    // Show loading state
    roomEntityList.innerHTML = `
        <div class="loading-container">
            <div class="loading-spinner"></div>
            <div class="loading-text">Loading room entities...</div>
        </div>
    `;
    
    try {
        // Load rooms, entities, and tracked entities
        const [roomsResponse, entitiesResponse, trackedResponse] = await Promise.all([
            fetch('/api/rooms'),
            fetch('/api/ha/entities'),
            fetch('/api/entities/tracked')
        ]);
        
        const rooms = await roomsResponse.json();
        availableEntities = await entitiesResponse.json();
        const trackedData = await trackedResponse.json();
        
        // Initialize room entities map with tracked entities
        roomEntities = new Map();
        rooms.forEach(room => {
            roomEntities.set(room.id, []);
        });
        
        // Populate room entities from tracked entities
        trackedData.entities.forEach(entity => {
            entity.rooms.forEach(room => {
                const roomEnts = roomEntities.get(room.id) || [];
                roomEnts.push({
                    entity_id: entity.entity_id,
                    name: entity.name,
                    domain: entity.domain
                });
                roomEntities.set(room.id, roomEnts);
            });
        });
        
        // Render rooms
        roomEntityList.innerHTML = rooms.map(room => `
            <div class="room-entity-section" data-room-id="${room.id}">
                <div class="room-header" onclick="toggleRoomExpand(${room.id})">
                    <h4>${room.name}</h4>
                    <button class="expand-button expanded"><i class="fa-solid fa-chevron-down"></i></button>
                </div>
                <div class="room-entities expanded" id="room-entities-${room.id}">
                    <div class="entity-chips" id="entity-chips-${room.id}"></div>
                    <div class="entity-chip add-entity-chip" onclick="showEntityModal(${room.id}, '${room.name}')">
                        + Add Entity
                    </div>
                </div>
            </div>
        `).join('');
        
        // Ensure all rooms are expanded by default
        document.querySelectorAll('.room-entities').forEach(room => {
            room.classList.add('expanded');
        });
        document.querySelectorAll('.expand-button').forEach(button => {
            button.classList.add('expanded');
        });
        
        // Initialize states for all rooms
        rooms.forEach(room => {
            renderRoomEntities(room.id);
        });
        
        // Initialize save button state
        updateSaveButtonState();
        
    } catch (error) {
        // Show error state
        roomEntityList.innerHTML = `
            <div class="loading-container">
                <div class="loading-text" style="color: #dc3545;">
                    <i class="fas fa-exclamation-circle"></i>
                    Error loading entities. Please try again.
                </div>
            </div>
        `;
        console.error('Error loading entities step:', error);
    }
}

function toggleRoomExpand(roomId) {
    const section = document.querySelector(`.room-entity-section[data-room-id="${roomId}"]`);
    const button = section.querySelector('.expand-button');
    const entities = section.querySelector('.room-entities');
    
    button.classList.toggle('expanded');
    entities.classList.toggle('expanded');
}

function renderRoomEntities(roomId) {
    const entities = roomEntities.get(roomId) || [];
    const container = document.getElementById(`entity-chips-${roomId}`);
    
    if (!container) {
        console.error(`Container not found for room ${roomId}`);
        return;
    }
    
    if (entities.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <p>No entities added to this room yet</p>
                <p class="empty-state-hint">Click "+ Add Entity" to get started</p>
            </div>
        `;
        return;
    }

    // Group entities by domain for better organization
    const groups = {
        script: entities.filter(e => e.domain === 'script'),
        climate: entities.filter(e => e.domain === 'climate'),
        light: entities.filter(e => e.domain === 'light'),
        switch: entities.filter(e => e.domain === 'switch'),
        sensor: entities.filter(e => e.domain === 'sensor'),
        binary_sensor: entities.filter(e => e.domain === 'binary_sensor'),
        other: entities.filter(e => !['script', 'climate', 'light', 'switch', 'sensor', 'binary_sensor'].includes(e.domain))
    };

    container.innerHTML = Object.entries(groups)
        .filter(([_, groupEntities]) => groupEntities.length > 0)
        .map(([groupType, groupEntities]) => {
            const groupDisplayName = {
                script: 'Scripts',
                climate: 'Climate',
                light: 'Lights',
                switch: 'Switches',
                sensor: 'Sensors',
                binary_sensor: 'Binary Sensors',
                other: 'Other'
            }[groupType];

            return `
                <div class="entity-group" data-group="${groupType}">
                    <div class="group-header">
                        <span>${groupDisplayName}</span>
                        ${groupType === 'climate' ? '<span class="help-text-climate">1 climate per room</span>' : ''}
                    </div>
                    <div class="entity-chips-container sortable-group" data-room="${roomId}" data-type="${groupType}">
                        ${groupEntities.map(entity => `
                            <div class="entity-chip${groupType === 'climate' ? ' climate-chip' : ''}" 
                                 data-entity-id="${entity.entity_id}" 
                                 data-domain="${entity.domain}">
                                ${groupType !== 'climate' ? '<div class="entity-drag-handle">⋮</div>' : ''}
                                <i class="fa-solid fa-${getEntityIcon(entity.domain)}"></i>
                                ${entity.name}
                                <span class="remove-entity" onclick="removeEntityFromRoom(${roomId}, '${entity.entity_id}')">&times;</span>
                            </div>
                        `).join('')}
                    </div>
                </div>
            `;
        }).join('');

    // Initialize sorting for each group (except climate)
    container.querySelectorAll('.sortable-group').forEach(group => {
        if (group.dataset.type !== 'climate') {
            new Sortable(group, {
                animation: 150,
                handle: '.entity-drag-handle',
                group: `entities-${group.dataset.type}`,
                onEnd: async function(evt) {
                    const roomId = evt.to.dataset.room;
                    const groupType = evt.to.dataset.type;
                    await updateEntityOrder(roomId, groupType);
                    await saveEntityConfig(); // Auto-save after reordering
                }
            });
        }
    });

    updateSaveButtonState();
}

function updateEntityOrder(roomId, groupType) {
    const container = document.querySelector(`.sortable-group[data-room="${roomId}"][data-type="${groupType}"]`);
    if (!container) return;

    const entityIds = Array.from(container.querySelectorAll('.entity-chip')).map(chip => chip.dataset.entityId);
    
    // Send the updated order to the server
    fetch(`/api/rooms/${roomId}/entities/reorder`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            entityIds: entityIds
        })
    })
    .then(() => {
        showToast('Entity order updated', 'success');
    })
    .catch(error => {
        console.error('Error saving entity order:', error);
        showToast('Failed to update entity order', 'error');
    });

    // Update local state
    const currentEntities = roomEntities.get(roomId) || [];
    const entityMap = new Map(currentEntities.map(e => [e.entity_id, e]));
    
    // Create new ordered array based on the DOM order
    const orderedEntities = entityIds
        .map(id => entityMap.get(id))
        .filter(Boolean);
    
    // Get entities not in this group
    const otherEntities = currentEntities.filter(e => !entityIds.includes(e.entity_id));

    // Update the roomEntities map with the new order
    roomEntities.set(roomId, [...otherEntities, ...orderedEntities]);
}

if (document.querySelector('.setup-step:last-child')) {
    loadEntitiesStep();
}

// Add some CSS styles
const style = document.createElement('style');
style.textContent = `
    .connection-status {
        margin: 15px 0;
        padding: 10px;
        border-radius: 13px;
    }
    
    .connection-status .testing {
        color: #666;
    }
    
    .connection-status .success {
        color: #2ecc71;
    }
    
    .connection-status .error {
        color: #e74c3c;
    }
    
    .setup-step-buttons {
        display: flex;
        gap: 10px;
        margin-top: 20px;
    }
`;
document.head.appendChild(style);

// Add this function to load available cards
async function loadAvailableCards(domain) {
    try {
        const response = await fetch('/api/cards/available');
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const cards = await response.json();
        
        // Ensure cards is an array before filtering
        if (!Array.isArray(cards)) {
            console.error('Expected array of cards, got:', cards);
            return [];
        }
        
        // Filter cards based on entity domain
        return cards.filter(card => 
            card.entity_type === domain || 
            card.entity_type === 'all' ||
            !card.entity_type  // Include cards without entity_type specified
        );
    } catch (error) {
        console.error('Error loading cards:', error);
        return [];
    }
}

// Update showEntityModal function to handle two-step selection
async function showEntityModal(roomId, roomName) {
    const modal = document.getElementById('entityModal');
    const modalRoomName = document.getElementById('modalRoomName');
    const modalEntityList = document.getElementById('modalEntityList');
    const searchInput = document.getElementById('entitySearch');
    const saveBtn = modal.querySelector('.modal-save');
    
    // Reset modal state
    modalRoomName.textContent = roomName;
    searchInput.value = '';
    saveBtn.disabled = true;
    
    // Get entities already in the room
    const roomEntityIds = new Set((roomEntities.get(roomId) || []).map(e => e.entity_id));
    const hasClimate = (roomEntities.get(roomId) || []).some(e => e.domain === 'climate');
    
    // Render available entities
    function renderEntities(searchTerm = '') {
        const filteredEntities = availableEntities.filter(entity => {
            if (roomEntityIds.has(entity.entity_id)) return false;
            if (entity.domain === 'climate' && hasClimate) return false;
            
            if (searchTerm) {
                const searchLower = searchTerm.toLowerCase();
                return entity.name.toLowerCase().includes(searchLower) || 
                       entity.entity_id.toLowerCase().includes(searchLower);
            }
            return true;
        });

        const groupedEntities = groupEntitiesByDomain(filteredEntities);
        
        modalEntityList.innerHTML = Object.entries(groupedEntities)
            .filter(([domain, entities]) => entities.length > 0)
            .map(([domain, entities]) => `
                <div class="entity-section">
                    <h5 class="entity-section-header">
                        <i class="fa-solid fa-${getEntityIcon(domain)}"></i>
                        ${domain.charAt(0).toUpperCase() + domain.slice(1)}s
                    </h5>
                    <div class="modal-entity-grid">
                        ${entities.map(entity => `
                            <div class="entity-card" 
                                 data-entity-id="${entity.entity_id}" 
                                 data-domain="${entity.domain}">
                                <div class="entity-icon">
                                    <i class="fa-solid fa-${getEntityIcon(entity.domain)}"></i>
                                </div>
                                <div class="entity-friendly-name">${entity.name}</div>
                                <div class="entity-full-name">${entity.entity_id}</div>
                            </div>
                        `).join('')}
                    </div>
                </div>
            `).join('');

        // Add click handlers for entity cards
        modalEntityList.querySelectorAll('.entity-card').forEach(card => {
            card.addEventListener('click', () => {
                // Toggle selection
                modalEntityList.querySelectorAll('.entity-card').forEach(c => 
                    c.classList.remove('selected'));
                card.classList.add('selected');
                saveBtn.disabled = false;
            });
        });
    }
    
    // Initial render
    renderEntities();
    
    // Setup search
    searchInput.addEventListener('input', (e) => renderEntities(e.target.value));
    
    // Update save button handler
    saveBtn.onclick = async () => {
        const selectedCard = modalEntityList.querySelector('.entity-card.selected');
        if (!selectedCard) return;
        
        const entityId = selectedCard.dataset.entityId;
        const entity = availableEntities.find(e => e.entity_id === entityId);
        
        try {
            const response = await fetch(`/api/rooms/${roomId}/devices`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    entity_id: entity.entity_id,
                    name: entity.name,
                    domain: entity.domain
                })
            });

            if (response.ok) {
                // Update the roomEntities Map with the new entity
                const currentEntities = roomEntities.get(roomId) || [];
                currentEntities.push({
                    entity_id: entity.entity_id,
                    name: entity.name,
                    domain: entity.domain
                });
                roomEntities.set(roomId, currentEntities);

                // Re-render and auto-save
                renderRoomEntities(roomId);
                await saveEntityConfig();
                
                modal.style.display = 'none';
                showToast('Entity added successfully', 'success');
            } else {
                const error = await response.json();
                showToast(error.error || 'Error adding entity', 'error');
            }
        } catch (error) {
            console.error('Error saving entity:', error);
            showToast('Error adding entity', 'error');
        }
    };
    
    // Show modal
    modal.style.display = 'block';

    // Add this near the end of the function
    if (window.innerWidth <= 768) {
        // Scroll modal to top on mobile
        modalEntityList.scrollTop = 0;
        
        // Focus search input with a slight delay to prevent visual issues
        setTimeout(() => {
            searchInput.focus();
        }, 300);
    }
}

async function removeEntityFromRoom(roomId, entityId) {
    try {
        const response = await fetch(`/api/rooms/${roomId}/devices/${entityId}`, {
            method: 'DELETE'
        });

        if (response.ok) {
            // Update local state
            const entities = roomEntities.get(roomId) || [];
            const updatedEntities = entities.filter(e => e.entity_id !== entityId);
            roomEntities.set(roomId, updatedEntities);

            // Re-render and auto-save
            renderRoomEntities(roomId);
            await saveEntityConfig();
            
            showToast('Entity removed successfully', 'success');
        } else {
            showToast('Error removing entity', 'error');
        }
    } catch (error) {
        console.error('Error:', error);
        showToast('Error removing entity', 'error');
    }
}

// Update saveEntityConfig to handle the Map iteration properly
async function saveEntityConfig() {
    try {
        const entities = [];
        if (roomEntities && roomEntities.size > 0) {
            for (const [roomId, roomEntityList] of roomEntities) {
                const container = document.getElementById(`entity-chips-${roomId}`);
                if (!container) continue;

                // Process each group type with its own order counter
                const groups = ['script', 'climate', 'light', 'switch', 'sensor', 'binary_sensor', 'other'];
                
                // Initialize order counters for each domain
                const domainOrders = {
                    script: 0,
                    climate: 0,
                    light: 0,
                    switch: 0,
                    sensor: 0,
                    binary_sensor: 0,
                    other: 0
                };

                groups.forEach(groupType => {
                    const groupContainer = container.querySelector(`.sortable-group[data-type="${groupType}"]`);
                    if (!groupContainer) return;

                    // Get entities in their current order for this group
                    const groupEntities = Array.from(groupContainer.querySelectorAll('.entity-chip'))
                        .map(chip => {
                            const entityId = chip.dataset.entityId;
                            const entity = roomEntityList.find(e => e.entity_id === entityId);
                            if (entity) {
                                // Use domain-specific order counter
                                const domain = entity.domain;
                                const order = domainOrders[domain] || domainOrders.other;
                                domainOrders[domain] = (domainOrders[domain] || 0) + 1;
                                
                                return {
                                    ...entity,
                                    order: order
                                };
                            }
                            return null;
                        })
                        .filter(Boolean);

                    // Add entities from this group to the main entities array
                    groupEntities.forEach(entity => {
                        const existingEntity = entities.find(e => e.entity_id === entity.entity_id);
                        if (existingEntity) {
                            existingEntity.rooms.push({
                                id: roomId,
                                order: entity.order
                            });
                        } else {
                            entities.push({
                                ...entity,
                                rooms: [{
                                    id: roomId,
                                    order: entity.order
                                }]
                            });
                        }
                    });
                });
            }
        }
        
        const response = await fetch('/api/setup/entities', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ entities })
        });
        
        if (response.ok) {
            showToast('Configuration saved successfully', 'success');
        } else {
            showToast('Failed to save entity configuration', 'error');
        }
    } catch (error) {
        showToast('Error saving entity configuration', 'error');
        console.error('Error:', error);
    }
}

// Load entities step when on step 3
if (document.querySelector('.setup-step:last-child')) {
    loadEntitiesStep();
}

// Update the saveEntityConfig button state based on whether any rooms have entities
function updateSaveButtonState() {
    const saveButton = document.querySelector('#entities-tab button[onclick="saveEntityConfig()"]');
    if (saveButton) {
        const hasEntities = Array.from(roomEntities.values()).some(entities => entities.length > 0);
        saveButton.disabled = !hasEntities;
    }
}

// Add helper function to get icon based on domain
function getEntityIcon(domain) {
    const iconMap = {
        light: 'lightbulb',
        switch: 'power-off',
        climate: 'temperature-half',
        sensor: 'gauge',
        binary_sensor: 'toggle-on',
        script: 'code', // Add script icon
        media_player: 'play',
        camera: 'video',
        cover: 'blinds',
        fan: 'fan',
        default: 'circle-dot'
    };
    return iconMap[domain] || iconMap.default;
}

// Add input event listener for room name changes
function initializeRoomInputs() {
    document.querySelectorAll('.room-entry input').forEach(input => {
        input.addEventListener('blur', saveRooms);
    });
}

// Add this helper function to group entities by domain
function groupEntitiesByDomain(entities) {
    const groups = {
        script: [],    // Scripts first
        climate: [],
        light: [],
        switch: [],
        sensor: [],
        binary_sensor: [],
        other: []
    };
    
    entities.forEach(entity => {
        if (groups.hasOwnProperty(entity.domain)) {
            groups[entity.domain].push(entity);
        } else {
            groups.other.push(entity);
        }
    });
    
    // Remove empty groups
    return Object.fromEntries(
        Object.entries(groups).filter(([_, entities]) => entities.length > 0)
    );
}

// Add touch event handling for better mobile experience
function initializeMobileEvents() {
    // Prevent body scrolling when modal is open on mobile
    const modal = document.getElementById('entityModal');
    modal.addEventListener('touchmove', (e) => {
        if (e.target === modal) {
            e.preventDefault();
        }
    });

    // Add touch feedback for entity cards
    document.addEventListener('touchstart', (e) => {
        const entityCard = e.target.closest('.entity-card');
        if (entityCard) {
            entityCard.style.opacity = '0.7';
        }
    }, { passive: true });

    document.addEventListener('touchend', (e) => {
        const entityCard = e.target.closest('.entity-card');
        if (entityCard) {
            entityCard.style.opacity = '1';
        }
    }, { passive: true });
}

