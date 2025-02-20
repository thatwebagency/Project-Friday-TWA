from flask import Flask, render_template, redirect, url_for, request, jsonify, session, Response
from modules.ha_client import HomeAssistantClient
from modules.models import db, Configuration, Room, Entity, entity_rooms
import json
from urllib.parse import urlparse
import logging
import asyncio
import qrcode
import base64
from io import BytesIO
import requests
from datetime import datetime
import os
from dotenv import load_dotenv
from flask_migrate import Migrate
import spotipy
from spotipy.oauth2 import SpotifyOAuth, SpotifyClientCredentials

load_dotenv()  # This loads the .env file

app = Flask(__name__)
app.config.from_object('config.Config')
db.init_app(app)
migrate = Migrate(app, db)

ha_client = None  # Only used for setup/configuration now
spotify_client = None  # Global Spotify client
logger = logging.getLogger(__name__)

def initialize_spotify_client():
    """Initialize the Spotify client if credentials are configured"""
    global spotify_client
    try:
        client_id = os.getenv('SPOTIPY_CLIENT_ID')
        client_secret = os.getenv('SPOTIPY_CLIENT_SECRET')
        redirect_uri = os.getenv('SPOTIPY_REDIRECT_URI')

        if not redirect_uri:
            redirect_uri = 'https://dazzling-cuchufli-31be08.netlify.app'
        
        cache_handler = spotipy.CacheFileHandler()
        auth_manager = spotipy.oauth2.SpotifyOAuth(
            client_id=client_id,
            client_secret=client_secret,
            redirect_uri=redirect_uri,
            scope='user-read-playback-state user-modify-playback-state playlist-read-private user-top-read user-read-currently-playing streaming user-follow-read user-read-playback-position user-read-recently-played user-library-read',
            show_dialog=True
        )



        spotify_client = spotipy.Spotify(auth_manager=auth_manager)
        spotify_client.me()  # Test the connection
        logger.info('Spotify client initialized successfully')
        return spotify_client
    except Exception as e:
        logger.error(f'Failed to initialize Spotify client: {str(e)}')
        return None

def get_spotify_client():
    """Get the global Spotify client, initializing it if necessary"""
    global spotify_client
    if spotify_client is None:
        spotify_client = initialize_spotify_client()
    if spotify_client is None:
        raise Exception('Spotify not configured or initialization failed')
    return spotify_client

@app.before_request
def check_setup():
    # List of endpoints that should be accessible during setup
    setup_endpoints = ['static', 'setup', 'test_ha_connection', 'setup_ha', 'setup_rooms', 'setup_entities', 
                      'get_ha_entities', 'get_rooms', 'dashboard', 'index', 'get_tracked_entities', 'rooms']  # Added 'get_tracked_entities'
    
    # Allow access to setup-related endpoints
    if (request.endpoint is None or 
        request.endpoint in setup_endpoints or 
        request.path == '/' or                    # Allow root URL
        request.path.startswith('/api/setup/') or
        request.path.startswith('/api/ha/') or    # Allow HA API endpoints
        request.path.startswith('/api/rooms') or  # Allow rooms API endpoint
        request.path.startswith('/api/entities')): # Allow entities API endpoints
        return
    
    # Check if setup is complete
    config = Configuration.query.first()
    if not config or not config.is_configured:
        return redirect(url_for('setup'))

@app.route("/")
def dashboard():
    config = Configuration.query.first()
    if not config or not config.is_configured:
        return redirect(url_for('settings'))
    
    # Check release notes
    release_data = None
    show_release = False
    try:
        release_file = 'release.json'
        if os.path.exists(release_file):
            with open(release_file, 'r') as f:
                release_data = json.load(f)
                
            # If not viewed, mark as viewed and save
            if not release_data.get('release_viewed', True):
                show_release = True
    except Exception as e:
        logger.error(f"Error reading release notes: {str(e)}")
        
    return render_template('dashboard.html', setup_required=False, show_release=show_release, release_data=release_data)

@app.route("/api/setup/ha", methods=['POST'])
def setup_ha():
    data = request.json
    ha_url = data['ha_url'].strip()
    
    # Ensure URL has protocol
    if not ha_url.startswith(('http://', 'https://')):
        ha_url = 'https://' + ha_url
        
    # Create WebSocket URL
    parsed_url = urlparse(ha_url)
    is_nabu_casa = '.nabu.casa' in parsed_url.hostname if parsed_url.hostname else False
    
    if is_nabu_casa:
        ws_url = f"wss://{parsed_url.hostname}"
    else:
        ws_protocol = 'wss' if parsed_url.scheme == 'https' else 'ws'
        if parsed_url.port:
            ws_url = f"{ws_protocol}://{parsed_url.hostname}:{parsed_url.port}"
        else:
            ws_url = f"{ws_protocol}://{parsed_url.hostname}"
    
    # Get existing configuration if it exists
    existing_config = Configuration.query.first()
    is_configured = existing_config.is_configured if existing_config else False
    
    # Delete existing configuration if it exists
    Configuration.query.delete()
    db.session.commit()
    
    # Create new configuration
    config = Configuration(
        ha_url=ha_url,
        ws_url=ws_url,  # Store the WebSocket URL
        access_token=data['access_token'].strip(),
        is_nabu_casa=is_nabu_casa,
        is_configured=is_configured
    )
    db.session.add(config)
    db.session.commit()
    
    # Initialize global HA client with new configuration
    global ha_client
    ha_client = HomeAssistantClient(
        ws_url=ws_url,
        access_token=data['access_token'].strip(),
        is_nabu_casa=is_nabu_casa
    )
    
    return jsonify({'success': True})

@app.route("/api/rooms/<int:room_id>", methods=['DELETE'])
def delete_room(room_id):
    try:
        room = Room.query.get_or_404(room_id)
        db.session.delete(room)
        db.session.commit()
        return jsonify({'success': True})
    except Exception as e:
        db.session.rollback()
        return jsonify({'error': str(e)}), 500

@app.route("/api/setup/rooms", methods=['POST'])
def setup_rooms():
    data = request.json
    
    # Delete all existing rooms first
    Room.query.delete()
    db.session.commit()
    
    # Add new rooms with order
    for index, room_name in enumerate(data['rooms']):
        if room_name.strip():  # Only add non-empty room names
            room = Room(name=room_name.strip(), order=index)
            db.session.add(room)
    
    db.session.commit()
    return jsonify({'success': True})

@app.route("/api/rooms/reorder", methods=['POST'])
def reorder_rooms():
    try:
        data = request.json
        room_orders = data.get('roomOrders', [])
        
        for room_id, new_order in room_orders:
            room = Room.query.get(room_id)
            if room:
                room.order = new_order
        
        db.session.commit()
        return jsonify({'success': True})
    except Exception as e:
        db.session.rollback()
        return jsonify({'error': str(e)}), 500

@app.route("/api/rooms")
def get_rooms():
    rooms = Room.query.order_by(Room.order).all()
    return jsonify([{
        'id': room.id,
        'name': room.name,
        'order': room.order
    } for room in rooms])

@app.route("/api/ha/entities")
def get_ha_entities():
    try:
        config = Configuration.query.first()
        if not config:
            return jsonify({'error': 'Home Assistant not configured'}), 400
        
        global ha_client
        if not ha_client or not ha_client.connection:
            ha_client = HomeAssistantClient(
                ws_url=config.ws_url,
                access_token=config.access_token,
                is_nabu_casa=config.is_nabu_casa
            )
        
        async def get_entities_async():
            try:
                await ha_client.connect()
                return await ha_client.get_entities()
            finally:
                await ha_client.disconnect()  # Ensure we disconnect properly
        
        entities = asyncio.run(get_entities_async())  # Use asyncio.run instead
        return jsonify(entities)
        
    except Exception as e:
        logger.error(f"Error fetching entities: {str(e)}")
        return jsonify({'error': str(e)}), 500

@app.route("/api/setup/entities", methods=['POST'])
def setup_entities():
    data = request.json
    complete_setup = request.args.get('complete_setup', 'false').lower() == 'true'
    
    try:
        # Clear existing entities and relationships
        Entity.query.delete()
        db.session.execute(db.text('DELETE FROM entity_rooms'))
        
        # Add new entities and their room relationships
        for entity_data in data['entities']:
            entity = Entity(
                entity_id=entity_data['entity_id'],
                name=entity_data['name'],
                domain=entity_data['domain']
            )
            db.session.add(entity)
            db.session.flush()  # Ensure entity has an ID
            
            # Add entity to specified rooms with order
            for room_data in entity_data['rooms']:
                room = Room.query.get(room_data['id'])
                if room:
                    # Add entity to room with order
                    db.session.execute(
                        entity_rooms.insert().values(
                            entity_id=entity.id,
                            room_id=room.id,
                            order=room_data['order']
                        )
                    )
        
        # Update configuration status if completing setup
        if complete_setup:
            config = Configuration.query.first()
            if config:
                config.is_configured = True
        
        db.session.commit()
        return jsonify({'success': True})
            
    except Exception as e:
        db.session.rollback()
        logger.error(f"Error in setup_entities: {str(e)}")
        return jsonify({'error': str(e)}), 500

@app.route("/api/setup/test-ha", methods=['POST'])
def test_ha_connection():
    try:
        data = request.json
        ha_url = data['ha_url'].strip()
        
        # Ensure URL has protocol
        if not ha_url.startswith(('http://', 'https://')):
            ha_url = 'https://' + ha_url  # Try HTTPS first
            
        # Create WebSocket URL
        parsed_url = urlparse(ha_url)
        
        # Check if it's a Nabu Casa URL
        is_nabu_casa = '.nabu.casa' in parsed_url.hostname if parsed_url.hostname else False
        
        if is_nabu_casa:
            # For Nabu Casa, use secure WebSocket and keep the full hostname
            ws_url = f"wss://{parsed_url.hostname}"
        else:
            # For local connections, try secure WebSocket first
            ws_protocol = 'wss' if parsed_url.scheme == 'https' else 'ws'
            if parsed_url.port:
                ws_url = f"{ws_protocol}://{parsed_url.hostname}:{parsed_url.port}"
            else:
                ws_url = f"{ws_protocol}://{parsed_url.hostname}"
        
        logger.debug(f"Attempting to connect to Home Assistant at: {ws_url}")
        
        test_client = HomeAssistantClient(
            ws_url=ws_url,
            access_token=data['access_token'].strip(),
            is_nabu_casa=is_nabu_casa
        )
        
        # Test the connection
        success, error_message = test_client.test_connection()
        
        if success:
            # Store the successful connection details in the session
            session['ha_url'] = ha_url
            session['ha_token'] = data['access_token']
            return jsonify({'success': True})
        else:
            return jsonify({
                'success': False, 
                'error': error_message or 'Could not establish connection to Home Assistant'
            })
            
    except Exception as e:
        error_message = str(e)
        if "No route to host" in error_message:
            error_message = "Could not reach Home Assistant. Please verify the URL and ensure Home Assistant is running and accessible."
        elif "Invalid access token" in error_message:
            error_message = "Invalid access token. Please check your long-lived access token."
        
        return jsonify({
            'success': False, 
            'error': error_message
        }), 400

@app.route("/api/weather/forecast")
def get_weather_forecast():
    try:
        api_key = os.getenv('WEATHER_API_KEY')
        location = os.getenv('LOCATION', 'London')
        
        if not api_key:
            return jsonify({'error': 'Weather API key not configured. Please set WEATHER_API_KEY in your environment variables.'}), 500
        
        # Add aqi=yes to get air quality data
        url = f"http://api.weatherapi.com/v1/forecast.json?key={api_key}&q={location}&days=1&aqi=yes"
        response = requests.get(url)
        response.raise_for_status()
        
        forecast_data = response.json()
        return jsonify(forecast_data)
    except requests.exceptions.HTTPError as e:
        if e.response.status_code == 403:
            return jsonify({'error': 'Invalid or missing API key. Please check your WEATHER_API_KEY environment variable.'}), 403
        return jsonify({'error': str(e)}), e.response.status_code
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route("/api/rooms/<int:room_id>/devices")
def get_room_devices(room_id):
    try:
        room = Room.query.get_or_404(room_id)
        
        # Get entities with their order from the junction table
        entities_with_order = db.session.query(
            Entity, 
            entity_rooms.c.order
        ).join(
            entity_rooms
        ).filter(
            entity_rooms.c.room_id == room_id,
            # Exclude Spotify entities if they exist
            ~Entity.domain.in_(['spotify'])  
        ).order_by(
            entity_rooms.c.order
        ).all()
        
        # Format devices for frontend
        devices = []
        for entity, order in entities_with_order:
            device = {
                'id': entity.entity_id,
                'name': entity.name,
                'type': entity.domain,
                'order': order or 0
            }
            devices.append(device)
        
        return jsonify(devices)
        
    except Exception as e:
        logger.error(f"Error getting room devices: {str(e)}")
        return jsonify({'error': str(e)}), 500

@app.route("/api/entities/tracked")
def get_tracked_entities():
    try:
        # Get all entities from database
        entities = Entity.query.all()
        
        # Format response with rooms
        tracked_entities = [{
            'entity_id': entity.entity_id,
            'name': entity.name,
            'domain': entity.domain,
            'rooms': [{'id': room.id, 'name': room.name} for room in entity.rooms]
        } for entity in entities]
        
        # Get HA connection details for WebSocket
        config = Configuration.query.first()
        if not config:
            return jsonify({'error': 'Home Assistant not configured'}), 400
            
        return jsonify({
            'entities': tracked_entities,
            'ha_config': {
                'ws_url': config.ws_url,
                'access_token': config.access_token,
                'is_nabu_casa': config.is_nabu_casa
            }
        })
        
    except Exception as e:
        logger.error(f"Error getting tracked entities: {str(e)}")
        return jsonify({'error': str(e)}), 500

@app.route("/settings")
def settings():
    client_id = os.getenv('SPOTIPY_CLIENT_ID')
    client_secret = os.getenv('SPOTIPY_CLIENT_SECRET')
    redirect_uri = os.getenv('SPOTIPY_REDIRECT_URI')

    if request.args.get("spotify_client_id") and request.args.get("spotify_client_secret"):
        client_id = request.args.get("spotify_client_id")
        client_secret = request.args.get("spotify_client_secret")
        
        # Read existing .env file
        env_path = '.env'
        env_lines = []
        if os.path.exists(env_path):
            with open(env_path, 'r') as f:
                env_lines = f.readlines()
        
        if not redirect_uri:
            # Update or add Spotify credentials
            spotify_vars = {
                'SPOTIPY_CLIENT_ID': client_id,
                'SPOTIPY_CLIENT_SECRET': client_secret,
                'SPOTIPY_REDIRECT_URI': 'https://dazzling-cuchufli-31be08.netlify.app'
            }
        else:
            spotify_vars = {
                'SPOTIPY_CLIENT_ID': client_id,
                'SPOTIPY_CLIENT_SECRET': client_secret,
                'SPOTIPY_REDIRECT_URI': redirect_uri
            }

        # Process existing lines
        updated_lines = []
        existing_vars = set()
        
        for line in env_lines:
            line = line.strip()
            if not line or line.startswith('#'):
                updated_lines.append(line)
                continue
                
            key = line.split('=')[0]
            if key in spotify_vars:
                updated_lines.append(f'{key}={spotify_vars[key]}')
                existing_vars.add(key)
            else:
                updated_lines.append(line)

        # Add any missing variables
        for key, value in spotify_vars.items():
            if key not in existing_vars:
                updated_lines.append(f'{key}={value}')

        # Write back to .env file
        with open(env_path, 'w') as f:
            f.write('\n'.join(updated_lines) + '\n')

        # Reload environment variables
        load_dotenv(override=True)
        
        return redirect('/settings#spotify')
    
    # Step 1: Check if credentials exist
    if not client_id or not client_secret:
        return render_template('settings.html', 
                             client_id=None,
                             client_secret=None,
                             auth_url=None,
                             spotify_connected=False)
    
    try:
        # Initialize OAuth with existing credentials
        cache_handler = spotipy.CacheFileHandler()

        if not redirect_uri:
            redirect_uri = 'https://dazzling-cuchufli-31be08.netlify.app'
        
        auth_manager = spotipy.oauth2.SpotifyOAuth(
            client_id=client_id,
            client_secret=client_secret,
            redirect_uri=redirect_uri,
            scope='user-read-playback-state user-modify-playback-state playlist-read-private user-top-read user-read-currently-playing streaming user-follow-read user-read-playback-position user-read-recently-played user-library-read',
            show_dialog=True,
            cache_handler=cache_handler
        )
        
        # Step 2: Handle the OAuth callback
        if request.args.get("code"):
            auth_manager.get_access_token(request.args.get("code"))
            return redirect('/settings#spotify')
        
        # Step 3: Check if we have valid tokens
        if auth_manager.validate_token(cache_handler.get_cached_token()):
            # We're fully authenticated
            global spotify_client
            spotify_client = spotipy.Spotify(auth_manager=auth_manager)
            auth_url = auth_manager.get_authorize_url()
            return render_template('settings.html',
                                 client_id=client_id,
                                 client_secret=client_secret,
                                 auth_url=auth_url,
                                 spotify_connected=True)
        else:
            # We need to authenticate
            auth_url = auth_manager.get_authorize_url()
            return render_template('settings.html',
                                 client_id=client_id,
                                 client_secret=client_secret,
                                 auth_url=auth_url,
                                 spotify_connected=False)
                                 
    except Exception as e:
        # If anything fails, show the connect button
        logger.error(f"Error in Spotify authentication: {str(e)}")
        return render_template('settings.html',
                             client_id=client_id,
                             client_secret=client_secret,
                             auth_url=None,
                             spotify_connected=False)

@app.route("/api/settings/ha", methods=['GET'])
def get_ha_settings():
    config = Configuration.query.first()
    if not config:
        return jsonify({'error': 'No configuration found'}), 404
    
    return jsonify({
        'ha_url': config.ha_url,  # Return the regular URL
        'access_token': config.access_token
    })

@app.route("/api/settings/ha", methods=['POST'])
def update_ha_settings():
    try:
        data = request.json
        ha_url = data['ha_url'].strip()
        
        # Ensure URL has protocol
        if not ha_url.startswith(('http://', 'https://')):
            ha_url = 'https://' + ha_url
            
        # Create WebSocket URL
        parsed_url = urlparse(ha_url)
        is_nabu_casa = '.nabu.casa' in parsed_url.hostname if parsed_url.hostname else False
        
        if is_nabu_casa:
            ws_url = f"wss://{parsed_url.hostname}"
        else:
            ws_protocol = 'wss' if parsed_url.scheme == 'https' else 'ws'
            if parsed_url.port:
                ws_url = f"{ws_protocol}://{parsed_url.hostname}:{parsed_url.port}"
            else:
                ws_url = f"{ws_protocol}://{parsed_url.hostname}"
        
        # Test the connection first
        test_client = HomeAssistantClient(
            ws_url=ws_url,
            access_token=data['access_token'].strip(),
            is_nabu_casa=is_nabu_casa
        )
        
        success, error_message = test_client.test_connection()
        
        if not success:
            return jsonify({
                'success': False,
                'error': error_message or 'Could not establish connection to Home Assistant'
            }), 400
            
        # If connection test successful, update the configuration
        config = Configuration.query.first()
        if not config:
            return jsonify({'error': 'No configuration found'}), 404
        
        # Store the previous configuration state
        is_configured = config.is_configured
        
        # Delete existing configuration
        Configuration.query.delete()
        db.session.commit()
        
        # Create new configuration with previous is_configured state
        new_config = Configuration(
            ha_url=ha_url,
            ws_url=ws_url,
            access_token=data['access_token'].strip(),
            is_nabu_casa=is_nabu_casa,
            is_configured=is_configured  # Preserve the configured state
        )
        db.session.add(new_config)
        db.session.commit()
        
        return jsonify({'success': True})
        
    except Exception as e:
        db.session.rollback()
        error_message = str(e)
        if "No route to host" in error_message:
            error_message = "Could not reach Home Assistant. Please verify the URL and ensure Home Assistant is running and accessible."
        elif "Invalid access token" in error_message:
            error_message = "Invalid access token. Please check your long-lived access token."
            
        return jsonify({'error': error_message}), 500

@app.route("/api/rooms/<int:room_id>/devices/<path:entity_id>", methods=['DELETE'])
def remove_device_from_room(room_id, entity_id):
    try:
        room = Room.query.get_or_404(room_id)
        entity = Entity.query.filter_by(entity_id=entity_id).first()
        
        if not entity:
            return jsonify({'error': 'Entity not found'}), 404
            
        if room in entity.rooms:
            entity.rooms.remove(room)
            db.session.commit()
            
        return jsonify({'success': True})
        
    except Exception as e:
        db.session.rollback()
        logger.error(f"Error removing device from room: {str(e)}")
        return jsonify({'error': str(e)}), 500

@app.route("/api/rooms/<int:room_id>/devices", methods=['POST'])
def add_device_to_room(room_id):
    try:
        data = request.json
        room = Room.query.get_or_404(room_id)
        
        # First find or create the entity
        entity = Entity.query.filter_by(entity_id=data['entity_id']).first()
        if not entity:
            entity = Entity(
                entity_id=data['entity_id'],
                name=data['name'],
                domain=data['domain']
            )
            db.session.add(entity)
            db.session.flush()  # This ensures the entity gets an ID
        
        # Make sure we have a valid entity ID
        if not entity.id:
            raise ValueError("Failed to get entity ID")
            
        # Check if relationship already exists
        existing = db.session.execute(
            entity_rooms.select().where(
                entity_rooms.c.entity_id == entity.id,
                entity_rooms.c.room_id == room.id
            )
        ).first()
        
        if not existing:
            # Get the next order number for this room
            max_order = db.session.execute(
                db.select(db.func.max(entity_rooms.c.order))
                .where(entity_rooms.c.room_id == room.id)
            ).scalar() or -1
            
            # Add entity to room with card type
            db.session.execute(
                entity_rooms.insert().values(
                    entity_id=entity.id,
                    room_id=room.id,
                    order=max_order + 1
                )
            )
        
        db.session.commit()
        return jsonify({'success': True})
        
    except Exception as e:
        db.session.rollback()
        logger.error(f"Error adding device to room: {str(e)}")
        return jsonify({'error': str(e)}), 500

@app.route("/api/rooms/<int:room_id>/entities/reorder", methods=['POST'])
def reorder_room_entities(room_id):
    try:
        data = request.json
        entity_ids = data.get('entityIds', [])
        
        # Get all entities for this room
        room = Room.query.get_or_404(room_id)
        
        # Update order for each entity in the room
        for index, entity_id in enumerate(entity_ids):
            entity = Entity.query.filter_by(entity_id=entity_id).first()
            if entity:
                # Check if relationship exists
                stmt = db.select(entity_rooms).where(
                    entity_rooms.c.room_id == room_id,
                    entity_rooms.c.entity_id == entity.id
                )
                exists = db.session.execute(stmt).first() is not None
                
                if exists:
                    # Update existing relationship
                    db.session.execute(
                        db.update(entity_rooms).where(
                            entity_rooms.c.room_id == room_id,
                            entity_rooms.c.entity_id == entity.id
                        ).values(order=index)
                    )
                else:
                    # Create new relationship with order
                    db.session.execute(
                        db.insert(entity_rooms).values(
                            room_id=room_id,
                            entity_id=entity.id,
                            order=index
                        )
                    )
        
        db.session.commit()
        return jsonify({'success': True})
        
    except Exception as e:
        db.session.rollback()
        return jsonify({'error': str(e)}), 500

@app.route("/api/entities/remove", methods=['POST'])
def remove_missing_entities():
    try:
        data = request.json
        missing_entities = data.get('entities', [])
        
        if not missing_entities:
            return jsonify({'success': True, 'message': 'No entities to remove'})
        
        # Remove the entities from the database
        for entity_id in missing_entities:
            entity = Entity.query.filter_by(entity_id=entity_id).first()
            if entity:
                # Remove all room associations first
                entity.rooms = []
                db.session.delete(entity)
        
        db.session.commit()
        
        return jsonify({
            'success': True,
            'message': f'Removed {len(missing_entities)} missing entities',
            'removed_entities': missing_entities
        })
        
    except Exception as e:
        db.session.rollback()
        logger.error(f"Error removing missing entities: {str(e)}")
        return jsonify({'error': str(e)}), 500

@app.route("/api/cards/available")
def get_available_cards():
    try:
        cards = []
        components_dir = os.path.join('static', 'components')
        
        # Iterate through component directories
        for card_dir in os.listdir(components_dir):
            settings_path = os.path.join(components_dir, card_dir, 'card_settings.json')
            if os.path.exists(settings_path):
                with open(settings_path, 'r') as f:
                    settings = json.load(f)
                    cards.append({
                        'id': card_dir,
                        'name': settings.get('name', card_dir),
                        'entity_type': settings.get('entity_type', 'unknown'),
                        'description': settings.get('description', '')
                    })
        
        return jsonify(cards)
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route("/api/media_proxy/<path:entity_picture>")
def media_proxy(entity_picture):
    try:
        config = Configuration.query.first()
        if not config:
            return jsonify({'error': 'Home Assistant not configured'}), 400

        # Construct the full URL to the media
        ha_url = config.ha_url.rstrip('/')
        full_url = f"{ha_url}/{entity_picture}"

        # Make the request to Home Assistant with the access token
        headers = {
            'Authorization': f'Bearer {config.access_token}',
            'Accept': 'image/*'
        }
        
        response = requests.get(full_url, headers=headers)
        response.raise_for_status()

        # Forward the content type header
        return Response(
            response.content,
            content_type=response.headers['content-type'],
            status=200
        )

    except Exception as e:
        logger.error(f"Error proxying media: {str(e)}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/settings/spotify', methods=['POST'])
def spotify_settings_api():
    try:
        data = request.json
        client_id = data.get('client_id')
        client_secret = data.get('client_secret')
        redirect_uri = os.getenv('SPOTIPY_REDIRECT_URI')
        
        if not client_id or not client_secret:
            return jsonify({'error': 'Missing credentials'}), 400

        # Save credentials to .env
        env_path = '.env'
        env_lines = []
        if os.path.exists(env_path):
            with open(env_path, 'r') as f:
                env_lines = f.readlines()

        if not redirect_uri:
            redirect_uri = 'https://dazzling-cuchufli-31be08.netlify.app'

        # Update or add Spotify credentials
        spotify_vars = {
            'SPOTIPY_CLIENT_ID': client_id,
            'SPOTIPY_CLIENT_SECRET': client_secret,
            'SPOTIPY_REDIRECT_URI': redirect_uri
        }

        # Process existing lines
        updated_lines = []
        existing_vars = set()
        
        for line in env_lines:
            line = line.strip()
            if not line or line.startswith('#'):
                updated_lines.append(line)
                continue
                
            key = line.split('=')[0]
            if key in spotify_vars:
                updated_lines.append(f'{key}={spotify_vars[key]}')
                existing_vars.add(key)
            else:
                updated_lines.append(line)

        # Add any missing variables
        for key, value in spotify_vars.items():
            if key not in existing_vars:
                updated_lines.append(f'{key}={value}')

        # Write back to .env file
        with open(env_path, 'w') as f:
            f.write('\n'.join(updated_lines) + '\n')
        
        # Reload environment variables
        load_dotenv(override=True)

        # Initialize OAuth to get auth URL
        auth_manager = SpotifyOAuth(
            client_id=client_id,
            client_secret=client_secret,
            redirect_uri=redirect_uri,
            scope='user-read-playback-state user-modify-playback-state playlist-read-private user-top-read user-read-currently-playing streaming user-follow-read user-read-playback-position user-read-recently-played user-library-read',
            show_dialog=True
        )
        
        auth_url = auth_manager.get_authorize_url()
        return jsonify({'success': True, 'auth_url': auth_url})
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/spotify/status')
def spotify_status():
    client_id = os.getenv('SPOTIPY_CLIENT_ID')
    client_secret = os.getenv('SPOTIPY_CLIENT_SECRET')
    
    if not client_id or not client_secret:
        return jsonify({'connected': False})
        
    try:
        auth_manager = SpotifyClientCredentials(
            client_id=client_id,
            client_secret=client_secret
        )
        sp = spotipy.Spotify(auth_manager=auth_manager)
        sp.search(q='test', limit=1)  # Test the connection
        return jsonify({'connected': True})
    except:
        return jsonify({'connected': False})

@app.route('/api/spotify/current_playback')
def get_current_playback():
    try:
        sp = get_spotify_client()
        playback = sp.current_playback()
        return jsonify(playback if playback else None)
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/spotify/playback/toggle', methods=['POST'])
def toggle_playback():
    try:
        sp = get_spotify_client()
        current_playback = sp.current_playback()
        
        if current_playback and current_playback['is_playing']:
            sp.pause_playback()
        else:
            sp.start_playback()
        
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/spotify/playback/next', methods=['POST'])
def next_track():
    try:
        sp = get_spotify_client()
        sp.next_track()
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/spotify/playback/previous', methods=['POST'])
def previous_track():
    try:
        sp = get_spotify_client()
        sp.previous_track()
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/spotify/devices')
def get_devices():
    try:
        sp = get_spotify_client()
        devices = sp.devices()
        return jsonify(devices)
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/spotify/playback/device', methods=['POST'])
def change_device():
    try:
        sp = get_spotify_client()
        device_id = request.json.get('device_id')
        
        if not device_id:
            return jsonify({'error': 'No device ID provided'}), 400
            
        # Transfer playback to selected device
        sp.transfer_playback(device_id=device_id)
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

def setup_spotify():
    """Interactive CLI setup for Spotify OAuth"""
    print("\n=== Spotify Setup ===")
    setup_spotify = input("Would you like to set up Spotify integration? (y/n): ").lower().strip()
    
    if setup_spotify != 'y':
        return False
        
    # Get credentials from user
    client_id = input("Enter your Spotify Client ID: ").strip()
    client_secret = input("Enter your Spotify Client Secret: ").strip()
    redirect_uri = os.getenv('SPOTIPY_REDIRECT_URI')
    
    if not redirect_uri:
        redirect_uri = 'https://dazzling-cuchufli-31be08.netlify.app'
    
    # Save credentials to .env
    env_values = {}
    if os.path.exists('.env'):
        with open('.env', 'r') as f:
            for line in f:
                if '=' in line:
                    key, value = line.strip().split('=', 1)
                    env_values[key] = value
    
    env_values.update({
        'SPOTIPY_CLIENT_ID': client_id,
        'SPOTIPY_CLIENT_SECRET': client_secret,
        'SPOTIPY_REDIRECT_URI': redirect_uri
    })
    
    # Write updated values to .env
    with open('.env', 'w') as f:
        for key, value in env_values.items():
            f.write(f'{key}={value}\n')
    
    # Reload environment variables
    load_dotenv(override=True)
    
    print("\nInitiating Spotify authentication...")
    try:
        # Initialize Spotify with OAuth
        spotify = spotipy.Spotify(auth_manager=SpotifyOAuth(
            client_id=client_id,
            client_secret=client_secret,
            redirect_uri=redirect_uri,
            scope='user-read-playback-state user-modify-playback-state playlist-read-private user-top-read user-read-currently-playing streaming user-follow-read user-read-playback-position user-read-recently-played user-library-read',
            open_browser=False
        ))
        
        # Test the connection
        user_info = spotify.me()
        print(f"\nSuccessfully connected to Spotify as: {user_info['display_name']}")
        return True
        
    except Exception as e:
        print(f"\nError connecting to Spotify: {str(e)}")
        return False

def is_spotify_configured():
    """Check if Spotify is configured and working"""
    client_id = os.getenv('SPOTIPY_CLIENT_ID')
    client_secret = os.getenv('SPOTIPY_CLIENT_SECRET')
    
    if not client_id or not client_secret:
        return False
        
    try:
        # Test the connection
        spotify = spotipy.Spotify(auth_manager=SpotifyOAuth(
            client_id=client_id,
            client_secret=client_secret,
            redirect_uri='http://localhost:8888',
            scope='user-read-playback-state user-modify-playback-state playlist-read-private user-top-read user-read-currently-playing streaming user-follow-read user-read-playback-position user-read-recently-played user-library-read',
            open_browser=False
        ))
        spotify.me()  # Test the connection
        return True
    except:
        return False

@app.route('/api/spotify/library')
def get_spotify_library():
    try:
        sp = get_spotify_client()
        
        # Get user's playlists
        playlists = sp.current_user_playlists(limit=20)
        
        # Get user's top artists and tracks
        top_artists = sp.current_user_top_artists(limit=20, time_range='medium_term')
        top_tracks = sp.current_user_top_tracks(limit=20, time_range='medium_term')
        
        return jsonify({
            'playlists': playlists['items'],
            'top_artists': top_artists['items'],
            'top_tracks': top_tracks['items']
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/media_players')
def get_media_players():
    try:
        # Query for all media_player entities
        media_players = Entity.query.filter_by(domain='media_player').all()
        
        # Format the response
        players = [{
            'entity_id': player.entity_id,
            'name': player.name,
            'domain': player.domain,
            'rooms': [{'id': room.id, 'name': room.name} for room in player.rooms]
        } for player in media_players]
        
        return jsonify(players)
    except Exception as e:
        logger.error(f"Error getting media players: {str(e)}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/spotify/search')
def spotify_search():
    try:
        query = request.args.get('q')
        if not query:
            return jsonify({'error': 'No search query provided'}), 400

        sp = get_spotify_client()
        
        # Add albums to the search types
        results = sp.search(
            q=query,
            limit=8,  # Limit results per category
            type='track,artist,playlist,album'  # Added album to search types
        )
        
        return jsonify({
            'tracks': results['tracks']['items'],
            'artists': results['artists']['items'],
            'playlists': results['playlists']['items'],
            'albums': results['albums']['items']  # Add albums to response
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/spotify/playlist/<playlist_id>')
def get_playlist_details(playlist_id):
    try:
        sp = get_spotify_client()
        playlist = sp.playlist(playlist_id)
        return jsonify(playlist)
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/spotify/artist/<artist_id>')
def get_artist_details(artist_id):
    try:
        sp = get_spotify_client()
        # Get artist details, top tracks, and albums
        artist = sp.artist(artist_id)
        top_tracks = sp.artist_top_tracks(artist_id)
        albums = sp.artist_albums(artist_id, album_type='album,single', limit=20)
        
        return jsonify({
            'artist': artist,
            'top_tracks': top_tracks['tracks'],
            'albums': albums['items']
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/spotify/album/<album_id>')
def get_album_details(album_id):
    try:
        sp = get_spotify_client()
        album = sp.album(album_id)
        return jsonify(album)
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route("/api/release/viewed", methods=['POST'])
def mark_release_viewed():
    try:
        release_file = 'release.json'
        if os.path.exists(release_file):
            with open(release_file, 'r') as f:
                release_data = json.load(f)
            
            release_data['release_viewed'] = True
            
            with open(release_file, 'w') as f:
                json.dump(release_data, f, indent=4)
                
        return jsonify({'success': True})
    except Exception as e:
        logger.error(f"Error marking release as viewed: {str(e)}")
        return jsonify({'error': str(e)}), 500

if __name__ == "__main__":
    # Check each required environment variable individually
    env_vars = {
        'WEATHER_API_KEY': {
            'prompt': "\nYou'll need a Weather API key from weatherapi.com\nEnter your Weather API key: ",
            'validate': lambda key: requests.get(f"http://api.weatherapi.com/v1/current.json?key={key}&q=London").status_code == 200
        },
        'LOCATION': {
            'prompt': "\nEnter your location (city name or coordinates): ",
            'validate': lambda x: bool(x.strip())
        }
    }

    # Read existing .env file if it exists
    env_values = {}
    if os.path.exists('.env'):
        with open('.env', 'r') as f:
            for line in f:
                if '=' in line:
                    key, value = line.strip().split('=', 1)
                    env_values[key] = value

    env_updated = False
    print("\n=== Project Friday Environment Setup ===")

    # Check each variable and prompt if missing or invalid
    for var_name, config in env_vars.items():
        current_value = os.getenv(var_name) or env_values.get(var_name)
        
        # Skip if value exists and is valid
        if current_value and config['validate'](current_value):
            env_values[var_name] = current_value
            continue

        # Prompt for missing or invalid value
        while True:
            value = input(config['prompt']).strip()
            try:
                if config['validate'](value):
                    env_values[var_name] = value
                    env_updated = True
                    break
                print(f"Invalid {var_name}. Please try again.")
            except:
                print(f"Error validating {var_name}. Please try again.")

    # Update .env file if changes were made
    if env_updated:
        with open('.env', 'w') as f:
            for key, value in env_values.items():
                f.write(f'{key}={value}\n')
        print("\nEnvironment configuration saved successfully!")
        # Reload environment variables
        load_dotenv(override=True)
    
    
    # Only setup Spotify if not already configured
    #if not is_spotify_configured():
    #    spotify_configured = setup_spotify()
    
    # Initialize Spotify client at startup
    #initialize_spotify_client()
    
    with app.app_context():
        db.create_all()
    app.run(host='0.0.0.0', port=8165)
