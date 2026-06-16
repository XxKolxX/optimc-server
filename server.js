const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const subscribers = {}; // topic -> list of Response objects

const WORLDS_FILE = path.join(__dirname, 'worlds.json');
const activePlayers = {}; // worldKey -> { uuid -> { uuid, name, x, y, z, yaw, health, dimension, lastSeen } }

function getRegisteredWorlds() {
    try {
        if (fs.existsSync(WORLDS_FILE)) {
            const content = fs.readFileSync(WORLDS_FILE, 'utf8');
            return JSON.parse(content);
        }
    } catch (e) {
        console.error("Error reading worlds file:", e);
    }
    return [];
}

function saveRegisteredWorlds(worlds) {
    try {
        fs.writeFileSync(WORLDS_FILE, JSON.stringify(worlds, null, 2), 'utf8');
    } catch (e) {
        console.error("Error writing worlds file:", e);
    }
}

function registerWorld(topic, worldKey) {
    if (!topic || !worldKey) return;
    const worlds = getRegisteredWorlds();
    const existing = worlds.find(w => w.topic === topic && w.worldKey === worldKey);
    if (!existing) {
        worlds.push({ topic, worldKey, registeredAt: Date.now() });
        saveRegisteredWorlds(worlds);
        console.log(`[Database] Registered new world: topic=${topic}, worldKey=${worldKey}`);
    }
}

function updateActivePlayers(worldKey, playerData) {
    if (!worldKey || !playerData) return;
    const now = Date.now();
    if (!activePlayers[worldKey]) {
        activePlayers[worldKey] = {};
    }
    
    // Update sender player (this is a player who actually has the mod)
    if (playerData.senderUuid) {
        activePlayers[worldKey][playerData.senderUuid] = {
            uuid: playerData.senderUuid,
            name: playerData.senderName,
            x: Number(playerData.x) || 0,
            y: Number(playerData.y) || 0,
            z: Number(playerData.z) || 0,
            yaw: Number(playerData.yaw) || 0,
            health: Number(playerData.health) || 20,
            dimension: playerData.dimension || 'overworld',
            isModUser: true,
            lastSeen: now
        };
    }
    
    // Update other players seen by sender (they do not have the mod)
    if (Array.isArray(playerData.players)) {
        playerData.players.forEach(p => {
            if (p.uuid) {
                const existing = activePlayers[worldKey][p.uuid];
                activePlayers[worldKey][p.uuid] = {
                    uuid: p.uuid,
                    name: p.name,
                    x: Number(p.x) || 0,
                    y: Number(p.y) || 0,
                    z: Number(p.z) || 0,
                    yaw: Number(p.yaw) || 0,
                    health: Number(p.health) || 20,
                    dimension: playerData.dimension || 'overworld',
                    isModUser: existing ? existing.isModUser : false,
                    lastSeen: now
                };
            }
        });
    }
}

function getActivePlayers(worldKey) {
    const now = Date.now();
    const playersMap = activePlayers[worldKey] || {};
    const list = [];
    for (const uuid in playersMap) {
        const p = playersMap[uuid];
        if (now - p.lastSeen < 15000) {
            list.push(p);
        } else {
            delete playersMap[uuid];
        }
    }
    return list;
}

// Helper to handle CORS headers
function setCorsHeaders(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With');
}

const server = http.createServer((req, res) => {
    setCorsHeaders(res);

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;
    const parts = pathname.split('/').filter(Boolean);

    // Endpoint: POST /tiles/:topic/... -> Upload map tile
    if (req.method === 'POST' && parts[0] === 'tiles' && parts.length >= 3) {
        const topic = parts[1];
        const subPathParts = parts.slice(2);
        const subPath = subPathParts.join('/');
        
        // Ensure path traversal protection
        if (subPath.includes('..') || topic.includes('..')) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Invalid path');
            return;
        }

        const worldKey = subPathParts[0];
        if (worldKey) {
            registerWorld(topic, worldKey);
        }

        const filePath = path.join(__dirname, 'tiles', topic, ...subPathParts);
        const dirPath = path.dirname(filePath);

        // Ensure directories exist
        fs.mkdir(dirPath, { recursive: true }, (err) => {
            if (err) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Failed to create directory');
                return;
            }

            const writeStream = fs.createWriteStream(filePath);
            req.pipe(writeStream);

            writeStream.on('finish', () => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
                console.log(`[Tiles] Saved ${subPath} for topic ${topic}`);
            });

            writeStream.on('error', (writeErr) => {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end(`Write error: ${writeErr.message}`);
            });
        });
        return;
    }

    // Endpoint: GET /tiles/:topic/... -> Serve map tile
    if (req.method === 'GET' && parts[0] === 'tiles' && parts.length >= 3) {
        const topic = parts[1];
        const subPathParts = parts.slice(2);
        const subPath = subPathParts.join('/');

        if (subPath.includes('..') || topic.includes('..')) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Invalid path');
            return;
        }

        const filePath = path.join(__dirname, 'tiles', topic, ...subPathParts);
        fs.access(filePath, fs.constants.F_OK, (err) => {
            if (err) {
                res.writeHead(404, { 'Content-Type': 'image/png' });
                res.end(''); // return empty transparent or just 404
                return;
            }
            res.writeHead(200, { 'Content-Type': 'image/png' });
            fs.createReadStream(filePath).pipe(res);
        });
        return;
    }

    // Endpoint: GET /:topic/json -> SSE subscription compatible with ntfy.sh
    if (req.method === 'GET' && parts.length === 2 && parts[1] === 'json') {
        const topic = parts[0];
        const isSse = req.headers.accept && req.headers.accept.includes('text/event-stream');

        if (isSse) {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive'
            });
            res.isSse = true;
            console.log(`[SSE] Browser subscriber joined room (SSE): ${topic}.`);
            res.write('event: open\ndata: {"status":"connected"}\n\n');
        } else {
            res.writeHead(200, {
                'Content-Type': 'application/x-ndjson; charset=utf-8',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive'
            });
            res.isNdjson = true;
            console.log(`[SSE] Subscriber joined room (NDJSON): ${topic}.`);
            res.write('{"event":"open"}\n');
        }

        if (!subscribers[topic]) {
            subscribers[topic] = [];
        }
        subscribers[topic].push(res);

        // Keep-alive interval (15s)
        const pingInterval = setInterval(() => {
            if (res.isSse) {
                res.write('event: keepalive\ndata: {}\n\n');
            } else {
                res.write('{"event":"keepalive"}\n');
            }
        }, 15000);

        req.on('close', () => {
            clearInterval(pingInterval);
            subscribers[topic] = subscribers[topic].filter(client => client !== res);
            console.log(`[SSE] Subscriber left room: ${topic}. Remaining: ${subscribers[topic].length}`);
        });
        return;
    }

    // Endpoint: POST /:topic -> Publish player position compatible with ntfy.sh
    if (req.method === 'POST' && parts.length === 1) {
        const topic = parts[0];
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                if (data && data.worldKey) {
                    registerWorld(topic, data.worldKey);
                    updateActivePlayers(data.worldKey, data);
                }
            } catch (err) {
                // Ignore parsing errors
            }

            const list = subscribers[topic];
            if (list && list.length > 0) {
                const ndjsonPayload = JSON.stringify({
                    event: "message",
                    message: body
                }) + '\n';
                
                const ssePayload = `event: message\ndata: ${JSON.stringify({ event: "message", message: body })}\n\n`;

                list.forEach(client => {
                    try {
                        if (client.isSse) {
                            client.write(ssePayload);
                        } else {
                            client.write(ndjsonPayload);
                        }
                    } catch (err) {
                        // Dead connection
                    }
                });
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
        });
        return;
    }

    // Endpoint: GET /api/worlds -> Get list of all worlds that have uploaded tiles or are registered
    if (req.method === 'GET' && parts.length === 2 && parts[0] === 'api' && parts[1] === 'worlds') {
        const tilesBase = path.join(__dirname, 'tiles');
        const dbWorlds = getRegisteredWorlds();
        const resultsMap = new Map();
        
        // Add database worlds first
        dbWorlds.forEach(w => {
            resultsMap.set(`${w.topic}:${w.worldKey}`, { topic: w.topic, worldKey: w.worldKey });
        });

        const sendResponse = () => {
            const results = Array.from(resultsMap.values()).map(w => {
                const onlinePlayers = getActivePlayers(w.worldKey);
                return {
                    topic: w.topic,
                    worldKey: w.worldKey,
                    onlineCount: onlinePlayers.length,
                    onlinePlayers: onlinePlayers.map(p => ({ uuid: p.uuid, name: p.name }))
                };
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(results));
        };

        fs.access(tilesBase, fs.constants.F_OK, (err) => {
            if (err) {
                sendResponse();
                return;
            }
            fs.readdir(tilesBase, { withFileTypes: true }, (readErr, files) => {
                if (readErr || !files) {
                    sendResponse();
                    return;
                }

                const topics = files.filter(dirent => dirent.isDirectory()).map(dirent => dirent.name);
                let pendingTopics = topics.length;

                if (pendingTopics === 0) {
                    sendResponse();
                    return;
                }

                topics.forEach(topic => {
                    const topicDir = path.join(tilesBase, topic);
                    fs.readdir(topicDir, { withFileTypes: true }, (topicErr, subFiles) => {
                        if (!topicErr && subFiles) {
                            const worldKeys = subFiles.filter(dirent => dirent.isDirectory()).map(dirent => dirent.name);
                            worldKeys.forEach(worldKey => {
                                resultsMap.set(`${topic}:${worldKey}`, { topic, worldKey });
                            });
                        }

                        pendingTopics--;
                        if (pendingTopics === 0) {
                            sendResponse();
                        }
                    });
                });
            });
        });
        return;
    }

    // Endpoint: GET /api/chunks -> Get list of uploaded chunks for a worldKey
    if (req.method === 'GET' && parts.length === 2 && parts[0] === 'api' && parts[1] === 'chunks') {
        const topic = url.searchParams.get('topic');
        const worldKey = url.searchParams.get('worldKey');

        if (!topic || topic.includes('..')) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('[]');
            return;
        }

        const getChunks = (wKey) => {
            const worldFolder = path.join(__dirname, 'tiles', topic, wKey);
            fs.readdir(worldFolder, (err, files) => {
                if (err || !files) {
                    res.writeHead(200, { 
                        'Content-Type': 'application/json',
                        'X-World-Key': wKey,
                        'Access-Control-Expose-Headers': 'X-World-Key'
                    });
                    res.end('[]');
                    return;
                }

                const chunkFiles = files.filter(name => name.startsWith('chunk_') && name.endsWith('.png'));
                const list = [];

                let pending = chunkFiles.length;
                if (pending === 0) {
                    res.writeHead(200, { 
                        'Content-Type': 'application/json',
                        'X-World-Key': wKey,
                        'Access-Control-Expose-Headers': 'X-World-Key'
                    });
                    res.end('[]');
                    return;
                }

                chunkFiles.forEach(name => {
                    const filePath = path.join(worldFolder, name);
                    fs.stat(filePath, (statErr, stats) => {
                        if (!statErr && stats) {
                            const coords = name.substring(6, name.length - 4); // cx_cz
                            const coordParts = coords.split('_');
                            if (coordParts.length === 2) {
                                const cx = parseInt(coordParts[0]);
                                const cz = parseInt(coordParts[1]);
                                const lastModified = stats.mtimeMs;
                                list.push([cx, cz, lastModified]);
                            }
                        }

                        pending--;
                        if (pending === 0) {
                            res.writeHead(200, { 
                                'Content-Type': 'application/json',
                                'X-World-Key': wKey,
                                'Access-Control-Expose-Headers': 'X-World-Key'
                            });
                            res.end(JSON.stringify(list));
                        }
                    });
                });
            });
        };

        if (worldKey && !worldKey.includes('..')) {
            getChunks(worldKey);
        } else {
            // Find the most recently modified subfolder in tiles/topic/
            const topicFolder = path.join(__dirname, 'tiles', topic);
            fs.readdir(topicFolder, { withFileTypes: true }, (err, files) => {
                if (err || !files) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end('[]');
                    return;
                }

                const folders = files.filter(dirent => dirent.isDirectory());
                if (folders.length === 0) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end('[]');
                    return;
                }

                let pending = folders.length;
                let latestFolder = null;
                let latestMtime = 0;

                folders.forEach(f => {
                    const folderPath = path.join(topicFolder, f.name);
                    fs.stat(folderPath, (statErr, stats) => {
                        if (!statErr && stats) {
                            if (stats.mtimeMs > latestMtime) {
                                latestMtime = stats.mtimeMs;
                                latestFolder = f.name;
                            }
                        }
                        pending--;
                        if (pending === 0) {
                            if (latestFolder) {
                                getChunks(latestFolder);
                            } else {
                                getChunks(folders[0].name);
                            }
                        }
                    });
                });
            });
        }
        return;
    }

    // Endpoint: GET /api/players -> Get active players for a worldKey
    if (req.method === 'GET' && parts.length === 2 && parts[0] === 'api' && parts[1] === 'players') {
        const worldKey = url.searchParams.get('worldKey');
        if (!worldKey) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing worldKey' }));
            return;
        }
        const players = getActivePlayers(worldKey);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(players));
        return;
    }

    // Endpoint: GET /web/* or GET / -> Serve static website files
    if (req.method === 'GET') {
        let filePath = pathname;
        if (filePath === '/' || filePath === '/index.html') {
            filePath = '/web/index.html';
        } else if (!filePath.startsWith('/web/')) {
            filePath = '/web' + filePath;
        }

        const relativePath = filePath.substring(1);
        const resolvedPath = path.resolve(__dirname, relativePath);

        // Path traversal protection
        if (!resolvedPath.startsWith(path.resolve(__dirname, 'web'))) {
            res.writeHead(403, { 'Content-Type': 'text/plain' });
            res.end('Forbidden');
            return;
        }

        fs.access(resolvedPath, fs.constants.F_OK, (err) => {
            if (err) {
                // If not found in /web, try serving a 404 or index
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('Not Found');
                return;
            }

            let contentType = 'text/plain';
            if (resolvedPath.endsWith('.html')) contentType = 'text/html; charset=utf-8';
            else if (resolvedPath.endsWith('.css')) contentType = 'text/css; charset=utf-8';
            else if (resolvedPath.endsWith('.js')) contentType = 'application/javascript; charset=utf-8';
            else if (resolvedPath.endsWith('.png')) contentType = 'image/png';
            else if (resolvedPath.endsWith('.ico')) contentType = 'image/x-icon';

            res.writeHead(200, { 'Content-Type': contentType });
            fs.createReadStream(resolvedPath).pipe(res);
        });
        return;
    }

    res.writeHead(404);
    res.end('Not Found');
});

server.listen(PORT, () => {
    console.log(`OptiMC Coop Relay Server is running on port ${PORT}`);
});
