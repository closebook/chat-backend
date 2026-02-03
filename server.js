const WebSocket = require('ws');
const express = require('express');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, maxPayload: 15 * 1024 * 1024 });

let clients = [];
let adminClients = [];
let messages = [];
let messageIdCounter = 0;
let onlineUsers = [];

app.get("/health", (req, res) => {
  res.status(200).send("OK");
});
// Store usernames that are currently in use
let activeUsernames = new Set();

app.use(express.static(path.join(__dirname, 'public')));

// Route for file downloads
app.get('/download/:fileId', (req, res) => {
    const fileId = req.params.fileId;
    const message = messages.find(msg => msg.type === 'file' && msg.fileId === fileId);
    
    if (message) {
        const buffer = Buffer.from(message.fileData, 'base64');
        res.setHeader('Content-Type', message.fileType);
        res.setHeader('Content-Disposition', `attachment; filename=${message.fileName}`);
        res.send(buffer);
    } else {
        res.status(404).send('File not found');
    }
});

function broadcastOnlineUsers() {
    const users = onlineUsers.map(user => user.username);
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
                type: 'online-users',
                users: users
            }));
        }
    });
}

function broadcast(message, excludeWs = null) {
    clients.forEach(client => {
        if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(message));
        }
    });
}

wss.on('connection', (ws) => {
    console.log('New client connected');
    ws.send(JSON.stringify({ type: 'init', messages }));

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            switch (data.type) {
                case 'set-username':
                    // Check if username already exists
                    if (activeUsernames.has(data.username)) {
                        ws.send(JSON.stringify({ 
                            type: 'username-taken', 
                            message: 'Username already taken. Please choose another.' 
                        }));
                    } else if (data.username.trim() === '') {
                        ws.send(JSON.stringify({ 
                            type: 'username-invalid', 
                            message: 'Username cannot be empty.' 
                        }));
                    } else {
                        // Add username to active set
                        activeUsernames.add(data.username);
                        ws.username = data.username;
                        
                        // Add to online users
                        if (!onlineUsers.some(user => user.username === data.username)) {
                            onlineUsers.push({ ws, username: data.username });
                        }
                        
                        ws.send(JSON.stringify({ 
                            type: 'username-set', 
                            username: data.username 
                        }));
                        
                        broadcastOnlineUsers();
                        
                        // Notify others about new user (system message)
                        broadcast({
                            type: 'system',
                            id: messageIdCounter++,
                            message: `${data.username} has joined the chat.`,
                            timestamp: Date.now()
                        }, ws);
                    }
                    break;
                    
                case 'change-username':
                    const oldUsername = ws.username;
                    const newUsername = data.newUsername;
                    
                    // Check if new username is already taken
                    if (activeUsernames.has(newUsername)) {
                        ws.send(JSON.stringify({ 
                            type: 'username-taken', 
                            message: 'Username already taken. Please choose another.' 
                        }));
                    } else if (newUsername.trim() === '') {
                        ws.send(JSON.stringify({ 
                            type: 'username-invalid', 
                            message: 'Username cannot be empty.' 
                        }));
                    } else {
                        // Remove old username from active set
                        activeUsernames.delete(oldUsername);
                        
                        // Update username
                        ws.username = newUsername;
                        activeUsernames.add(newUsername);
                        
                        // Update online users array
                        const userIndex = onlineUsers.findIndex(u => u.ws === ws);
                        if (userIndex !== -1) {
                            onlineUsers[userIndex].username = newUsername;
                        }
                        
                        ws.send(JSON.stringify({ 
                            type: 'username-changed', 
                            oldUsername: oldUsername,
                            newUsername: newUsername
                        }));
                        
                        broadcastOnlineUsers();
                        
                        // Notify others about username change (system message)
                        broadcast({
                            type: 'system',
                            id: messageIdCounter++,
                            message: `${oldUsername} is now known as ${newUsername}.`,
                            timestamp: Date.now()
                        });
                    }
                    break;

                case 'user':
                    if (!ws.username) {
                        ws.send(JSON.stringify({ 
                            type: 'error', 
                            message: 'Please set a username first.' 
                        }));
                        return;
                    }
                    
                    if (data.message === '!online') {
                        const userList = onlineUsers.map((u, i) => `${i + 1}. ${u.username}👨‍💻`).join('<br>');
                        ws.send(JSON.stringify({ 
                            type: 'system', 
                            id: messageIdCounter++,
                            message: `Online users 🌐:<br>${userList}`,
                            timestamp: Date.now()
                        }));
                    } else {
                        let mentionedUsers = [];
                        let newMessage = {
                            id: messageIdCounter++,
                            type: 'user',
                            username: ws.username,
                            message: data.message,
                            isAdmin: false,
                            timestamp: Date.now()
                        };

                        // Handle reply data
                        if (data.replyTo) {
                            newMessage.replyTo = data.replyTo;
                            newMessage.replyUsername = data.replyUsername;
                            newMessage.replyMessage = data.replyMessage;
                        }

                        messages.push(newMessage);
                        broadcast(newMessage);

                        // Check for mentions and send direct notifications
                        data.message.replace(/@(\w+)/g, (_, mentionedUser) => {
                            let user = onlineUsers.find(u => u.username === mentionedUser);
                            if (user && user.ws !== ws) { // Don't notify yourself
                                mentionedUsers.push(user.ws);
                            }
                        });

                        // Remove duplicates
                        mentionedUsers = [...new Set(mentionedUsers)];
                        
                        mentionedUsers.forEach(userWs => {
                            if (userWs.readyState === WebSocket.OPEN) {
                                userWs.send(JSON.stringify({
                                    type: 'mention',
                                    from: ws.username,
                                    message: data.message.substring(0, 50) + (data.message.length > 50 ? '...' : '')
                                }));
                            }
                        });
                    }
                    break;
                    
                case 'file':
                    if (!ws.username) {
                        ws.send(JSON.stringify({ 
                            type: 'error', 
                            message: 'Please set a username first.' 
                        }));
                        return;
                    }
                    
                    if (data.fileSize > 10 * 1024 * 1024) {
                        ws.send(JSON.stringify({
                            type: 'system',
                            id: messageIdCounter++,
                            message: 'File size exceeds 10MB limit',
                            timestamp: Date.now()
                        }));
                        return;
                    }

                    const newFileMessage = {
                        id: messageIdCounter++,
                        type: 'file',
                        username: ws.username,
                        fileId: data.fileId,
                        fileName: data.fileName,
                        fileType: data.fileType,
                        fileSize: data.fileSize,
                        fileData: data.fileData,
                        fileCategory: data.fileCategory,
                        message: data.message || '',
                        isAdmin: false,
                        timestamp: Date.now()
                    };

                    // Handle reply data for files
                    if (data.replyTo) {
                        newFileMessage.replyTo = data.replyTo;
                        newFileMessage.replyUsername = data.replyUsername;
                        newFileMessage.replyMessage = data.replyMessage;
                    }

                    messages.push(newFileMessage);
                    broadcast(newFileMessage);
                    break;
                    
                case 'admin-login':
                    if (data.username === 'admin' && data.password === 'pc44@uu') {
                        ws.send(JSON.stringify({ 
                            type: 'admin-login-success',
                            id: messageIdCounter++,
                            message: `${ws.username || 'Admin'} has logged in as administrator.`,
                            timestamp: Date.now()
                        }));
                        adminClients.push(ws);
                    } else {
                        ws.send(JSON.stringify({ 
                            type: 'admin-login-failed',
                            id: messageIdCounter++,
                            message: 'Admin login failed. Incorrect password.',
                            timestamp: Date.now()
                        }));
                    }
                    break;
                    
                case 'delete-message':
                    if (adminClients.includes(ws)) {
                        messages = messages.filter(msg => msg.id !== parseInt(data.messageId));
                        broadcast({ 
                            type: 'delete-message', 
                            messageId: data.messageId 
                        });
                    }
                    break;
                    
                case 'typing':
                    if (ws.username) {
                        broadcast({ type: 'typing', username: ws.username });
                    }
                    break;
                    
                case 'stop-typing':
                    if (ws.username) {
                        broadcast({ type: 'stop-typing', username: ws.username });
                    }
                    break;
            }
        } catch (error) {
            console.error('Error processing message:', error);
        }
    });

    clients.push(ws);

    ws.on('close', () => {
        clients = clients.filter(client => client !== ws);
        adminClients = adminClients.filter(admin => admin !== ws);
        
        // Remove from online users and active usernames
        if (ws.username) {
            activeUsernames.delete(ws.username);
            onlineUsers = onlineUsers.filter(user => user.ws !== ws);
            
            // Notify others about user leaving (system message)
            broadcast({
                type: 'system',
                id: messageIdCounter++,
                message: `${ws.username} has left the chat.`,
                timestamp: Date.now()
            });
            
            broadcastOnlineUsers();
        }
        
        console.log(`Client disconnected. Active usernames: ${Array.from(activeUsernames).join(', ')}`);
    });

    broadcastOnlineUsers();
});

// Send online users list every 5 seconds
setInterval(broadcastOnlineUsers, 5000);


server.listen(3000, () => console.log('Server running on port 3000'));
