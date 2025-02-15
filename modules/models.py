from flask_sqlalchemy import SQLAlchemy
from datetime import datetime

db = SQLAlchemy()

class Configuration(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    ha_url = db.Column(db.String(200), nullable=False)
    ws_url = db.Column(db.String(200), nullable=False)
    access_token = db.Column(db.String(200), nullable=False)
    is_nabu_casa = db.Column(db.Boolean, default=False)
    is_configured = db.Column(db.Boolean, default=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

class Room(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100), nullable=False)
    order = db.Column(db.Integer, default=0)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    entities = db.relationship('Entity', secondary='entity_rooms', back_populates='rooms')

# Junction table for many-to-many relationship between entities and rooms
entity_rooms = db.Table('entity_rooms',
    db.Column('entity_id', db.Integer, db.ForeignKey('entity.id'), primary_key=True),
    db.Column('room_id', db.Integer, db.ForeignKey('room.id'), primary_key=True),
    db.Column('order', db.Integer, default=0)  # Add order field here
)

class Entity(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    entity_id = db.Column(db.String(100), nullable=False)
    name = db.Column(db.String(100), nullable=False)
    domain = db.Column(db.String(50), nullable=False)
    rooms = db.relationship('Room', secondary=entity_rooms, back_populates='entities')
    created_at = db.Column(db.DateTime, default=datetime.utcnow)