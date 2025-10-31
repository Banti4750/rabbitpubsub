const express = require('express');
const session = require('express-session');
const RedisStore = require('connect-redis').default;
const { createClient } = require('redis');
const cookieParser = require('cookie-parser');
const bodyParser = require('body-parser');
const { Server } = require('socket.io');
const amqp = require('amqplib');
const http = require('http');

const app = express();
const server = http.createServer(app);


const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'your-secret-key';

// Redis client setup for session store
let redisClient;
let redisStore;

async function initializeRedis() {
    try {
        // Configure Redis connection based on environment
        const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

        redisClient = createClient({
            url: redisUrl,
            legacyMode: false
        });

        redisClient.on('error', (err) => console.error('Redis Client Error:', err));
        redisClient.on('connect', () => console.log('Redis Client Connected'));

        await redisClient.connect();

        redisStore = new RedisStore({
            client: redisClient,
            prefix: 'sess:'
        });

        return true;
    } catch (error) {
        console.error('Failed to initialize Redis:', error);
        return false;
    }
}

// RabbitMQ connection
let rabbitConn;
let chatExchange;
let rabbitChannel;

async function initializeRabbitMQ() {
    try {
        const rabbitUrl = process.env.RABBITMQ_URL || 'amqp://localhost';

        rabbitConn = await amqp.connect(rabbitUrl);
        rabbitChannel = await rabbitConn.createChannel();

        // Create exchange with fanout type for pub-sub
        await rabbitChannel.assertExchange('chatExchange', 'fanout', {
            durable: false
        });

        chatExchange = 'chatExchange';

        console.log('RabbitMQ Connected and Exchange Created');

        rabbitConn.on('error', (err) => console.error('RabbitMQ Connection Error:', err));
        rabbitConn.on('close', () => console.log('RabbitMQ Connection Closed'));

        return true;
    } catch (error) {
        console.error('Failed to initialize RabbitMQ:', error);
        return false;
    }
}

// Setup application after connections are ready
async function setupApp() {
    // Express middleware
    app.use(bodyParser.json());
    app.use(bodyParser.urlencoded({ extended: true }));
    app.use(cookieParser());

    // Session middleware - NOW configured with Redis store
    const sessionMiddleware = session({
        store: redisStore,
        secret: SESSION_SECRET,
        resave: false,
        saveUninitialized: false,
        cookie: {
            secure: false, // Set to true if using HTTPS
            httpOnly: true,
            maxAge: 1000 * 60 * 60 * 24 // 24 hours
        }
    });

    app.use(sessionMiddleware);

    // Serve static files
    app.use(express.static('public'));

    // Login route
    app.post('/login', (req, res) => {
        const username = req.body.username;

        if (!username) {
            return res.status(400).json({ error: 'Username is required' });
        }

        req.session.user = username;
        req.session.save((err) => {
            if (err) {
                console.error('Session save error:', err);
                return res.status(500).json({ error: 'Failed to save session' });
            }
            res.json({ success: true, user: username });
        });
    });

    // Logout route
    app.get('/logout', (req, res) => {
        req.session.destroy((err) => {
            if (err) {
                console.error('Session destroy error:', err);
            }
            res.redirect('/');
        });
    });

    // Socket.io setup
    const io = new Server(server, {
        cors: {
            origin: "*",
            methods: ["GET", "POST"]
        }
    });

    // Middleware to share session with socket.io
    io.use((socket, next) => {
        sessionMiddleware(socket.request, {}, next);
    });

    // Socket.io connection handler
    io.on('connection', async (socket) => {
        const session = socket.request.session;

        if (!session || !session.user) {
            console.log('Unauthenticated socket connection attempt');
            socket.disconnect();
            return;
        }

        console.log(`User connected: ${session.user}`);

        try {
            // Create exclusive queue for this socket connection
            const { queue } = await rabbitChannel.assertQueue('', {
                exclusive: true,
                autoDelete: true
            });

            // Bind queue to chat exchange
            await rabbitChannel.bindQueue(queue, chatExchange, '');

            // Subscribe to messages from RabbitMQ
            await rabbitChannel.consume(queue, (msg) => {
                if (msg) {
                    const message = JSON.parse(msg.content.toString());
                    socket.emit('chat', JSON.stringify(message));
                }
            }, { noAck: true });

            // Handle chat messages from client
            socket.on('chat', (data) => {
                try {
                    const msg = JSON.parse(data);
                    const reply = {
                        action: 'message',
                        user: session.user,
                        msg: msg.msg,
                        timestamp: new Date().toISOString()
                    };

                    // Publish to RabbitMQ exchange
                    rabbitChannel.publish(
                        chatExchange,
                        '',
                        Buffer.from(JSON.stringify(reply))
                    );
                } catch (error) {
                    console.error('Error handling chat message:', error);
                }
            });

            // Handle user join
            socket.on('join', () => {
                try {
                    const reply = {
                        action: 'control',
                        user: session.user,
                        msg: ' joined the channel',
                        timestamp: new Date().toISOString()
                    };

                    // Publish to RabbitMQ exchange
                    rabbitChannel.publish(
                        chatExchange,
                        '',
                        Buffer.from(JSON.stringify(reply))
                    );
                } catch (error) {
                    console.error('Error handling join:', error);
                }
            });

            // Handle disconnect
            socket.on('disconnect', () => {
                console.log(`User disconnected: ${session.user}`);

                try {
                    const reply = {
                        action: 'control',
                        user: session.user,
                        msg: ' left the channel',
                        timestamp: new Date().toISOString()
                    };

                    // Publish to RabbitMQ exchange
                    rabbitChannel.publish(
                        chatExchange,
                        '',
                        Buffer.from(JSON.stringify(reply))
                    );
                } catch (error) {
                    console.error('Error handling disconnect:', error);
                }
            });

        } catch (error) {
            console.error('Error setting up socket connection:', error);
            socket.disconnect();
        }
    });
}

// Start server
async function startServer() {
    try {
        // Initialize Redis
        const redisInitialized = await initializeRedis();
        if (!redisInitialized) {
            throw new Error('Failed to initialize Redis');
        }

        // Initialize RabbitMQ
        const rabbitInitialized = await initializeRabbitMQ();
        if (!rabbitInitialized) {
            throw new Error('Failed to initialize RabbitMQ');
        }

        // Setup Express app and routes AFTER connections are ready
        await setupApp();

        // Start listening
        server.listen(PORT, () => {
            console.log(`Server running on port ${PORT}`);
            console.log(`Visit http://localhost:${PORT} to access the chat`);
        });

    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('SIGTERM received, closing gracefully...');

    server.close();

    if (rabbitChannel) await rabbitChannel.close();
    if (rabbitConn) await rabbitConn.close();
    if (redisClient) await redisClient.quit();

    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('SIGINT received, closing gracefully...');

    server.close();

    if (rabbitChannel) await rabbitChannel.close();
    if (rabbitConn) await rabbitConn.close();
    if (redisClient) await redisClient.quit();

    process.exit(0);
});

// Start the server
startServer();