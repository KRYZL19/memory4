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
const maxCards = 16; // 8 Paare für ein überschaubares Spiel

// Bildpfade generieren (bild1.jpg bis bild45.jpg)
const images = Array.from({length: 45}, (_, i) => `/images/bild${i+1}.jpg`);

// Zufällige Auswahl von Bildpaaren
function getRandomImages(count) {
    const shuffled = images.sort(() => 0.5 - Math.random());
    return shuffled.slice(0, count);
}

io.on('connection', (socket) => {
    console.log('New connection:', socket.id);

    socket.on('createRoom', (playerName) => {
        const roomId = Math.random().toString(36).substr(2, 9);
        rooms.set(roomId, {
            players: [{ id: socket.id, name: playerName, score: 0 }],
            cards: [],
            currentTurn: null,
            gameStarted: false
        });
        socket.join(roomId);
        socket.emit('roomCreated', roomId);
        console.log(`Room ${roomId} created by ${playerName} (${socket.id})`);
    });

    socket.on('joinRoom', ({ roomId, playerName }) => {
        const room = rooms.get(roomId);
        if (room && room.players.length < 2 && !room.players.find(p => p.id === socket.id)) {
            room.players.push({ id: socket.id, name: playerName, score: 0 });
            socket.join(roomId);
            io.to(roomId).emit('playerJoined', room.players);
            console.log(`Player ${playerName} (${socket.id}) joined room ${roomId}`);

            if (room.players.length === 2) {
                // Spiel vorbereiten
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
                room.currentTurn = room.players[0].id; // Spieler 1 beginnt
                io.to(roomId).emit('gameStart', {
                    cards: room.cards,
                    currentTurn: room.currentTurn,
                    players: room.players
                });
                console.log(`Game started in room ${roomId}, currentTurn: ${room.currentTurn}`);
            }
        } else {
            socket.emit('joinError', 'Raum voll oder nicht gefunden');
            console.log(`Join error for ${playerName} (${socket.id}) in room ${roomId}`);
        }
    });

    socket.on('flipCard', ({ roomId, cardId }) => {
        const room = rooms.get(roomId);
        if (room && socket.id === room.currentTurn && room.gameStarted) {
            const card = room.cards[cardId];
            if (!card.isFlipped && !card.isMatched) {
                card.isFlipped = true;
                const flippedCards = room.cards.filter(c => c.isFlipped && !c.isMatched);
                console.log(`Card ${cardId} flipped by ${socket.id} in room ${roomId}`);

                if (flippedCards.length === 2) {
                    if (flippedCards[0].image === flippedCards[1].image) {
                        flippedCards.forEach(c => (c.isMatched = true));
                        const player = room.players.find(p => p.id === socket.id);
                        player.score += 1;
                        console.log(`Match found by ${socket.id}, score: ${player.score}`);
                    } else {
                        setTimeout(() => {
                            flippedCards.forEach(c => (c.isFlipped = false));
                            room.currentTurn = room.players.find(p => p.id !== socket.id).id;
                            io.to(roomId).emit('gameUpdate', {
                                cards: room.cards,
                                currentTurn: room.currentTurn,
                                players: room.players
                            });
                            console.log(`No match, turn changed to ${room.currentTurn}`);
                        }, 1000);
                    }
                }

                io.to(roomId).emit('gameUpdate', {
                    cards: room.cards,
                    currentTurn: room.currentTurn,
                    players: room.players
                });

                // Spielende prüfen
                if (room.cards.every(c => c.isMatched)) {
                    const winner = room.players.reduce((a, b) => a.score > b.score ? a : b);
                    io.to(roomId).emit('gameEnd', {
                        winner: winner.name,
                        scores: room.players
                    });
                    rooms.delete(roomId);
                    console.log(`Game ended in room ${roomId}, winner: ${winner.name}`);
                }
            }
        } else {
            console.log(`Invalid flip attempt by ${socket.id} in room ${roomId}, currentTurn: ${room.currentTurn}`);
        }
    });

    socket.on('disconnect', () => {
        for (const [roomId, room] of rooms) {
            const playerIndex = room.players.findIndex(p => p.id === socket.id);
            if (playerIndex !== -1) {
                room.players.splice(playerIndex, 1);
                io.to(roomId).emit('playerLeft', room.players);
                console.log(`Player ${socket.id} left room ${roomId}`);
                if (room.players.length === 0) {
                    rooms.delete(roomId);
                    console.log(`Room ${roomId} deleted`);
                }
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => {
    console.log(`Server läuft auf Port ${PORT}`);
});
