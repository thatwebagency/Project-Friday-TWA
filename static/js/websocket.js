const socket = io();

socket.on('connect', () => {
    console.log('Connected to server');
});

function sendCommand(device_type, command, entity_id) {
    socket.emit('device_command', {
        device_type: device_type,
        command: command,
        entity_id: entity_id
    });
}
