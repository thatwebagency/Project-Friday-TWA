let roomDevices = {};
let haSocket = null;
let trackedEntities = {};
let entityStates = {};
let messageId = 1;
let pendingUpdates = new Set();

// Time functions
function updateTime() {
    const now = new Date();
    const timeString = now.toLocaleTimeString('en-US', { 
        hour: 'numeric', 
        minute: '2-digit',
        hour12: true 
    });
    const dateString = now.toLocaleDateString('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric'
    });
    document.getElementById('currentTime').textContent = timeString;
    document.getElementById('currentDate').textContent = dateString;
}

// Weather functions
async function updateWeather() {
    try {
        const forecastResponse = await fetch('/api/weather/forecast');
        const data = await forecastResponse.json();
        
        if (data.error) {
            const errorHTML = `
                <div class="error">
                    ${data.error}
                </div>
            `;
            document.querySelector('.current-weather').innerHTML = errorHTML;
            document.querySelector('.hourly-forecast').innerHTML = '';
            return;
        }

        // Map WeatherAPI condition codes to our local icons
        function getLocalIcon(code, isDay) {
            const iconMap = {
                1000: isDay ? 'sun1739422508' : 'moon1739422508',  // Clear
                1003: isDay ? 'cloud_sun1739422508' : 'cloud_moon1739422508',  // Partly cloudy
                1006: 'cloud1739422508',  // Cloudy
                1009: 'clouds1739422508',  // Overcast
                1030: 'cloud1739422508',  // Mist
                1063: isDay ? 'rain0_sun1739422508' : 'rain1_moon1739422508',  // Patchy rain
                1186: 'rain01739422508',  // Moderate rain
                1189: 'rain11739422508',  // Moderate rain
                1192: 'rain21739422508',  // Heavy rain
                1273: 'rain_lightning1739422508',  // Patchy light rain with thunder
                1276: 'rain_lightning1739422508',  // Moderate or heavy rain with thunder
                1279: isDay ? 'snow_sun1739422508' : 'snow_moon1739422508',  // Light snow
                1282: 'snow1739422508',  // Heavy snow
                1069: 'rain_snow1739422508',  // Patchy sleet
                1114: 'snow1739422508',  // Blowing snow
                1117: 'snow1739422508',  // Blizzard
                1135: 'cloud1739422508',  // Fog
                1087: 'lightning1739422508',  // Thunder
                1246: 'rain11739422508',  // Torrential rain shower
                // Wind conditions
                1030: isDay ? 'cloud_wind_sun1739422508' : 'cloud_wind_moon1739422508',  // Windy with mist
                1183: isDay ? 'rain1_sun1739422508' : 'rain1_moon1739422508',  // Light rain
            };
            
            const defaultIcon = isDay ? 'cloud_sun1739422508' : 'cloud_moon1739422508';
            return `/static/images/32/${iconMap[code] || defaultIcon}.png`;
        }
        
        const currentWeatherHTML = `
            <div class="weather-now">
                <div class="weather-location">${data.location.name}, ${data.location.region}</div>
                <div class="weather-temp">${data.current.temp_c}°C</div>
                <div class="weather-condition">
                    <img src="${getLocalIcon(data.current.condition.code, data.current.is_day)}" 
                         alt="${data.current.condition.text}"
                         class="weather-icon">
                    <span>${data.current.condition.text}</span>
                </div>
                <div class="weather-details">
                    <div>Feels like ${data.current.feelslike_c}°C</div>
                    <div>Humidity: ${data.current.humidity}%</div>
                    <div>Wind: ${data.current.wind_kph} km/h ${data.current.wind_dir}</div>
                    <div>UV Index: ${data.current.uv}</div>
                </div>
            </div>
        `;
        document.querySelector('.current-weather').innerHTML = currentWeatherHTML;
        
        // Get next 6 hours of forecast
        const currentHour = new Date().getHours();
        const hours = data.forecast.forecastday[0].hour
            .filter(hour => new Date(hour.time).getHours() > currentHour)
            .slice(0, 6);
        
        const hourlyForecastHTML = `
            <div class="forecast-title">Next 6 Hours</div>
            <div class="forecast-container">
                <div class="forecast-grid">
                    ${hours.map(hour => `
                        <div class="forecast-hour">
                            <div class="forecast-time">
                                ${new Date(hour.time).toLocaleTimeString('en-US', { hour: 'numeric', hour12: true })}
                            </div>
                            <img src="${getLocalIcon(hour.condition.code, hour.is_day)}" 
                                 alt="${hour.condition.text}"
                                 class="weather-icon">
                            <div class="forecast-temp">${hour.temp_c}°C</div>
                            <div class="forecast-rain">${hour.chance_of_rain}% rain</div>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
        document.querySelector('.hourly-forecast').innerHTML = hourlyForecastHTML;

    } catch (error) {
        console.error('Error fetching weather:', error);
        const errorHTML = `
            <div class="error">
                Unable to fetch weather data. Please try again later.
            </div>
        `;
        document.querySelector('.current-weather').innerHTML = errorHTML;
        document.querySelector('.hourly-forecast').innerHTML = '';
    }
}

// Home Assistant WebSocket functions
async function initializeHomeAssistant() {
    try {
        const response = await fetch('/api/entities/tracked');
        const data = await response.json();
        
        data.entities.forEach(entity => {
            trackedEntities[entity.entity_id] = entity;
        });
        
        await connectToHA(data.ha_config);
    } catch (error) {
        console.error('Error initializing HA connection:', error);
    }
}

function connectToHA(config) {
    return new Promise((resolve, reject) => {
        if (haSocket) {
            haSocket.close();
        }
        
        const wsUrl = config.ws_url.endsWith('/api/websocket') ? 
            config.ws_url : 
            `${config.ws_url}/api/websocket`;
        
        haSocket = new WebSocket(wsUrl);
        
        haSocket.onopen = () => {
            console.log('Connected to Home Assistant');
            haSocket.send(JSON.stringify({
                type: "auth",
                access_token: config.access_token
            }));
        };
        
        haSocket.onmessage = (event) => {
            const message = JSON.parse(event.data);
            
            if (message.type === "auth_ok") {
                console.log('Successfully authenticated with Home Assistant');
                fetchInitialStates().then(() => {
                    subscribeToStateChanges();
                    resolve();
                });
            } else if (message.type === "auth_invalid") {
                console.error('Authentication failed:', message);
                reject(new Error('Authentication failed'));
            } else if (message.type === "result" && message.success && Array.isArray(message.result)) {
                handleInitialStates(message.result);
            } else if (message.type === "event" && message.event.event_type === "state_changed") {
                handleStateChange(message.event.data);
            }
        };
        
        haSocket.onclose = (event) => {
            console.log('Disconnected from Home Assistant:', event.code, event.reason);
            // Implement exponential backoff for reconnection
            const backoffDelay = Math.min(1000 * Math.pow(2, haSocket.retries || 0), 30000);
            haSocket.retries = (haSocket.retries || 0) + 1;
            setTimeout(() => connectToHA(config), backoffDelay);
        };
        
        haSocket.onerror = (error) => {
            console.error('WebSocket error:', error);
            // Log additional connection details for debugging
            console.debug('Connection details:', {
                wsUrl,
                isNabuCasa: config.is_nabu_casa,
                readyState: haSocket.readyState
            });
        };
    });
}

function getNextMessageId() {
    return messageId++;
}

function fetchInitialStates() {
    return new Promise((resolve) => {
        haSocket.send(JSON.stringify({
            id: getNextMessageId(),
            type: 'get_states'
        }));
        
        const checkStates = setInterval(() => {
            if (Object.keys(entityStates).length > 0) {
                clearInterval(checkStates);
                resolve();
            }
        }, 100);
    });
}

function handleInitialStates(states) {
    if (!Array.isArray(states)) {
        console.error('Received invalid states data:', states);
        return;
    }
    
    states.forEach(state => {
        if (state && trackedEntities[state.entity_id]) {
            entityStates[state.entity_id] = state;
        }
    });
}

function subscribeToStateChanges() {
    haSocket.send(JSON.stringify({
        id: getNextMessageId(),
        type: "subscribe_events",
        event_type: "state_changed"
    }));
}

function showToast(message, duration = 3000) {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    
    const container = document.querySelector('.toast-container');
    container.appendChild(toast);
    
    // Trigger reflow to ensure animation works
    toast.offsetHeight;
    
    // Show toast
    requestAnimationFrame(() => {
        toast.classList.add('show');
    });
    
    // Remove toast after duration
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

function handleStateChange(data) {
    const entityId = data.entity_id;
    const newState = data.new_state;
    const oldState = data.old_state;
    
    // Update our local state
    entityStates[entityId] = newState;
    
    // Only show notification if this entity was being updated
    if (pendingUpdates.has(entityId)) {
        // Generate appropriate notification message
        let message = '';
        if (entityId.startsWith('light.')) {
            const friendlyName = newState.attributes?.friendly_name || 'Light';
            if (newState.state === 'on' && oldState?.state === 'off') {
                message = `${friendlyName} turned on`;
            } else if (newState.state === 'off' && oldState?.state === 'on') {
                message = `${friendlyName} turned off`;
            } else if (newState.state === 'on' && newState.attributes?.brightness) {
                const brightnessPercent = Math.round((newState.attributes.brightness / 255) * 100);
                message = `${friendlyName} set to ${brightnessPercent}%`;
            }
        } else if (entityId.startsWith('climate.')) {
            const friendlyName = newState.attributes?.friendly_name || 'Climate';
            if (newState.attributes?.temperature !== oldState?.attributes?.temperature) {
                message = `${friendlyName} set to ${newState.attributes.temperature}°C`;
            } else if (newState.state !== oldState?.state) {
                const mode = newState.state.charAt(0).toUpperCase() + newState.state.slice(1);
                message = `${friendlyName} mode changed to ${mode}`;
            } else if (newState.attributes?.fan_mode !== oldState?.attributes?.fan_mode) {
                const fanMode = newState.attributes.fan_mode.charAt(0).toUpperCase() + 
                               newState.attributes.fan_mode.slice(1);
                message = `${friendlyName} fan set to ${fanMode}`;
            }
        }
        
        // Show notification if we have a message
        if (message) {
            showToast(message);
        }
        
        // Remove entity from pending updates
        pendingUpdates.delete(entityId);
    }
    
    // Always update UI for the entity regardless of pending status
    const deviceCard = document.querySelector(`[data-device-id="${entityId}"]`);
    if (deviceCard) {
        if (entityId.startsWith('light.')) {
            updateLightCard(entityId, newState);
        } else if (entityId.startsWith('climate.')) {
            updateClimateDisplay(entityId, newState);
        } else if (entityId.startsWith('sensor.')) {
            updateSensorCard(entityId, newState);
        }
    }
}

function updateLightCard(entityId, state) {
    const card = document.querySelector(`[data-device-id="${entityId}"]`);
    if (!card) return;
    
    // Update card state attribute
    card.setAttribute('data-state', state.state);
    
    // Update brightness level display
    const brightnessLevel = card.querySelector('.brightness-level');
    if (brightnessLevel) {
        if (state.state === 'on') {
            const brightnessPercent = Math.round((state.attributes?.brightness || 0) / 255 * 100);
            brightnessLevel.textContent = `${brightnessPercent}%`;
        } else {
            brightnessLevel.textContent = 'Off';
        }
    }
    
    // Hide loader if it exists
    hideLoader(card);
    
    // If brightness modal is open for this device, update it
    const brightnessModal = document.querySelector('.brightness-modal.show');
    if (brightnessModal) {
        const brightnessValue = brightnessModal.querySelector('.brightness-value');
        if (brightnessValue) {
            if (state.state === 'on') {
                const brightnessPercent = Math.round((state.attributes?.brightness || 0) / 255 * 100);
                brightnessValue.textContent = `${brightnessPercent}%`;
            } else {
                brightnessValue.textContent = 'Off';
            }
        }
    }
}

// Room and device functions
async function loadRooms() {
    try {
        await initializeHomeAssistant();
        
        const response = await fetch('/api/rooms');
        const rooms = await response.json();
        
        // Load devices for all rooms first
        await Promise.all(rooms.map(room => loadRoomDevices(room.id)));
        
        // Generate room tabs HTML without empty state indication
        const roomsHTML = rooms.map(room => `
            <div class="room-tab ${room.id === rooms[0].id ? 'active' : ''}" 
                 data-room-id="${room.id}">
                ${room.name}
            </div>
        `).join('');
        
        document.getElementById('roomsContainer').innerHTML = roomsHTML;
        
        document.querySelectorAll('.room-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                document.querySelectorAll('.room-tab').forEach(t => 
                    t.classList.remove('active'));
                tab.classList.add('active');
                displayRoomDevices(tab.dataset.roomId);
            });
        });
        
        if (rooms.length > 0) {
            displayRoomDevices(rooms[0].id);
        }
        
    } catch (error) {
        console.error('Error loading rooms:', error);
        document.getElementById('roomsContainer').innerHTML = `
            <div class="error">Unable to load rooms</div>
        `;
    }
}

async function loadRoomDevices(roomId) {
    try {
        const response = await fetch(`/api/rooms/${roomId}/devices`);
        const devices = await response.json();
        roomDevices[roomId] = devices;
    } catch (error) {
        console.error(`Error loading devices for room ${roomId}:`, error);
        roomDevices[roomId] = [];
    }
}

function displayRoomDevices(roomId) {
    const devices = roomDevices[roomId] || [];
    
    // Sort devices by their order within each category
    const categories = {
        sensors: devices.filter(d => d.type === 'sensor').sort((a, b) => a.order - b.order),
        lights: devices.filter(d => d.type === 'light').sort((a, b) => a.order - b.order),
        climate: devices.filter(d => d.type === 'climate').sort((a, b) => a.order - b.order),
        other: devices.filter(d => d.type !== 'light' && d.type !== 'climate' && d.type !== 'sensor')
            .sort((a, b) => a.order - b.order),
    };
    
    // Check if there are any non-climate devices
    const hasNonClimateDevices = Object.entries(categories)
        .filter(([category]) => category !== 'climate')
        .some(([_, devices]) => devices.length > 0);

    // Define the order of categories
    const categoryOrder = ['sensors', 'lights', 'other'];

    // Generate sections HTML only if there are non-climate devices
    const sectionsHTML = hasNonClimateDevices ? 
        categoryOrder
            .map(category => {
                const deviceList = categories[category];
                if (deviceList.length === 0) return '';
                
                return `
                    <div class="device-section">
                        <h2 class="section-title">${category.charAt(0).toUpperCase() + category.slice(1)}</h2>
                        <div class="devices-grid">
                            ${deviceList.map(device => {
                                const currentState = entityStates[device.id] || {};
                                const isOn = currentState.state === 'on';
                                const brightness = currentState.attributes?.brightness || 0;
                                
                                return `
                                    <div class="device-card ${device.type === 'light' ? 'light-card' : ''} 
                                                    ${device.type === 'sensor' ? 'sensor-card' : ''}" 
                                         data-device-id="${device.id}"
                                         data-state="${currentState.state || 'unknown'}"
                                         ${device.type === 'light' ? 'data-action="toggle"' : ''}>
                                        <div class="device-controls">
                                            ${device.type === 'light' ? getLightControls({
                                                ...device,
                                                state: currentState.state,
                                                attributes: currentState.attributes
                                            }) : getDeviceControls({
                                                ...device,
                                                state: currentState.state,
                                                attributes: currentState.attributes
                                            })}
                                        </div>
                                    </div>
                                `;
                            }).join('')}
                        </div>
                    </div>
                `;
            }).join('') :
        `<div class="empty-state">
            <p>No devices in this room yet</p>
            <p class="empty-state-hint">Add devices to this room to see them here.</p>
        </div>`;

    // Only add climate bar and modal if we have climate devices
    const climateDevices = categories.climate;
    const climateHTML = climateDevices.length > 0 ? `
        <div class="climate-control-bar">
            ${climateDevices.map(device => {
                const state = entityStates[device.id] || {};
                const currentTemp = state.attributes?.temperature || 0;
                const currentMode = state.state || 'off';
                const fanMode = state.attributes?.fan_mode || 'auto';
                const currentRoomTemp = state.attributes?.current_temperature || '—';
                
                const displayMode = currentMode.charAt(0).toUpperCase() + currentMode.slice(1);
                const displayFanMode = fanMode.charAt(0).toUpperCase() + fanMode.slice(1);
                
                return `
                    <div class="climate-control">
                        <span class="climate-label">Currently ${currentRoomTemp}°C</span>
                        <div class="temp-display" data-device-id="${device.id}">
                            ${currentTemp}°C
                        </div>
                    </div>
                    <div class="climate-control">
                        <span class="climate-label">Mode</span>
                        <div class="climate-value">
                            <div class="climate-value-display" data-type="mode" data-device-id="${device.id}">
                                <span class="current-value">${displayMode}</span>
                            </div>
                            <div class="climate-dropdown" data-type="mode">
                                ${(state.attributes?.hvac_modes || []).map(mode => `
                                    <div class="climate-option ${mode === currentMode ? 'selected' : ''}" 
                                         data-value="${mode}">
                                        ${mode.charAt(0).toUpperCase() + mode.slice(1)}
                                    </div>
                                `).join('')}
                            </div>
                        </div>
                    </div>
                    <div class="climate-control">
                        <span class="climate-label">Fan</span>
                        <div class="climate-value">
                            <div class="climate-value-display" data-type="fan" data-device-id="${device.id}">
                                <span class="current-value">${displayFanMode}</span>
                            </div>
                            <div class="climate-dropdown" data-type="fan">
                                ${(state.attributes?.fan_modes || []).map(mode => `
                                    <div class="climate-option ${mode === fanMode ? 'selected' : ''}" 
                                         data-value="${mode}">
                                        ${mode.charAt(0).toUpperCase() + mode.slice(1)}
                                    </div>
                                `).join('')}
                            </div>
                        </div>
                    </div>
                `;
            }).join('')}
        </div>

        <div class="temp-modal">
            <div class="temp-slider-container">
                <div class="current-temp-display">20°C</div>
                <canvas class="circular-slider" width="300" height="300"></canvas>
                <div class="temp-loader">
                    <div class="loader-spinner"></div>
                </div>
            </div>
        </div>
    ` : '';
    
    document.getElementById('roomContent').innerHTML = sectionsHTML + climateHTML;

    // Only setup listeners if we have devices
    if (climateDevices.length > 0) {
        setupDeviceControlListeners();
        setupClimateControlListeners();
        setupTempControlListeners();
    } else if (hasNonClimateDevices) {
        setupDeviceControlListeners();
    }
}

function updateDeviceCard(card, state) {
    const controls = card.querySelector('.device-controls');
    const device = {
        id: state.entity_id,
        type: state.entity_id.split('.')[0],
        state: state.state,
        name: state.attributes.friendly_name || state.entity_id,
        attributes: state.attributes
    };

    // Update card state attribute
    card.setAttribute('data-state', state.state);

    if (device.type === 'light') {
        controls.innerHTML = getLightControls(device);
    } else {
        controls.innerHTML = getDeviceControls(device);
    }
    
    setupDeviceControlListeners();
}

function getDeviceControls(device) {
    switch (device.type) {
        case 'light':
            return getLightControls(device);
        case 'climate':
            return getClimateControls(device);
        case 'sensor':
            return getSensorControls(device);
        default:
            return `<button class="toggle-btn" data-action="toggle">
                        ${device.state === 'on' ? 'Turn Off' : 'Turn On'}
                    </button>`;
    }
}

function getLightControls(device) {
    const isOn = device.state === 'on';
    const brightness = device.attributes?.brightness || 0;
    const brightnessPercent = Math.round((brightness / 255) * 100);
    
    return `
        <div class="light-header">
            <span class="brightness-level">${isOn ? `${brightnessPercent}%` : 'Off'}</span>
            <div class="toggle-circle" data-action="toggle">
                <i class="fa-regular fa-lightbulb"></i>
            </div>
        </div>
        <div class="device-name">${device.name}</div>
    `;
}

function getClimateControls(device) {
    return `
        <div class="temp-control">
            <button class="temp-btn" data-action="temp-down">-</button>
            <span class="current-temp">${device.temperature}°C</span>
            <button class="temp-btn" data-action="temp-up">+</button>
        </div>
    `;
}

function getSensorControls(device) {
    // Format the state value if it's a number
    let value = device.state;
    let unit = device.attributes?.unit_of_measurement || '';
    
    // Check if value is a number and not 'unknown', 'unavailable', etc.
    if (!isNaN(value) && value !== '') {
        value = parseFloat(value).toFixed(2);
    }
    
    return `
        <div class="sensor-value">
            ${value}<span class="sensor-unit">${unit}</span>
        </div>
        <div class="device-name">${device.name}</div>
    `;
}

function setupDeviceControlListeners() {
    document.querySelectorAll('.device-card').forEach(card => {
        const deviceId = card.dataset.deviceId;
        
        // Toggle circle click
        const toggleCircle = card.querySelector('.toggle-circle');
        if (toggleCircle) {
            toggleCircle.addEventListener('click', (e) => {
                e.stopPropagation();
                showLoader(card);
                toggleDevice(deviceId);
            });
        }
        
        // Card click for brightness modal
        if (card.classList.contains('light-card')) {
            card.addEventListener('click', (e) => {
                if (!e.target.closest('.toggle-circle')) {
                    showBrightnessModal(deviceId);
                }
            });
        }
    });
}

function showLoader(card) {
    // Remove existing loader if any
    const existingLoader = card.querySelector('.card-loader');
    if (existingLoader) {
        existingLoader.remove();
    }

    const loader = document.createElement('div');
    loader.className = 'card-loader';
    loader.innerHTML = `
        <div class="loader-spinner"></div>
    `;
    card.appendChild(loader);
}

function hideLoader(card) {
    const loader = card.querySelector('.card-loader');
    if (loader) {
        loader.remove();
    }
}

async function updateBrightness(entityId, brightness_pct) {
    if (!haSocket || haSocket.readyState !== WebSocket.OPEN) {
        console.error('WebSocket not connected');
        return;
    }

    pendingUpdates.add(entityId);
    haSocket.send(JSON.stringify({
        id: getNextMessageId(),
        type: 'call_service',
        domain: 'light',
        service: 'turn_on',
        target: {
            entity_id: entityId
        },
        service_data: {
            brightness_pct: parseInt(brightness_pct)
        }
    }));
}

function showBrightnessModal(deviceId) {
    const device = entityStates[deviceId];
    const brightness = device?.attributes?.brightness || 0;
    const brightnessPercent = Math.round((brightness / 255) * 100);
    const isOn = device?.state === 'on';
    
    // Remove existing modal if any
    const existingModal = document.querySelector('.brightness-modal');
    if (existingModal) {
        existingModal.remove();
    }
    
    const modal = document.createElement('div');
    modal.className = 'brightness-modal';
    modal.innerHTML = `
        <div class="brightness-slider-container">
            <h3>${device?.attributes?.friendly_name || 'Light'}</h3>
            <input type="range" 
                   class="vertical-brightness-slider" 
                   value="${brightnessPercent}" 
                   min="0" 
                   max="100"
                   step="1">
            <div class="brightness-value">${isOn ? `${brightnessPercent}%` : 'Off'}</div>
        </div>
    `;
    
    document.body.appendChild(modal);
    
    // Show modal with animation
    requestAnimationFrame(() => {
        modal.classList.add('show');
    });
    
    // Setup event listeners
    const slider = modal.querySelector('.vertical-brightness-slider');
    const brightnessValue = modal.querySelector('.brightness-value');
    
    // Update display during sliding without sending updates
    slider.addEventListener('input', (e) => {
        const percent = parseInt(e.target.value);
        brightnessValue.textContent = percent === 0 ? 'Off' : `${percent}%`;
    });
    
    // Send update only when sliding ends
    slider.addEventListener('change', (e) => {
        const percent = parseInt(e.target.value);
        
        // Show loader when updating brightness
        const card = document.querySelector(`[data-device-id="${deviceId}"]`);
        if (card) showLoader(card);
        
        updateBrightness(deviceId, percent);
    });
    
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            modal.classList.remove('show');
            setTimeout(() => modal.remove(), 300);
        }
    });
}

async function toggleDevice(entityId) {
    if (!haSocket || haSocket.readyState !== WebSocket.OPEN) {
        console.error('WebSocket not connected');
        return;
    }

    pendingUpdates.add(entityId);
    const domain = entityId.split('.')[0];
    const service = entityStates[entityId]?.state === 'on' ? 'turn_off' : 'turn_on';

    haSocket.send(JSON.stringify({
        id: getNextMessageId(),
        type: 'call_service',
        domain: domain,
        service: service,
        target: {
            entity_id: entityId
        }
    }));
}

function setupClimateControlListeners() {
    // Temperature controls
    document.querySelectorAll('.temp-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const deviceId = btn.dataset.deviceId;
            const action = btn.dataset.action;
            const state = entityStates[deviceId];
            const currentTemp = state.attributes?.temperature || 0;
            const newTemp = action === 'temp-up' ? currentTemp + 0.5 : currentTemp - 0.5;
            updateClimateTemp(deviceId, newTemp);
        });
    });

    // Custom dropdown controls
    document.querySelectorAll('.climate-value-display').forEach(display => {
        display.addEventListener('click', (e) => {
            e.stopPropagation();
            const dropdown = display.parentElement.querySelector('.climate-dropdown');
            
            // Close all other dropdowns first
            document.querySelectorAll('.climate-dropdown.show').forEach(d => {
                if (d !== dropdown) d.classList.remove('show');
            });
            
            dropdown.classList.toggle('show');
        });
    });

    document.querySelectorAll('.climate-option').forEach(option => {
        option.addEventListener('click', (e) => {
            e.stopPropagation();
            const deviceId = option.closest('.climate-value').querySelector('.climate-value-display').dataset.deviceId;
            const type = option.closest('.climate-dropdown').dataset.type;
            const value = option.dataset.value;
            
            // Update the display
            const displayElement = option.closest('.climate-value').querySelector('.current-value');
            displayElement.textContent = value;
            
            // Update the selected state
            option.closest('.climate-dropdown').querySelectorAll('.climate-option').forEach(opt => {
                opt.classList.remove('selected');
            });
            option.classList.add('selected');
            
            // Close the dropdown
            option.closest('.climate-dropdown').classList.remove('show');
            
            // Send update to HA
            if (type === 'mode') {
                updateClimateMode(deviceId, value);
            } else if (type === 'fan') {
                updateClimateFan(deviceId, value);
            }
        });
    });

    // Close dropdowns when clicking outside
    document.addEventListener('click', () => {
        document.querySelectorAll('.climate-dropdown.show').forEach(dropdown => {
            dropdown.classList.remove('show');
        });
    });
}

function updateClimateTemp(entityId, temperature) {
    if (!haSocket || haSocket.readyState !== WebSocket.OPEN) return;

    const currentState = entityStates[entityId];
    let hvac_mode = currentState.state;
    
    // If current mode is 'off', set to cool
    if (hvac_mode === 'off') {
        hvac_mode = 'cool';
        
        // First set the mode
        haSocket.send(JSON.stringify({
            id: getNextMessageId(),
            type: 'call_service',
            domain: 'climate',
            service: 'set_hvac_mode',
            target: { entity_id: entityId },
            service_data: { hvac_mode }
        }));
    }

    pendingUpdates.add(entityId);
    haSocket.send(JSON.stringify({
        id: getNextMessageId(),
        type: 'call_service',
        domain: 'climate',
        service: 'set_temperature',
        target: { entity_id: entityId },
        service_data: { temperature }
    }));
}

function updateClimateMode(entityId, hvac_mode) {
    if (!haSocket || haSocket.readyState !== WebSocket.OPEN) return;

    pendingUpdates.add(entityId);
    haSocket.send(JSON.stringify({
        id: getNextMessageId(),
        type: 'call_service',
        domain: 'climate',
        service: 'set_hvac_mode',
        target: { entity_id: entityId },
        service_data: { hvac_mode }
    }));
}

function updateClimateFan(entityId, fan_mode) {
    if (!haSocket || haSocket.readyState !== WebSocket.OPEN) return;

    const currentState = entityStates[entityId];
    let hvac_mode = currentState.state;
    
    // If current mode is 'off', set to cool
    if (hvac_mode === 'off') {
        hvac_mode = 'cool';
        
        // First set the mode
        haSocket.send(JSON.stringify({
            id: getNextMessageId(),
            type: 'call_service',
            domain: 'climate',
            service: 'set_hvac_mode',
            target: { entity_id: entityId },
            service_data: { hvac_mode }
        }));
    }

    pendingUpdates.add(entityId);
    haSocket.send(JSON.stringify({
        id: getNextMessageId(),
        type: 'call_service',
        domain: 'climate',
        service: 'set_fan_mode',
        target: { entity_id: entityId },
        service_data: { fan_mode }
    }));
}

function setupTempControlListeners() {
    const tempDisplays = document.querySelectorAll('.temp-display');
    const modal = document.querySelector('.temp-modal');
    const canvas = document.querySelector('.circular-slider');
    const sliderContainer = document.querySelector('.temp-slider-container');
    
    if (!canvas) return;
    
    canvas.width = 300;
    canvas.height = 300;
    
    const ctx = canvas.getContext('2d');
    let isDragging = false;

    function calculateTempFromPosition(x, y) {
        const rect = canvas.getBoundingClientRect();
        const centerX = rect.width / 2;
        const centerY = rect.height / 2;
        
        // Calculate angle from center to mouse position
        const angle = Math.atan2(y - centerY, x - centerX);
        
        // Constrain angle to our arc range (-0.8π to 0.8π)
        let constrainedAngle = angle;
        if (angle < -Math.PI * 0.8) constrainedAngle = -Math.PI * 0.8;
        if (angle > Math.PI * 0.8) constrainedAngle = Math.PI * 0.8;
        
        // Convert angle to temperature (16-30°C range)
        const percentage = (constrainedAngle + Math.PI * 0.8) / (Math.PI * 1.6);
        const temp = Math.round(16 + (30 - 16) * percentage);
        return Math.min(Math.max(temp, 16), 30); // Ensure temp stays within bounds
    }

    function drawSlider(temp) {
        const width = canvas.width;
        const height = canvas.height;
        const centerX = width / 2;
        const centerY = height / 2;
        const radius = Math.min(width, height) / 2 - 20;
        
        ctx.clearRect(0, 0, width, height);
        
        // Draw background arc
        ctx.beginPath();
        ctx.arc(centerX, centerY, radius, -Math.PI * 0.8, Math.PI * 0.8);
        ctx.strokeStyle = '#f0f0f0';
        ctx.lineWidth = 20;
        ctx.stroke();
        
        // Draw temperature arc
        const percentage = (temp - 16) / (30 - 16);
        const angle = -Math.PI * 0.8 + (Math.PI * 1.6 * percentage);
        
        ctx.beginPath();
        ctx.arc(centerX, centerY, radius, -Math.PI * 0.8, angle);
        ctx.strokeStyle = '#000000';
        ctx.stroke();
        
        // Draw handle
        ctx.beginPath();
        const handleX = centerX + radius * Math.cos(angle);
        const handleY = centerY + radius * Math.sin(angle);
        ctx.arc(handleX, handleY, 15, 0, Math.PI * 2);
        ctx.fillStyle = '#000000';
        ctx.fill();
    }

    tempDisplays.forEach(display => {
        display.addEventListener('click', () => {
            const deviceId = display.dataset.deviceId;
            const currentTemp = entityStates[deviceId].attributes.temperature;
            
            // Store the device ID in the slider container
            sliderContainer.dataset.deviceId = deviceId;
            
            modal.classList.add('show');
            document.querySelector('.current-temp-display').textContent = `${currentTemp}°C`;
            drawSlider(currentTemp);
        });
    });

    function handleMove(e) {
        if (!isDragging) return;
        
        e.preventDefault();
        
        // Get mouse or touch position
        const clientX = e.type.includes('touch') ? e.touches[0].clientX : e.clientX;
        const clientY = e.type.includes('touch') ? e.touches[0].clientY : e.clientY;
        
        const rect = canvas.getBoundingClientRect();
        const x = clientX - rect.left;
        const y = clientY - rect.top;
        
        const temp = calculateTempFromPosition(x, y);
        document.querySelector('.current-temp-display').textContent = `${temp}°C`;
        drawSlider(temp);
    }

    function startDragging(e) {
        isDragging = true;
        handleMove(e);
    }

    function stopDragging() {
        if (!isDragging) return;
        isDragging = false;
        
        const temp = parseInt(document.querySelector('.current-temp-display').textContent);
        document.querySelector('.temp-loader').classList.add('show');
        updateClimateTemp(sliderContainer.dataset.deviceId, temp);
    }

    // Mouse events
    canvas.addEventListener('mousedown', startDragging);
    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', stopDragging);

    // Touch events for mobile with passive: false
    canvas.addEventListener('touchstart', startDragging, { passive: false });
    document.addEventListener('touchmove', handleMove, { passive: false });
    document.addEventListener('touchend', stopDragging);

    // Close modal when clicking outside
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            modal.classList.remove('show');
        }
    });
}

// Add this new function to handle climate display updates
function updateClimateDisplay(entityId, state) {
    // Update temperature display
    document.querySelectorAll(`[data-device-id="${entityId}"].temp-display`).forEach(element => {
        element.textContent = `${state.attributes.temperature}°C`;
        // Update the current temperature label
        const label = element.closest('.climate-control').querySelector('.climate-label');
        if (label) {
            label.textContent = `Currently ${state.attributes.current_temperature || '—'}°C`;
        }
    });

    // Update mode display
    document.querySelectorAll(`[data-device-id="${entityId}"].climate-value-display[data-type="mode"]`).forEach(element => {
        const displayMode = state.state.charAt(0).toUpperCase() + state.state.slice(1);
        element.querySelector('.current-value').textContent = displayMode;
        
        // Update selected state in dropdown
        const dropdown = element.parentElement.querySelector('.climate-dropdown');
        if (dropdown) {
            dropdown.querySelectorAll('.climate-option').forEach(option => {
                option.classList.toggle('selected', option.dataset.value === state.state);
            });
        }
    });

    // Update fan mode display
    document.querySelectorAll(`[data-device-id="${entityId}"].climate-value-display[data-type="fan"]`).forEach(element => {
        const fanMode = state.attributes.fan_mode || 'auto';
        const displayFanMode = fanMode.charAt(0).toUpperCase() + fanMode.slice(1);
        element.querySelector('.current-value').textContent = displayFanMode;
        
        // Update selected state in dropdown
        const dropdown = element.parentElement.querySelector('.climate-dropdown');
        if (dropdown) {
            dropdown.querySelectorAll('.climate-option').forEach(option => {
                option.classList.toggle('selected', option.dataset.value === fanMode);
            });
        }
    });

    // Hide loader and modal if this entity was being updated
    const tempLoader = document.querySelector('.temp-loader');
    const tempModal = document.querySelector('.temp-modal');
    if (tempModal && tempModal.classList.contains('show')) {
        const currentDevice = tempModal.querySelector('.temp-slider-container').dataset.deviceId;
        if (currentDevice === entityId) {
            tempLoader?.classList.remove('show');
            tempModal.classList.remove('show');
        }
    }
}

function updateSensorCard(entityId, state) {
    const card = document.querySelector(`[data-device-id="${entityId}"]`);
    if (!card) return;
    
    const sensorValue = card.querySelector('.sensor-value');
    if (sensorValue) {
        let value = state.state;
        let unit = state.attributes?.unit_of_measurement || '';
        
        // Check if value is a number and not 'unknown', 'unavailable', etc.
        if (!isNaN(value) && value !== '') {
            value = parseFloat(value).toFixed(2);
        }
        
        sensorValue.innerHTML = `${value}<span class="sensor-unit">${unit}</span>`;
    }
}

// Initialize everything
document.addEventListener('DOMContentLoaded', () => {
    updateTime();
    setInterval(updateTime, 60000);
    
    updateWeather();
    setInterval(updateWeather, 300000);
    
    loadRooms();
});
