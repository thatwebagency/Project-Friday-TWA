from flask import Flask, render_template, redirect, url_for, request, jsonify, session
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

load_dotenv()  # This loads the .env file

app = Flask(__name__)
app.config.from_object('config.Config')
db.init_app(app)
migrate = Migrate(app, db)

ha_client = None  # Only used for setup/configuration now
logger = logging.getLogger(__name__)

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
        
    return render_template('dashboard.html', setup_required=False)

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
            entity_rooms.c.room_id == room_id
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
                'order': order or 0  # Use 0 as default if order is None
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
    return render_template('settings.html')

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

if __name__ == "__main__":
    # Check if .env file exists and has required variables
    if not os.path.exists('.env') or not all([
        os.getenv('WEATHER_API_KEY'),
        os.getenv('LOCATION')
    ]):
        print("\n=== Project Friday Environment Setup ===")
        print("You'll need a Weather API key from weatherapi.com")
        
        # Get Weather API key
        while True:
            weather_api_key = input("\nEnter your Weather API key: ").strip()
            
            # Validate the API key
            test_url = f"http://api.weatherapi.com/v1/current.json?key={weather_api_key}&q=London"
            try:
                response = requests.get(test_url)
                if response.status_code == 200:
                    break
                print("Invalid API key. Please try again.")
            except:
                print("Error validating API key. Please try again.")
        
        # Get location
        location = input("\nEnter your location (city name or coordinates): ").strip()
        
        # Create .env file
        with open('.env', 'w') as f:
            f.write(f'WEATHER_API_KEY={weather_api_key}\n')
            f.write(f'LOCATION={location}\n')
        
        print("\nEnvironment configuration saved successfully!")
        
        # Reload environment variables
        load_dotenv(override=True)
    
    with app.app_context():
        db.create_all()
    app.run(host='0.0.0.0', port=8165, debug=True)
