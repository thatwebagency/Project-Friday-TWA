let roomDevices = {};
let haSocket = null;
let trackedEntities = {};
let entityStates = {};
let messageId = 1;
let pendingUpdates = new Set();
let messageHandlers = new Map(); // Store message handlers globally
let selectedMediaPlayer = null; // Store the currently selected media player entity_id

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

function getBlindIcons(device) {
    console.log('getBlindIcons function', device);
    if (device === 'open') {
        iconName = 'blindopen';
    }
    else {
        iconName = 'blindclosed'; 
    };   
    console.log('returning icon', iconName);
    // Return the SVG string for the icon
    return blindIconsSVGs[iconName] || '';
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

        function getLocalIcon(code, isDay) {
            // Map weather API codes to icon names in our SVG collection
            const iconMap = {
                1000: isDay ? 'sun' : 'moon',  // Clear
                1003: isDay ? 'cloud_sun' : 'cloud_moon',  // Partly cloudy
                1006: 'cloud',  // Cloudy
                1009: 'clouds',  // Overcast
                1030: 'cloud',  // Mist
                1063: isDay ? 'rain0_sun' : 'rain1_moon',  // Patchy rain
                1186: 'rain0_sun',  // Moderate rain
                1189: 'rain0_sun',  // Moderate rain
                1192: 'rain2',  // Heavy rain
                1273: 'rain_lightning',  // Patchy light rain with thunder
                1276: 'rain_lightning',  // Moderate or heavy rain with thunder
                1279: isDay ? 'snow_sun' : 'snow_moon',  // Light snow
                1282: 'snow',  // Heavy snow
                1069: 'rain_snow',  // Patchy sleet
                1114: 'snow',  // Blowing snow
                1117: 'snow',  // Blizzard
                1135: 'cloud',  // Fog
                1087: 'lightning',  // Thunder
                1246: 'rain2',  // Torrential rain shower
                // Wind conditions
                1030: isDay ? 'cloud_sun' : 'cloud_moon',  // Windy with mist
                1183: isDay ? 'rain0_sun' : 'rain0_moon',  // Light rain
            };
            
            const defaultIcon = isDay ? 'cloud_sun' : 'cloud_moon';
            const iconName = iconMap[code] || defaultIcon;
            
            // Return the SVG string for the icon
            return weatherIconsSVGs[iconName] || '';
        }
        
        const currentWeatherHTML = `
    <div class="weather-now">
        <div class="weather-location">Botanic Ridge, ${data.location.region}</div>
        
        <div class="weather-temp-max">${data.forecast.forecastday[0].day.maxtemp_c}°C today!</div>
        <div class="weather-condition">
            <div class="weather-icon">
                ${getLocalIcon(data.current.condition.code, data.current.is_day)}
            </div>
            <span>${data.current.condition.text} - its currently ${data.current.temp_c}°C</span>
        </div>
       
    </div>
`;
        document.querySelector('.current-weather').innerHTML = currentWeatherHTML;
      

        // Get next 3 days of forecast
const days = data.forecast.forecastday;
const hourlyForecastHTML = `
    <div class="forecast-title">Next 3 Days</div>
    <div class="forecast-container">
        <div class="forecast-grid">
            ${days.map(day => `
                <div class="forecast-hour">
                    <div class="forecast-time">
                        ${new Date(day.date).toLocaleString('en-US', { weekday: 'short' })}
                    </div>
                    <div class="weather-icon">
                        ${getLocalIcon(day.day.condition.code, data.current.is_day)}
                    </div>
                    <div class="forecast-temp">${day.day.maxtemp_c}°C</div>
                    <div class="forecast-rain">${day.day.daily_chance_of_rain}% rain</div>
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

    // Create a Set of all entity IDs from HA to check for missing entities
    const haEntityIds = new Set(states.map(state => state.entity_id));

    // Check for entities that exist in our tracking but not in HA
    const missingEntities = Object.keys(trackedEntities).filter(entityId => !haEntityIds.has(entityId));

    // If we found missing entities, send them to backend for removal
    if (missingEntities.length > 0) {
        console.log('Found missing entities:', missingEntities);
        fetch('/api/entities/remove', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ entities: missingEntities })
        })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                // Remove missing entities from our local tracking
                missingEntities.forEach(entityId => {
                    delete trackedEntities[entityId];
                });
                // Reload the current room to reflect changes
                const activeRoom = document.querySelector('.room-tab.active');
                if (activeRoom) {
                    displayRoomDevices(activeRoom.dataset.roomId);
                }
            }
        })
        .catch(error => console.error('Error removing missing entities:', error));
    }

    // Update states for existing entities
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
    if (!data || !data.entity_id || !data.new_state) {
        console.error('Invalid state change data:', data);
        return;
    }

    const { entity_id, new_state, old_state } = data;
    
    // Update our local state
    entityStates[entity_id] = new_state;
    
    // Find and update the device card
    const deviceCard = document.querySelector(`[data-device-id="${entity_id}"]`);
    if (deviceCard) {
        if (entity_id.startsWith('light.')) {
            updateLightCard(entity_id, new_state);
        } else if (entity_id.startsWith('climate.')) {
            updateClimateDisplay(entity_id, new_state);
        } else if (entity_id.startsWith('sensor.')) {
            updateSensorCard(entity_id, new_state);
        } else if (entity_id.startsWith('switch.')) {
            updateSwitchCard(entity_id, new_state);
        } else if (entity_id.startsWith('script.')) {
            updateScriptPill(entity_id, new_state);
        } else if (entity_id.startsWith('media_player.')) {
            updateMediaPlayerCard(entity_id, new_state);
        } else if (entity_id.startsWith('cover.')) {
            updateCoverCard(entity_id, new_state);
        }
    }
    
    // Always update control bar if this is the selected media player, regardless of card visibility
    if (entity_id === selectedMediaPlayer) {
        updateSpotifyControlBar(new_state);
    }
    
    // Only show notification if this entity was being updated AND it's not a script
    if (pendingUpdates.has(entity_id) && !entity_id.startsWith('script.')) {
        // Generate appropriate notification message
        let message = '';
        if (entity_id.startsWith('light.')) {
            const friendlyName = new_state.attributes?.friendly_name || 'Light';
            if (new_state.state === 'on' && old_state?.state === 'off') {
                message = `${friendlyName} turned on`;
            } else if (new_state.state === 'off' && old_state?.state === 'on') {
                message = `${friendlyName} turned off`;
            } else if (new_state.state === 'on' && new_state.attributes?.brightness) {
                const brightnessPercent = Math.round((new_state.attributes.brightness / 255) * 100);
                message = `${friendlyName} set to ${brightnessPercent}%`;
            }
        } else if (entity_id.startsWith('climate.')) {
            const friendlyName = new_state.attributes?.friendly_name || 'Climate';
            if (new_state.attributes?.temperature !== old_state?.attributes?.temperature) {
                message = `${friendlyName} set to ${new_state.attributes.temperature}°C`;
            } else if (new_state.state !== old_state?.state) {
                const mode = new_state.state.charAt(0).toUpperCase() + new_state.state.slice(1);
                message = `${friendlyName} mode changed to ${mode}`;
            }
        } else if (entity_id.startsWith('switch.')) {
            const friendlyName = new_state.attributes?.friendly_name || 'Switch';
            if (new_state.state === 'on' && old_state?.state === 'off') {
                message = `${friendlyName} turned on`;
            } else if (new_state.state === 'off' && old_state?.state === 'on') {
                message = `${friendlyName} turned off`;
            }
        }

        // Show notification if we have a message
        if (message) {
            showToast(message);
        }
        
        // Remove entity from pending updates
        pendingUpdates.delete(entity_id);
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
    const loader = card.querySelector('.card-loader');
    if (loader) {
        loader.remove();
    }
    
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

        // Check Spotify status
        const isSpotifyConnected = await checkSpotifyStatus();
        
        // Generate room tabs HTML including Spotify if connected
        const roomsHTML = rooms.map(room => `
            <div class="room-tab ${room.id === rooms[0].id ? 'active' : ''}" 
                 data-room-id="${room.id}">
                ${room.name}
            </div>
        `).join('') + (isSpotifyConnected ? `
            <div class="room-tab" data-room-id="spotify">
            <i class="fab fa-spotify spotify-icon" aria-hidden="true"></i>
                Spotify
            </div>
        ` : '');

        document.getElementById('roomsContainer').innerHTML = roomsHTML;

        document.querySelectorAll('.room-tab').forEach(tab => {
            tab.addEventListener('click', async () => {
                document.querySelectorAll('.room-tab').forEach(t => 
                    t.classList.remove('active'));
                tab.classList.add('active');
                
                if (tab.dataset.roomId === 'spotify') {
                    // Fetch media players before displaying Spotify room
                    try {
                        const response = await fetch('/api/media_players');
                        const players = await response.json();
                        
                        // If no player is selected, try to find a playing one
                        if (!selectedMediaPlayer) {
                            // Find first playing player
                            const playingPlayer = players.find(player => 
                                entityStates[player.entity_id]?.state === 'playing'
                            );
                            
                            // If no playing player found, find first available player
                            const availablePlayer = players.find(player => 
                                entityStates[player.entity_id]?.state !== 'unavailable'
                            );
                            
                            // Select the playing player, or the first available one
                            if (playingPlayer) {
                                selectMediaPlayer(playingPlayer.entity_id);
                            } else if (availablePlayer) {
                                selectMediaPlayer(availablePlayer.entity_id);
                            }
                        }
                    } catch (error) {
                        console.error('Error fetching media players:', error);
                    }
                    displaySpotifyRoom();
                } else {
                    displayRoomDevices(tab.dataset.roomId);
                }
            });
        });

        if (rooms.length > 0) {
            displayRoomDevices(rooms[0].id);
        }

        // Hide loader after everything is loaded
        hideLoader();

    } catch (error) {
        console.error('Error loading rooms:', error);
        document.getElementById('roomsContainer').innerHTML = `
            <div class="error">Unable to load rooms</div>
        `;
        // Hide loader even if there's an error
        hideLoader();
    }
}

function displayRoom(roomId) {
    if (roomId === 'spotify') {
        // If no player is selected, try to find a playing one
        if (!selectedMediaPlayer) {
            fetch('/api/media_players')
                .then(response => response.json())
                .then(players => {
                    // Find first playing player
                    const playingPlayer = players.find(player => 
                        entityStates[player.entity_id]?.state === 'playing'
                    );
                    
                    // If no playing player found, find first available player
                    const availablePlayer = players.find(player => 
                        entityStates[player.entity_id]?.state !== 'unavailable'
                    );
                    
                    // Select the playing player, or the first available one
                    if (playingPlayer) {
                        selectMediaPlayer(playingPlayer.entity_id);
                    } else if (availablePlayer) {
                        selectMediaPlayer(availablePlayer.entity_id);
                    }
                })
                .catch(error => console.error('Error fetching media players:', error));
        }
        
        displaySpotifyRoom();
        // Show control bar with current playback state if we have a selected player
        if (selectedMediaPlayer && entityStates[selectedMediaPlayer]) {
            const controlBar = document.querySelector('.spotify-control-bar');
            if (controlBar) {
                controlBar.classList.add('show');
                updateSpotifyControlBar(entityStates[selectedMediaPlayer]);
            }
        }
    } else {
        // Hide control bar for non-Spotify rooms
        const controlBar = document.querySelector('.spotify-control-bar');
        if (controlBar) {
            controlBar.classList.remove('show');
        }
    }
    
    // Update active room
    document.querySelectorAll('.room-tab').forEach(tab => {
        tab.classList.remove('active');
        if (tab.dataset.roomId === roomId) {
            tab.classList.add('active');
        }
    });

    // Display devices for the selected room
    displayRoomDevices(roomId);
}

function handleSpotifySearch(e) {
    clearTimeout(window.searchTimeout);
    const query = e.target.value.trim();
    const roomContent = document.getElementById('roomContent');
    
    // Clear search results if query is empty
    if (!query) {
        loadSpotifyLibrary();
        return;
    }

    // Add loading class
    roomContent.querySelector('.spotify-content')?.classList.add('loading');

    // Debounce search requests
    window.searchTimeout = setTimeout(() => {
        fetch(`/api/spotify/search?q=${encodeURIComponent(query)}`)
            .then(response => {
                if (!response.ok) throw new Error('Search failed');
                return response.json();
            })
            .then(data => {
                const spotifyContent = roomContent.querySelector('.spotify-content');
                if (!spotifyContent) return;

                spotifyContent.innerHTML = `
                    ${data.tracks.length > 0 ? generateSpotifySection('Tracks', data.tracks, item => ({
                        image: (item.album?.images && item.album.images.length > 0) ? item.album.images[0].url : '/static/images/default-spotify.jpg',
                        title: item.name,
                        subtitle: item.artists?.[0]?.name || 'Unknown Artist',
                        uri: item.uri,
                        type: 'track'
                    })) : ''}

                    ${data.artists.length > 0 ? generateSpotifySection('Artists', data.artists, item => ({
                        image: (item.images && item.images.length > 0) ? item.images[0].url : '/static/images/default-spotify.jpg',
                        title: item.name,
                        subtitle: `${formatFollowers(item.followers?.total || 0)} followers`,
                        uri: item.uri,
                        type: 'artist'
                    })) : ''}

                    ${data.playlists.length > 0 ? generateSpotifySection('Playlists', data.playlists, item => ({
                        image: (item.images && item.images.length > 0) ? item.images[0].url : '/static/images/default-spotify.jpg',
                        title: item.name,
                        subtitle: `${item.tracks?.total || 0} tracks`,
                        uri: item.uri,
                        type: 'playlist'
                    })) : ''}
                `;

                spotifyContent.classList.remove('loading');
                setupSpotifyGridItemListeners();
            })
            .catch(error => {
                console.error('Search error:', error);
                showToast('Search failed. Please try again.', 3000);
                roomContent.querySelector('.spotify-content')?.classList.remove('loading');
            });
    }, 500); // Wait 500ms after last keystroke before searching
}

// Update displaySpotifyRoom to use the new function
function displaySpotifyRoom() {
    const roomContent = document.getElementById('roomContent');
    
    // Show loading state
    roomContent.innerHTML = `
        <div class="spotify-room">
            <div class="spotify-search">
                <div class="search-container">
                    <input type="text" 
                           id="spotifySearch" 
                           placeholder="Search tracks, artists, or playlists..."
                           class="spotify-search-input">
                    <i class="fas fa-search search-icon"></i>
                </div>
            </div>
            <div class="spotify-loader">
                <div class="loader-spinner"></div>
            </div>
        </div>
    `;

    // Add search functionality
    const searchInput = document.getElementById('spotifySearch');
    searchInput.addEventListener('input', handleSpotifySearch);

    // Load initial library
    loadSpotifyLibrary();
}

function loadSpotifyLibrary() {
    fetch('/api/spotify/library')
        .then(response => {
            if (!response.ok) throw new Error('Failed to load Spotify library');
            return response.json();
        })
        .then(data => {
            const roomContent = document.getElementById('roomContent');
            roomContent.innerHTML = `
                <div class="spotify-room">
                    <div class="spotify-search">
                        <div class="search-container">
                            <input type="text" 
                                   id="spotifySearch" 
                                   placeholder="Search tracks, artists, or playlists..."
                                   class="spotify-search-input">
                            <i class="fas fa-search search-icon"></i>
                        </div>
                    </div>
                    <div class="spotify-content">
                        ${generateSpotifySection('Your Playlists', data.playlists, item => ({
                            image: (item.images && item.images.length > 0) ? item.images[0].url : '/static/images/default-spotify.jpg',
                            title: item.name,
                            subtitle: `${item.tracks?.total || 0} tracks`,
                            uri: item.uri,
                            type: 'playlist'
                        }))}

                        ${generateSpotifySection('Top Artists', data.top_artists, item => ({
                            image: (item.images && item.images.length > 0) ? item.images[0].url : '/static/images/default-spotify.jpg',
                            title: item.name,
                            subtitle: `${formatFollowers(item.followers?.total || 0)} followers`,
                            uri: item.uri,
                            type: 'artist'
                        }))}

                        ${generateSpotifySection('Top Tracks', data.top_tracks, item => ({
                            image: (item.album?.images && item.album.images.length > 0) ? item.album.images[0].url : '/static/images/default-spotify.jpg',
                            title: item.name,
                            subtitle: item.artists?.[0]?.name || 'Unknown Artist',
                            uri: item.uri,
                            type: 'track'
                        }))}
                    </div>
                    
                    <div class="spotify-control-bar ${selectedMediaPlayer ? 'show' : ''}">
                        <div class="spotify-track-info">
                            <div class="spotify-track-image">
                                <img src="/static/images/default-spotify.jpg" alt="Track Cover">
                            </div>
                            <div class="spotify-track-details">
                                <span class="spotify-track-name">${selectedMediaPlayer ? (entityStates[selectedMediaPlayer]?.attributes?.media_title || 'Nothing Playing') : 'Select a player to begin'}</span>
                                <span class="spotify-track-artist">${selectedMediaPlayer ? (entityStates[selectedMediaPlayer]?.attributes?.media_artist || '') : ''}</span>
                            </div>
                        </div>
                        <div class="spotify-controls">
                            <button class="spotify-control-button previous" ${!selectedMediaPlayer ? 'disabled' : ''}>
                                <i class="fas fa-backward"></i>
                            </button>
                            <button class="spotify-control-button play-pause" ${!selectedMediaPlayer ? 'disabled' : ''}>
                                <i class="fas fa-play"></i>
                            </button>
                            <button class="spotify-control-button next" ${!selectedMediaPlayer ? 'disabled' : ''}>
                                <i class="fas fa-forward"></i>
                            </button>
                        </div>
                        <div class="media-player-control">
                            <button class="volume-control-button" ${!selectedMediaPlayer ? 'disabled' : ''}>
                                <i class="fas fa-volume-high"></i>
                            </button>
                            <div class="volume-popover">
                                <div class="volume-slider-container">
                                    <input type="range" 
                                           class="horizontal-volume-slider" 
                                           min="0" 
                                           max="100" 
                                           value="${selectedMediaPlayer ? Math.round((entityStates[selectedMediaPlayer]?.attributes?.volume_level || 0) * 100) : 0}"
                                           ${!selectedMediaPlayer ? 'disabled' : ''}>
                                </div>
                            </div>
                            <span class="selected-player-name">${selectedMediaPlayer ? (entityStates[selectedMediaPlayer]?.attributes?.friendly_name || 'Media Player') : 'Select Player'}</span>
                            <button class="media-player-selector">
                                <i class="fas fa-chevron-down"></i>
                            </button>
                            <div class="media-player-popover">
                                <div class="media-player-list">
                                    <!-- Players will be populated here -->
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            `;

            // Reattach search listener
            const searchInput = document.getElementById('spotifySearch');
            searchInput.addEventListener('input', handleSpotifySearch);

            // Setup other listeners
            setupSpotifyControlBar();
            setupSpotifyGridItemListeners();

            if (selectedMediaPlayer && entityStates[selectedMediaPlayer]) {
                updateSpotifyControlBar(entityStates[selectedMediaPlayer]);
            }
        })
        .catch(error => {
            console.error('Error loading Spotify library:', error);
            const roomContent = document.getElementById('roomContent');
            roomContent.innerHTML = `
                <div class="spotify-room">
                    <div class="spotify-error">
                        Failed to load Spotify library. Please try again later.
                    </div>
                </div>
            `;
        });
}

function generateSpotifySection(title, items, itemMapper) {
    if (!items || items.length === 0) return '';
    
    return `
        <div class="spotify-section">
            <h2>${title}</h2>
            <div class="spotify-grid">
                ${items.map(item => {
                    const { image, title, subtitle, uri, type } = itemMapper(item);
                    return `
                        <div class="spotify-grid-item" 
                             data-uri="${uri}"
                             data-type="${type}">
                            <div class="grid-item-image">
                                <img src="${image}" alt="${title}">
                            </div>
                            <div class="grid-item-info">
                                <div class="grid-item-title">${title}</div>
                                <div class="grid-item-subtitle">${subtitle}</div>
                            </div>
                        </div>
                    `;
                }).join('')}
            </div>
        </div>
    `;
}

function setupSpotifyGridItemListeners() {
    document.querySelectorAll('.spotify-grid-item').forEach(item => {
        item.addEventListener('click', async () => {
            const uri = item.dataset.uri;
            const type = item.dataset.type;
            
            console.log('Clicked item:', { uri, type, selectedMediaPlayer });
            
            if (!uri || !selectedMediaPlayer) {
                showToast('Please select a media player first', 3000);
                return;
            }

            try {
                const msgId = getNextMessageId();
                console.log('Sending play command:', {
                    msgId,
                    entityId: selectedMediaPlayer,
                    uri,
                    type
                });
                
                pendingUpdates.add(selectedMediaPlayer);
                
                // Show loading state on the control bar
                const controlBar = document.querySelector('.spotify-control-bar');
                if (controlBar) controlBar.classList.add('loading');
                
                const message = {
                    id: msgId,
                    type: 'call_service',
                    domain: 'media_player',
                    service: 'play_media',
                    target: {
                        entity_id: selectedMediaPlayer
                    },
                    service_data: {
                        media_content_id: uri,
                        media_content_type: 'music',
                        enqueue: type === 'track' ? 'play' : 'replace'
                    }
                };
                
                console.log('WebSocket message:', message);
                haSocket.send(JSON.stringify(message));

                const response = await handleCommandResponse(msgId, selectedMediaPlayer);
                console.log('Command response:', response);
                
                showToast(`Playing ${type}...`);
            } catch (error) {
                console.error('Error playing media:', error);
                showToast(`Failed to play ${type}: ${error.message}`, 5000);
                pendingUpdates.delete(selectedMediaPlayer);
                
                // Remove loading state on error
                const controlBar = document.querySelector('.spotify-control-bar');
                if (controlBar) controlBar.classList.remove('loading');
            }
        });
    });
}

// Helper function to format follower counts
function formatFollowers(count) {
    if (count >= 1000000) {
        return `${(count / 1000000).toFixed(1)}M`;
    }
    if (count >= 1000) {
        return `${(count / 1000).toFixed(1)}K`;
    }
    return count.toString();
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
        scripts: devices.filter(d => d.type === 'script').sort((a, b) => a.order - b.order),
        sensors: devices.filter(d => d.type === 'sensor').sort((a, b) => a.order - b.order),
        lights: devices.filter(d => d.type === 'light').sort((a, b) => a.order - b.order),
        switches: devices.filter(d => d.type === 'switch').sort((a, b) => a.order - b.order),
        climate: devices.filter(d => d.type === 'climate').sort((a, b) => a.order - b.order),
        media_players: devices.filter(d => d.type === 'media_player').sort((a, b) => a.order - b.order),
        other: devices.filter(d => !['light', 'climate', 'sensor', 'switch', 'script', 'media_player'].includes(d.type))
            .sort((a, b) => a.order - b.order),
    };
    // Add scripts section if there are scripts
    const scriptsHTML = categories.scripts.length > 0 ? `
        <div class="scripts-section">
            <div class="scripts-container">
                ${categories.scripts.map(script => `
                    <button class="script-pill" 
                            data-device-id="${script.id}"
                            data-state="${entityStates[script.id]?.state || 'off'}">
                        ${script.name}
                        <div class="script-loader"></div>
                    </button>
                `).join('')}
            </div>
        </div>
    ` : '';

    // Check if there are any non-climate devices
    const hasNonClimateDevices = Object.entries(categories)
        .filter(([category]) => category !== 'climate')
        .some(([_, devices]) => devices.length > 0);

    // Define the order of categories
    const categoryOrder = ['sensors', 'lights', 'switches', 'media_players', 'other'];

    // Generate sections HTML only if there are non-climate devices
    const sectionsHTML = hasNonClimateDevices ? 
        categoryOrder
            .map(category => {
                const deviceList = categories[category];
                if (deviceList.length === 0) return '';

                return `
                    <div class="device-section">
                        <h2 class="section-title">${category.charAt(0).toUpperCase() + category.slice(1).replace('_', ' ')}</h2>
                        <div class="devices-grid">
                            ${deviceList.map(device => {
                                const currentState = entityStates[device.id] || {};
                                
                                if (device.type === 'media_player') {
                                    return getMediaPlayerCard(device, currentState);
                                }
                                
                                const isOn = currentState.state === 'on';
                                const brightness = currentState.attributes?.brightness || 0;
                                
                                return `
                                    <div class="device-card ${device.type === 'light' ? 'light-card' : ''} 
                                                    ${device.type === 'sensor' ? 'sensor-card' : ''}
                                                    ${device.type === 'switch' ? 'switch-card' : ''}
                                                    ${device.type === 'cover' ? 'cover-card' : ''} 
                                         data-device-id="${device.id}"
                                         data-state="${currentState.state || 'unknown'}"
                                         ${(device.type === 'switch') ? 'data-action="toggle"' : ''}>
                                        <div class="device-controls">
                                            ${device.type === 'light' ? getLightControls({
                                                ...device,
                                                state: currentState.state,
                                                attributes: currentState.attributes
                                            }) : device.type === 'switch' ? getSwitchControls({
                                                ...device,
                                                state: currentState.state,
                                                attributes: currentState.attributes
                                            }) : device.type === 'cover' ? getCoverControls({
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

    const roomContent = document.getElementById('roomContent');
    roomContent.innerHTML = scriptsHTML + sectionsHTML + climateHTML;
    
    // Add or remove has-climate class based on presence of climate devices
    roomContent.classList.toggle('has-climate', climateDevices.length > 0);

    // Only setup listeners if we have devices
    if (climateDevices.length > 0) {
        setupDeviceControlListeners();
        setupClimateControlListeners();
        setupTempControlListeners();
    } else if (hasNonClimateDevices) {
        setupDeviceControlListeners();
    }

    // Add script execution handler
    document.querySelectorAll('.script-pill').forEach(pill => {
        pill.addEventListener('click', async () => {
            const scriptId = pill.dataset.deviceId;
            await executeScript(scriptId, pill);
        });
    });

    // Add this line to set up media player listeners
    setupMediaPlayerListeners();
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

    // Remove existing unavailable overlay if it exists
    const existingOverlay = card.querySelector('.unavailable-overlay');
    if (existingOverlay) {
        existingOverlay.remove();
    }

    // Add unavailable overlay if state is unavailable
    if (state.state === 'unavailable') {
        const overlay = document.createElement('div');
        overlay.className = 'unavailable-overlay';
        overlay.innerHTML = '<span class="unavailable-message">Device Unavailable</span>';
        card.appendChild(overlay);
    }

    if (device.type === 'light') {
        controls.innerHTML = getLightControls(device);
    } else if (device.type === 'switch') {
        controls.innerHTML = getSwitchControls(device);
    } else if (device.type === 'cover') {
        controls.innerHTML = getCoverControls(device, state);
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
        case 'cover':
            return getCoverControls(device);
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
    const isUnavailable = device.state === 'unavailable';

    return `
        <div class="light-header">
            <span class="brightness-level">${isUnavailable ? 'Unavailable' : isOn ? `${brightnessPercent}%` : 'Off'}</span>
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

        // Cover controls
    document.querySelectorAll('.cover-open-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const card = btn.closest('.device-card');
            const entityId = card.dataset.deviceId;
            openCover(entityId);
        });
    });
    
    document.querySelectorAll('.cover-close-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const card = btn.closest('.device-card');
            const entityId = card.dataset.deviceId;
            closeCover(entityId);
        });
    });
    
    document.querySelectorAll('.cover-stop-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const card = btn.closest('.device-card');
            const entityId = card.dataset.deviceId;
            stopCover(entityId);
        });
    });
    
    // Add debounced listener for cover position sliders to avoid too many API calls
    document.querySelectorAll('.cover-position-slider').forEach(slider => {
        slider.addEventListener('change', () => {
            const card = slider.closest('.device-card');
            const entityId = card.dataset.deviceId;
            const position = slider.value;
            setCoverPosition(entityId, position);
        });
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

function handleCommandResponse(messageId, deviceId) {
    return new Promise((resolve, reject) => {
        // Clear any existing handler for this messageId
        if (messageHandlers.has(messageId)) {
            haSocket.removeEventListener('message', messageHandlers.get(messageId));
            messageHandlers.delete(messageId);
        }

        const timeout = setTimeout(() => {
            // Clean up handler on timeout
            if (messageHandlers.has(messageId)) {
                haSocket.removeEventListener('message', messageHandlers.get(messageId));
                messageHandlers.delete(messageId);
            }
            reject(new Error('Command timed out'));
        }, 10000);

        const messageHandler = (event) => {
            const message = JSON.parse(event.data);

            if (message.id === messageId) {
                clearTimeout(timeout);

                // Clean up handler after receiving matching message
                haSocket.removeEventListener('message', messageHandler);
                messageHandlers.delete(messageId);

                if (!message.success) {
                    const errorMessage = message.error?.message || 'Unknown error';
                    const cleanErrorMessage = errorMessage
                        .replace(/Request failed due connection error: \d+, message='/, '')
                        .replace(/', url='.*'$/, '')
                        .replace(/^Bad Request: /, '');
                    reject(new Error(cleanErrorMessage));
                } else {
                    resolve(message);
                }
            }
        };

        messageHandlers.set(messageId, messageHandler);
        haSocket.addEventListener('message', messageHandler);
    });
}

// Update the toggleDevice function to use error handling
async function toggleDevice(entityId) {
    if (!haSocket || haSocket.readyState !== WebSocket.OPEN) {
        showToast('Not connected to Home Assistant', 5000);
        return;
    }

    const card = document.querySelector(`[data-device-id="${entityId}"]`);
    if (!card) return;

    pendingUpdates.add(entityId);
    const domain = entityId.split('.')[0];
    const service = entityStates[entityId]?.state === 'on' ? 'turn_off' : 'turn_on';
    const msgId = getNextMessageId();

    try {
        haSocket.send(JSON.stringify({
            id: msgId,
            type: 'call_service',
            domain: domain,
            service: service,
            target: {
                entity_id: entityId
            }
        }));

        await handleCommandResponse(msgId, entityId);
    } catch (error) {
        console.error(`Error toggling device:`, error);
        showToast(`Failed to toggle device: ${error.message}`, 5000);

        // Remove loader and pending update
        const loader = card.querySelector('.card-loader');
        if (loader) loader.remove();
        pendingUpdates.delete(entityId);
    }
}

// Update updateBrightness function with error handling
async function updateBrightness(entityId, brightness_pct) {
    if (!haSocket || haSocket.readyState !== WebSocket.OPEN) {
        showToast('Not connected to Home Assistant', 5000);
        return;
    }

    const card = document.querySelector(`[data-device-id="${entityId}"]`);
    if (!card) return;

    pendingUpdates.add(entityId);
    const msgId = getNextMessageId();

    try {
        haSocket.send(JSON.stringify({
            id: msgId,
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

        await handleCommandResponse(msgId, entityId);
    } catch (error) {
        console.error('Error updating brightness:', error);
        showToast(`Failed to update brightness: ${error.message}`, 5000);

        // Remove loader and pending update
        const loader = card.querySelector('.card-loader');
        if (loader) loader.remove();
        pendingUpdates.delete(entityId);
    }
}

// Update updateClimateTemp function with error handling
async function updateClimateTemp(entityId, temperature) {
    if (!haSocket || haSocket.readyState !== WebSocket.OPEN) {
        showToast('Not connected to Home Assistant', 5000);
        return;
    }

    const currentState = entityStates[entityId];
    let hvac_mode = currentState.state;

    try {
        // If current mode is 'off', set to cool first
        if (hvac_mode === 'off') {
            hvac_mode = 'cool';
            const modeMsgId = getNextMessageId();

            haSocket.send(JSON.stringify({
                id: modeMsgId,
                type: 'call_service',
                domain: 'climate',
                service: 'set_hvac_mode',
                target: { entity_id: entityId },
                service_data: { hvac_mode }
            }));

            await handleCommandResponse(modeMsgId, entityId);
        }

        pendingUpdates.add(entityId);
        const tempMsgId = getNextMessageId();

        haSocket.send(JSON.stringify({
            id: tempMsgId,
            type: 'call_service',
            domain: 'climate',
            service: 'set_temperature',
            target: { entity_id: entityId },
            service_data: { temperature }
        }));

        await handleCommandResponse(tempMsgId, entityId);
    } catch (error) {
        console.error('Error updating temperature:', error);
        showToast(`Failed to update temperature: ${error.message}`, 5000);

        // Hide the temperature loader
        const tempLoader = document.querySelector('.temp-loader');
        if (tempLoader) tempLoader.classList.remove('show');

        pendingUpdates.delete(entityId);
    }
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
    setInterval(updateWeather, 900000);

    loadRooms();

    setupSpotifyControlBar();
});

// Add at the start of the file
function hideLoader() {
    const loader = document.getElementById('loaderModal');
    loader.classList.add('hide');
    // Remove the loader from DOM after animation
    setTimeout(() => {
        loader.style.display = 'none';
    }, 300);
}

// Add new function for switch controls
function getSwitchControls(device) {
    const isOn = device.state === 'on';
    const isUnavailable = device.state === 'unavailable';

    return `
        <div class="switch-header">
            <span class="switch-state">${isUnavailable ? 'Unavailable' : isOn ? 'On' : 'Off'}</span>
            <div class="toggle-circle" data-action="toggle">
                <i class="fa-solid fa-power-off"></i>
            </div>
        </div>
        <div class="device-name">${device.name}</div>
    `;
}

// Update click handler to handle switches
document.addEventListener('click', async (event) => {
    const deviceCard = event.target.closest('[data-action="toggle"]');
    if (!deviceCard) return;

    const deviceId = deviceCard.dataset.deviceId;
    const isLight = deviceCard.classList.contains('light-card');
    const isSwitch = deviceCard.classList.contains('switch-card');

    if (isLight || isSwitch) {
        // Show loader
        const loader = document.createElement('div');
        loader.className = 'card-loader';
        loader.innerHTML = '<div class="loader-spinner"></div>';
        deviceCard.appendChild(loader);

        // Add to pending updates
        pendingUpdates.add(deviceId);

        try {
            if (!haSocket || haSocket.readyState !== WebSocket.OPEN) {
                throw new Error('WebSocket not connected');
            }

            const domain = isLight ? 'light' : 'switch';
            const service = deviceCard.dataset.state === 'on' ? 'turn_off' : 'turn_on';

            haSocket.send(JSON.stringify({
                id: getNextMessageId(),
                type: 'call_service',
                domain: domain,
                service: service,
                target: {
                    entity_id: deviceId
                }
            }));
        } catch (error) {
            console.error(`Error toggling ${isLight ? 'light' : 'switch'}:`, error);
            // Remove loader on error
            loader.remove();
            pendingUpdates.delete(deviceId);
        }
    }
});

// Add new function to update switch cards
function updateSwitchCard(entityId, state) {
    const card = document.querySelector(`[data-device-id="${entityId}"]`);
    if (!card) return;

    // Update card state attribute
    card.setAttribute('data-state', state.state);

    // Update switch state text
    const stateText = card.querySelector('.switch-state');
    if (stateText) {
        stateText.textContent = state.state === 'on' ? 'On' : 'Off';
    }

    // Hide loader if it exists
    const loader = card.querySelector('.card-loader');
    if (loader) {
        loader.remove();
    }
}

async function executeScript(scriptId, pillElement) {
    if (!haSocket || haSocket.readyState !== WebSocket.OPEN) {
        showToast('Not connected to Home Assistant', 5000);
        return;
    }

    try {
        // Show loading state
        pillElement.classList.add('loading');
        pendingUpdates.add(scriptId);

        const msgId = getNextMessageId();
        haSocket.send(JSON.stringify({
            id: msgId,
            type: 'call_service',
            domain: 'script',
            service: 'turn_on',
            target: {
                entity_id: scriptId
            }
        }));

        await handleCommandResponse(msgId, scriptId);
        showToast(`Executed ${entityStates[scriptId]?.attributes?.friendly_name || 'Script'}`);
    } catch (error) {
        console.error('Error executing script:', error);
        showToast(`Failed to execute script: ${error.message}`, 5000);
    } finally {
        // Remove loading state
        pillElement.classList.remove('loading');
        pendingUpdates.delete(scriptId);
    }
}

function updateScriptPill(entityId, state) {
    const pill = document.querySelector(`[data-device-id="${entityId}"]`);
    if (pill) {
        pill.dataset.state = state.state;
    }
}

// Add new media player functions
function updateMediaPlayerCard(entityId, state) {
    const card = document.querySelector(`[data-device-id="${entityId}"]`);
    if (!card) return;

    // Remove loader if it exists
    const loader = card.querySelector('.card-loader');
    if (loader) {
        loader.style.display = 'none';
    }

    const mediaTitle = card.querySelector('.media-title');
    const mediaArtist = card.querySelector('.media-artist');
    const playPauseBtn = card.querySelector('.play-pause');
    const previousBtn = card.querySelector('.previous');
    const nextBtn = card.querySelector('.next');
    
    // Update title and artist
    if (mediaTitle) mediaTitle.textContent = state.attributes?.media_title || 'Nothing Playing';
    if (mediaArtist) mediaArtist.textContent = state.attributes?.media_artist || '';
    
    // Update background with media art if available
    if (state.attributes?.entity_picture) {
        const artworkUrl = `/api/media_proxy${state.attributes.entity_picture}`;
        card.style.backgroundImage = `linear-gradient(rgba(0, 0, 0, 0.5), rgba(0, 0, 0, 0.7)), url('${artworkUrl}')`;
        card.style.backgroundSize = 'cover';
        card.style.backgroundPosition = 'center';
        card.classList.add('has-media');
    } else {
        card.style.backgroundImage = 'none';
        card.style.backgroundColor = '#f7f7f7';
        card.classList.remove('has-media');
    }
    
    // Update play/pause button icon
    if (playPauseBtn) {
        playPauseBtn.innerHTML = state.state === 'playing' ? 
            '<i class="fa-solid fa-pause"></i>' : 
            '<i class="fa-solid fa-play"></i>';
    }
    
    // Enable/disable buttons based on playback state
    const hasMedia = !!state.attributes?.media_title;
    if (playPauseBtn) playPauseBtn.disabled = !hasMedia;
    if (previousBtn) previousBtn.disabled = !hasMedia;
    if (nextBtn) nextBtn.disabled = !hasMedia;
    
    // Update volume slider if it exists
    const volumeSlider = card.querySelector('.volume-slider');
    if (volumeSlider && state.attributes?.volume_level !== undefined) {
        volumeSlider.value = Math.round(state.attributes.volume_level * 100);
    }
}

function setupMediaPlayerListeners() {
    document.querySelectorAll('.media-player-card').forEach(card => {
        const deviceId = card.dataset.deviceId;
        const playPauseBtn = card.querySelector('.media-btn.play-pause');
        const previousBtn = card.querySelector('.media-btn.previous');
        const nextBtn = card.querySelector('.media-btn.next');
        const volumeSlider = card.querySelector('.volume-slider');
        
        if (playPauseBtn) {
            playPauseBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const state = entityStates[deviceId];
                if (!state) return;
                const service = state.state === 'playing' ? 'media_pause' : 'media_play';
                sendMediaCommand(deviceId, service);
            });
        }
        
        if (previousBtn) {
            previousBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                sendMediaCommand(deviceId, 'media_previous_track');
            });
        }
        
        if (nextBtn) {
            nextBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                sendMediaCommand(deviceId, 'media_next_track');
            });
        }
        
        if (volumeSlider) {
            volumeSlider.addEventListener('change', (e) => {
                e.stopPropagation();
                const volume = parseInt(e.target.value) / 100;
                sendVolumeCommand(deviceId, volume);
            });
        }
    });
}

async function sendMediaCommand(entityId, service) {
    if (!haSocket || haSocket.readyState !== WebSocket.OPEN) {
        showToast('Not connected to Home Assistant', 5000);
        return;
    }

    const card = document.querySelector(`.media-player-card[data-device-id="${entityId}"]`);
    const controlBar = document.querySelector('.spotify-control-bar');
    const loader = card?.querySelector('.card-loader');

    // Show loading state
    if (loader) loader.style.display = 'flex';
    if (controlBar && entityId === selectedMediaPlayer) controlBar.classList.add('loading');

    pendingUpdates.add(entityId);
    const msgId = getNextMessageId();

    try {
        haSocket.send(JSON.stringify({
            id: msgId,
            type: 'call_service',
            domain: 'media_player',
            service: service,
            target: {
                entity_id: entityId
            }
        }));

        await handleCommandResponse(msgId, entityId);
        // Don't hide loader here - wait for state change
    } catch (error) {
        console.error('Error controlling media player:', error);
        showToast(`Failed to control media player: ${error.message}`, 5000);
        pendingUpdates.delete(entityId);
        // Hide loader on error
        if (loader) loader.style.display = 'none';
        if (controlBar && entityId === selectedMediaPlayer) controlBar.classList.remove('loading');
    }
}

async function sendVolumeCommand(entityId, volume) {
    if (!haSocket || haSocket.readyState !== WebSocket.OPEN) {
        showToast('Not connected to Home Assistant', 5000);
        return;
    }

    const msgId = getNextMessageId();
    pendingUpdates.add(entityId);

    try {
        haSocket.send(JSON.stringify({
            id: msgId,
            type: 'call_service',
            domain: 'media_player',
            service: 'volume_set',
            target: {
                entity_id: entityId
            },
            service_data: {
                volume_level: volume
            }
        }));

        await handleCommandResponse(msgId, entityId);
    } catch (error) {
        console.error('Error setting volume:', error);
        showToast(`Failed to set volume: ${error.message}`, 5000);
        pendingUpdates.delete(entityId);
    }
}

// Add media player styles
const mediaPlayerStyles = `
    // ... copy all styles from the original dashboard.js styles constant ...
`;

// Add the styles to the document
const styleSheet = document.createElement("style");
styleSheet.textContent = mediaPlayerStyles;
document.head.appendChild(styleSheet);

// Add this new function to generate media player card HTML
function getMediaPlayerCard(device, state) {
    const hasMedia = !!state.attributes?.media_title;
    const artworkUrl = state.attributes?.entity_picture ? 
        `/api/media_proxy${state.attributes.entity_picture}` : '';
    
    return `
        <div class="device-card media-player-card ${artworkUrl ? 'has-media' : ''}" 
             data-device-id="${device.id}"
             data-state="${state.state || 'off'}"
             style="${artworkUrl ? `background-image: linear-gradient(rgba(0, 0, 0, 0.5), rgba(0, 0, 0, 0.7)), url('${artworkUrl}')` : ''}">
            <div class="media-content">
                <div class="media-info">
                    <div class="device-name">${device.name}</div>
                    <div class="media-title">${state.attributes?.media_title || 'Nothing Playing'}</div>
                    <div class="media-artist">${state.attributes?.media_artist || ''}</div>
                </div>
                <div class="bottom-media-controls">
                    <div class="media-controls">
                        <button class="media-btn previous" data-device-id="${device.id}" ${!hasMedia ? 'disabled' : ''}>
                            <i class="fa-solid fa-backward"></i>
                        </button>
                        <button class="media-btn play-pause" data-device-id="${device.id}" ${!hasMedia ? 'disabled' : ''}>
                            <i class="fa-solid ${state.state === 'playing' ? 'fa-pause' : 'fa-play'}"></i>
                        </button>
                        <button class="media-btn next" data-device-id="${device.id}" ${!hasMedia ? 'disabled' : ''}>
                            <i class="fa-solid fa-forward"></i>
                        </button>
                    </div>
                    <div class="volume-control">
                        <i class="fa-solid fa-volume-high"></i>
                        <input type="range" class="volume-slider" 
                               data-device-id="${device.id}"
                               value="${Math.round((state.attributes?.volume_level || 0) * 100)}" 
                               min="0" max="100">
                    </div>
                </div>
            </div>
            <div class="card-loader" style="display: none;">
                <div class="loader-spinner"></div>
            </div>
        </div>
    `;
}

// Add this to your existing event listeners setup
document.addEventListener('DOMContentLoaded', () => {
    // ... existing initialization code ...
    
    // Add media player listeners when room content is updated
    const observer = new MutationObserver(() => {
        setupMediaPlayerListeners();
    });
    
    observer.observe(document.getElementById('roomContent'), {
        childList: true,
        subtree: true
    });
});

// Add these new functions for Spotify functionality
async function checkSpotifyStatus() {
    try {
        const response = await fetch('/api/spotify/status');
        const data = await response.json();
        return data.connected;
    } catch (error) {
        console.error('Error checking Spotify status:', error);
        return false;
    }
}

// Remove the duplicate setupSpotifyControlBar function and keep this version
function setupSpotifyControlBar() {
    const controlBar = document.querySelector('.spotify-control-bar');
    if (!controlBar) return;

    // Add media player selector button listener
    const playerSelector = controlBar.querySelector('.media-player-selector');
    if (playerSelector) {
        playerSelector.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            showMediaPlayerPopover();
        });
    }

    // Close popover when clicking outside
    document.addEventListener('click', (e) => {
        const popover = document.querySelector('.media-player-popover');
        const selector = document.querySelector('.media-player-selector');
        
        if (popover && selector && 
            !popover.contains(e.target) && 
            !selector.contains(e.target)) {
            hideMediaPlayerPopover();
        }
    });

    // Control button listeners
    const playPauseBtn = controlBar.querySelector('.play-pause');
    const previousBtn = controlBar.querySelector('.previous');
    const nextBtn = controlBar.querySelector('.next');

    if (playPauseBtn) playPauseBtn.addEventListener('click', togglePlayback);
    if (previousBtn) previousBtn.addEventListener('click', previousTrack);
    if (nextBtn) nextBtn.addEventListener('click', nextTrack);

    // Add volume control button listener
    const volumeButton = controlBar.querySelector('.volume-control-button');
    const volumePopover = controlBar.querySelector('.volume-popover');
    const volumeSlider = controlBar.querySelector('.horizontal-volume-slider');

    if (volumeButton) {
        volumeButton.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            volumePopover.classList.toggle('show');
        });
    }

    if (volumeSlider) {
        // Update volume while sliding
        volumeSlider.addEventListener('input', (e) => {
            const volume = parseInt(e.target.value) / 100;
            // Update volume icon based on level
            updateVolumeIcon(volume);
        });

        // Send update when sliding ends
        volumeSlider.addEventListener('change', (e) => {
            const volume = parseInt(e.target.value) / 100;
            if (selectedMediaPlayer) {
                sendVolumeCommand(selectedMediaPlayer, volume);
            }
        });
    }

    // Close volume popover when clicking outside
    document.addEventListener('click', (e) => {
        if (volumePopover && 
            !volumePopover.contains(e.target) && 
            !volumeButton.contains(e.target)) {
            volumePopover.classList.remove('show');
        }
    });
}

function showMediaPlayerPopover() {
    const popover = document.querySelector('.media-player-popover');
    if (!popover) return;

    // Show the popover
    popover.classList.add('show');

    // Show loading state first
    popover.querySelector('.media-player-list').innerHTML = `
        <div class="loading-players">
            <div class="loader-spinner"></div>
        </div>
    `;

    // Fetch available media players from the endpoint
    fetch('/api/media_players')
        .then(response => response.json())
        .then(players => {
            // Filter out unavailable players
            const availablePlayers = players.filter(player => {
                const state = entityStates[player.entity_id];
                return state && state.state !== 'unavailable';
            });

            // Generate the media player list HTML
            const mediaPlayerListHTML = availablePlayers.length > 0 ? 
                availablePlayers.map(player => {
                    const state = entityStates[player.entity_id];
                    const isSelected = player.entity_id === selectedMediaPlayer;
                    return `
                        <div class="media-player-item ${isSelected ? 'selected' : ''}" 
                             data-entity-id="${player.entity_id}">
                            <div class="media-player-icon">
                                <i class="fas fa-${player.entity_id.includes('spotify') ? 'spotify' : 'music'}"></i>
                            </div>
                            <div class="media-player-info">
                                <div class="media-player-name">${player.name}</div>
                                <div class="media-player-state">${state ? state.state : 'unknown'}</div>
                            </div>
                            ${isSelected ? '<div class="selected-check"><i class="fas fa-check"></i></div>' : ''}
                        </div>
                    `;
                }).join('') : 
                '<div class="no-players">No media players available</div>';

            // Update the popover content
            popover.querySelector('.media-player-list').innerHTML = mediaPlayerListHTML;

            // Add click handlers for player selection
            popover.querySelectorAll('.media-player-item').forEach(item => {
                item.addEventListener('click', (e) => {
                    e.stopPropagation();
                    selectMediaPlayer(item.dataset.entityId);
                    hideMediaPlayerPopover();
                });
            });
        })
        .catch(error => {
            console.error('Error loading media players:', error);
            popover.querySelector('.media-player-list').innerHTML = `
                <div class="error-message">Failed to load media players</div>
            `;
        });
}

function hideMediaPlayerPopover() {
    const popover = document.querySelector('.media-player-popover');
    if (popover) {
        popover.classList.remove('show');
    }
}

function selectMediaPlayer(entityId) {
    selectedMediaPlayer = entityId;
    const state = entityStates[entityId];
    
    // Update the selected player name in the control bar
    const controlBar = document.querySelector('.spotify-control-bar');
    if (!controlBar) return;
    
    const playerName = controlBar.querySelector('.selected-player-name');
    if (playerName) {
        playerName.textContent = state?.attributes?.friendly_name || 'Media Player';
    }
    
    // Enable all control buttons when a player is selected
    const controls = controlBar.querySelectorAll('.spotify-control-button');
    controls.forEach(control => {
        control.disabled = false;
    });
    
    // Show the control bar
    controlBar.classList.add('show');
    
    // Update the control bar with the current state
    if (state) {
        updateSpotifyControlBar(state);
    }
}

// Update the updateSpotifyControlBar function to handle HA media player states
function updateSpotifyControlBar(state) {
    const controlBar = document.querySelector('.spotify-control-bar');
    if (!controlBar) return;

    // Remove loading state if present
    controlBar.classList.remove('loading');

    // Update track info
    const trackImage = controlBar.querySelector('.spotify-track-image img');
    const trackName = controlBar.querySelector('.spotify-track-name');
    const trackArtist = controlBar.querySelector('.spotify-track-artist');
    const playPauseButton = controlBar.querySelector('.play-pause i');
    const controls = controlBar.querySelectorAll('.spotify-control-button');

    if (state && state.attributes) {
        // Update track image
        if (state.attributes.entity_picture) {
            trackImage.src = `/api/media_proxy${state.attributes.entity_picture}`;
        } else {
            trackImage.src = '/static/images/default-spotify.jpg';
        }

        // Update track info
        trackName.textContent = state.attributes.media_title || 'Nothing Playing';
        trackArtist.textContent = state.attributes.media_artist || '';

        // Update play/pause button
        if (state.state === 'playing') {
            playPauseButton.className = 'fas fa-pause';
        } else if (state.state === 'paused') {
            playPauseButton.className = 'fas fa-play';
        } else {
            playPauseButton.className = 'fas fa-play';
        }

        // Enable/disable controls based on player state
        const hasMedia = !!state.attributes.media_title;
        const isAvailable = state.state !== 'unavailable';
        controls.forEach(control => {
            control.disabled = !hasMedia || !isAvailable;
        });

        // Show the control bar if we have a selected player
        if (selectedMediaPlayer) {
            controlBar.classList.add('show');
        }
    } else {
        // Reset to default state if no state or attributes
        trackImage.src = '/static/images/default-spotify.jpg';
        trackName.textContent = 'Nothing Playing';
        trackArtist.textContent = '';
        playPauseButton.className = 'fas fa-play';
        
        // Disable all controls
        controls.forEach(button => {
            button.disabled = true;
        });
    }

    // Update selected player name if it exists
    const playerName = controlBar.querySelector('.selected-player-name');
    if (playerName && selectedMediaPlayer) {
        playerName.textContent = state?.attributes?.friendly_name || 'Media Player';
    }

    // Update volume slider and icon if they exist
    const volumeSlider = controlBar.querySelector('.horizontal-volume-slider');
    if (volumeSlider && state.attributes?.volume_level !== undefined) {
        const volume = Math.round(state.attributes.volume_level * 100);
        volumeSlider.value = volume;
        updateVolumeIcon(state.attributes.volume_level);
    }
}

// Update the togglePlayback function to use the sendMediaCommand
function togglePlayback() {
    if (!selectedMediaPlayer) return;
    const state = entityStates[selectedMediaPlayer];
    if (!state) return;
    
    const service = state.state === 'playing' ? 'media_pause' : 'media_play';
    sendMediaCommand(selectedMediaPlayer, service);
}

function previousTrack() {
    if (!selectedMediaPlayer) return;
    sendMediaCommand(selectedMediaPlayer, 'media_previous_track');
}

function nextTrack() {
    if (!selectedMediaPlayer) return;
    sendMediaCommand(selectedMediaPlayer, 'media_next_track');
}

// Add after updateWeather() function
async function updateSpotifyStatus() {
    try {
        const response = await fetch('/api/spotify/status');
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json();
        
        const spotifySection = document.querySelector('.spotify-section');
        if (!spotifySection) return;
        
        if (!data.connected) {
            spotifySection.innerHTML = `
                <div class="section-title">
                    <i class="fab fa-spotify spotify-icon"></i>
                    <span>Spotify</span>
                </div>
                <div class="spotify-error">
                    Spotify not configured. Visit settings to set it up.
                </div>
            `;
            return;
        }
        
        // If connected, update playback state and load library
        updatePlaybackState();
        loadSpotifyLibrary();  // Add this line to load the library
    } catch (error) {
        console.error('Error checking Spotify status:', error);
        const spotifySection = document.querySelector('.spotify-section');
        if (spotifySection) {
            spotifySection.innerHTML = `
                <div class="section-title">
                    <i class="fab fa-spotify spotify-icon"></i>
                    <span>Spotify</span>
                </div>
                <div class="spotify-error">
                    Unable to connect to Spotify. Please try again later.
                </div>
            `;
        }
    }
}

// Helper function to generate grid sections
function generateGridSection(title, items, itemMapper) {
    if (!items || items.length === 0) return '';
    
    return `
        <div class="spotify-grid-section">
            <h3>${title}</h3>
            <div class="spotify-grid">
                ${items.map(item => {
                    const { image, title, subtitle, uri } = itemMapper(item);
                    return `
                        <div class="spotify-grid-item" data-uri="${uri}">
                            <div class="grid-item-image">
                                <img src="${image}" alt="${title}" onerror="this.src='/static/images/default-spotify.jpg'">
                            </div>
                            <div class="grid-item-info">
                                <div class="grid-item-title">${title}</div>
                                <div class="grid-item-subtitle">${subtitle}</div>
                            </div>
                        </div>
                    `;
                }).join('')}
            </div>
        </div>
    `;
}

// Add function to update volume icon
function updateVolumeIcon(volume) {
    const volumeButton = document.querySelector('.volume-control-button i');
    if (!volumeButton) return;

    if (volume === 0) {
        volumeButton.className = 'fas fa-volume-mute';
    } else if (volume < 0.5) {
        volumeButton.className = 'fas fa-volume-low';
    } else {
        volumeButton.className = 'fas fa-volume-high';
    }
}

// Add function for Cover Entities

function updateCoverCard(entityId, state) {
    const card = document.querySelector(`[data-device-id="${entityId}"]`);
    if (!card) return;
    
    // Update card state
    card.setAttribute('data-state', state.state);

    // Update position display if available
    const positionDisplay = card.querySelector('.cover-position');
    if (positionDisplay) {
        const position = state.attributes?.current_position;
        if (position !== undefined) {
            positionDisplay.textContent = `${Math.round(position)}%`;
        } else {
            // If position is not available, show the state
            positionDisplay.textContent = state.state.charAt(0).toUpperCase() + state.state.slice(1);
        }
    }

    // Update slider if available
    const positionSlider = card.querySelector('.cover-position-slider');
    if (positionSlider && state.attributes?.current_position !== undefined) {
        positionSlider.value = state.attributes.current_position;
        positionSlider.disabled = state.state === 'unavailable';
    }

    // Update button states
    const openBtn = card.querySelector('.cover-open-btn');
    const closeBtn = card.querySelector('.cover-close-btn');
    const stopBtn = card.querySelector('.cover-stop-btn');

    if (openBtn && closeBtn && stopBtn) {
        openBtn.disabled = state.state === 'open' || state.state === 'opening' || state.state === 'unavailable';
        closeBtn.disabled = state.state === 'closed' || state.state === 'closing' || state.state === 'unavailable';
        stopBtn.disabled = (state.state !== 'opening' && state.state !== 'closing') || state.state === 'unavailable';
    }

    // Update icon based on state
    const stateIcon = card.querySelector('.device-state-icon');
    if (stateIcon) {
        let iconClass = 'fas fa-window-maximize';
        
        if (state.state === 'open') {
            iconClass = 'fas fa-window-maximize';
        } else if (state.state === 'closed') {
            iconClass = 'fas fa-window-minimize';
        } else if (state.state === 'opening') {
            iconClass = 'fas fa-arrow-up';
        } else if (state.state === 'closing') {
            iconClass = 'fas fa-arrow-down';
        }
        
        stateIcon.className = `device-state-icon ${iconClass}`;
    }
}

async function openCover(entityId) {
    const card = document.querySelector(`[data-device-id="${entityId}"]`);
    if (!card) return;
    
    showLoader(card);
    pendingUpdates.add(entityId);
    
    try {
        const response = await fetch('/api/services/cover/open_cover', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                entity_id: entityId
            })
        });
        
        if (!response.ok) {
            throw new Error(`Failed to open cover: ${response.statusText}`);
        }
    } catch (error) {
        console.error('Error opening cover:', error);
        showToast(`Error opening cover: ${error.message}`, 3000);
    } finally {
        hideLoader(card);
    }
}

async function closeCover(entityId) {
    const card = document.querySelector(`[data-device-id="${entityId}"]`);
    if (!card) return;
    
    showLoader(card);
    pendingUpdates.add(entityId);
    
    try {
        const response = await fetch('/api/services/cover/close_cover', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                entity_id: entityId
            })
        });
        
        if (!response.ok) {
            throw new Error(`Failed to close cover: ${response.statusText}`);
        }
    } catch (error) {
        console.error('Error closing cover:', error);
        showToast(`Error closing cover: ${error.message}`, 3000);
    } finally {
        hideLoader(card);
    }
}

async function stopCover(entityId) {
    const card = document.querySelector(`[data-device-id="${entityId}"]`);
    if (!card) return;
    
    showLoader(card);
    pendingUpdates.add(entityId);
    
    try {
        const response = await fetch('/api/services/cover/stop_cover', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                entity_id: entityId
            })
        });
        
        if (!response.ok) {
            throw new Error(`Failed to stop cover: ${response.statusText}`);
        }
    } catch (error) {
        console.error('Error stopping cover:', error);
        showToast(`Error stopping cover: ${error.message}`, 3000);
    } finally {
        hideLoader(card);
    }
}

async function setCoverPosition(entityId, position) {
    const card = document.querySelector(`[data-device-id="${entityId}"]`);
    if (!card) return;
    
    showLoader(card);
    pendingUpdates.add(entityId);
    
    try {
        const response = await fetch('/api/services/cover/set_cover_position', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                entity_id: entityId,
                position: parseInt(position)
            })
        });
        
        if (!response.ok) {
            throw new Error(`Failed to set cover position: ${response.statusText}`);
        }
    } catch (error) {
        console.error('Error setting cover position:', error);
        showToast(`Error setting cover position: ${error.message}`, 3000);
    } finally {
        hideLoader(card);
    }
}

function getCoverCard(device, state) {
    const isOpen = state.state === 'open';
    const isClosed = state.state === 'closed';
    const isOpening = state.state === 'opening';
    const isClosing = state.state === 'closing';
    const position = state.attributes?.current_position;
    const supportsPosition = position !== undefined;
    
    let stateIconClass = 'fas fa-window-maximize';
    if (isClosed) {
        stateIconClass = 'fas fa-window-minimize';
    } else if (isOpening) {
        stateIconClass = 'fas fa-arrow-up';
    } else if (isClosing) {
        stateIconClass = 'fas fa-arrow-down';
    }
    
    return `
        <div class="device-card cover-card" 
             data-device-id="${device.id}" 
             data-state="${state.state}">
            <div class="device-header">
                <div class="device-name">${device.name}</div>
                <div class="device-state">
                    <i class="device-state-icon ${stateIconClass}"></i>
                </div>
            </div>
            <div class="device-controls">
                ${getCoverControls(device, state)}
            </div>
        </div>
    `;
}


function getCoverControls(device, state) {
    const isOpen = device.state === 'open';
    const isClosed = device.state === 'closed';
    const isOpening = device.state === 'opening';
    const isClosing = device.state === 'closing';
    const isUnavailable = device.state === 'unavailable';
    const position = device.state.attributes?.current_position;
    const supportsPosition = position !== undefined;
    if (device.state === 'open') {
        iconName = 'blindopen';
    }
    else {
        iconName = 'blindclosed'; 
    };   
    console.log('getCoverControls', iconName);
    return `
        <div class="cover-header">
            <span class="cover-position">${isUnavailable ? 'Unavailable' : isOpen ? 'Open' : 'Closed'}</span>
            <div class="toggle-circle" data-action="toggle">
                ${blindIconsSVGs[iconName]}
            </div>
        </div>
        <div class="device-name">${device.name}</div>
    `;
}