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

document.addEventListener('DOMContentLoaded', () => {
    const hiText = document.getElementById('hi-text');
    const greetingGroup = document.querySelector('.greeting-group');
    const welcomeGroup = document.querySelector('.welcome-group');
    const startButton = document.querySelector('.start-button-container');
    
    // Set greeting based on time of day
    const getGreeting = () => {
        const hour = new Date().getHours();
        if (hour < 12) return "Good Morning";
        if (hour < 18) return "Good Afternoon";
        return "Good Evening";
    };
    
    hiText.textContent = getGreeting();
    
    // Show greeting first
    greetingGroup.style.display = 'block';
    setTimeout(() => {
        hiText.classList.add('fade-in');
    }, 500);

    // After 2s, fade out greeting
    setTimeout(() => {
        hiText.classList.add('fade-out');
        setTimeout(() => {
            greetingGroup.style.display = 'none';
            
            // Show welcome group and start button
            welcomeGroup.style.display = 'block';
            startButton.style.display = 'block';
            
            welcomeGroup.querySelectorAll('.fade-word').forEach(word => {
                word.classList.add('fade-in');
            });
            startButton.querySelector('.fade-word').classList.add('fade-in');
        }, 1000);
    }, 2000);

    // Handle button click
    startButton.querySelector('.start-button').addEventListener('click', () => {
        const wrapper = document.querySelector('.setup-fade-wrapper');
        wrapper.style.transition = 'opacity 1s';
        wrapper.style.opacity = '0';
        setTimeout(() => wrapper.remove(), 1000);
    });

    // Add the next button handler
    document.getElementById('nextButton')?.addEventListener('click', async () => {
        const form = document.getElementById('haConfig');
        const formData = new FormData(form);
        const nextButton = document.getElementById('nextButton');
        const statusDiv = document.getElementById('connectionStatus');
        
        let haUrl = formData.get('ha_url').trim();
        const accessToken = formData.get('access_token').trim();
        
        if (!haUrl || !accessToken) {
            statusDiv.innerHTML = '<div class="error">Please fill in both fields</div>';
            statusDiv.classList.add('show');
            return;
        }

        // Add protocol if not present
        if (!haUrl.startsWith('http://') && !haUrl.startsWith('https://')) {
            haUrl = 'https://' + haUrl;
        }

        // Remove trailing slash if present
        haUrl = haUrl.replace(/\/$/, '');

        statusDiv.innerHTML = '<div class="testing">Testing connection...</div>';
        statusDiv.classList.add('show');
        nextButton.disabled = true;
        
        try {
            const response = await fetch('/api/setup/test-ha', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    ha_url: haUrl,
                    access_token: accessToken
                })
            });
            
            const data = await response.json();
            
            if (data.success) {
                statusDiv.innerHTML = '<div class="success">Connection successful! ✓</div>';
                // Proceed with HA configuration
                const haConfigResponse = await fetch('/api/setup/ha', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        ha_url: haUrl,
                        access_token: accessToken
                    })
                });
                
                if (haConfigResponse.ok) {
                    // Use the goToStep function with null checks
                    const currentStep = document.querySelector('.setup-step[style*="display: block"]') || 
                                     document.querySelector('.setup-step[style*="opacity: 1"]') ||
                                     document.getElementById('step1');
                    const targetStep = document.getElementById('step2');
                    
                    if (currentStep && targetStep) {
                        currentStep.style.display = 'none';
                        targetStep.style.display = 'block';
                        
                        // Update pills
                        document.querySelectorAll('.pill').forEach(pill => {
                            const pillStep = parseInt(pill.getAttribute('data-step'));
                            if (pillStep <= 2) {
                                pill.classList.add('active');
                            } else {
                                pill.classList.remove('active');
                            }
                        });
                        
                        // Update connecting lines
                        document.querySelectorAll('.pill-line').forEach((line, index) => {
                            if (index === 0) line.classList.add('active');
                            if (index === 1) line.classList.remove('active');
                        });
                        
                        // Load rooms
                        loadRooms();
                    }
                }
            } else {
                statusDiv.innerHTML = `<div class="error">Connection failed: ${data.error || 'Could not connect to Home Assistant'}</div>`;
                statusDiv.classList.add('show');
                nextButton.disabled = false;
            }
        } catch (error) {
            statusDiv.innerHTML = `<div class="error">Connection failed: ${error.message}</div>`;
            statusDiv.classList.add('show');
            nextButton.disabled = false;
        }
    });

    // Add handler for step 2 next button
    document.getElementById('step2Next')?.addEventListener('click', async () => {
        const form = document.getElementById('roomConfig');
        const formData = new FormData(form);
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

    // Initialize setup form with existing values if any
    initializeSetup();
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
    } catch (error) {
        console.error('Error loading rooms:', error);
    }
}

// Update the addRoom function to include drag handle
function addRoom() {
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
    
    // Focus the new input
    newRoom.querySelector('input').focus();
}

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
        }
    } catch (error) {
        console.error('Error deleting room:', error);
    }
}

async function loadEntitiesStep() {
    try {
        // Load rooms, entities, and tracked entities
        const [roomsResponse, entitiesResponse, trackedResponse] = await Promise.all([
            fetch('/api/rooms'),
            fetch('/api/ha/entities'),
            fetch('/api/entities/tracked')  // Add this new request
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
        const roomEntityList = document.getElementById('roomEntityList');
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
    
    if (entities.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <p>No entities added to this room yet</p>
                <p class="empty-state-hint">Click "+ Add Entity" to get started</p>
            </div>
        `;
        return;
    }

    // Group entities by type, maintaining their order within the groups
    const groups = {
        climate: entities.filter(e => e.domain === 'climate'),
        lights: entities.filter(e => e.domain === 'light'),
        sensors: entities.filter(e => ['sensor', 'binary_sensor'].includes(e.domain)),
        other: entities.filter(e => !['climate', 'light', 'sensor', 'binary_sensor'].includes(e.domain))
    };

    container.innerHTML = Object.entries(groups)
        .filter(([_, groupEntities]) => groupEntities.length > 0)
        .map(([groupType, groupEntities]) => `
            <div class="entity-group" data-group="${groupType}">
                <div class="group-header">
                    <span>${groupType.charAt(0).toUpperCase() + groupType.slice(1)}</span>
                    ${groupType !== 'climate' ? '<div class="group-drag-handle">⋮⋮</div>' : ''}
                </div>
                <div class="entity-chips-container sortable-group" data-room="${roomId}" data-type="${groupType}">
                    ${groupEntities.map(entity => `
                        <div class="entity-chip${groupType === 'climate' ? ' climate-chip' : ''}" data-entity-id="${entity.entity_id}">
                            ${groupType !== 'climate' ? '<div class="entity-drag-handle">⋮</div>' : ''}
                            <i class="fa-solid fa-${getEntityIcon(entity.domain)}"></i>
                            ${entity.name}
                            <span class="remove-entity" onclick="removeEntityFromRoom(${roomId}, '${entity.entity_id}')">&times;</span>
                        </div>
                    `).join('')}
                </div>
            </div>
        `).join('');

    // Initialize sorting for each group (except climate)
    container.querySelectorAll('.sortable-group').forEach(group => {
        if (group.dataset.type !== 'climate') {
            new Sortable(group, {
                animation: 150,
                handle: '.entity-drag-handle',
                group: `entities-${group.dataset.type}`,
                onEnd: function(evt) {
                    const roomId = evt.to.dataset.room;
                    const groupType = evt.to.dataset.type;
                    updateEntityOrder(roomId, groupType);
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
    
    // Get all entities for this room
    const currentEntities = roomEntities.get(roomId) || [];
    
    // Separate entities by group type
    const groupEntities = currentEntities.filter(e => {
        switch(groupType) {
            case 'lights':
                return e.domain === 'light';
            case 'sensors':
                return ['sensor', 'binary_sensor'].includes(e.domain);
            case 'climate':
                return e.domain === 'climate';
            case 'other':
                return !['light', 'sensor', 'binary_sensor', 'climate'].includes(e.domain);
            default:
                return false;
        }
    });

    // Create a map of entity_id to full entity object
    const entityMap = new Map(groupEntities.map(e => [e.entity_id, e]));
    
    // Create new ordered array based on the DOM order
    const orderedGroupEntities = entityIds
        .map(id => entityMap.get(id))
        .filter(Boolean);

    // Get entities not in this group
    const otherEntities = currentEntities.filter(e => {
        switch(groupType) {
            case 'lights':
                return e.domain !== 'light';
            case 'sensors':
                return !['sensor', 'binary_sensor'].includes(e.domain);
            case 'climate':
                return e.domain !== 'climate';
            case 'other':
                return ['light', 'sensor', 'binary_sensor', 'climate'].includes(e.domain);
            default:
                return true;
        }
    });

    // Update the roomEntities map with the new order
    roomEntities.set(roomId, [...otherEntities, ...orderedGroupEntities]);

    // Send the updated order to the server
    fetch(`/api/rooms/${roomId}/entities/reorder`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            group: groupType,
            entityIds: entityIds
        })
    }).catch(error => console.error('Error saving entity order:', error));
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

function showEntityModal(roomId, roomName) {
    const modal = document.getElementById('entityModal');
    const modalRoomName = document.getElementById('modalRoomName');
    const modalEntityList = document.getElementById('modalEntityList');
    const searchInput = document.getElementById('entitySearch');
    
    // Set room name in modal
    modalRoomName.textContent = roomName;
    
    // Get entities already in the room
    const roomEntityIds = new Set((roomEntities.get(roomId) || []).map(e => e.entity_id));
    const hasClimate = (roomEntities.get(roomId) || []).some(e => e.domain === 'climate');
    
    // Render available entities
    function renderEntities(searchTerm = '') {
        const filteredEntities = availableEntities.filter(entity => {
            if (roomEntityIds.has(entity.entity_id)) return false;
            // Prevent adding climate if one already exists
            if (entity.domain === 'climate' && hasClimate) return false;
            if (searchTerm) {
                const searchLower = searchTerm.toLowerCase();
                return entity.name.toLowerCase().includes(searchLower) || 
                       entity.entity_id.toLowerCase().includes(searchLower);
            }
            return true;
        });
        
        modalEntityList.innerHTML = `
            <div class="modal-entity-grid">
                ${filteredEntities.map(entity => `
                    <div class="entity-card" data-entity-id="${entity.entity_id}">
                        <div class="entity-icon">
                            <i class="fa-solid fa-${getEntityIcon(entity.domain)}"></i>
                        </div>
                        <div class="entity-friendly-name">${entity.name}</div>
                        <div class="entity-full-name">${entity.entity_id}</div>
                        <div class="entity-checkbox"></div>
                    </div>
                `).join('')}
            </div>
        `;

        // Add click handlers for cards
        modalEntityList.querySelectorAll('.entity-card').forEach(card => {
            card.addEventListener('click', () => {
                card.classList.toggle('selected');
            });
        });
    }
    
    // Initial render
    renderEntities();
    
    // Setup search
    searchInput.value = '';
    searchInput.addEventListener('input', (e) => renderEntities(e.target.value));
    
    // Setup modal buttons
    const closeBtn = modal.querySelector('.modal-close');
    const cancelBtn = modal.querySelector('.modal-cancel');
    const saveBtn = modal.querySelector('.modal-save');
    
    function closeModal() {
        modal.style.display = 'none';
        searchInput.removeEventListener('input', renderEntities);
    }
    
    closeBtn.onclick = closeModal;
    cancelBtn.onclick = closeModal;
    
    saveBtn.onclick = () => {
        const selectedCards = modalEntityList.querySelectorAll('.entity-card.selected');
        const newEntities = Array.from(selectedCards).map(card => {
            const entityId = card.dataset.entityId;
            const entity = availableEntities.find(e => e.entity_id === entityId);
            return {
                entity_id: entity.entity_id,
                name: entity.name,
                domain: entity.domain
            };
        });
        
        // Add selected entities to room
        const currentEntities = roomEntities.get(roomId) || [];
        roomEntities.set(roomId, [...currentEntities, ...newEntities]);
        
        // Re-render room entities and update save button state
        renderRoomEntities(roomId);
        updateSaveButtonState();
        closeModal();
    };
    
    // Show modal
    modal.style.display = 'block';
}

function removeEntityFromRoom(roomId, entityId) {
    const entities = roomEntities.get(roomId) || [];
    roomEntities.set(roomId, entities.filter(e => e.entity_id !== entityId));
    renderRoomEntities(roomId);
    updateSaveButtonState();
}

// Update saveEntityConfig to handle the Map iteration properly
async function saveEntityConfig() {
    try {
        // Convert roomEntities Map to array format expected by backend
        const entities = [];
        if (roomEntities && roomEntities.size > 0) {
            for (const [roomId, roomEntityList] of roomEntities) {
                roomEntityList.forEach(entity => {
                    const existingEntity = entities.find(e => e.entity_id === entity.entity_id);
                    if (existingEntity) {
                        existingEntity.rooms.push(roomId);
                    } else {
                        entities.push({
                            ...entity,
                            rooms: [roomId]
                        });
                    }
                });
            }
        }
        
        const response = await fetch('/api/setup/entities?complete_setup=true', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ entities })
        });
        
        if (response.ok) {
            // Show the setup complete modal
            const modal = document.getElementById('setupCompleteModal');
            modal.style.display = 'block';
            
            // Wait a moment, then redirect
            setTimeout(() => {
                window.location.href = '/';
            }, 2000);
        } else {
            console.error('Failed to save entity configuration');
        }
    } catch (error) {
        console.error('Error saving entity configuration:', error);
    }
}

// Load entities step when on step 3
if (document.querySelector('.setup-step:last-child')) {
    loadEntitiesStep();
}

// Update the saveEntityConfig button state based on whether any rooms have entities
function updateSaveButtonState() {
    const saveButton = document.querySelector('#step3 .setup-step-buttons button:last-child');
    const hasEntities = Array.from(roomEntities.values()).some(entities => entities.length > 0);
    saveButton.disabled = !hasEntities;
}

// Add helper function to get icon based on domain
function getEntityIcon(domain) {
    const iconMap = {
        light: 'lightbulb',
        switch: 'power-off',
        climate: 'temperature-half',
        sensor: 'gauge',
        binary_sensor: 'toggle-on',
        media_player: 'play',
        camera: 'video',
        cover: 'blinds',
        fan: 'fan',
        // Add more mappings as needed
        default: 'circle-dot'
    };
    return iconMap[domain] || iconMap.default;
}
