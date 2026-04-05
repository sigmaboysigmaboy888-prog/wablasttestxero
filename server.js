const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { Boom } = require('@hapi/boom');
const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason,
    makeInMemoryStore,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const Pino = require('pino');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*" }
});

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Store untuk sessions
const sessions = new Map();
const store = makeInMemoryStore({ logger: Pino().child({ level: 'silent' }) });

// Fungsi untuk membuat session WhatsApp
async function createWhatsAppSession(phoneNumber, res, socketId) {
    const sessionDir = path.join(__dirname, 'sessions', phoneNumber);
    
    if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: Pino({ level: 'silent' }),
        browser: ['Ubuntu', 'Chrome', '20.0.04'],
        defaultQueryTimeoutMs: undefined,
        keepAliveIntervalMs: 10000
    });

    store.bind(sock.ev);

    sessions.set(phoneNumber, sock);

    let pairingCode = null;

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && !pairingCode) {
            io.to(socketId).emit('qr', { phoneNumber, qr });
        }

        if (connection === 'open') {
            io.to(socketId).emit('status_update', {
                phoneNumber,
                status: 'active',
                message: 'Connected successfully'
            });
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            let status = 'inactive';
            let statusType = 'inactive';
            
            if (statusCode === DisconnectReason.loggedOut) {
                status = 'banned';
                statusType = 'banned';
            } else if (statusCode === 429 || lastDisconnect?.error?.message?.includes('rate')) {
                status = 'limited';
                statusType = 'limited';
            } else {
                status = 'inactive';
                statusType = 'inactive';
            }
            
            io.to(socketId).emit('status_update', {
                phoneNumber,
                status: statusType,
                message: `Disconnected: ${status}`
            });

            if (shouldReconnect) {
                setTimeout(() => createWhatsAppSession(phoneNumber, null, socketId), 5000);
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // Request pairing code jika diminta
    if (res && res.pairingCode) {
        try {
            pairingCode = await sock.requestPairingCode(phoneNumber);
            io.to(socketId).emit('pairing_code', { phoneNumber, code: pairingCode });
        } catch (error) {
            io.to(socketId).emit('error', { phoneNumber, error: error.message });
        }
    }

    return sock;
}

// Socket.IO connection
io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);

    // Request pairing code
    socket.on('request_pairing', async (data) => {
        const { phoneNumber } = data;
        try {
            const sock = await createWhatsAppSession(phoneNumber, { pairingCode: true }, socket.id);
            socket.emit('pairing_requested', { phoneNumber, success: true });
        } catch (error) {
            socket.emit('error', { phoneNumber, error: error.message });
        }
    });

    // Send blast message
    socket.on('send_blast', async (data) => {
        const { phoneNumber, targets, templates, delay } = data;
        
        const sock = sessions.get(phoneNumber);
        
        if (!sock) {
            socket.emit('blast_result', {
                phoneNumber,
                results: targets.map(t => ({ 
                    number: t, 
                    status: 'failed', 
                    message: 'Session not connected' 
                }))
            });
            return;
        }

        const results = [];
        
        for (let i = 0; i < targets.length; i++) {
            const target = targets[i];
            const template = templates[i % templates.length];
            
            try {
                const formattedNumber = target.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
                
                await sock.sendMessage(formattedNumber, { text: template });
                
                results.push({
                    number: target,
                    status: 'sent',
                    message: 'Message sent successfully'
                });
                
                socket.emit('blast_progress', {
                    phoneNumber,
                    current: i + 1,
                    total: targets.length,
                    lastResult: { number: target, status: 'sent' }
                });
                
                if (delay > 0 && i < targets.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, delay * 1000));
                }
                
            } catch (error) {
                let status = 'failed';
                let errorMsg = error.message;
                
                if (error.message?.includes('banned') || error.message?.includes('blocked')) {
                    status = 'banned';
                } else if (error.message?.includes('rate') || error.message?.includes('too many')) {
                    status = 'limited';
                } else if (error.message?.includes('not registered')) {
                    status = 'pending';
                }
                
                results.push({
                    number: target,
                    status: status,
                    message: errorMsg
                });
                
                socket.emit('blast_progress', {
                    phoneNumber,
                    current: i + 1,
                    total: targets.length,
                    lastResult: { number: target, status: status }
                });
            }
        }
        
        socket.emit('blast_result', { phoneNumber, results });
    });

    // Get session status
    socket.on('get_status', async (data) => {
        const { phoneNumber } = data;
        const sock = sessions.get(phoneNumber);
        
        if (!sock || !sock.user) {
            socket.emit('status_response', {
                phoneNumber,
                status: 'inactive'
            });
        } else {
            socket.emit('status_response', {
                phoneNumber,
                status: 'active'
            });
        }
    });

    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
    });
});

// Serve HTML
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
