from app import app, db

with app.app_context():
    db.drop_all()  # This ensures we start fresh
    db.create_all()
    print("Database tables created successfully!")
