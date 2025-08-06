const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors: { origin: '*' } });

app.use(express.static('public'));

app.get('/', (req, res) => res.sendFile(__dirname + '/public/index.html'));

const rooms = new Map();
const images = Array.from({ length: 45 }, (_, i) => `/images/bild${i + 1}.jpg`);

function getRandomImages(count) {
    return [...images].sort(() => 0.5 - Math.random()).slice(0, count);
}

io.on('connection', (socket) => {
    console.log(`🔌 Neue Verbindung: ${socket.id}`);

    // Raum erstellen mit Paaranzahl
    socket.on('createRoom', ({ roomId, playerName, pairCount }) => {
        if (!roomId || !playerName) return socket.emit('joinError', 'Raum-ID und Name erforderlich.');
        if (rooms.has(roomId)) return socket.emit('joinError', 'Diese Raum-ID ist bereits vergeben.');

        rooms.set(roomId, {
            players: [{ id: socket.id, name: playerName, score: 0 }],
            cards: [],
            currentTurn: null,
            gameStarted: false,
            locked: false,
            pairCount,
            timer: null
        });

        socket.join(roomId);
        socket.emit('roomCreated', roomId);
        console.log(`✅ Raum ${roomId} erstellt (${pairCount} Paare) von ${playerName}`);
    });

    // Raum beitreten
    socket.on('joinRoom', ({ roomId, playerName }) => {
        const room = rooms.get(roomId);
        if (!room) return socket.emit('joinError', 'Raum nicht verfügbar.');
        if (room.players.length >= 2) return socket.emit('joinError', 'Raum ist voll.');

        room.players.push({ id: socket.id, name: playerName, score: 0 });
        socket.join(roomId);
        io.to(roomId).emit('playerJoined', room.players);

        console.log(`🎮 ${playerName} (${socket.id}) ist Raum ${roomId} beigetreten.`);

        // Spiel starten
        if (room.players.length === 2) {
            startGame(roomId);
        }
    });

    function startGame(roomId) {
        const room = rooms.get(roomId);
        const selectedImages = getRandomImages(room.pairCount);
        const cardPairs = [...selectedImages, ...selectedImages];
        room.cards = cardPairs.sort(() => 0.5 - Math.random()).map((img, index) => ({
            id: index,
            image: img,
            isFlipped: false,
            isMatched: false
        }));
        room.currentTurn = room.players[0].id;
        room.gameStarted = true;

        io.to(roomId).emit('gameStart', {
            cards: room.cards,
            currentTurn: room.currentTurn,
            players: room.players,
            pairCount: room.pairCount
        });

        startTurnTimer(roomId); // Start Timer für ersten Spieler
    }

    function startTurnTimer(roomId) {
        const room = rooms.get(roomId);
        if (room.timer) clearTimeout(room.timer);

        room.timer = setTimeout(() => {
            const nextPlayer = room.players.find(p => p.id !== room.currentTurn);
            if (nextPlayer) {
                room.currentTurn = nextPlayer.id;
                io.to(roomId).emit('gameUpdate', {
                    cards: room.cards,
                    currentTurn: room.currentTurn,
                    players: room.players
                });
                startTurnTimer(roomId); // Neuer Timer
            }
        }, 15000); // 15 Sekunden pro Zug
    }

    // Karte flippen
    socket.on('flipCard', ({ roomId, cardId }) => {
        const room = rooms.get(roomId);
        if (!room) return socket.emit('flipError', 'Raum nicht verfügbar.');
        if (!room.gameStarted) return socket.emit('flipError', 'Das Spiel ist nicht aktiv.');
        if (room.locked) return socket.emit('flipError', 'Warte, Animation läuft.');
        if (socket.id !== room.currentTurn) return socket.emit('flipError', 'Nicht dein Zug.');

        const card = room.cards[cardId];
        if (!card || card.isFlipped || card.isMatched) return;

        card.isFlipped = true;
        const flippedCards = room.cards.filter(c => c.isFlipped && !c.isMatched);

        if (flippedCards.length === 1) {
            io.to(roomId).emit('gameUpdate', { cards: room.cards, currentTurn: room.currentTurn, players: room.players });
            return;
        }

        // Zwei Karten
        room.locked = true;
        io.to(roomId).emit('gameUpdate', { cards: room.cards, currentTurn: room.currentTurn, players: room.players });

        if (flippedCards[0].image === flippedCards[1].image) {
            flippedCards.forEach(c => (c.isMatched = true));
            const player = room.players.find(p => p.id === socket.id);
            player.score++;
            room.locked = false;

            io.to(roomId).emit('gameUpdate', { cards: room.cards, currentTurn: room.currentTurn, players: room.players });
        } else {
            setTimeout(() => {
                flippedCards.forEach(c => (c.isFlipped = false));
                const nextPlayer = room.players.find(p => p.id !== socket.id);
                room.currentTurn = nextPlayer.id;
                room.locked = false;
                io.to(roomId).emit('gameUpdate', { cards: room.cards, currentTurn: room.currentTurn, players: room.players });
                startTurnTimer(roomId);
            }, 1000);
        }

        // Spielende prüfen
        if (room.cards.every(c => c.isMatched)) {
            clearTimeout(room.timer);
            const winner = room.players.reduce((a, b) => (a.score > b.score ? a : b));
            io.to(roomId).emit('gameEnd', { winner: winner.name, scores: room.players });
            console.log(`🏆 Spiel beendet: ${winner.name}`);
        }
    });

    // Disconnect
    socket.on('disconnect', () => {
        for (const [roomId, room] of rooms) {
            const idx = room.players.findIndex(p => p.id === socket.id);
            if (idx !== -1) {
                room.players.splice(idx, 1);
                io.to(roomId).emit('playerLeft', room.players);

                if (room.players.length === 0) {
                    rooms.delete(roomId);
                } else {
                    room.gameStarted = false;
                    room.cards = [];
                    room.currentTurn = null;
                    clearTimeout(room.timer);
                    io.to(roomId).emit('gameReset', 'Ein Spieler hat das Spiel verlassen.');
                }
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => console.log(`✅ Server läuft auf Port ${PORT}`));
