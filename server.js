const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    cors: {
        origin: [process.env.APP_URL || 'http://localhost:3000'],
        methods: ['GET', 'POST'],
        credentials: true
    }
});
const path = require('path');

app.use(express.static('public'));

const rooms = new Map();
const maxCards = 16; // 8 Paare für ein Memory-Spiel
const images = Array.from({ length: 45 }, (_, i) => `/images/bild${i + 1}.jpg`);

// Zufällige Auswahl von Bildern
function getRandomImages(count) {
    const shuffled = [...images].sort(() => 0.5 - Math.random());
    return shuffled.slice(0, count);
}

// Hilfsfunktion für Debug-Logging
function logRoom(roomId) {
    const room = rooms.get(roomId);
    console.log(`🛠 Room ${roomId} State:`, {
        players: room.players.map(p => ({ id: p.id, name: p.name, score: p.score })),
        currentTurn: room.currentTurn,
        locked: room.locked,
        started: room.gameStarted
    });
}

io.on('connection', (socket) => {
    console.log(`🔌 Neue Verbindung: ${socket.id}`);

    // Raum erstellen mit Passwort
    socket.on('createRoom', ({ playerName, password }) => {
        if (!playerName || !password) {
            socket.emit('joinError', 'Name und Passwort sind erforderlich.');
            return;
        }

        const roomId = Math.random().toString(36).substr(2, 9);
        rooms.set(roomId, {
            password,
            players: [{ id: socket.id, name: playerName, score: 0 }],
            cards: [],
            currentTurn: null,
            gameStarted: false,
            locked: false
        });

        socket.join(roomId);
        socket.emit('roomCreated', roomId);
        console.log(`✅ Raum ${roomId} erstellt von ${playerName} (${socket.id}) mit Passwort: ${password}`);
    });

    // Raum beitreten mit Passwort
    socket.on('joinRoom', ({ roomId, playerName, password }) => {
        const room = rooms.get(roomId);

        if (!room) {
            socket.emit('joinError', 'Raum nicht gefunden.');
            return;
        }

        if (room.password !== password) {
            socket.emit('joinError', 'Falsches Passwort.');
            return;
        }

        if (room.players.length >= 2) {
            socket.emit('joinError', 'Raum ist bereits voll.');
            return;
        }

        room.players.push({ id: socket.id, name: playerName, score: 0 });
        socket.join(roomId);
        io.to(roomId).emit('playerJoined', room.players);
        console.log(`🎮 ${playerName} (${socket.id}) ist Raum ${roomId} beigetreten.`);

        // Spiel starten, wenn 2 Spieler da sind
        if (room.players.length === 2) {
            const selectedImages = getRandomImages(maxCards / 2);
            const cardPairs = [...selectedImages, ...selectedImages];
            room.cards = cardPairs
                .sort(() => 0.5 - Math.random())
                .map((img, index) => ({
                    id: index,
                    image: img,
                    isFlipped: false,
                    isMatched: false
                }));
            room.gameStarted = true;
            room.currentTurn = room.players[0].id;

            io.to(roomId).emit('gameStart', {
                cards: room.cards,
                currentTurn: room.currentTurn,
                players: room.players
            });
            console.log(`🚀 Spiel gestartet in Raum ${roomId}. Spieler 1 beginnt.`);
            logRoom(roomId);
        }
    });

    // Karte umdrehen
    socket.on('flipCard', ({ roomId, cardId }) => {
        const room = rooms.get(roomId);

        if (!room) return socket.emit('flipError', 'Raum nicht gefunden.');
        if (!room.gameStarted) return socket.emit('flipError', 'Das Spiel ist nicht aktiv.');
        if (room.locked) return socket.emit('flipError', 'Bitte warte, die Kartenanimation läuft.');
        if (socket.id !== room.currentTurn) return socket.emit('flipError', 'Du bist nicht dran.');

        const card = room.cards[cardId];
        if (!card || card.isFlipped || card.isMatched) return;

        card.isFlipped = true;
        const flippedCards = room.cards.filter(c => c.isFlipped && !c.isMatched);

        // Eine Karte aufgedeckt
        if (flippedCards.length === 1) {
            io.to(roomId).emit('gameUpdate', {
                cards: room.cards,
                currentTurn: room.currentTurn,
                players: room.players
            });
            return;
        }

        // Zwei Karten aufgedeckt
        room.locked = true;
        io.to(roomId).emit('gameUpdate', {
            cards: room.cards,
            currentTurn: room.currentTurn,
            players: room.players
        });

        if (flippedCards[0].image === flippedCards[1].image) {
            // ✅ Match
            flippedCards.forEach(c => (c.isMatched = true));
            const player = room.players.find(p => p.id === socket.id);
            player.score++;
            room.locked = false; // Spieler darf weiter ziehen

            io.to(roomId).emit('gameUpdate', {
                cards: room.cards,
                currentTurn: room.currentTurn,
                players: room.players
            });
            console.log(`🎯 Treffer von ${player.name}, Score: ${player.score}`);
        } else {
            // ❌ Kein Match
            setTimeout(() => {
                flippedCards.forEach(c => (c.isFlipped = false));
                const nextPlayer = room.players.find(p => p.id !== socket.id);
                room.currentTurn = nextPlayer.id;
                room.locked = false;

                io.to(roomId).emit('gameUpdate', {
                    cards: room.cards,
                    currentTurn: room.currentTurn,
                    players: room.players
                });
                console.log(`🔄 Kein Treffer, Zug wechselt zu ${nextPlayer.name}`);
            }, 1000);
        }

        // Spielende prüfen
        if (room.cards.every(c => c.isMatched)) {
            const winner = room.players.reduce((a, b) => (a.score > b.score ? a : b));
            io.to(roomId).emit('gameEnd', { winner: winner.name, scores: room.players });
            rooms.delete(roomId);
            console.log(`🏆 Spiel in Raum ${roomId} beendet. Gewinner: ${winner.name}`);
        }
    });

    // Spieler trennt Verbindung
    socket.on('disconnect', () => {
        for (const [roomId, room] of rooms) {
            const playerIndex = room.players.findIndex(p => p.id === socket.id);
            if (playerIndex !== -1) {
                const leftPlayer = room.players[playerIndex];
                room.players.splice(playerIndex, 1);
                io.to(roomId).emit('playerLeft', room.players);
                console.log(`❌ Spieler ${leftPlayer.name} (${socket.id}) hat Raum ${roomId} verlassen.`);

                if (room.players.length === 0) {
                    rooms.delete(roomId);
                    console.log(`🗑 Raum ${roomId} gelöscht.`);
                } else {
                    room.gameStarted = false;
                    room.cards = [];
                    room.currentTurn = null;
                    io.to(roomId).emit('gameReset', 'Ein Spieler hat das Spiel verlassen.');
                }
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server läuft auf Port ${PORT}`);
});
