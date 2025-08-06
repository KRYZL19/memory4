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
const images = Array.from({ length: 45 }, (_, i) => `/images/bild${i + 1}.jpg`);

// Zufällige Auswahl von Bildpaaren
function getRandomImages(count) {
    const shuffled = images.sort(() => 0.5 - Math.random());
    return shuffled.slice(0, count);
}

io.on('connection', (socket) => {
    console.log('Neue Verbindung:', socket.id);

    // Raum erstellen
    socket.on('createRoom', (playerName) => {
        const roomId = Math.random().toString(36).substr(2, 9);
        rooms.set(roomId, {
            players: [{ id: socket.id, name: playerName, score: 0 }],
            cards: [],
            currentTurn: null,
            gameStarted: false,
            locked: false // NEU: Sperr-Flag für Animation
        });
        socket.join(roomId);
        socket.emit('roomCreated', roomId);
        console.log(`Raum ${roomId} erstellt von ${playerName} (${socket.id})`);
    });

    // Raum beitreten
    socket.on('joinRoom', ({ roomId, playerName }) => {
        const room = rooms.get(roomId);
        if (room && room.players.length < 2 && !room.players.find(p => p.id === socket.id)) {
            room.players.push({ id: socket.id, name: playerName, score: 0 });
            socket.join(roomId);
            io.to(roomId).emit('playerJoined', room.players);
            console.log(`Spieler ${playerName} (${socket.id}) ist Raum ${roomId} beigetreten.`);

            if (room.players.length === 2) {
                // Spiel starten
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
                console.log(`Spiel gestartet in Raum ${roomId}, Zug: ${room.currentTurn}`);
            }
        } else {
            socket.emit('joinError', 'Raum voll oder nicht gefunden');
            console.log(`Beitrittsfehler für ${playerName} (${socket.id}) in Raum ${roomId}`);
        }
    });

    // Karte umdrehen
    socket.on('flipCard', ({ roomId, cardId }) => {
        const room = rooms.get(roomId);

        if (!room) {
            socket.emit('flipError', 'Raum nicht gefunden.');
            return;
        }

        if (room.locked) {
            socket.emit('flipError', 'Bitte warte, bis die Kartenanimation beendet ist.');
            return;
        }

        if (socket.id !== room.currentTurn || !room.gameStarted) {
            socket.emit('flipError', 'Du bist nicht dran oder das Spiel ist nicht aktiv.');
            return;
        }

        const card = room.cards[cardId];
        if (!card || card.isFlipped || card.isMatched) return;

        card.isFlipped = true;
        const flippedCards = room.cards.filter(c => c.isFlipped && !c.isMatched);
        console.log(`Karte ${cardId} umgedreht von ${socket.id} in Raum ${roomId}`);

        if (flippedCards.length === 2) {
            room.locked = true; // Sperre aktivieren

            if (flippedCards[0].image === flippedCards[1].image) {
                // ✅ Karten passen
                flippedCards.forEach(c => (c.isMatched = true));
                const player = room.players.find(p => p.id === socket.id);
                player.score += 1;
                room.locked = false; // Spieler bleibt dran

                io.to(roomId).emit('gameUpdate', {
                    cards: room.cards,
                    currentTurn: room.currentTurn,
                    players: room.players
                });
                console.log(`Treffer von ${socket.id}, Punkte: ${player.score}`);
            } else {
                // ❌ Kein Match -> Karten zeigen, dann umdrehen + Zug wechseln
                io.to(roomId).emit('gameUpdate', {
                    cards: room.cards,
                    currentTurn: room.currentTurn,
                    players: room.players
                });

                setTimeout(() => {
                    flippedCards.forEach(c => (c.isFlipped = false));
                    const nextPlayer = room.players.find(p => p.id !== socket.id);
                    room.currentTurn = nextPlayer ? nextPlayer.id : room.players[0].id;
                    room.locked = false; // Sperre lösen

                    io.to(roomId).emit('gameUpdate', {
                        cards: room.cards,
                        currentTurn: room.currentTurn,
                        players: room.players
                    });
                    console.log(`Kein Treffer, Zug wechselt zu ${room.currentTurn}`);
                }, 1000);
            }
        } else {
            // Nur eine Karte aufgedeckt
            io.to(roomId).emit('gameUpdate', {
                cards: room.cards,
                currentTurn: room.currentTurn,
                players: room.players
            });
        }

        // Spielende prüfen
        if (room.cards.every(c => c.isMatched)) {
            const winner = room.players.reduce((a, b) => a.score > b.score ? a : b);
            io.to(roomId).emit('gameEnd', {
                winner: winner.name,
                scores: room.players
            });
            rooms.delete(roomId);
            console.log(`Spiel in Raum ${roomId} beendet. Gewinner: ${winner.name}`);
        }
    });

    // Spieler trennt Verbindung
    socket.on('disconnect', () => {
        for (const [roomId, room] of rooms) {
            const playerIndex = room.players.findIndex(p => p.id === socket.id);
            if (playerIndex !== -1) {
                room.players.splice(playerIndex, 1);
                io.to(roomId).emit('playerLeft', room.players);
                console.log(`Spieler ${socket.id} hat Raum ${roomId} verlassen.`);

                if (room.players.length === 0) {
                    rooms.delete(roomId);
                    console.log(`Raum ${roomId} gelöscht.`);
                } else {
                    room.gameStarted = false;
                    room.cards = [];
                    room.currentTurn = null;
                    io.to(roomId).emit('gameReset', 'Ein Spieler hat das Spiel verlassen.');
                    console.log(`Spiel in Raum ${roomId} zurückgesetzt.`);
                }
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => {
    console.log(`Server läuft auf Port ${PORT}`);
});
