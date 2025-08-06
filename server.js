const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors: { origin: '*' } });

app.use(express.static('public'));

app.get('/', (req, res) => res.sendFile(__dirname + '/public/index.html'));

const rooms = new Map();
const maxCards = 16;
const images = Array.from({ length: 45 }, (_, i) => `/images/bild${i + 1}.jpg`);

function getRandomImages(count) {
    const shuffled = [...images].sort(() => 0.5 - Math.random());
    return shuffled.slice(0, count);
}

io.on('connection', (socket) => {
    console.log(`🔌 Neue Verbindung: ${socket.id}`);

    socket.on('createRoom', ({ roomId, playerName }) => {
        if (!roomId || !playerName) return socket.emit('joinError', 'Raum-ID und Name erforderlich.');
        if (rooms.has(roomId)) return socket.emit('joinError', 'Diese Raum-ID ist bereits vergeben.');

        rooms.set(roomId, {
            players: [{ id: socket.id, name: playerName, score: 0 }],
            cards: [],
            currentTurn: null,
            gameStarted: false,
            locked: false,
            chat: []
        });

        socket.join(roomId);
        socket.emit('roomCreated', roomId);
        console.log(`✅ Raum ${roomId} erstellt von ${playerName}`);
    });

    socket.on('joinRoom', ({ roomId, playerName }) => {
        const room = rooms.get(roomId);
        if (!room) return socket.emit('joinError', 'Raum nicht verfügbar.');
        if (room.players.length >= 2) return socket.emit('joinError', 'Raum ist voll.');

        room.players.push({ id: socket.id, name: playerName, score: 0 });
        socket.join(roomId);
        io.to(roomId).emit('playerJoined', room.players);
        socket.emit('chatHistory', room.chat);

        if (room.players.length === 2) {
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

            io.to(roomId).emit('gameStart', {
                cards: room.cards,
                currentTurn: room.currentTurn,
                players: room.players,
                roomId // ✅ Raum-ID mitsenden
            });
        }
    });

    socket.on('flipCard', ({ roomId, cardId }) => {
        const room = rooms.get(roomId);
        console.log(`flipCard attempt roomId:${roomId}, socketId:${socket.id}`);
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
            if (flippedCards[0].image === flippedCards[1].image) {
                flippedCards.forEach(c => c.isMatched = true);
                const player = room.players.find(p => p.id === socket.id);
                player.score++;
                room.locked = false;
                io.to(roomId).emit('gameUpdate', { cards: room.cards, currentTurn: room.currentTurn, players: room.players });
            } else {
                setTimeout(() => {
    flippedCards.forEach(c => c.isFlipped = false);
    const next = room.players.find(p => p.id !== socket.id);
    room.currentTurn = next.id;
    room.locked = false;
    io.to(roomId).emit('gameUpdate', { cards: room.cards, currentTurn: room.currentTurn, players: room.players });
}, 1500); // ⬅︎ jetzt 1,5 Sekunden

            }
        }

        if (room.cards.every(c => c.isMatched)) {
            const winner = room.players.reduce((a, b) => (a.score > b.score ? a : b));
            io.to(roomId).emit('gameEnd', { winner: winner.name, scores: room.players });
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
