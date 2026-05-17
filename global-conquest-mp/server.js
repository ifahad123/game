/**
 * GLOBAL CONQUEST — Multiplayer WebSocket Server
 * 
 * Deploy on Railway / Render / Fly.io (see README.md)
 * 
 * Architecture:
 *   - Players create or join "rooms" (one game session per room)
 *   - The HOST runs the authoritative game simulation and broadcasts state
 *   - Other players send only INPUT (click territory, choose action)
 *   - Server validates inputs and relays them to the host
 *   - Host processes, updates state, and broadcasts to all
 * 
 * Room lifecycle:
 *   LOBBY → STARTING (countdown) → PLAYING → FINISHED
 */

const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 8080;
const wss = new WebSocketServer({ port: PORT });

// rooms: Map<roomCode, Room>
const rooms = new Map();
// socketToRoom: Map<ws, roomCode>  — for fast cleanup on disconnect
const socketToRoom = new Map();

// ── Helpers ─────────────────────────────────────────────────────────────────

function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code;
    do {
        code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    } while (rooms.has(code));
    return code;
}

function send(ws, msg) {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
    }
}

function broadcast(room, msg, excludeWs = null) {
    for (const player of room.players.values()) {
        if (player.ws !== excludeWs) {
            send(player.ws, msg);
        }
    }
}

function broadcastAll(room, msg) {
    broadcast(room, msg, null);
}

function roomSummary(room) {
    return {
        code: room.code,
        status: room.status,
        playerCount: room.players.size,
        maxPlayers: room.maxPlayers,
        players: Array.from(room.players.values()).map(p => ({
            id: p.id,
            name: p.name,
            colorIndex: p.colorIndex,
            isHost: p.isHost,
            connected: p.ws.readyState === WebSocket.OPEN
        }))
    };
}

// Map size config based on player count
function mapConfig(playerCount) {
    // cols x rows — scales with players
    if (playerCount === 2) return { cols: 3, rows: 4 }; // 12 territories
    if (playerCount === 3) return { cols: 3, rows: 5 }; // 15 territories
    return { cols: 4, rows: 5 };                         // 20 territories (4 players)
}

// ── Room management ──────────────────────────────────────────────────────────

function createRoom(hostWs, hostName) {
    const code = generateRoomCode();
    const playerId = 'p1';

    const host = {
        ws: hostWs,
        id: playerId,
        name: hostName || 'Player 1',
        colorIndex: 0,   // 0=blue,1=red,2=yellow,3=green
        isHost: true,
        connected: true
    };

    const room = {
        code,
        status: 'lobby',   // lobby | starting | playing | finished
        maxPlayers: 4,
        players: new Map([[playerId, host]]),
        nextPlayerIndex: 1,
        countdownTimer: null,
        emptySlotTimer: null,
    };

    rooms.set(code, room);
    socketToRoom.set(hostWs, code);

    send(hostWs, {
        type: 'room_created',
        roomCode: code,
        playerId,
        colorIndex: 0,
        room: roomSummary(room)
    });

    log(`Room ${code} created by ${hostName}`);
    return room;
}

function joinRoom(ws, code, playerName) {
    const room = rooms.get(code.toUpperCase());

    if (!room) {
        send(ws, { type: 'error', message: 'Room not found. Check the code and try again.' });
        return;
    }
    if (room.status !== 'lobby') {
        send(ws, { type: 'error', message: 'This game has already started.' });
        return;
    }
    if (room.players.size >= room.maxPlayers) {
        send(ws, { type: 'error', message: 'Room is full.' });
        return;
    }

    // Assign next available player slot
    const colorIndex = room.nextPlayerIndex;
    const playerId = `p${room.nextPlayerIndex + 1}`;
    room.nextPlayerIndex++;

    const player = {
        ws,
        id: playerId,
        name: playerName || `Player ${room.players.size + 1}`,
        colorIndex,
        isHost: false,
        connected: true
    };

    room.players.set(playerId, player);
    socketToRoom.set(ws, code.toUpperCase());

    // Tell the joiner their identity
    send(ws, {
        type: 'room_joined',
        roomCode: room.code,
        playerId,
        colorIndex,
        room: roomSummary(room)
    });

    // Tell everyone else someone joined
    broadcast(room, { type: 'player_joined', room: roomSummary(room) }, ws);

    log(`${playerName} joined room ${room.code} as ${playerId}`);
}

function startCountdown(room) {
    if (room.status !== 'lobby') return;
    if (room.players.size < 2) {
        broadcastAll(room, { type: 'error', message: 'Need at least 2 players to start.' });
        return;
    }

    room.status = 'starting';
    let count = 5;

    broadcastAll(room, { type: 'countdown', count, room: roomSummary(room) });

    room.countdownTimer = setInterval(() => {
        count--;
        if (count > 0) {
            broadcastAll(room, { type: 'countdown', count });
        } else {
            clearInterval(room.countdownTimer);
            startGame(room);
        }
    }, 1000);
}

function startGame(room) {
    room.status = 'playing';
    const cfg = mapConfig(room.players.size);

    // Assign start positions based on player count
    const startPositions = [
        { row: 0, col: 0 },
        { row: cfg.rows - 1, col: cfg.cols - 1 },
        { row: 0, col: cfg.cols - 1 },
        { row: cfg.rows - 1, col: 0 },
    ];

    const playerList = Array.from(room.players.values()).map((p, i) => ({
        id: p.id,
        name: p.name,
        colorIndex: p.colorIndex,
        startPos: startPositions[i]
    }));

    broadcastAll(room, {
        type: 'game_start',
        mapConfig: cfg,
        players: playerList,
        hostId: getHost(room).id
    });

    log(`Game started in room ${room.code} with ${room.players.size} players, map ${cfg.cols}x${cfg.rows}`);
}

function getHost(room) {
    for (const p of room.players.values()) {
        if (p.isHost) return p;
    }
    return null;
}

function handleDisconnect(ws) {
    const code = socketToRoom.get(ws);
    if (!code) return;

    const room = rooms.get(code);
    if (!room) return;

    socketToRoom.delete(ws);

    // Find which player disconnected
    let disconnectedPlayer = null;
    for (const [id, player] of room.players.entries()) {
        if (player.ws === ws) {
            disconnectedPlayer = player;
            player.connected = false;
            break;
        }
    }

    if (!disconnectedPlayer) return;
    log(`${disconnectedPlayer.name} disconnected from room ${code}`);

    if (room.status === 'lobby' || room.status === 'starting') {
        // Remove them entirely from lobby
        room.players.delete(disconnectedPlayer.id);
        if (room.countdownTimer) {
            clearInterval(room.countdownTimer);
            room.countdownTimer = null;
            room.status = 'lobby';
        }

        if (room.players.size === 0) {
            rooms.delete(code);
            log(`Room ${code} deleted (empty)`);
            return;
        }

        // If host left, promote next player
        if (disconnectedPlayer.isHost) {
            const next = room.players.values().next().value;
            next.isHost = true;
            log(`${next.name} is now host of room ${code}`);
        }

        broadcastAll(room, { type: 'player_left', room: roomSummary(room) });

    } else if (room.status === 'playing') {
        // Notify others — host will handle AI takeover in-client
        broadcastAll(room, {
            type: 'player_disconnected',
            playerId: disconnectedPlayer.id,
            room: roomSummary(room)
        });

        // If host disconnected, promote next connected player as host
        if (disconnectedPlayer.isHost) {
            for (const p of room.players.values()) {
                if (p.connected) {
                    p.isHost = true;
                    send(p.ws, { type: 'promoted_to_host' });
                    log(`${p.name} promoted to host in room ${code}`);
                    break;
                }
            }
        }

        // If nobody left connected, clean up
        const anyConnected = Array.from(room.players.values()).some(p => p.connected);
        if (!anyConnected) {
            rooms.delete(code);
            log(`Room ${code} deleted (all disconnected)`);
        }
    }
}

// ── Message router ───────────────────────────────────────────────────────────

function handleMessage(ws, raw) {
    let msg;
    try {
        msg = JSON.parse(raw);
    } catch {
        return;
    }

    const { type } = msg;

    switch (type) {

        // ── Lobby ──────────────────────────────────────────────────────────
        case 'create_room':
            createRoom(ws, msg.playerName);
            break;

        case 'join_room':
            joinRoom(ws, msg.roomCode, msg.playerName);
            break;

        case 'start_game': {
            const code = socketToRoom.get(ws);
            const room = rooms.get(code);
            if (!room) break;
            const player = getPlayerByWs(room, ws);
            if (!player || !player.isHost) {
                send(ws, { type: 'error', message: 'Only the host can start the game.' });
                break;
            }
            startCountdown(room);
            break;
        }

        case 'cancel_start': {
            const code = socketToRoom.get(ws);
            const room = rooms.get(code);
            if (!room) break;
            if (room.countdownTimer) {
                clearInterval(room.countdownTimer);
                room.countdownTimer = null;
            }
            room.status = 'lobby';
            broadcastAll(room, { type: 'countdown_cancelled', room: roomSummary(room) });
            break;
        }

        // ── In-game: host broadcasts authoritative state to all clients ────
        case 'game_state': {
            // Host → server → all other players
            const code = socketToRoom.get(ws);
            const room = rooms.get(code);
            if (!room || room.status !== 'playing') break;
            const player = getPlayerByWs(room, ws);
            if (!player || !player.isHost) break;
            broadcast(room, { type: 'game_state', state: msg.state }, ws);
            break;
        }

        // ── In-game: non-host player sends an action to the host ──────────
        case 'player_action': {
            const code = socketToRoom.get(ws);
            const room = rooms.get(code);
            if (!room || room.status !== 'playing') break;
            const player = getPlayerByWs(room, ws);
            if (!player) break;
            // Forward action to host
            const host = getHost(room);
            if (host && host.ws !== ws) {
                send(host.ws, {
                    type: 'player_action',
                    playerId: player.id,
                    action: msg.action
                });
            }
            break;
        }

        // ── In-game: game over notification ───────────────────────────────
        case 'game_over': {
            const code = socketToRoom.get(ws);
            const room = rooms.get(code);
            if (!room) break;
            room.status = 'finished';
            broadcast(room, { type: 'game_over', result: msg.result }, ws);
            break;
        }

        // ── Ping/pong keepalive ───────────────────────────────────────────
        case 'ping':
            send(ws, { type: 'pong' });
            break;

        default:
            break;
    }
}

function getPlayerByWs(room, ws) {
    for (const p of room.players.values()) {
        if (p.ws === ws) return p;
    }
    return null;
}

// ── Server events ────────────────────────────────────────────────────────────

wss.on('connection', (ws) => {
    ws.on('message', (data) => handleMessage(ws, data.toString()));
    ws.on('close', () => handleDisconnect(ws));
    ws.on('error', () => handleDisconnect(ws));
    // Keepalive ping every 25s to prevent proxy timeouts
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
});

const keepAlive = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (!ws.isAlive) { ws.terminate(); return; }
        ws.isAlive = false;
        ws.ping();
    });
}, 25000);

wss.on('close', () => clearInterval(keepAlive));

function log(msg) {
    console.log(`[${new Date().toISOString()}] ${msg}`);
}

log(`Global Conquest server listening on port ${PORT}`);
log(`Rooms active: ${rooms.size}`);
