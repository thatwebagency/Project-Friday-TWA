let roomDevices = {};
let haSocket = null;
let trackedEntities = {};
let entityStates = {};
let messageId = 1;
let pendingUpdates = new Set();
let messageHandlers = new Map(); // Store message handlers globally
let selectedMediaPlayer = null; // Store the currently selected media player entity_id

let isReorderMode = false;
let longPressTimer = null;
const LONG_PRESS_DURATION = 500; // 500ms for long press

let spotifyLibraryLoaded = false;

document.addEventListener('contextmenu', event => {
    event.preventDefault();
});

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
            haSocket.send(JSON.stringify({
                type: "auth",
                access_token: config.access_token
            }));
        };

        haSocket.onmessage = (event) => {
            const message = JSON.parse(event.data);

            if (message.type === "auth_ok") {
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

                    ${data.artists.length > 0 ? generateSpotifySection('Albums', data.albums, item => ({
                        image: (item.images && item.images.length > 0) ? item.images[0].url : '/static/images/default-spotify.jpg',
                        title: item.name,
                        subtitle: item.artists?.[0]?.name || 'Unknown Artist',
                        uri: item.uri,
                        type: 'album'
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
    const searchBar = document.querySelector('.spotify-search');
    
    // Show search bar
    searchBar.style.display = 'block';
    
    // Create a timeout for the loading message
    const loadingTimeout = setTimeout(() => {
        const roomContent = document.getElementById('roomContent');
        const existingMessage = roomContent.querySelector('.spotify-loading-message');
        
        if (!existingMessage && roomContent.querySelector('.spotify-loader')) {
            const messageDiv = document.createElement('div');
            messageDiv.className = 'spotify-loading-message';
            messageDiv.textContent = 'This is taking longer than expected. Please check your terminal as you may need to reauthenticate with Spotify.';
            roomContent.querySelector('.spotify-room').appendChild(messageDiv);
        }
    }, 3000);

    fetch('/api/spotify/library')
        .then(response => {
            if (!response.ok) throw new Error('Failed to load Spotify library');
            return response.json();
        })
        .then(data => {
            // Clear the timeout since loading completed
            clearTimeout(loadingTimeout);
            
            // Remove any existing loading message
            const existingMessage = document.querySelector('.spotify-loading-message');
            if (existingMessage) {
                existingMessage.remove();
            }

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
            // Clear the timeout on error
            clearTimeout(loadingTimeout);
            
            // Remove any existing loading message
            const existingMessage = document.querySelector('.spotify-loading-message');
            if (existingMessage) {
                existingMessage.remove();
            }

            console.error('Error loading Spotify library:', error);
            const roomContent = document.getElementById('roomContent');
            roomContent.innerHTML = `
                <div class="spotify-room">
                    <div class="spotify-error">
                        Failed to load Spotify library. Please try again later. Please check your Terminal as you may need to reauthenticate with Spotify.
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
                ${items.filter(item => item).map(item => {
                    try {
                        const { image, title, subtitle, uri, type } = itemMapper(item);
                        return `
                            <div class="spotify-grid-item" 
                                 data-uri="${uri || ''}"
                                 data-type="${type || ''}">
                                <div class="grid-item-image">
                                    <img src="${image || '/static/images/default-spotify.jpg'}" 
                                         alt="${title || 'Unknown'}"
                                         onerror="this.src='/static/images/default-spotify.jpg'">
                                </div>
                                <div class="grid-item-info">
                                    <div class="grid-item-title">${title || 'Unknown'}</div>
                                    <div class="grid-item-subtitle">${subtitle || ''}</div>
                                </div>
                            </div>
                        `;
                    } catch (error) {
                        console.error('Error mapping Spotify item:', error);
                        return '';
                    }
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
            
            
            if (!uri || !selectedMediaPlayer) {
                showToast('Please select a media player first', 3000);
                return;
            }

            if (type === 'playlist' || type === 'artist' || type === 'album') {
                return;
            }

            try {
                const msgId = getNextMessageId();
                
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
                
                haSocket.send(JSON.stringify(message));

                const response = await handleCommandResponse(msgId, selectedMediaPlayer);
                
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
        return devices;
    } catch (error) {
        console.error(`Error loading devices for room ${roomId}:`, error);
        roomDevices[roomId] = [];
        throw error;
    }
}

function displayRoomDevices(roomId) {
    // First, reload the room's devices
    loadRoomDevices(roomId).then(() => {
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
                                                        ${device.type === 'switch' ? 'switch-card' : ''}" 
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
                <button class="add-device-btn"">
                    <i class="fa-solid fa-plus"></i> Add Device
                </button>
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
        // Add room ID to content div for reference
        roomContent.setAttribute('data-room-id', roomId);

        // Add click handler for add device button
        const addDeviceBtn = roomContent.querySelector('.add-device-btn');
        if (addDeviceBtn) {
            addDeviceBtn.onclick = () => showEntityModal(roomId);
        }
        
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
        initializeEntityCards();
    }).catch(error => {
        console.error('Error loading room devices:', error);
        showToast('Error loading devices. Please try again.', 3000);
    });
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
                if (isReorderMode) {
                    return;
                }
                e.stopPropagation();
                showLoader(card);
                toggleDevice(deviceId);
            });
        }

        // Card click for brightness modal
        if (card.classList.contains('light-card')) {
            card.addEventListener('click', (e) => {
                if (isReorderMode) {
                    return;
                }
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
            if (isReorderMode) {
                return;
            }
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
            if (isReorderMode) {
                return;
            }
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
            if (isReorderMode) {
                return;
            }
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
        if (isReorderMode) {
            return;
        }
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
            if (isReorderMode) {
                return;
            }
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

    setupSpotifyControlBar();

    // Check if we need to show release notes
    const releaseDataElement = document.getElementById('release-data');
    if (releaseDataElement) {
        const showRelease = releaseDataElement.dataset.showRelease === 'true';
        const releaseData = JSON.parse(releaseDataElement.dataset.releaseData || '{}');
        
        if (showRelease && releaseData) {
            showReleaseNotesPopup(releaseData);
        }
    }
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
                if (isReorderMode) {
                    return;
                }
                e.stopPropagation();
                const state = entityStates[deviceId];
                if (!state) return;
                const service = state.state === 'playing' ? 'media_pause' : 'media_play';
                sendMediaCommand(deviceId, service);
            });
        }
        
        if (previousBtn) {
            previousBtn.addEventListener('click', (e) => {
                if (isReorderMode) {
                    return;
                }
                e.stopPropagation();
                sendMediaCommand(deviceId, 'media_previous_track');
            });
        }
        
        if (nextBtn) {
            nextBtn.addEventListener('click', (e) => {
                if (isReorderMode) {
                    return;
                }
                e.stopPropagation();
                sendMediaCommand(deviceId, 'media_next_track');
            });
        }
        
        if (volumeSlider) {
            volumeSlider.addEventListener('change', (e) => {
                if (isReorderMode) {
                    return;
                }
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

function showPlaylistView(playlistId) {
    const spotifyContent = document.querySelector('.spotify-content');
    const searchBar = document.querySelector('.spotify-search');
    
    // Hide search bar
    searchBar.style.display = 'none';
    
    spotifyContent.innerHTML = `
        <div class="playlist-view">
            <button class="back-button">
                <i class="fas fa-arrow-left"></i>
                Back
            </button>
            <div class="playlist-loader">
                <div class="loader-spinner"></div>
            </div>
        </div>
    `;

    // Show the playlist view
    const playlistView = spotifyContent.querySelector('.playlist-view');
    playlistView.classList.add('show');

    // Fetch playlist details
    fetch(`/api/spotify/playlist/${playlistId}`)
        .then(response => response.json())
        .then(playlist => {
            const trackCount = playlist.tracks.total;
            const duration = formatPlaylistDuration(playlist.tracks.items);
            
            playlistView.innerHTML = `
                <button class="back-button">
                    <i class="fas fa-arrow-left"></i>
                    Back
                </button>
                <div class="playlist-header">
                    <div class="playlist-cover">
                        <img src="${playlist.images[0]?.url || '/static/images/default-playlist.jpg'}" 
                             alt="${playlist.name}">
                    </div>
                    <div class="playlist-info">
                        <h1 class="playlist-title">${playlist.name}</h1>
                        <div class="playlist-meta">
                            ${trackCount} songs • ${duration}
                        </div>
                        <button class="playlist-play-button" data-uri="${playlist.uri}">
                            <i class="fas fa-play"></i>
                            Play
                        </button>
                    </div>
                </div>
                <div class="playlist-tracks">
                    ${playlist.tracks.items.map((item, index) => `
                        <div class="playlist-track" data-uri="${item.track.uri}" data-context-uri="${playlist.uri}">
                            <span class="track-number">${index + 1}</span>
                            <img class="track-image" 
                                 src="${item.track.album.images[0]?.url || '/static/images/default-track.jpg'}" 
                                 alt="${item.track.name}">
                            <div class="track-details">
                                <div class="track-title">${item.track.name}</div>
                                <div class="track-artist">${item.track.artists.map(a => a.name).join(', ')}</div>
                            </div>
                            <span class="track-duration">${formatDuration(item.track.duration_ms)}</span>
                        </div>
                    `).join('')}
                </div>
            `;

            // Add event listeners
            setupPlaylistEventListeners(playlistView);
        })
        .catch(error => {
            console.error('Error loading playlist:', error);
            playlistView.innerHTML = `
                <div class="error-message">
                    Failed to load playlist. Please try again later.
                </div>
            `;
        });
}

function setupPlaylistEventListeners(playlistView) {
    // Back button
    playlistView.querySelector('.back-button').addEventListener('click', () => {
        loadSpotifyLibrary();
    });

    // Play button
    playlistView.querySelector('.playlist-play-button').addEventListener('click', (e) => {
        const uri = e.currentTarget.dataset.uri;
        playSpotifyContent(uri);
    });

    // Individual tracks
    playlistView.querySelectorAll('.playlist-track').forEach(track => {
        track.addEventListener('click', (e) => {
            const trackUri = e.currentTarget.dataset.uri;
            const contextUri = e.currentTarget.dataset.contextUri;
            // For individual tracks, we'll use the track URI directly
            playSpotifyContent(trackUri);
        });
    });
}

function formatPlaylistDuration(tracks) {
    const totalMs = tracks.reduce((total, item) => total + item.track.duration_ms, 0);
    const hours = Math.floor(totalMs / (1000 * 60 * 60));
    const minutes = Math.floor((totalMs % (1000 * 60 * 60)) / (1000 * 60));
    
    if (hours > 0) {
        return `${hours} hr ${minutes} min`;
    }
    return `${minutes} min`;
}

function formatDuration(ms) {
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function showArtistView(artistId, fromLibrary = true) {
    const spotifyContent = document.querySelector('.spotify-content');
    const searchBar = document.querySelector('.spotify-search');
    
    if (fromLibrary) {
        // Clear navigation history when coming from library
        navigationHistory = [];
    }
    
    // Hide search bar
    searchBar.style.display = 'none';
    
    spotifyContent.innerHTML = `
        <div class="artist-view">
            <button class="back-button">
                <i class="fas fa-arrow-left"></i>
                Back
            </button>
            <div class="artist-loader">
                <div class="loader-spinner"></div>
            </div>
        </div>
    `;

    // Show the artist view
    const artistView = spotifyContent.querySelector('.artist-view');
    artistView.classList.add('show');

    // Fetch artist details
    fetch(`/api/spotify/artist/${artistId}`)
        .then(response => response.json())
        .then(data => {
            const { artist, top_tracks, albums } = data;
            
            artistView.innerHTML = `
                <button class="back-button">
                    <i class="fas fa-arrow-left"></i>
                    Back
                </button>
                <div class="artist-header">
                    <div class="artist-cover">
                        <img src="${artist.images[0]?.url || '/static/images/default-artist.jpg'}" 
                             alt="${artist.name}">
                    </div>
                    <div class="artist-info">
                        <h1 class="artist-name">${artist.name}</h1>
                        <div class="artist-meta">
                            ${formatFollowers(artist.followers.total)} followers
                        </div>
                    </div>
                </div>
                <div class="artist-sections">
                    <div class="artist-section">
                        <h2 class="section-title">Popular</h2>
                        <div class="playlist-tracks">
                            ${top_tracks.slice(0, 5).map((track, index) => `
                                <div class="playlist-track" data-uri="${track.uri}">
                                    <span class="track-number">${index + 1}</span>
                                    <img class="track-image" 
                                         src="${track.album.images[0]?.url || '/static/images/default-track.jpg'}" 
                                         alt="${track.name}">
                                    <div class="track-details">
                                        <div class="track-title">${track.name}</div>
                                        <div class="track-artist">${track.album.name}</div>
                                    </div>
                                    <span class="track-duration">${formatDuration(track.duration_ms)}</span>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                    <div class="artist-section">
                        <h2 class="section-title">Albums</h2>
                        <div class="albums-grid">
                            ${albums.map(album => `
                                <div class="album-item" data-uri="${album.uri}">
                                    <div class="album-cover">
                                        <img src="${album.images[0]?.url || '/static/images/default-album.jpg'}" 
                                             alt="${album.name}">
                                    </div>
                                    <div class="album-name">${album.name}</div>
                                    <div class="album-year">${new Date(album.release_date).getFullYear()}</div>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                </div>
            `;

            // Add event listeners
            setupArtistEventListeners(artistView);
        })
        .catch(error => {
            console.error('Error loading artist:', error);
            artistView.innerHTML = `
                <div class="error-message">
                    Failed to load artist. Please try again later.
                </div>
            `;
        });
}

function setupArtistEventListeners(artistView) {
    // Back button
    artistView.querySelector('.back-button').addEventListener('click', () => {
        if (navigationHistory.length > 0) {
            // Restore the previous view
            const previousView = navigationHistory.pop();
            const spotifyContent = document.querySelector('.spotify-content');
            spotifyContent.innerHTML = previousView.content;
            
            // Restore scroll position after content is loaded
            setTimeout(() => {
                spotifyContent.scrollTop = previousView.scrollPosition;
                // Reattach event listeners for the artist view
                if (previousView.type === 'artist') {
                    setupArtistEventListeners(spotifyContent.querySelector('.artist-view'));
                }
            }, 0);
        } else {
            loadSpotifyLibrary();
        }
    });

    artistView.querySelectorAll('.playlist-track').forEach(track => {
        track.addEventListener('click', (e) => {
            const uri = e.currentTarget.dataset.uri;
            playSpotifyContent(uri);
        });
    });

    artistView.querySelectorAll('.album-item').forEach(album => {
        album.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const uri = e.currentTarget.dataset.uri;
            const albumId = uri.split(':')[2];
            showAlbumView(albumId, true);  // Pass true to indicate it's from artist view
        });
    });
}

function playSpotifyContent(contextUri, trackUri = null) {
    if (!selectedMediaPlayer || !haSocket || haSocket.readyState !== WebSocket.OPEN) {
        showToast('Not connected to media player', 3000);
        return;
    }

    // Show loading state
    const controlBar = document.querySelector('.spotify-control-bar');
    if (controlBar) controlBar.classList.add('loading');

    // Add to pending updates
    pendingUpdates.add(selectedMediaPlayer);

    // First ensure the media player is on
    haSocket.send(JSON.stringify({
        id: getNextMessageId(),
        type: 'call_service',
        domain: 'media_player',
        service: 'turn_on',
        target: {
            entity_id: selectedMediaPlayer
        }
    }));

    // Then play the content
    const data = {
        media_content_id: trackUri || contextUri,
        media_content_type: trackUri ? 'music' : 'playlist',
    };

    haSocket.send(JSON.stringify({
        id: getNextMessageId(),
        type: 'call_service',
        domain: 'media_player',
        service: 'play_media',
        target: {
            entity_id: selectedMediaPlayer
        },
        service_data: data
    }));
}

// Update the click handler to handle both playlists and artists
document.addEventListener('click', (e) => {
    const gridItem = e.target.closest('.spotify-grid-item');
    if (gridItem) {
        e.preventDefault();
        e.stopPropagation();
        
        const uri = gridItem.dataset.uri;
        if (uri?.startsWith('spotify:playlist:')) {
            const playlistId = uri.split(':')[2];
            showPlaylistView(playlistId);
        } else if (uri?.startsWith('spotify:artist:')) {
            const artistId = uri.split(':')[2];
            showArtistView(artistId, true); // Indicate this is from library
        } else if (uri?.startsWith('spotify:album:')) {
            const albumId = uri.split(':')[2];
            showAlbumView(albumId, false); // Indicate this is from library
        }
    }
});

// Add a navigation history stack
let navigationHistory = [];

function showAlbumView(albumId, fromArtist = false) {
    if (fromArtist) {
        // Store the current artist view HTML and scroll position
        const currentView = document.querySelector('.spotify-content').innerHTML;
        const scrollPosition = document.querySelector('.spotify-content').scrollTop;
        navigationHistory.push({
            type: 'artist',
            content: currentView,
            scrollPosition: scrollPosition
        });
    } else {
        // Clear navigation history if coming from library
        navigationHistory = [];
    }

    const spotifyContent = document.querySelector('.spotify-content');
    const searchBar = document.querySelector('.spotify-search');
    
    // Hide search bar
    searchBar.style.display = 'none';
    
    spotifyContent.innerHTML = `
        <div class="album-view">
            <button class="back-button">
                <i class="fas fa-arrow-left"></i>
                Back
            </button>
            <div class="album-loader">
                <div class="loader-spinner"></div>
            </div>
        </div>
    `;

    // Show the album view
    const albumView = spotifyContent.querySelector('.album-view');
    albumView.classList.add('show');

    // Fetch album details
    fetch(`/api/spotify/album/${albumId}`)
        .then(response => response.json())
        .then(album => {
            const releaseYear = new Date(album.release_date).getFullYear();
            const totalDuration = formatAlbumDuration(album.tracks.items);
            
            albumView.innerHTML = `
                <button class="back-button">
                    <i class="fas fa-arrow-left"></i>
                    Back
                </button>
                <div class="album-header">
                    <div class="album-cover">
                        <img src="${album.images[0]?.url || '/static/images/default-album.jpg'}" 
                             alt="${album.name}">
                    </div>
                    <div class="album-info">
                        <h1 class="album-title">${album.name}</h1>
                        <div class="album-meta">
                            ${album.artists.map(artist => artist.name).join(', ')} • ${releaseYear} • 
                            ${album.total_tracks} songs, ${totalDuration}
                        </div>
                        <button class="album-play-button" data-uri="${album.uri}">
                            <i class="fas fa-play"></i>
                            Play
                        </button>
                    </div>
                </div>
                <div class="album-tracks">
                    ${album.tracks.items.map((track, index) => `
                        <div class="playlist-track" data-uri="${track.uri}" data-context-uri="${album.uri}">
                            <span class="track-number" style="padding-right: 20px;">${index + 1}</span>
                            <div class="track-details">
                                <div class="track-title">${track.name}</div>
                                <div class="track-artist">${track.artists.map(a => a.name).join(', ')}</div>
                            </div>
                            <span class="track-duration">${formatDuration(track.duration_ms)}</span>
                        </div>
                    `).join('')}
                </div>
            `;

            // Add event listeners
            setupAlbumEventListeners(albumView);
        })
        .catch(error => {
            console.error('Error loading album:', error);
            albumView.innerHTML = `
                <div class="error-message">
                    Failed to load album. Please try again later.
                </div>
            `;
        });
}

function setupAlbumEventListeners(albumView) {
    // Back button
    albumView.querySelector('.back-button').addEventListener('click', () => {
        if (navigationHistory.length > 0) {
            // Restore the previous view
            const previousView = navigationHistory.pop();
            const spotifyContent = document.querySelector('.spotify-content');
            spotifyContent.innerHTML = previousView.content;
            
            // Restore scroll position after content is loaded
            setTimeout(() => {
                spotifyContent.scrollTop = previousView.scrollPosition;
                // Reattach event listeners for the artist view
                if (previousView.type === 'artist') {
                    setupArtistEventListeners(spotifyContent.querySelector('.artist-view'));
                }
            }, 0);
        } else {
            loadSpotifyLibrary();
        }
    });

    // Play button
    albumView.querySelector('.album-play-button').addEventListener('click', (e) => {
        const uri = e.currentTarget.dataset.uri;
        playSpotifyContent(uri);
    });

    // Individual tracks
    albumView.querySelectorAll('.playlist-track').forEach(track => {
        track.addEventListener('click', (e) => {
            const trackUri = e.currentTarget.dataset.uri;
            const contextUri = e.currentTarget.dataset.contextUri;
            playSpotifyContent(trackUri);
        });
    });
}

function formatAlbumDuration(tracks) {
    const totalMs = tracks.reduce((total, track) => total + track.duration_ms, 0);
    const minutes = Math.floor(totalMs / 60000);
    
    if (minutes >= 60) {
        const hours = Math.floor(minutes / 60);
        const remainingMinutes = minutes % 60;
        return `${hours} hr ${remainingMinutes} min`;
    }
    return `${minutes} min`;
}

// Add this function to handle entering/exiting reorder mode
function toggleReorderMode(roomId) {
    isReorderMode = !isReorderMode;
    const room = document.querySelector(`.room-content[data-room-id="${roomId}"]`);
    if (!room) {
        console.error(`Could not find room with ID ${roomId}`);
        return;
    }
    room.classList.toggle('reorder-mode', isReorderMode);

    // Add or remove the "Add devices" button
    let addDevicesButton = room.querySelector('.add-devices-button');
    if (isReorderMode) {
        if (!addDevicesButton) {
            const roomName = document.querySelector(`[data-room-id="${roomId}"]`)?.querySelector('.room-name')?.textContent || 'Room';
            addDevicesButton = document.createElement('button');
            addDevicesButton.className = 'add-devices-button';
            addDevicesButton.innerHTML = '<i class="fas fa-plus"></i> Add Devices';
            addDevicesButton.onclick = () => showEntityModal(roomId, roomName);
            room.insertBefore(addDevicesButton, room.firstChild);
        }

        // Add remove buttons to all device cards and script pills
        room.querySelectorAll('.device-card, .script-pill').forEach(element => {
            if (!element.querySelector('.remove-device-button')) {
                const removeButton = document.createElement('button');
                removeButton.className = 'remove-device-button';
                removeButton.innerHTML = '<i class="fas fa-minus"></i>';
                removeButton.onclick = async (e) => {
                    e.stopPropagation();
                    const entityId = element.dataset.deviceId;
                    try {
                        const response = await fetch(`/api/rooms/${roomId}/devices/${entityId}`, {
                            method: 'DELETE'
                        });
                        
                        if (!response.ok) {
                            throw new Error('Failed to remove device');
                        }

                        await loadRoomDevices(roomId);
                        displayRoomDevices(roomId);
                        
                        isReorderMode = true;
                        toggleReorderMode(roomId);
                        
                        displayRoomDevices(roomId);
                        
                        showToast('Device removed successfully');
                    } catch (error) {
                        console.error('Error removing device:', error);
                        showToast('Failed to remove device', 3000);
                    }
                };
                element.appendChild(removeButton);
            }
        });
    } else {
        // Remove add devices button and remove buttons
        if (addDevicesButton) {
            addDevicesButton.remove();
        }
        room.querySelectorAll('.remove-device-button').forEach(button => button.remove());
    }

    // Initialize or destroy Sortable instances for each section
    const deviceSections = room.querySelectorAll('.device-section .devices-grid');
    const scriptsContainer = room.querySelector('.scripts-container');
    
    // Handle device sections
    deviceSections.forEach(section => {
        const sectionType = section.closest('.device-section').querySelector('.section-title').textContent.toLowerCase();
        
        const existingSortable = Sortable.get(section);
        if (existingSortable) {
            existingSortable.destroy();
        }
        
        if (isReorderMode) {
            new Sortable(section, {
                animation: 150,
                handle: '.device-card',
                group: sectionType,
                onEnd: async function(evt) {
                    const sectionElement = evt.to.closest('.device-section');
                    const sectionType = sectionElement.querySelector('.section-title').textContent.toLowerCase();
                    await updateEntityOrder(roomId, sectionType);
                }
            });
        }
    });

    // Handle scripts section
    if (scriptsContainer) {
        const existingSortable = Sortable.get(scriptsContainer);
        if (existingSortable) {
            existingSortable.destroy();
        }
        
        if (isReorderMode) {
            new Sortable(scriptsContainer, {
                animation: 150,
                handle: '.script-pill',
                group: 'scripts',
                onEnd: async function(evt) {
                    await updateEntityOrder(roomId, 'scripts');
                }
            });
        }
    }
}

// Update the entity order update function to handle scripts
async function updateEntityOrder(roomId, sectionType) {
    const section = sectionType === 'scripts' 
        ? document.querySelector(`.room-content[data-room-id="${roomId}"] .scripts-container`)
        : document.querySelector(`.room-content[data-room-id="${roomId}"] .device-section .devices-grid`);
        
    if (!section) {
        console.error('Could not find section');
        return;
    }

    const entityIds = Array.from(
        section.querySelectorAll(sectionType === 'scripts' ? '.script-pill' : '.device-card')
    ).map(element => element.dataset.deviceId);

    try {
        const response = await fetch(`/api/rooms/${roomId}/entities/reorder`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                entityIds: entityIds,
                groupType: sectionType
            })
        });

        if (!response.ok) {
            throw new Error('Failed to update entity order');
        }
    } catch (error) {
        console.error('Error updating entity order:', error);
        showToast('Failed to save new order', 3000);
    }
}

// Update the click handler for entity cards
function initializeEntityCards() {
    const cards = document.querySelectorAll('.device-card, .script-pill');

    cards.forEach(card => {
        let startTime;
        let startTouch;

        // Mouse Events
        card.addEventListener('mousedown', (e) => {
            if (isReorderMode) return;
            startTime = Date.now();
            longPressTimer = setTimeout(() => {
                const room = card.closest('.room-content');
                if (!room) {
                    console.error('Could not find parent room element');
                    return;
                }
                const roomId = room.dataset.roomId;
                if (roomId) {
                    toggleReorderMode(roomId);
                } else {
                    console.error('Room ID not found on room element');
                }
            }, LONG_PRESS_DURATION);
        });

        card.addEventListener('mouseup', (e) => {
            if (longPressTimer) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
            }
            
            // Only handle click if it's a short press and not in reorder mode
            if (!isReorderMode && Date.now() - startTime < LONG_PRESS_DURATION) {
                handleCardClick(card, e);
            }
        });

        card.addEventListener('mouseleave', () => {
            if (longPressTimer) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
            }
        });

        // Touch Events
        card.addEventListener('touchstart', (e) => {
            if (isReorderMode) return;
            startTime = Date.now();
            startTouch = e.touches[0];
            longPressTimer = setTimeout(() => {
                const room = card.closest('.room-content');
                console.log('Room element:', room);
                if (!room) {
                    console.error('Could not find parent room element');
                    return;
                }
                const roomId = room.dataset.roomId;
                console.log('Room ID:', roomId);
                if (roomId) {
                    toggleReorderMode(roomId);
                } else {
                    console.error('Room ID not found on room element');
                }
            }, LONG_PRESS_DURATION);
        }, { passive: true });

        card.addEventListener('touchend', (e) => {
            if (longPressTimer) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
            }
            
            // Only handle tap if it's a short press and not in reorder mode
            if (!isReorderMode && Date.now() - startTime < LONG_PRESS_DURATION) {
                handleCardClick(card, e);
            }
        });

        card.addEventListener('touchmove', (e) => {
            if (longPressTimer) {
                // Cancel long press if user moves finger more than 10px
                const touch = e.touches[0];
                const moveThreshold = 10;
                
                if (Math.abs(touch.clientX - startTouch.clientX) > moveThreshold ||
                    Math.abs(touch.clientY - startTouch.clientY) > moveThreshold) {
                    clearTimeout(longPressTimer);
                    longPressTimer = null;
                }
            }
        }, { passive: true });
    });

    // Add click handler to exit reorder mode when clicking outside cards
    document.addEventListener('click', (e) => {
        if (isReorderMode && 
            !e.target.closest('.device-card') && 
            !e.target.closest('.add-devices-button') && // Ignore clicks on the add devices button
            !e.target.closest('.modal-content')) {      // Ignore clicks inside the modal
            const room = document.querySelector('.room-content.reorder-mode');
            if (room) {
                toggleReorderMode(room.dataset.roomId);
            }
        }
    });
}

// Add this helper function to handle card clicks
function handleCardClick(card, event) {
    const entityId = card.dataset.entityId;
    const domain = card.dataset.domain;
    
    // Your existing click handling logic here
    if (domain === 'light' || domain === 'switch') {
        event.preventDefault();
        toggleDevice(entityId, card);
    } else if (domain === 'climate') {
        // Climate control handling
    } else if (domain === 'media_player') {
        // Media player handling
    }
    // ... rest of your click handling logic ...
}

// Add this near the top of the file with other initialization code
function showReleaseNotesPopup(releaseData) {
    const popup = document.createElement('div');
    popup.className = 'release-popup';
    popup.innerHTML = `
        <div class="release-popup-content">
            <h2>What's New in ${releaseData.release_version}</h2>
            <div class="release-date">Released on ${new Date(releaseData.release_date).toLocaleDateString()}</div>
            ${releaseData.release_notes}
            <button class="confirm-button">Got it!</button>
        </div>
    `;

    document.body.appendChild(popup);

    // Add fade-in effect
    setTimeout(() => popup.classList.add('show'), 10);

    // Handle confirmation
    popup.querySelector('.confirm-button').addEventListener('click', async () => {
        try {
            const response = await fetch('/api/release/viewed', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) throw new Error('Failed to mark release as viewed');

            // Remove popup with fade-out effect
            popup.classList.remove('show');
            setTimeout(() => popup.remove(), 300);
        } catch (error) {
            console.error('Error marking release as viewed:', error);
        }
    });
}

// Add these helper functions
function getEntityIcon(domain) {
    const iconMap = {
        light: 'lightbulb',
        switch: 'power-off',
        climate: 'temperature-half',
        sensor: 'gauge',
        binary_sensor: 'toggle-on',
        script: 'code',
        media_player: 'play-circle',
        camera: 'video',
        cover: 'blinds',
        fan: 'fan',
        default: 'circle-dot'
    };
    return iconMap[domain] || iconMap.default;
}

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
    
    try {
        // Get all available entities
        const entitiesResponse = await fetch('/api/ha/entities');
        const allEntities = await entitiesResponse.json();
        
        // Get current room's entities
        const roomDevicesResponse = await fetch(`/api/rooms/${roomId}/devices`);
        const roomDevices = await roomDevicesResponse.json();
        
        // Create a set of existing entity IDs for quick lookup
        const existingEntityIds = new Set(roomDevices.map(device => device.id));
        
        // Check if room has a climate device
        const hasClimate = roomDevices.some(device => device.type === 'climate');
        
        // Filter out existing entities and handle climate devices
        const availableEntities = allEntities.filter(entity => {
            
            // Filter out existing entities
            if (existingEntityIds.has(entity.entity_id)) {
                return false;
            }
            
            // Filter out climate entities if room already has one
            if (hasClimate && entity.domain === 'climate') {
                return false;
            }
            
            return true;
        });
        
        // Group filtered entities by domain
        const groupedEntities = groupEntitiesByDomain(availableEntities);
        
        function renderEntities(searchTerm = '') {
            const filteredEntities = searchTerm 
                ? availableEntities.filter(e => 
                    e.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                    e.entity_id.toLowerCase().includes(searchTerm.toLowerCase()))
                : availableEntities;
            
            const groupedFiltered = groupEntitiesByDomain(filteredEntities);
            
            modalEntityList.innerHTML = Object.entries(groupedFiltered)
                .map(([domain, entities]) => `
                    <div class="entity-section">
                        <h5 class="entity-section-header">
                            <i class="fa-solid fa-${getEntityIcon(domain)}"></i>
                            ${domain.split('_').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')}
                            ${entities.length > 0 ? `<span class="entity-count">(${entities.length})</span>` : ''}
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
                `).filter(section => section.includes('entity-card')).join('');
            
            // Add click handlers for entity cards
            modalEntityList.querySelectorAll('.entity-card').forEach(card => {
                card.addEventListener('click', () => {
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
            const domain = selectedCard.dataset.domain;
            const name = selectedCard.querySelector('.entity-friendly-name').textContent;
            
            try {
                const response = await fetch(`/api/rooms/${roomId}/devices`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        entity_id: entityId,
                        name: name,
                        domain: domain
                    })
                });

                if (response.ok) {
                    modal.style.display = 'none';
                    // Refresh the room content
                    await displayRoomDevices(roomId);
                    showToast('Entity added successfully', 'success');
                } else {
                    const error = await response.json();
                    showToast(error.error || 'Error adding entity', 'error');
                }
            } catch (error) {
                console.error('Error saving entity:', error);
                showToast('Error adding entity', 'error');
            }
            toggleReorderMode(roomId);
        };
        
        // Show modal
        modal.style.display = 'block';
        
    } catch (error) {
        console.error('Error loading entities:', error);
        showToast('Error loading entities', 'error');
    }
}

function groupEntitiesByDomain(entities) {
    const groups = {
        script: [],
        climate: [],
        media_player: [],
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
    
    return Object.fromEntries(
        Object.entries(groups).filter(([_, entities]) => entities.length > 0)
    );
}

// Add this function to create and append the modal
function createEntityModal() {
    const modal = document.createElement('div');
    modal.id = 'entityModal';
    modal.className = 'modal';
    modal.innerHTML = `
        <div class="modal-content">
            <div class="modal-header">
                <h4>Add Entities to <span id="modalRoomName"></span></h4>
                <button type="button" class="modal-close">&times;</button>
            </div>
            <div class="modal-body">
                <div class="entity-search">
                    <input type="text" placeholder="Search entities..." id="entitySearch">
                </div>
                <div id="modalEntityList">
                    <!-- Entity sections will be dynamically added here -->
                </div>
            </div>
            <div class="modal-footer">
                <button type="button" class="modal-cancel">Cancel</button>
                <button type="button" class="modal-save" disabled>Add Selected</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    initializeModalEvents();
}

// Add modal initialization
function initializeModalEvents() {
    const entityModal = document.getElementById('entityModal');
    const closeButton = entityModal.querySelector('.modal-close');
    const cancelButton = entityModal.querySelector('.modal-cancel');
    
    [closeButton, cancelButton].forEach(button => {
        button.addEventListener('click', () => {
            entityModal.style.display = 'none';
        });
    });
    
    window.addEventListener('click', (e) => {
        if (e.target === entityModal) {
            entityModal.style.display = 'none';
        }
    });
}

// Call this when the page loads
document.addEventListener('DOMContentLoaded', () => {
    createEntityModal();
    // ... existing initialization code ...
});

function handleEntitySelection(entityId, roomId) {
    const loader = document.querySelector('.entity-modal .modal-loader');
    if (loader) loader.classList.add('show');

    // Get the order for the new entity (highest order + 1)
    const currentDevices = roomDevices[roomId] || [];
    const newOrder = currentDevices.length > 0 
        ? Math.max(...currentDevices.map(d => d.order)) + 1 
        : 0;

    fetch('/api/setup/entities', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            entities: [{
                entity_id: entityId,
                name: entityStates[entityId]?.attributes?.friendly_name || entityId,
                domain: entityId.split('.')[0],
                rooms: [{
                    id: roomId,
                    order: newOrder
                }]
            }]
        })
    })
    .then(response => response.json())
    .then(async data => {
        if (data.success) {
            // Reload the room's devices
            await loadRoomDevices(roomId);
            
            // Exit reorder mode
            isReorderMode = true; // Set to true so toggleReorderMode will turn it off
            toggleReorderMode(roomId);
            
            // Redisplay the room
            displayRoomDevices(roomId);
            
            // Close the modal
            const modal = document.querySelector('.entity-modal');
            if (modal) {
                modal.classList.remove('show');
                setTimeout(() => modal.remove(), 300);
            }
            
            showToast('Entity added successfully');
        } else {
            throw new Error(data.error || 'Failed to add entity');
        }
    })
    .catch(error => {
        console.error('Error adding entity:', error);
        showToast(`Failed to add entity: ${error.message}`, 5000);
    })
    .finally(() => {
        if (loader) loader.classList.remove('show');
    });
}

function showAddEntityModal(roomId) {
    // Remove existing modal if any
    const existingModal = document.querySelector('.entity-modal');
    if (existingModal) {
        existingModal.remove();
    }

    fetch('/api/ha/entities')
        .then(response => response.json())
        .then(entities => {
            // Filter out entities that are already in the room
            const currentDevices = roomDevices[roomId] || [];
            const currentEntityIds = new Set(currentDevices.map(d => d.id));
            
            const availableEntities = entities.filter(entity => 
                !currentEntityIds.has(entity.entity_id) &&
                !entity.entity_id.startsWith('zone.') &&
                !entity.entity_id.startsWith('persistent_notification.')
            );

            const modal = document.createElement('div');
            modal.className = 'entity-modal';
            modal.innerHTML = `
                <div class="modal-content">
                    <h2>Add Entity</h2>
                    <div class="search-container">
                        <input type="text" class="entity-search" placeholder="Search entities...">
                    </div>
                    <div class="entities-list">
                        ${availableEntities.map(entity => `
                            <div class="entity-item" data-entity-id="${entity.entity_id}">
                                <span class="entity-name">${entity.attributes?.friendly_name || entity.entity_id}</span>
                                <span class="entity-id">${entity.entity_id}</span>
                            </div>
                        `).join('')}
                    </div>
                    <div class="modal-loader">
                        <div class="loader-spinner"></div>
                    </div>
                </div>
            `;

            document.body.appendChild(modal);

            // Show modal with animation
            requestAnimationFrame(() => {
                modal.classList.add('show');
            });

            // Setup search functionality
            const searchInput = modal.querySelector('.entity-search');
            const entityItems = modal.querySelectorAll('.entity-item');

            searchInput.addEventListener('input', (e) => {
                const searchTerm = e.target.value.toLowerCase();
                entityItems.forEach(item => {
                    const name = item.querySelector('.entity-name').textContent.toLowerCase();
                    const id = item.querySelector('.entity-id').textContent.toLowerCase();
                    const matches = name.includes(searchTerm) || id.includes(searchTerm);
                    item.style.display = matches ? '' : 'none';
                });
            });

            // Setup click handlers
            entityItems.forEach(item => {
                item.addEventListener('click', () => {
                    const entityId = item.dataset.entityId;
                    handleEntitySelection(entityId, roomId);
                });
            });

            // Close modal when clicking outside
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    modal.classList.remove('show');
                    setTimeout(() => modal.remove(), 300);
                }
            });
        })
        .catch(error => {
            console.error('Error fetching entities:', error);
            showToast('Error fetching entities. Please try again.', 5000);
        });
}

function refreshReorderMode(roomId) {
    const room = document.querySelector(`.room-content[data-room-id="${roomId}"]`);
    if (!room) {
        console.error(`Could not find room with ID ${roomId}`);
        return;
    }

    // Ensure room has reorder-mode class
    room.classList.add('reorder-mode');

    // Add the "Add devices" button if it doesn't exist
    let addDevicesButton = room.querySelector('.add-devices-button');
    if (!addDevicesButton) {
        const roomName = document.querySelector(`[data-room-id="${roomId}"]`)?.querySelector('.room-name')?.textContent || 'Room';
        addDevicesButton = document.createElement('button');
        addDevicesButton.className = 'add-devices-button';
        addDevicesButton.innerHTML = '<i class="fas fa-plus"></i> Add Devices';
        addDevicesButton.onclick = () => showEntityModal(roomId, roomName);
        room.insertBefore(addDevicesButton, room.firstChild);
    }

    // Add remove buttons to all device cards
    room.querySelectorAll('.device-card').forEach(card => {
        if (!card.querySelector('.remove-device-button')) {
            const removeButton = document.createElement('button');
            removeButton.className = 'remove-device-button';
            removeButton.innerHTML = '<i class="fas fa-minus"></i>';
            removeButton.onclick = async (e) => {
                e.stopPropagation(); // Prevent card click event
                const entityId = card.dataset.deviceId;
                if (confirm('Are you sure you want to remove this device from the room?')) {
                    try {
                        const response = await fetch(`/api/rooms/${roomId}/devices/${entityId}`, {
                            method: 'DELETE'
                        });
                        
                        if (!response.ok) {
                            throw new Error('Failed to remove device');
                        }

                        // Reload and redisplay room devices
                        await loadRoomDevices(roomId);
                        displayRoomDevices(roomId);
                        
                        // Refresh reorder mode
                        refreshReorderMode(roomId);
                        
                        showToast('Device removed successfully');
                    } catch (error) {
                        console.error('Error removing device:', error);
                        showToast('Failed to remove device', 3000);
                    }
                }
            };
            card.appendChild(removeButton);
        }
    });

    // Initialize Sortable instances for each device section
    const deviceSections = room.querySelectorAll('.device-section .devices-grid');
    deviceSections.forEach(section => {
        const sectionType = section.closest('.device-section').querySelector('.section-title').textContent.toLowerCase();
        
        // Destroy existing Sortable instance if it exists
        const existingSortable = Sortable.get(section);
        if (existingSortable) {
            existingSortable.destroy();
        }
        
        // Initialize new Sortable instance
        new Sortable(section, {
            animation: 150,
            handle: '.device-card',
            group: sectionType,
            onEnd: async function(evt) {
                const sectionElement = evt.to.closest('.device-section');
                const sectionType = sectionElement.querySelector('.section-title').textContent.toLowerCase();
                await updateEntityOrder(roomId, sectionType);
            }
        });
    });
}

// Update handleEntitySelection to use refreshReorderMode
function handleEntitySelection(entityId, roomId) {
    const loader = document.querySelector('.entity-modal .modal-loader');
    if (loader) loader.classList.add('show');

    // Get the order for the new entity (highest order + 1)
    const currentDevices = roomDevices[roomId] || [];
    const newOrder = currentDevices.length > 0 
        ? Math.max(...currentDevices.map(d => d.order)) + 1 
        : 0;

    fetch('/api/setup/entities', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            entities: [{
                entity_id: entityId,
                name: entityStates[entityId]?.attributes?.friendly_name || entityId,
                domain: entityId.split('.')[0],
                rooms: [{
                    id: roomId,
                    order: newOrder
                }]
            }]
        })
    })
    .then(response => response.json())
    .then(async data => {
        if (data.success) {
            // Reload the room's devices
            await loadRoomDevices(roomId);
            // Redisplay the room
            displayRoomDevices(roomId);
            
            // Close the modal
            const modal = document.querySelector('.entity-modal');
            if (modal) {
                modal.classList.remove('show');
                setTimeout(() => modal.remove(), 300);
            }
            
            // Refresh reorder mode
            refreshReorderMode(roomId);
            
            showToast('Entity added successfully');
        } else {
            throw new Error(data.error || 'Failed to add entity');
        }
    })
    .catch(error => {
        console.error('Error adding entity:', error);
        showToast(`Failed to add entity: ${error.message}`, 5000);
    })
    .finally(() => {
        if (loader) loader.classList.remove('show');
    });
}


