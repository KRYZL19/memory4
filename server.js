const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors: { origin: '*' } });

app.use(express.static('public'));

const rooms = new Map();
const maxCards = 16;
const images = Array.from({ length: 45 }, (_, i) => `/images/bild${i + 1}.jpg`);

function getRandomImages(count) {
    const shuffled = [...images].sort(() => 0.5 - Math.random());
    return shuffled.slice(0, count);
}

io.on('connection', (socket) => {
    console.log(`🔌 Neue Verbindung: ${socket.id}`);

    socket.on('createRoom', ({ roomId, playerName, turnTime }) => {
        if (!roomId || !playerName || !turnTime) return socket.emit('joinError', 'Alle Felder erforderlich.');
        if (rooms.has(roomId)) return socket.emit('joinError', 'Diese Raum-ID ist bereits vergeben.');

        rooms.set(roomId, {
            players: [{ id: socket.id, name: playerName, score: 0, moves: 0, hits: 0 }],
            cards: [],
            currentTurn: null,
            gameStarted: false,
            locked: false,
            chat: [],
            timer: null,
            turnTime: turnTime,
            startTime: null
        });

        socket.join(roomId);
        socket.emit('roomCreated', roomId);
        console.log(`✅ Raum ${roomId} erstellt mit ${turnTime}s Zugzeit.`);
    });

    socket.on('joinRoom', ({ roomId, playerName }) => {
        const room = rooms.get(roomId);
        if (!room) return socket.emit('joinError', 'Raum nicht verfügbar.');
        if (room.players.length >= 2) return socket.emit('joinError', 'Raum ist voll.');

        room.players.push({ id: socket.id, name: playerName, score: 0, moves: 0, hits: 0 });
        socket.join(roomId);
        io.to(roomId).emit('playerJoined', room.players);
        socket.emit('chatHistory', room.chat);

        if (room.players.length === 2) startGame(roomId);
    });

    function startGame(roomId) {
        const room = rooms.get(roomId);
        const selectedImages = getRandomImages(maxCards / 2);
        const cardPairs = [...selectedImages, ...selectedImages];
        room.cards = cardPairs.sort(() => 0.5 - Math.random()).map((img, index) => ({
            id: index,
            image: img,
            isFlipped: false,
            isMatched: false
        }));

        room.currentTurn = room.players[0].id;
        room.gameStarted = true;
        room.startTime = Date.now();

        io.to(roomId).emit('gameStart', {
            cards: room.cards,
            currentTurn: room.currentTurn,
            players: room.players,
            roomId,
            timer: room.turnTime
        });

        startTurnTimer(roomId);
    }

    function startTurnTimer(roomId) {
        const room = rooms.get(roomId);
        if (!room) return;

        if (room.timer) clearInterval(room.timer);
        let timeLeft = room.turnTime;
        io.to(roomId).emit('timerUpdate', timeLeft);

        room.timer = setInterval(() => {
            timeLeft--;
            io.to(roomId).emit('timerUpdate', timeLeft);
            if (timeLeft <= 0) {
                clearInterval(room.timer);
                switchTurn(roomId);
            }
        }, 1000);
    }

    function switchTurn(roomId) {
        const room = rooms.get(roomId);
        if (!room) return;
        const nextPlayer = room.players.find(p => p.id !== room.currentTurn);
        room.currentTurn = nextPlayer.id;
        io.to(roomId).emit('gameUpdate', { cards: room.cards, currentTurn: room.currentTurn, players: room.players });
        startTurnTimer(roomId);
    }

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
        io.to(roomId).emit('gameUpdate', { cards: room.cards, currentTurn: room.currentTurn, players: room.players });

        if (flippedCards.length === 2) {
            room.locked = true;
            const player = room.players.find(p => p.id === socket.id);
            player.moves++;

            if (flippedCards[0].image === flippedCards[1].image) {
                flippedCards.forEach(c => c.isMatched = true);
                player.score++;
                player.hits++;
                room.locked = false;
                io.to(roomId).emit('gameUpdate', { cards: room.cards, currentTurn: room.currentTurn, players: room.players });
                startTurnTimer(roomId);
            } else {
                setTimeout(() => {
                    flippedCards.forEach(c => c.isFlipped = false);
                    room.locked = false;
                    switchTurn(roomId);
                }, 1500);
            }
        }

        if (room.cards.every(c => c.isMatched)) {
            clearInterval(room.timer);
            const duration = Math.floor((Date.now() - room.startTime) / 1000);
            const winner = room.players.reduce((a, b) => (a.score > b.score ? a : b));
            io.to(roomId).emit('gameEnd', { 
                winner: winner.name,
                scores: room.players,
                stats: room.players.map(p => ({
                    name: p.name,
                    moves: p.moves,
                    hits: p.hits,
                    accuracy: ((p.hits / Math.max(1, p.moves)) * 100).toFixed(1) + '%'
                })),
                duration,
                roomId
            });
            rooms.delete(roomId);
        }
    });

    socket.on('sendChatMessage', ({ roomId, name, message }) => {
        const room = rooms.get(roomId);
        if (!room) return;
        const chatMessage = { name, message, time: new Date().toLocaleTimeString() };
        room.chat.push(chatMessage);
        io.to(roomId).emit('newChatMessage', chatMessage);
    });

    socket.on('restartGame', (roomId) => {
        if (!roomId) return;
        if (!rooms.has(roomId)) return;
        startGame(roomId);
    });

    socket.on('disconnect', () => {
        for (const [roomId, room] of rooms) {
            const index = room.players.findIndex(p => p.id === socket.id);
            if (index !== -1) {
                room.players.splice(index, 1);
                io.to(roomId).emit('playerLeft', room.players);
                if (room.players.length === 0) rooms.delete(roomId);
                else {
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
http.listen(PORT, '0.0.0.0', () => console.log(`✅ Server läuft auf Port ${PORT}`));
