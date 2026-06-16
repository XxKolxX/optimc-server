const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const subscribers = {}; // topic -> list of Response objects

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
        res.writeHead(200, {
            'Content-Type': 'application/x-ndjson; charset=utf-8',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        });

        if (!subscribers[topic]) {
            subscribers[topic] = [];
        }
        subscribers[topic].push(res);
        console.log(`[SSE] Subscriber joined room: ${topic}. Total subscribers: ${subscribers[topic].length}`);

        // Keep-alive interval (15s)
        res.write('{"event":"open"}\n');
        const pingInterval = setInterval(() => {
            res.write('{"event":"keepalive"}\n');
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
            const list = subscribers[topic];
            if (list && list.length > 0) {
                const payload = JSON.stringify({
                    event: "message",
                    message: body
                }) + '\n';

                list.forEach(client => {
                    try {
                        client.write(payload);
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

    // Endpoint: GET /api/chunks -> Get list of uploaded chunks for a worldKey
    if (req.method === 'GET' && parts.length === 2 && parts[0] === 'api' && parts[1] === 'chunks') {
        const topic = url.searchParams.get('topic');
        const worldKey = url.searchParams.get('worldKey');

        if (!topic || !worldKey || topic.includes('..') || worldKey.includes('..')) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('[]');
            return;
        }

        const worldFolder = path.join(__dirname, 'tiles', topic, worldKey);
        fs.readdir(worldFolder, (err, files) => {
            if (err || !files) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end('[]');
                return;
            }

            const chunkFiles = files.filter(name => name.startsWith('chunk_') && name.endsWith('.png'));
            const list = [];

            let pending = chunkFiles.length;
            if (pending === 0) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
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
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify(list));
                    }
                });
            });
        });
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
