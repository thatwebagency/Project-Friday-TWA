from flask_socketio import SocketIO, emit

class WebSocketServer:
    def __init__(self, flask_app=None):
        self.flask_app = flask_app
        self.socketio = None

    def start(self):
        if not self.flask_app:
            raise ValueError("Flask app not set")
        
        self.socketio = SocketIO(self.flask_app)
        
        @self.socketio.on('connect')
        def handle_connect():
            print('Client connected')

        @self.socketio.on('disconnect')
        def handle_disconnect():
            print('Client disconnected')
        
        self.socketio.run(self.flask_app, host='0.0.0.0', port=8165, debug=True)
