// Canvas roundRect Polyfill for compatibility with older browsers
if (typeof CanvasRenderingContext2D !== 'undefined' && !CanvasRenderingContext2D.prototype.roundRect) {
    CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
        if (typeof r === 'undefined') r = 0;
        if (typeof r === 'number') {
            r = {tl: r, tr: r, br: r, bl: r};
        } else {
            var defaultRadius = {tl: 0, tr: 0, br: 0, bl: 0};
            for (var side in defaultRadius) {
                r[side] = r[side] || defaultRadius[side];
            }
        }
        this.beginPath();
        this.moveTo(x + r.tl, y);
        this.lineTo(x + w - r.tr, y);
        this.quadraticCurveTo(x + w, y, x + w, y + r.tr);
        this.lineTo(x + w, y + h - r.br);
        this.quadraticCurveTo(x + w, y + h, x + w - r.br, y + h);
        this.lineTo(x + r.bl, y + h);
        this.quadraticCurveTo(x, y + h, x, y + h - r.bl);
        this.lineTo(x, y + r.tl);
        this.quadraticCurveTo(x, y, x + r.tl, y);
        this.closePath();
        return this;
    };
}

// Cloud Mode Detection & Topic
const isCloudMode = (window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1' && window.location.hostname !== '[::1]');
const urlParams = new URLSearchParams(window.location.search);
let currentTopic = urlParams.get('topic') || '';
let sseSource = null;
window.OptiMC_sharingServer = '';
let myCloudUuid = localStorage.getItem('optimc_my_cloud_uuid') || '';

// State Variables
let state = {
    active: false,
    worldKey: '',
    dimension: 'overworld',
    player: { name: '', uuid: '', x: 0, y: 0, z: 0, yaw: 0, health: 20 },
    players: [],
    sharedPeers: [],
    focusedPlayerUuid: null,
    chunks: [],
    tabPressed: false // Received in status API when TAB list key is held in MC
};

// Size adjustments state
let sizes = {
    nick: 11,
    dot: 8,
    arrow: 14,
    hp: 3,
    pipScale: 100,
    zoomStep: 0.5,
    holdZoom: 0.8
};

// Keybindings zoom state
let lastZoomInState = false;
let lastZoomOutState = false;
let isHoldingZoom = false;
let originalZoomVal = null;
let originalPipZoomVal = null;

// Canvas Configuration
const canvas = document.getElementById('map-canvas');
const ctx = canvas.getContext('2d');

let view = {
    x: 0, // Centered world coordinate (in blocks)
    z: 0,
    zoom: 2.0, // Pixels per block
    minZoom: 0.1,
    maxZoom: 15.0,
    isDragging: false,
    dragStart: { x: 0, y: 0 },
    dragOffset: { x: 0, y: 0 },
    autoCenter: true
};

// Image Caches
const tileCache = {}; // Key: "cx_cz", Value: { img, lastModified, status }
const avatarCache = {}; // Key: "uuid", Value: Image object

// Document Picture-in-Picture window variables
let pipWindow = null;
let pipCanvas = null;
let pipCtx = null;
let pipZoom = 2.0;

// Active Tab Handler
const tabs = {
    'tab-map': document.getElementById('map-controls'),
    'tab-waypoints': document.getElementById('waypoints-controls'),
    'tab-settings': document.getElementById('settings-controls'),
    'tab-help': document.getElementById('help-controls')
};

Object.keys(tabs).forEach(tabId => {
    const btn = document.getElementById(tabId);
    if (btn) {
        btn.addEventListener('click', () => {
            // Remove active from all tabs
            Object.keys(tabs).forEach(id => {
                const b = document.getElementById(id);
                if (b) b.classList.remove('active');
                if (tabs[id]) tabs[id].style.display = 'none';
            });
            // Add active to clicked
            btn.classList.add('active');
            if (tabs[tabId]) tabs[tabId].style.display = 'flex';
        });
    }
});

// Right-click context menu state & events
let contextMenuCoords = { x: 0, z: 0 };
const contextMenu = document.getElementById('map-context-menu');
const waypointModal = document.getElementById('waypoint-modal');

canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    
    // Calculate world block coordinates from clicked screen coordinates
    contextMenuCoords.x = Math.round(view.x + (mx - canvas.width / 2) / view.zoom);
    contextMenuCoords.z = Math.round(view.z + (my - canvas.height / 2) / view.zoom);
    
    contextMenu.style.left = `${e.clientX}px`;
    contextMenu.style.top = `${e.clientY}px`;
    contextMenu.style.display = 'block';
});

// Close context menu on click anywhere else
window.addEventListener('click', (e) => {
    if (e.target.closest('#map-context-menu')) return;
    contextMenu.style.display = 'none';
});

// Copy coords event
document.getElementById('menu-copy-coords').addEventListener('click', () => {
    const text = `${contextMenuCoords.x}, ${contextMenuCoords.z}`;
    navigator.clipboard.writeText(text).then(() => {
        const btn = document.getElementById('menu-copy-coords');
        const originalText = btn.innerText;
        btn.innerText = '✔️ Skopiowano!';
        setTimeout(() => {
            btn.innerText = originalText;
        }, 1500);
    }).catch(err => {
        console.error("Błąd kopiowania:", err);
    });
});

// Open Add Waypoint Modal
document.getElementById('menu-add-waypoint').addEventListener('click', () => {
    document.getElementById('waypoint-name').value = '';
    document.getElementById('waypoint-color').value = '#ef4444';
    waypointModal.style.display = 'flex';
});

// Modal events
document.getElementById('modal-cancel').addEventListener('click', () => {
    waypointModal.style.display = 'none';
});

document.getElementById('modal-save').addEventListener('click', () => {
    const nameInput = document.getElementById('waypoint-name').value.trim();
    const name = nameInput || `Waypoint (${contextMenuCoords.x}, ${contextMenuCoords.z})`;
    const color = document.getElementById('waypoint-color').value;
    
    addWaypoint({
        id: Date.now().toString(),
        name: name,
        x: contextMenuCoords.x,
        z: contextMenuCoords.z,
        dim: state.dimension,
        color: color
    });
    
    waypointModal.style.display = 'none';
});

// Waypoint Management
let waypoints = [];

// Load waypoints for active world key
function loadWaypoints() {
    if (!state.worldKey) return;
    try {
        const stored = localStorage.getItem(`optimc_waypoints_${state.worldKey}`);
        waypoints = stored ? JSON.parse(stored) : [];
    } catch (e) {
        waypoints = [];
    }
    renderWaypointList();
    syncWaypointsToBackend();
}

function saveWaypoints() {
    if (!state.worldKey) return;
    localStorage.setItem(`optimc_waypoints_${state.worldKey}`, JSON.stringify(waypoints));
    renderWaypointList();
    syncWaypointsToBackend();
}

function addWaypoint(wp) {
    waypoints.push(wp);
    saveWaypoints();
}

function deleteWaypoint(id) {
    const wpToDelete = waypoints.find(wp => wp.id === id);
    if (wpToDelete) {
        try {
            const storedDeleted = localStorage.getItem(`optimc_deleted_waypoints_${state.worldKey}`);
            let deletedIds = storedDeleted ? JSON.parse(storedDeleted) : [];
            if (!deletedIds.includes(wpToDelete.id)) {
                deletedIds.push(wpToDelete.id);
                localStorage.setItem(`optimc_deleted_waypoints_${state.worldKey}`, JSON.stringify(deletedIds));
            }
        } catch (e) {}
    }
    waypoints = waypoints.filter(wp => wp.id !== id);
    saveWaypoints();
}

async function syncWaypointsToBackend() {
    if (!state.active) return;
    try {
        await fetch('/api/waypoints', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(waypoints)
        });
    } catch (e) {
        console.error("Błąd synchronizacji waypointów z backendem:", e);
    }
}

function renderWaypointList() {
    const list = document.getElementById('waypoint-list');
    list.innerHTML = '';
    
    const activeWps = waypoints.filter(wp => wp.dim === state.dimension);
    
    if (activeWps.length === 0) {
        list.innerHTML = '<div class="waypoint-empty">Brak waypointów w tym wymiarze</div>';
        return;
    }
    
    activeWps.forEach(wp => {
        const item = document.createElement('div');
        item.className = 'waypoint-item';
        
        // Click to center
        item.addEventListener('click', (e) => {
            if (e.target.classList.contains('btn-delete-wp')) return;
            view.x = wp.x;
            view.z = wp.z;
            view.autoCenter = false;
            document.getElementById('btn-recenter').classList.remove('active');
        });
        
        item.innerHTML = `
            <div class="waypoint-color-indicator" style="background-color: ${wp.color};"></div>
            <div class="waypoint-info">
                <span class="waypoint-name">${wp.name}</span>
                <span class="waypoint-coords">X: ${wp.x}, Z: ${wp.z}</span>
            </div>
            <button class="btn-delete-wp" data-id="${wp.id}">✕</button>
        `;
        list.appendChild(item);
    });
    
    // Bind delete clicks
    list.querySelectorAll('.btn-delete-wp').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const id = btn.getAttribute('data-id');
            deleteWaypoint(id);
        });
    });
}

// Load settings from localStorage
function loadSettings() {
    const showHeight = localStorage.getItem('optimc_show_height');
    const showHp = localStorage.getItem('optimc_show_hp');
    const showGrid = localStorage.getItem('optimc_show_grid');
    const showWps = localStorage.getItem('optimc_show_waypoints');
    
    // PiP minimap settings
    const pipShowNames = localStorage.getItem('optimc_pip_show_names');
    const pipShowHeight = localStorage.getItem('optimc_pip_show_height');
    const pipShowHp = localStorage.getItem('optimc_pip_show_hp');
    const pipShowWps = localStorage.getItem('optimc_pip_show_waypoints');
    const pipShowWpNames = localStorage.getItem('optimc_pip_show_waypoint_names');

    if (showHeight !== null) document.getElementById('set-show-height').checked = (showHeight === 'true');
    if (showHp !== null) document.getElementById('set-show-hp').checked = (showHp === 'true');
    if (showGrid !== null) document.getElementById('set-show-grid').checked = (showGrid === 'true');
    if (showWps !== null) document.getElementById('set-show-waypoints').checked = (showWps === 'true');
    
    if (pipShowNames !== null) document.getElementById('set-pip-show-names').checked = (pipShowNames === 'true');
    if (pipShowHeight !== null) document.getElementById('set-pip-show-height').checked = (pipShowHeight === 'true');
    if (pipShowHp !== null) document.getElementById('set-pip-show-hp').checked = (pipShowHp === 'true');
    if (pipShowWps !== null) document.getElementById('set-pip-show-waypoints').checked = (pipShowWps === 'true');
    if (pipShowWpNames !== null) document.getElementById('set-pip-show-waypoint-names').checked = (pipShowWpNames === 'true');
}

// Bind change listeners to save settings
document.getElementById('set-show-height').addEventListener('change', (e) => {
    localStorage.setItem('optimc_show_height', e.target.checked);
});
document.getElementById('set-show-hp').addEventListener('change', (e) => {
    localStorage.setItem('optimc_show_hp', e.target.checked);
});
document.getElementById('set-show-grid').addEventListener('change', (e) => {
    localStorage.setItem('optimc_show_grid', e.target.checked);
});
document.getElementById('set-show-waypoints').addEventListener('change', (e) => {
    localStorage.setItem('optimc_show_waypoints', e.target.checked);
});

// PiP change listeners
document.getElementById('set-pip-show-names').addEventListener('change', (e) => {
    localStorage.setItem('optimc_pip_show_names', e.target.checked);
});
document.getElementById('set-pip-show-height').addEventListener('change', (e) => {
    localStorage.setItem('optimc_pip_show_height', e.target.checked);
});
document.getElementById('set-pip-show-hp').addEventListener('change', (e) => {
    localStorage.setItem('optimc_pip_show_hp', e.target.checked);
});
document.getElementById('set-pip-show-waypoints').addEventListener('change', (e) => {
    localStorage.setItem('optimc_pip_show_waypoints', e.target.checked);
});
document.getElementById('set-pip-show-waypoint-names').addEventListener('change', (e) => {
    localStorage.setItem('optimc_pip_show_waypoint_names', e.target.checked);
});

// Load sizes settings from localStorage
function loadSizes() {
    const nick = localStorage.getItem('optimc_size_nick');
    const dot = localStorage.getItem('optimc_size_dot');
    const arrow = localStorage.getItem('optimc_size_arrow');
    const hp = localStorage.getItem('optimc_size_hp');
    const pipScale = localStorage.getItem('optimc_size_pip_scale');
    const zoomStep = localStorage.getItem('optimc_size_zoom_step');
    const holdZoom = localStorage.getItem('optimc_size_hold_zoom');
    
    if (nick !== null) {
        sizes.nick = parseInt(nick);
        document.getElementById('size-nick').value = sizes.nick;
        document.getElementById('val-size-nick').innerText = sizes.nick + 'px';
    }
    if (dot !== null) {
        sizes.dot = parseInt(dot);
        document.getElementById('size-dot').value = sizes.dot;
        document.getElementById('val-size-dot').innerText = sizes.dot + 'px';
    }
    if (arrow !== null) {
        sizes.arrow = parseInt(arrow);
        document.getElementById('size-arrow').value = sizes.arrow;
        document.getElementById('val-size-arrow').innerText = sizes.arrow + 'px';
    }
    if (hp !== null) {
        sizes.hp = parseInt(hp);
        document.getElementById('size-hp').value = sizes.hp;
        document.getElementById('val-size-hp').innerText = sizes.hp + 'px';
    }
    if (pipScale !== null) {
        sizes.pipScale = parseInt(pipScale);
        document.getElementById('size-pip-scale').value = sizes.pipScale;
        document.getElementById('val-size-pip-scale').innerText = sizes.pipScale + '%';
    }
    if (zoomStep !== null) {
        sizes.zoomStep = parseFloat(zoomStep);
        document.getElementById('size-zoom-step').value = sizes.zoomStep;
        document.getElementById('val-size-zoom-step').innerText = sizes.zoomStep;
    }
    if (holdZoom !== null) {
        sizes.holdZoom = parseFloat(holdZoom);
        document.getElementById('size-hold-zoom').value = sizes.holdZoom;
        document.getElementById('val-size-hold-zoom').innerText = sizes.holdZoom;
    }
}

// Bind sizes input listeners
function setupSizeListeners() {
    const updateSize = (id, key, suffix = 'px') => {
        const input = document.getElementById(id);
        const valSpan = document.getElementById(`val-${id}`);
        input.addEventListener('input', (e) => {
            sizes[key] = parseInt(e.target.value);
            valSpan.innerText = sizes[key] + suffix;
            localStorage.setItem(`optimc_size_${key}`, sizes[key]);
        });
    };
    
    const updateFloatSize = (id, key) => {
        const input = document.getElementById(id);
        const valSpan = document.getElementById(`val-${id}`);
        input.addEventListener('input', (e) => {
            sizes[key] = parseFloat(e.target.value);
            valSpan.innerText = sizes[key];
            localStorage.setItem(`optimc_size_${key}`, sizes[key]);
        });
    };
    
    updateSize('size-nick', 'nick');
    updateSize('size-dot', 'dot');
    updateSize('size-arrow', 'arrow');
    updateSize('size-hp', 'hp');
    updateSize('size-pip-scale', 'pipScale', '%');
    updateFloatSize('size-zoom-step', 'zoomStep');
    updateFloatSize('size-hold-zoom', 'holdZoom');
}

// Cooperation (Sharing) Settings
async function loadSharingSettings() {
    try {
        const response = await fetch('/api/settings');
        const data = await response.json();
        document.getElementById('set-share-enabled').checked = data.sharingEnabled;
        const srv = data.sharingServer || 'https://ntfy.sp-codes.de/';
        document.getElementById('set-share-server').value = srv;
        window.OptiMC_sharingServer = srv;
    } catch (e) {
        console.error("Błąd podczas ładowania ustawień kooperacji:", e);
        window.OptiMC_sharingServer = 'https://ntfy.sp-codes.de/';
    }
}

async function saveSharingSettings() {
    const sharingEnabled = document.getElementById('set-share-enabled').checked;
    const sharingServer = document.getElementById('set-share-server').value;
    window.OptiMC_sharingServer = sharingServer;

    try {
        await fetch('/api/settings', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ sharingEnabled, sharingServer })
        });
    } catch (e) {
        console.error("Błąd podczas zapisywania ustawień kooperacji:", e);
    }
}

function setupSharingListeners() {
    document.getElementById('set-share-enabled').addEventListener('change', saveSharingSettings);
    document.getElementById('set-share-server').addEventListener('change', saveSharingSettings);

    const copyBtn = document.getElementById('btn-copy-share-link');
    if (copyBtn) {
        copyBtn.addEventListener('click', () => {
            const input = document.getElementById('share-link-url');
            if (input && input.value) {
                navigator.clipboard.writeText(input.value).then(() => {
                    const originalText = copyBtn.innerText;
                    copyBtn.innerText = "Skopiowano!";
                    copyBtn.style.background = "#10b981";
                    copyBtn.style.color = "#fff";
                    setTimeout(() => {
                        copyBtn.innerText = originalText;
                        copyBtn.style.background = "";
                        copyBtn.style.color = "";
                    }, 2000);
                }).catch(err => {
                    console.error("Nie udało się skopiować linku:", err);
                });
            }
        });
    }
}

// Floating Mini-map Window Setup (Picture-in-Picture)
async function openPipMinimap() {
    if ('documentPictureInPicture' in window) {
        try {
            // Request Pip Window (always stays on top)
            pipWindow = await window.documentPictureInPicture.requestWindow({
                width: 300,
                height: 300
            });
            setupPipWindow(pipWindow);
        } catch (err) {
            console.error("Dokument PiP został odrzucony lub wystąpił błąd:", err);
            fallbackPopupMinimap();
        }
    } else {
        fallbackPopupMinimap();
    }
}

function fallbackPopupMinimap() {
    const width = 300;
    const height = 300;
    const left = screen.width - width - 50;
    const top = 100;
    pipWindow = window.open('', 'OptiMC_Minimap', `width=${width},height=${height},left=${left},top=${top},menubar=no,toolbar=no,location=no,status=no`);
    if (pipWindow) {
        setupPipWindow(pipWindow);
    } else {
        alert("Wyskakujące okienka są zablokowane przez przeglądarkę! Zezwól na nie, aby otworzyć mini-mapę.");
    }
}

function setupPipWindow(win) {
    // Canvas roundRect Polyfill for PiP window context
    if (win.CanvasRenderingContext2D && !win.CanvasRenderingContext2D.prototype.roundRect) {
        win.CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
            if (typeof r === 'undefined') r = 0;
            if (typeof r === 'number') {
                r = {tl: r, tr: r, br: r, bl: r};
            } else {
                var defaultRadius = {tl: 0, tr: 0, br: 0, bl: 0};
                for (var side in defaultRadius) {
                    r[side] = r[side] || defaultRadius[side];
                }
            }
            this.beginPath();
            this.moveTo(x + r.tl, y);
            this.lineTo(x + w - r.tr, y);
            this.quadraticCurveTo(x + w, y, x + w, y + r.tr);
            this.lineTo(x + w, y + h - r.br);
            this.quadraticCurveTo(x + w, y + h, x + w - r.br, y + h);
            this.lineTo(x + r.bl, y + h);
            this.quadraticCurveTo(x, y + h, x, y + h - r.bl);
            this.lineTo(x, y + r.tl);
            this.quadraticCurveTo(x, y, x + r.tl, y);
            this.closePath();
            return this;
        };
    }

    // Load stylesheet links directly to avoid CORS issues
    const fontLink = win.document.createElement('link');
    fontLink.rel = 'stylesheet';
    fontLink.href = 'https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;800&display=swap';
    win.document.head.appendChild(fontLink);

    const link = win.document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'style.css';
    win.document.head.appendChild(link);

    // Custom CSS for PiP overlays
    const customStyle = win.document.createElement('style');
    customStyle.textContent = `
        body {
            margin: 0;
            padding: 0;
            overflow: hidden;
            background-color: #070913;
            font-family: 'Outfit', sans-serif;
            position: relative;
            width: 100vw;
            height: 100vh;
        }
        canvas {
            width: 100%;
            height: 100%;
            display: block;
        }
        .pip-overlay {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(7, 9, 19, 0.4);
            opacity: 0;
            transition: opacity 0.2s ease;
            display: flex;
            flex-direction: column;
            justify-content: space-between;
            padding: 10px;
            box-sizing: border-box;
            pointer-events: none;
        }
        body:hover .pip-overlay {
            opacity: 1;
            pointer-events: auto;
        }
        .pip-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            color: #f3f4f6;
            font-size: 0.8rem;
            font-weight: 600;
            text-shadow: 0 1px 4px rgba(0,0,0,0.8);
        }
        .pip-controls {
            display: flex;
            align-items: center;
            gap: 8px;
            background: rgba(13, 17, 30, 0.85);
            border: 1px solid rgba(255,255,255,0.08);
            padding: 6px 10px;
            border-radius: 8px;
            backdrop-filter: blur(8px);
        }
        .pip-controls button {
            background: transparent;
            border: none;
            color: #f3f4f6;
            font-size: 1rem;
            cursor: pointer;
            width: 20px;
            height: 20px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-weight: 800;
        }
        .pip-controls input[type="range"] {
            flex: 1;
            height: 4px;
            accent-color: #3b82f6;
            cursor: pointer;
        }
    `;
    win.document.head.appendChild(customStyle);

    // Build PiP Body
    win.document.body.innerHTML = `
        <canvas id="pip-canvas"></canvas>
        <div class="pip-overlay">
            <div class="pip-header">
                <span id="pip-dim">Overworld</span>
                <span id="pip-coords">X: 0, Z: 0</span>
            </div>
            <div class="pip-controls">
                <button id="pip-zoom-dec">-</button>
                <input type="range" id="pip-zoom-slider" min="0.5" max="8" step="0.1" value="${pipZoom}">
                <button id="pip-zoom-inc">+</button>
            </div>
        </div>
    `;

    // Cache elements
    pipCanvas = win.document.getElementById('pip-canvas');
    pipCtx = pipCanvas.getContext('2d');

    const pipZoomSlider = win.document.getElementById('pip-zoom-slider');
    const pipZoomDec = win.document.getElementById('pip-zoom-dec');
    const pipZoomInc = win.document.getElementById('pip-zoom-inc');

    // Load initial pip zoom from localStorage
    const savedPipZoom = localStorage.getItem('optimc_pip_zoom');
    if (savedPipZoom !== null) {
        pipZoom = parseFloat(savedPipZoom);
        pipZoomSlider.value = pipZoom;
    }

    pipZoomSlider.addEventListener('input', (e) => {
        pipZoom = parseFloat(e.target.value);
        localStorage.setItem('optimc_pip_zoom', pipZoom);
    });

    pipZoomDec.addEventListener('click', () => {
        pipZoom = Math.max(0.5, pipZoom - 0.5);
        pipZoomSlider.value = pipZoom;
        localStorage.setItem('optimc_pip_zoom', pipZoom);
    });

    pipZoomInc.addEventListener('click', () => {
        pipZoom = Math.min(8.0, pipZoom + 0.5);
        pipZoomSlider.value = pipZoom;
        localStorage.setItem('optimc_pip_zoom', pipZoom);
    });

    // Resize handlers
    const resizePipCanvas = () => {
        pipCanvas.width = win.innerWidth;
        pipCanvas.height = win.innerHeight;
    };
    win.addEventListener('resize', resizePipCanvas);
    resizePipCanvas();

    // Clean close
    win.addEventListener('unload', () => {
        pipWindow = null;
        pipCanvas = null;
        pipCtx = null;
    });
}

// Interpolation cache for players (enables 60fps sliding movements)
const interpolatedPlayers = {};

// Initialize Canvas Size
function resizeCanvas() {
    canvas.width = canvas.parentElement.clientWidth;
    canvas.height = canvas.parentElement.clientHeight;
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// Initial center
view.x = 0;
view.z = 0;

// Mouse Drag/Pan Events
canvas.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return; // Only drag with left click
    view.isDragging = true;
    view.dragStart.x = e.clientX;
    view.dragStart.y = e.clientY;
    view.autoCenter = false;
});

window.addEventListener('mousemove', (e) => {
    if (!view.isDragging) return;
    
    // Shift screen delta
    const dx = e.clientX - view.dragStart.x;
    const dz = e.clientY - view.dragStart.y;
    
    // Convert screen pixels to blocks
    view.x -= dx / view.zoom;
    view.z -= dz / view.zoom;
    
    view.dragStart.x = e.clientX;
    view.dragStart.y = e.clientY;
    
    document.getElementById('btn-recenter').classList.remove('active');
});

window.addEventListener('mouseup', () => {
    view.isDragging = false;
});

// Touch Drag Support (Mobile)
canvas.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) {
        view.isDragging = true;
        view.dragStart.x = e.touches[0].clientX;
        view.dragStart.y = e.touches[0].clientY;
        view.autoCenter = false;
    }
});

canvas.addEventListener('touchmove', (e) => {
    if (!view.isDragging || e.touches.length !== 1) return;
    const dx = e.touches[0].clientX - view.dragStart.x;
    const dz = e.touches[0].clientY - view.dragStart.y;
    
    view.x -= dx / view.zoom;
    view.z -= dz / view.zoom;
    
    view.dragStart.x = e.touches[0].clientX;
    view.dragStart.y = e.touches[0].clientY;
});

canvas.addEventListener('touchend', () => {
    view.isDragging = false;
});

// Mouse Wheel Zoom (Centers on Mouse Pointer)
canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    
    const zoomFactor = 1.1;
    const oldZoom = view.zoom;
    
    // Mouse world position before zoom
    const mouseX = e.clientX - canvas.getBoundingClientRect().left;
    const mouseY = e.clientY - canvas.getBoundingClientRect().top;
    
    const worldMouseX = view.x + (mouseX - canvas.width / 2) / oldZoom;
    const worldMouseZ = view.z + (mouseY - canvas.height / 2) / oldZoom;
    
    if (e.deltaY < 0) {
        view.zoom = Math.min(view.maxZoom, view.zoom * zoomFactor);
    } else {
        view.zoom = Math.max(view.minZoom, view.zoom / zoomFactor);
    }
    
    // Adjust view center so mouse pointer stays in the same world position
    view.x = worldMouseX - (mouseX - canvas.width / 2) / view.zoom;
    view.z = worldMouseZ - (mouseY - canvas.height / 2) / view.zoom;
    
    updateZoomPercent();
});

// Zoom UI Buttons
document.getElementById('zoom-in').addEventListener('click', () => {
    view.zoom = Math.min(view.maxZoom, view.zoom * 1.3);
    updateZoomPercent();
});

document.getElementById('zoom-out').addEventListener('click', () => {
    view.zoom = Math.max(view.minZoom, view.zoom / 1.3);
    updateZoomPercent();
});

function updateZoomPercent() {
    document.getElementById('zoom-percent').innerText = Math.round(view.zoom * 50) + '%';
}
updateZoomPercent();

// Mouse Move Coordinates display
canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    
    // Convert screen coordinates to world coordinates
    const worldX = Math.round(view.x + (mx - canvas.width / 2) / view.zoom);
    const worldZ = Math.round(view.z + (my - canvas.height / 2) / view.zoom);
    
    document.getElementById('mouse-coords').innerText = `X: ${worldX}, Z: ${worldZ}`;
});

// Recenter Button
document.getElementById('btn-recenter').addEventListener('click', () => {
    view.autoCenter = true;
    state.focusedPlayerUuid = state.player.uuid;
    document.getElementById('btn-recenter').classList.add('active');
    updatePlayerFocusUI();
});

// Clear Map Button
document.getElementById('btn-clear-map').addEventListener('click', async () => {
    if (confirm("Czy na pewno chcesz wyczyścić mapę dla tego świata? Te zmiany są nieodwracalne!")) {
        try {
            const response = await fetch('/api/clear');
            const data = await response.json();
            if (data.success) {
                // Clear local caches
                for (let key in tileCache) delete tileCache[key];
                state.chunks = [];
                // Recenter
                view.x = state.player.x;
                view.z = state.player.z;
                // Redraw
                await fetchChunks();
            }
        } catch (e) {
            alert("Błąd podczas czyszczenia mapy.");
        }
    }
});

// Dynamic Player Selection
function focusOnPlayer(uuid) {
    state.focusedPlayerUuid = uuid;
    view.autoCenter = true;
    updatePlayerFocusUI();
}

function updatePlayerFocusUI() {
    const items = document.querySelectorAll('.player-item');
    items.forEach(item => {
        if (item.getAttribute('data-uuid') === state.focusedPlayerUuid) {
            item.classList.add('focused');
        } else {
            item.classList.remove('focused');
        }
    });
}

function updatePipZoomSlider() {
    if (pipWindow) {
        const slider = pipWindow.document.getElementById('pip-zoom-slider');
        if (slider) {
            slider.value = pipZoom;
        }
    }
}

function handleZoomKeys(data) {
    if (!data.active) return;

    // Zoom In key
    if (data.zoomInPressed && !lastZoomInState) {
        if (isHoldingZoom && originalZoomVal !== null) {
            originalZoomVal = Math.min(view.maxZoom, originalZoomVal + sizes.zoomStep);
            originalPipZoomVal = Math.min(8.0, originalPipZoomVal + sizes.zoomStep);
            view.zoom = Math.min(view.maxZoom, view.zoom + sizes.zoomStep);
            pipZoom = Math.min(8.0, pipZoom + sizes.zoomStep);
        } else {
            view.zoom = Math.min(view.maxZoom, view.zoom + sizes.zoomStep);
            pipZoom = Math.min(8.0, pipZoom + sizes.zoomStep);
        }
        updateZoomPercent();
        updatePipZoomSlider();
        localStorage.setItem('optimc_pip_zoom', pipZoom);
    }
    lastZoomInState = data.zoomInPressed;

    // Zoom Out key
    if (data.zoomOutPressed && !lastZoomOutState) {
        if (isHoldingZoom && originalZoomVal !== null) {
            originalZoomVal = Math.max(view.minZoom, originalZoomVal - sizes.zoomStep);
            originalPipZoomVal = Math.max(0.5, originalPipZoomVal - sizes.zoomStep);
            view.zoom = Math.max(view.minZoom, view.zoom - sizes.zoomStep);
            pipZoom = Math.max(0.5, pipZoom - sizes.zoomStep);
        } else {
            view.zoom = Math.max(view.minZoom, view.zoom - sizes.zoomStep);
            pipZoom = Math.max(0.5, pipZoom - sizes.zoomStep);
        }
        updateZoomPercent();
        updatePipZoomSlider();
        localStorage.setItem('optimc_pip_zoom', pipZoom);
    }
    lastZoomOutState = data.zoomOutPressed;

    // Zoom Hold key
    if (data.zoomHoldPressed && !isHoldingZoom) {
        isHoldingZoom = true;
        originalZoomVal = view.zoom;
        originalPipZoomVal = pipZoom;
        view.zoom = Math.max(view.minZoom, view.zoom / (1 + sizes.holdZoom));
        pipZoom = Math.max(0.5, pipZoom / (1 + sizes.holdZoom));
        updateZoomPercent();
        updatePipZoomSlider();
    } else if (!data.zoomHoldPressed && isHoldingZoom) {
        isHoldingZoom = false;
        if (originalZoomVal !== null) {
            view.zoom = originalZoomVal;
        }
        if (originalPipZoomVal !== null) {
            pipZoom = originalPipZoomVal;
        }
        originalZoomVal = null;
        originalPipZoomVal = null;
        updateZoomPercent();
        updatePipZoomSlider();
    }
}

function syncSharedWaypoints(peers) {
    if (!peers || peers.length === 0 || !state.worldKey) return;
    
    let deletedIds = [];
    try {
        const storedDeleted = localStorage.getItem(`optimc_deleted_waypoints_${state.worldKey}`);
        deletedIds = storedDeleted ? JSON.parse(storedDeleted) : [];
    } catch (e) {}
    
    let changed = false;
    
    peers.forEach(peer => {
        if (!peer.waypoints) return;
        
        peer.waypoints.forEach(wp => {
            const alreadyExists = waypoints.some(localWp => 
                localWp.id === wp.id || 
                (localWp.dim === wp.dim && Math.abs(localWp.x - wp.x) < 1.5 && Math.abs(localWp.z - wp.z) < 1.5)
            );
            
            const isDeleted = deletedIds.includes(wp.id);
            
            if (!alreadyExists && !isDeleted) {
                const wpName = wp.name || "Waypoint";
                const importedName = wpName.startsWith(`[${peer.name}]`) ? wpName : `[${peer.name}] ${wpName}`;
                waypoints.push({
                    id: wp.id,
                    name: importedName,
                    x: wp.x,
                    z: wp.z,
                    dim: wp.dim,
                    color: wp.color
                });
                changed = true;
            }
        });
    });
    
    if (changed) {
        saveWaypoints();
    }
}

// API Polling Loop (fetches stats every 250ms)
async function pollStatus() {
    try {
        const response = await fetch('/api/status');
        const data = await response.json();
        
        if (data.active) {
            const worldChanged = state.worldKey !== data.worldKey;
            const dimChanged = state.dimension !== data.dimension;
            
            state.active = true;
            state.worldKey = data.worldKey;
            state.dimension = data.dimension;
            state.player = data.player;
            state.players = data.players;
            state.sharedPeers = data.sharedPeers || [];
            syncSharedWaypoints(state.sharedPeers);
            state.tabPressed = data.tabPressed; // Track if Tab is pressed in Minecraft client
            
            handleZoomKeys(data);
            
            document.getElementById('connection-status').innerText = "Live";
            document.getElementById('connection-status').className = "status-badge online";
            
            // Display share link if custom server
            if (data.topic && window.OptiMC_sharingServer) {
                const shareServer = window.OptiMC_sharingServer.trim();
                if (shareServer && !shareServer.includes('ntfy')) {
                    const shareUrl = shareServer + (shareServer.endsWith('/') ? '' : '/') + "?topic=" + data.topic;
                    const shareInput = document.getElementById('share-link-url');
                    const shareGroup = document.getElementById('group-share-link');
                    if (shareInput && shareGroup) {
                        shareInput.value = shareUrl;
                        shareGroup.style.display = 'block';
                    }
                } else {
                    const shareGroup = document.getElementById('group-share-link');
                    if (shareGroup) shareGroup.style.display = 'none';
                }
            } else {
                const shareGroup = document.getElementById('group-share-link');
                if (shareGroup) shareGroup.style.display = 'none';
            }

            // Set focused player to local player by default
            if (!state.focusedPlayerUuid) {
                state.focusedPlayerUuid = state.player.uuid;
            }
            
            // Update Coordinates display in footer
            document.getElementById('local-coords').innerText = `X: ${Math.round(state.player.x)} | Y: ${Math.round(state.player.y)} | Z: ${Math.round(state.player.z)}`;
            
            // Highlight current dimension button
            updateDimensionUI();
            
            // If the world key changed, clear tile caches and fetch chunk listing
            if (worldChanged) {
                for (let key in tileCache) delete tileCache[key];
                state.chunks = [];
                await fetchChunks();
                loadWaypoints();
            } else if (dimChanged) {
                renderWaypointList();
            }
            
            // Build Player list UI
            renderPlayerList();
        } else {
            setOffline();
        }
    } catch (e) {
        setOffline();
    }
}

function setOffline() {
    state.active = false;
    document.getElementById('connection-status').innerText = "Offline";
    document.getElementById('connection-status').className = "status-badge offline";
}

async function fetchChunks() {
    if (!state.worldKey && (!isCloudMode || !currentTopic)) return;
    try {
        const url = isCloudMode 
            ? `/api/chunks?topic=${currentTopic}` + (state.worldKey ? `&worldKey=${state.worldKey}` : '')
            : `/api/chunks?worldKey=${state.worldKey}`;
        const response = await fetch(url);
        
        const worldKeyHeader = response.headers.get('X-World-Key');
        if (worldKeyHeader && state.worldKey !== worldKeyHeader) {
            const oldWorldKey = state.worldKey;
            state.worldKey = worldKeyHeader;
            if (oldWorldKey) {
                for (let key in tileCache) delete tileCache[key];
            }
        }
        
        state.chunks = await response.json();
    } catch (e) {
        // Ignore
    }
}

// Polling interval tasks
setInterval(pollStatus, 100);
setInterval(fetchChunks, 2000); // refresh list of chunks every 2 seconds

// Dimension Button Visual styling
function updateDimensionUI() {
    const dims = ['overworld', 'the_nether', 'the_end'];
    dims.forEach(d => {
        const btn = document.getElementById(`dim-btn-${d}`) || document.getElementById(`dim-${d.replace('the_', '')}`);
        if (btn) {
            if (state.dimension === d) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        }
    });
}

function renderPlayerList() {
    const list = document.getElementById('player-list');
    
    // Collect all target players in order
    let targetPlayers = [];
    
    // Local player
    targetPlayers.push({
        uuid: state.player.uuid,
        name: state.player.name,
        x: state.player.x,
        y: state.player.y,
        z: state.player.z,
        health: state.player.health,
        type: 'local'
    });
    
    // 1. Friends (shared peers)
    if (state.sharedPeers) {
        state.sharedPeers.forEach(peer => {
            if (peer.dimension === state.dimension) {
                targetPlayers.push({
                    uuid: peer.uuid,
                    name: peer.name,
                    x: peer.x,
                    y: peer.y,
                    z: peer.z,
                    health: peer.health,
                    type: 'friend'
                });
            }
        });
    }

    // 2. Other players in render distance (who are not friends)
    state.players.forEach(p => {
        const isFriend = state.sharedPeers && state.sharedPeers.some(f => f.uuid === p.uuid);
        if (!isFriend) {
            targetPlayers.push({
                uuid: p.uuid,
                name: p.name,
                x: p.x,
                y: p.y,
                z: p.z,
                health: p.health,
                type: 'other'
            });
        }
    });

    // 3. Remote players (seen by friends)
    if (state.sharedPeers) {
        state.sharedPeers.forEach(peer => {
            peer.seenPlayers.forEach(sp => {
                const isLocal = sp.uuid === state.player.uuid;
                const isLocalOther = state.players.some(x => x.uuid === sp.uuid);
                const isFriend = state.sharedPeers.some(x => x.uuid === sp.uuid);
                if (!isLocal && !isLocalOther && !isFriend) {
                    targetPlayers.push({
                        uuid: sp.uuid,
                        name: sp.name,
                        x: sp.x,
                        y: sp.y,
                        z: sp.z,
                        health: sp.health,
                        type: 'remote'
                    });
                }
            });
        });
    }
    
    const items = list.querySelectorAll('.player-item');
    let needsRebuild = false;
    
    if (items.length !== targetPlayers.length) {
        needsRebuild = true;
    } else {
        for (let i = 0; i < items.length; i++) {
            if (items[i].getAttribute('data-uuid') !== targetPlayers[i].uuid) {
                needsRebuild = true;
                break;
            }
        }
    }
    
    if (needsRebuild) {
        list.innerHTML = '';
        targetPlayers.forEach(p => {
            if (p.type === 'local') {
                addPlayerToUI(p, true);
            } else if (p.type === 'other') {
                addPlayerToUI(p, false);
            } else if (p.type === 'friend') {
                addSharedPlayerToUI(p, true);
            } else if (p.type === 'remote') {
                addSharedPlayerToUI(p, false);
            }
        });
    } else {
        // Just update existing DOM elements to avoid hover & event loss
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const p = targetPlayers[i];

            // 0. Update Name if out of sync
            const nameSpan = item.querySelector('.player-name');
            if (nameSpan) {
                let nameText = p.name;
                if (p.type === 'local') {
                    nameText += ' (Ja)';
                } else if (p.type === 'friend') {
                    nameText += ' (znaj)';
                }
                if (nameSpan.textContent !== nameText) {
                    nameSpan.textContent = nameText;
                }
            }
            
            // 1. Focus class
            if (p.uuid === state.focusedPlayerUuid) {
                item.classList.add('focused');
            } else {
                item.classList.remove('focused');
            }
            
            // 2. Health bar
            const healthPercent = Math.max(0, Math.min(100, (p.health / 20.0) * 100));
            const fill = item.querySelector('.health-bar-fill');
            if (fill) {
                fill.style.width = `${healthPercent}%`;
            }
            
            // 3. Details/Coordinates
            const detailsDiv = item.querySelector('.player-details');
            if (detailsDiv) {
                const sourceLabel = p.type === 'friend' ? 
                    `<span style="font-size: 0.7rem; color: #60a5fa; border: 1px solid rgba(96,165,250,0.3); padding: 1px 4px; border-radius: 4px; background: rgba(96,165,250,0.1); font-weight:800;">Znajomy</span>` :
                    (p.type === 'remote' ? `<span style="font-size: 0.7rem; color: #a7f3d0; border: 1px solid rgba(167,243,208,0.3); padding: 1px 4px; border-radius: 4px; background: rgba(167,243,208,0.1); font-weight:800;">Zdalny</span>` : '');
                
                const setMeBtnHtml = (isCloudMode && p.type !== 'local') ? 
                    `<button class="btn-set-me" data-uuid="${p.uuid}" style="font-size: 0.7rem; margin-left: 6px; padding: 2px 6px; background: rgba(59, 130, 246, 0.15); border: 1px solid rgba(59, 130, 246, 0.3); border-radius: 4px; color: #60a5fa; cursor: pointer; font-weight: 800; transition: all 0.2s;">To ja</button>` : '';

                detailsDiv.innerHTML = `
                    <span>X: ${Math.round(p.x)} Z: ${Math.round(p.z)} (Y: ${Math.round(p.y)})</span>
                    <div style="display: flex; align-items: center; gap: 4px;">
                        ${sourceLabel}
                        ${setMeBtnHtml}
                    </div>
                `;
            }
            
            // 4. Relative height reference
            let focusedY = state.player.y;
            if (state.focusedPlayerUuid) {
                if (state.focusedPlayerUuid === state.player.uuid) {
                    focusedY = state.player.y;
                } else {
                    const fp = targetPlayers.find(x => x.uuid === state.focusedPlayerUuid);
                    if (fp) focusedY = fp.y;
                }
            }
            const hDiff = p.y - focusedY;
            const heightSpan = item.querySelector('.player-height');
            if (heightSpan) {
                if (Math.abs(hDiff) <= 1.5) {
                    heightSpan.className = 'player-height height-same';
                    heightSpan.innerHTML = '● =';
                } else if (hDiff > 1.5) {
                    heightSpan.className = 'player-height height-higher';
                    heightSpan.innerHTML = `▲ +${Math.round(hDiff)}m`;
                } else {
                    heightSpan.className = 'player-height height-lower';
                    heightSpan.innerHTML = `▼ ${Math.round(hDiff)}m`;
                }
            }
        }
    }
    
    // Bind "To ja" button clicks
    list.querySelectorAll('.btn-set-me').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const uuid = btn.getAttribute('data-uuid');
            myCloudUuid = uuid;
            localStorage.setItem('optimc_my_cloud_uuid', myCloudUuid);
            state.player = null;
            state.sharedPeers = [];
            state.focusedPlayerUuid = myCloudUuid;
            renderPlayerList();
        });
    });
    
    updatePlayerFocusUI();
}

function addSharedPlayerToUI(p, isFriend) {
    const list = document.getElementById('player-list');
    
    let focusedY = state.player.y;
    if (state.focusedPlayerUuid) {
        if (state.focusedPlayerUuid === state.player.uuid) focusedY = state.player.y;
        else {
            const fp = state.players.find(x => x.uuid === state.focusedPlayerUuid) || 
                       (state.sharedPeers && state.sharedPeers.find(x => x.uuid === state.focusedPlayerUuid)) ||
                       (state.sharedPeers && state.sharedPeers.flatMap(peer => peer.seenPlayers).find(x => x.uuid === state.focusedPlayerUuid));
            if (fp) focusedY = fp.y;
        }
    }
    
    let relativeHeightHtml = '';
    const hDiff = p.y - focusedY;
    if (Math.abs(hDiff) <= 1.5) {
        relativeHeightHtml = `<span class="player-height height-same">● =</span>`;
    } else if (hDiff > 1.5) {
        relativeHeightHtml = `<span class="player-height height-higher">▲ +${Math.round(hDiff)}m</span>`;
    } else {
        relativeHeightHtml = `<span class="player-height height-lower">▼ ${Math.round(hDiff)}m</span>`;
    }
    
    if (!avatarCache[p.uuid]) {
        avatarCache[p.uuid] = new Image();
        avatarCache[p.uuid].src = `https://mc-heads.net/avatar/${p.uuid}/32`;
        avatarCache[p.uuid].onerror = () => {
            avatarCache[p.uuid].failed = true;
        };
    }
    
    const item = document.createElement('div');
    item.className = 'player-item';
    item.setAttribute('data-uuid', p.uuid);
    if (p.uuid === state.focusedPlayerUuid) item.classList.add('focused');
    
    item.addEventListener('click', () => focusOnPlayer(p.uuid));
    
    const healthPercent = Math.max(0, Math.min(100, (p.health / 20.0) * 100));
    
    const sourceLabel = isFriend ? 
        `<span style="font-size: 0.7rem; color: #60a5fa; border: 1px solid rgba(96,165,250,0.3); padding: 1px 4px; border-radius: 4px; background: rgba(96,165,250,0.1); font-weight:800;">Znajomy</span>` :
        `<span style="font-size: 0.7rem; color: #a7f3d0; border: 1px solid rgba(167,243,208,0.3); padding: 1px 4px; border-radius: 4px; background: rgba(167,243,208,0.1); font-weight:800;">Zdalny</span>`;

    const setMeBtnHtml = isCloudMode ? 
        `<button class="btn-set-me" data-uuid="${p.uuid}" style="font-size: 0.7rem; margin-left: 6px; padding: 2px 6px; background: rgba(59, 130, 246, 0.15); border: 1px solid rgba(59, 130, 246, 0.3); border-radius: 4px; color: #60a5fa; cursor: pointer; font-weight: 800; transition: all 0.2s;">To ja</button>` : '';

    item.innerHTML = `
        <div class="player-avatar" style="background-image: url('https://mc-heads.net/avatar/${p.uuid}/32');"></div>
        <div class="player-info">
            <div class="player-name-row">
                <span class="player-name">${p.name}${isFriend ? ' (znaj)' : ''}</span>
                ${relativeHeightHtml}
            </div>
            <div class="player-details" style="display:flex; justify-content:space-between; align-items:center;">
                <span>X: ${Math.round(p.x)} Z: ${Math.round(p.z)} (Y: ${Math.round(p.y)})</span>
                <div style="display: flex; align-items: center; gap: 4px;">
                    ${sourceLabel}
                    ${setMeBtnHtml}
                </div>
            </div>
            <div class="health-bar-container">
                <div class="health-bar-fill" style="width: ${healthPercent}%"></div>
            </div>
        </div>
    `;
    list.appendChild(item);
}

function addPlayerToUI(p, isLocal) {
    const list = document.getElementById('player-list');
    
    // Get focused player height reference
    let focusedY = state.player.y;
    if (state.focusedPlayerUuid) {
        if (state.focusedPlayerUuid === state.player.uuid) focusedY = state.player.y;
        else {
            const fp = state.players.find(x => x.uuid === state.focusedPlayerUuid);
            if (fp) focusedY = fp.y;
        }
    }
    
    // Calculate relative height index
    let relativeHeightHtml = '';
    const hDiff = p.y - focusedY;
    if (Math.abs(hDiff) <= 1.5) {
        relativeHeightHtml = `<span class="player-height height-same">● =</span>`;
    } else if (hDiff > 1.5) {
        relativeHeightHtml = `<span class="player-height height-higher">▲ +${Math.round(hDiff)}m</span>`;
    } else {
        relativeHeightHtml = `<span class="player-height height-lower">▼ ${Math.round(hDiff)}m</span>`;
    }
    
    // Load avatar if not in cache
    if (!avatarCache[p.uuid]) {
        avatarCache[p.uuid] = new Image();
        avatarCache[p.uuid].src = `https://mc-heads.net/avatar/${p.uuid}/32`;
        avatarCache[p.uuid].onerror = () => {
            avatarCache[p.uuid].failed = true;
        };
    }
    
    const item = document.createElement('div');
    item.className = 'player-item';
    item.setAttribute('data-uuid', p.uuid);
    if (p.uuid === state.focusedPlayerUuid) item.classList.add('focused');
    
    item.addEventListener('click', () => focusOnPlayer(p.uuid));
    
    const healthPercent = Math.max(0, Math.min(100, (p.health / 20.0) * 100));
    
    const setMeBtnHtml = (isCloudMode && !isLocal) ? 
        `<button class="btn-set-me" data-uuid="${p.uuid}" style="font-size: 0.7rem; margin-left: 6px; padding: 2px 6px; background: rgba(59, 130, 246, 0.15); border: 1px solid rgba(59, 130, 246, 0.3); border-radius: 4px; color: #60a5fa; cursor: pointer; font-weight: 800; transition: all 0.2s;">To ja</button>` : '';

    item.innerHTML = `
        <div class="player-avatar" style="background-image: url('https://mc-heads.net/avatar/${p.uuid}/32');"></div>
        <div class="player-info">
            <div class="player-name-row">
                <span class="player-name">${p.name} ${isLocal ? ' (Ja)' : ''}</span>
                ${relativeHeightHtml}
            </div>
            <div class="player-details" style="display:flex; justify-content:space-between; align-items:center;">
                <span>X: ${Math.round(p.x)} Z: ${Math.round(p.z)} (Y: ${Math.round(p.y)})</span>
                ${setMeBtnHtml}
            </div>
            <div class="health-bar-container">
                <div class="health-bar-fill" style="width: ${healthPercent}%"></div>
            </div>
        </div>
    `;
    list.appendChild(item);
}

// 60FPS Draw & Interpolate Loop
function draw() {
    requestAnimationFrame(draw);
    
    // Set active dimension theme colors
    let themeGridColor = 'rgba(255, 255, 255, 0.02)';
    let themeClearColor = '#070913';
    
    if (state.dimension === 'the_nether') {
        themeClearColor = '#1a0505';
        themeGridColor = 'rgba(239, 68, 68, 0.02)';
    } else if (state.dimension === 'the_end') {
        themeClearColor = '#0b0514';
        themeGridColor = 'rgba(168, 85, 247, 0.02)';
    }
    
    // Clear screen
    ctx.fillStyle = themeClearColor;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    if (!state.active) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
        ctx.font = '20px Outfit';
        ctx.textAlign = 'center';
        if (isCloudMode) {
            ctx.fillText("Wybierz serwer / świat z listy po lewej stronie.", canvas.width / 2, canvas.height / 2);
        } else {
            ctx.fillText("Brak połączenia z Minecraft. Uruchom grę.", canvas.width / 2, canvas.height / 2);
        }
        return;
    }
    
    // 1. Interpolate Player Positions (glides markers smoothly)
    interpolatePlayerPositions();
    
    // 2. Auto-centering logic on focused player
    if (view.autoCenter && state.focusedPlayerUuid) {
        let targetX = 0;
        let targetZ = 0;
        
        if (state.focusedPlayerUuid === state.player.uuid) {
            targetX = state.player.x;
            targetZ = state.player.z;
        } else {
            const targetP = state.players.find(x => x.uuid === state.focusedPlayerUuid) ||
                            (state.sharedPeers && state.sharedPeers.find(x => x.uuid === state.focusedPlayerUuid)) ||
                            (state.sharedPeers && state.sharedPeers.flatMap(peer => peer.seenPlayers).find(x => x.uuid === state.focusedPlayerUuid));
            if (targetP) {
                targetX = targetP.x;
                targetZ = targetP.z;
            } else {
                targetX = state.player.x;
                targetZ = state.player.z;
            }
        }
        
        // Glide view coordinates smoothly to match focus
        view.x += (targetX - view.x) * 0.15;
        view.z += (targetZ - view.z) * 0.15;
    }
    
    // 3. Draw Chunks (visible on screen only)
    drawVisibleChunks();
    
    // 4. Draw Grid Lines (On top of chunks so they are fully visible!)
    drawGrid(themeGridColor);
    
    // 4b. Draw Waypoints
    drawWaypoints();
    
    // 5. Draw Player Markers
    drawPlayerMarkers();

    // 6. Draw Picture-in-Picture Minimap
    drawPipMinimap();
}

function drawGrid(gridColor) {
    const showGrid = document.getElementById('set-show-grid').checked;
    if (!showGrid) return;

    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1;
    
    const gridSize = 16 * view.zoom; // grid of chunks
    const startX = ((-view.x * view.zoom) + canvas.width / 2) % gridSize;
    const startY = ((-view.z * view.zoom) + canvas.height / 2) % gridSize;
    
    for (let x = startX; x < canvas.width; x += gridSize) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, canvas.height);
        ctx.stroke();
    }
    for (let y = startY; y < canvas.height; y += gridSize) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(canvas.width, y);
        ctx.stroke();
    }
}

// Convert world coordinate (block) to screen coordinate (pixel)
function worldToScreen(wx, wz) {
    const sx = Math.floor((wx - view.x) * view.zoom + canvas.width / 2);
    const sy = Math.floor((wz - view.z) * view.zoom + canvas.height / 2);
    return { x: sx, y: sy };
}

function drawVisibleChunks() {
    if (!state.worldKey) return;
    
    state.chunks.forEach(c => {
        const cx = c[0];
        const cz = c[1];
        const lastModified = c[2];
        
        // Chunk block coordinate boundaries
        const blockX = cx * 16;
        const blockZ = cz * 16;
        
        // Screen position of corners
        const posTL = worldToScreen(blockX, blockZ);
        const posBR = worldToScreen(blockX + 16, blockZ + 16);
        const w = posBR.x - posTL.x;
        const h = posBR.y - posTL.y;
        
        // Dynamic Frustum Culling
        if (posTL.x + w < 0 || posTL.x > canvas.width ||
            posTL.y + h < 0 || posTL.y > canvas.height) {
            return;
        }
        
        const tileKey = `${cx}_${cz}`;
        let cached = tileCache[tileKey];
        
        if (!cached) {
            const img = new Image();
            img.src = (isCloudMode ? `/tiles/${currentTopic}/${state.worldKey}/chunk_${cx}_${cz}.png` : `/tiles/${state.worldKey}/chunk_${cx}_${cz}.png`) + `?t=${lastModified}`;
            img.onload = () => {
                tileCache[tileKey] = { img: img, lastModified: lastModified, status: 'loaded' };
            };
            tileCache[tileKey] = { img: null, lastModified: lastModified, status: 'loading' };
            cached = tileCache[tileKey];
        } else if (cached.lastModified !== lastModified && cached.status !== 'loading') {
            const img = new Image();
            const oldImg = cached.img;
            img.src = (isCloudMode ? `/tiles/${currentTopic}/${state.worldKey}/chunk_${cx}_${cz}.png` : `/tiles/${state.worldKey}/chunk_${cx}_${cz}.png`) + `?t=${lastModified}`;
            img.onload = () => {
                tileCache[tileKey] = { img: img, lastModified: lastModified, status: 'loaded' };
            };
            tileCache[tileKey] = { img: oldImg, lastModified: lastModified, status: 'loading' };
            cached = tileCache[tileKey];
        }
        
        if (cached && cached.img && cached.img.complete) {
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(cached.img, posTL.x, posTL.y, w, h);
        }
    });
}

function drawWaypoints() {
    const showWps = document.getElementById('set-show-waypoints').checked;
    if (!showWps) return;

    const activeWps = waypoints.filter(wp => wp.dim === state.dimension);
    
    activeWps.forEach(wp => {
        const pos = worldToScreen(wp.x, wp.z);
        
        // Check if on screen (Frustum Culling)
        if (pos.x < -100 || pos.x > canvas.width + 100 || pos.y < -100 || pos.y > canvas.height + 100) {
            return;
        }
        
        // Draw waypoint pin/circle
        ctx.save();
        
        // Glow effect
        ctx.shadowBlur = 8;
        ctx.shadowColor = wp.color;
        
        // Outer colored ring
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, 7, 0, Math.PI * 2);
        ctx.fillStyle = wp.color;
        ctx.fill();
        
        // Inner white dot
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, 3, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        
        ctx.restore();
        
        // Draw waypoint name text
        ctx.fillStyle = 'rgba(7, 9, 19, 0.8)';
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
        ctx.lineWidth = 1;
        
        const label = wp.name;
        ctx.font = '600 10px Outfit';
        const textWidth = ctx.measureText(label).width;
        
        ctx.beginPath();
        ctx.roundRect(pos.x - textWidth / 2 - 4, pos.y + 10, textWidth + 8, 14, 3);
        ctx.fill();
        ctx.stroke();
        
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, pos.x, pos.y + 17);
    });
}

function drawPipMinimap() {
    if (!pipCtx || !pipCanvas) return;
    
    // Clear PiP Canvas
    let themeClearColor = '#070913';
    if (state.dimension === 'the_nether') themeClearColor = '#1a0505';
    else if (state.dimension === 'the_end') themeClearColor = '#0b0514';
    
    pipCtx.fillStyle = themeClearColor;
    pipCtx.fillRect(0, 0, pipCanvas.width, pipCanvas.height);
    
    // Center on local player
    const px = state.player.x;
    const pz = state.player.z;
    
    // Update pip overlay texts
    const pipCoordsSpan = pipWindow.document.getElementById('pip-coords');
    if (pipCoordsSpan) {
        pipCoordsSpan.innerText = `X: ${Math.round(px)}, Z: ${Math.round(pz)}`;
    }
    const pipDimSpan = pipWindow.document.getElementById('pip-dim');
    if (pipDimSpan) {
        let dimLabel = 'Overworld';
        if (state.dimension === 'the_nether') dimLabel = 'Nether';
        else if (state.dimension === 'the_end') dimLabel = 'End';
        pipDimSpan.innerText = dimLabel;
    }
    
    // Map block coordinates to PiP screen pixels
    const pipWorldToScreen = (wx, wz) => {
        const sx = Math.floor((wx - px) * pipZoom + pipCanvas.width / 2);
        const sy = Math.floor((wz - pz) * pipZoom + pipCanvas.height / 2);
        return { x: sx, y: sy };
    };
    
    // 1. Draw chunks inside PiP
    if (state.worldKey) {
        state.chunks.forEach(c => {
            const cx = c[0];
            const cz = c[1];
            const lastModified = c[2];
            
            const blockX = cx * 16;
            const blockZ = cz * 16;
            
            const posTL = pipWorldToScreen(blockX, blockZ);
            const posBR = pipWorldToScreen(blockX + 16, blockZ + 16);
            const w = posBR.x - posTL.x;
            const h = posBR.y - posTL.y;
            
            // Frustum Culling
            if (posTL.x + w < 0 || posTL.x > pipCanvas.width ||
                posTL.y + h < 0 || posTL.y > pipCanvas.height) {
                return;
            }
            
            const tileKey = `${cx}_${cz}`;
            const cached = tileCache[tileKey];
            if (cached && cached.img && cached.img.complete) {
                pipCtx.imageSmoothingEnabled = false;
                pipCtx.drawImage(cached.img, posTL.x, posTL.y, w, h);
            }
        });
    }
    
    // 2. Draw Waypoints in PiP (with names rendered!)
    const showWps = document.getElementById('set-pip-show-waypoints').checked;
    const pipScale = (sizes.pipScale || 100) / 100;
    
    if (showWps) {
        const activeWps = waypoints.filter(wp => wp.dim === state.dimension);
        activeWps.forEach(wp => {
            const pos = pipWorldToScreen(wp.x, wp.z);
            if (pos.x < -100 || pos.x > pipCanvas.width + 100 || pos.y < -100 || pos.y > pipCanvas.height + 100) {
                return;
            }
            
            pipCtx.save();
            pipCtx.shadowBlur = 6 * pipScale;
            pipCtx.shadowColor = wp.color;
            
            pipCtx.beginPath();
            pipCtx.arc(pos.x, pos.y, 5 * pipScale, 0, Math.PI * 2);
            pipCtx.fillStyle = wp.color;
            pipCtx.fill();
            
            pipCtx.beginPath();
            pipCtx.arc(pos.x, pos.y, 2 * pipScale, 0, Math.PI * 2);
            pipCtx.fillStyle = '#ffffff';
            pipCtx.fill();
            
            pipCtx.restore();
            
            // Render label name for waypoints in PiP if enabled
            const showWpNames = document.getElementById('set-pip-show-waypoint-names').checked;
            if (showWpNames) {
                pipCtx.fillStyle = 'rgba(7, 9, 19, 0.8)';
                pipCtx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
                pipCtx.lineWidth = 1;
                
                const label = wp.name;
                const fontSize = Math.max(7, Math.round(9 * pipScale));
                pipCtx.font = '600 ' + fontSize + 'px Outfit';
                const textWidth = pipCtx.measureText(label).width;
                
                const padding = 4 * pipScale;
                const boxHeight = (fontSize + 4) * pipScale;
                const offset = (5 + 3) * pipScale; // pin radius + gap
                
                pipCtx.beginPath();
                pipCtx.roundRect(pos.x - textWidth / 2 - padding, pos.y + offset, textWidth + padding * 2, boxHeight, 3 * pipScale);
                pipCtx.fill();
                pipCtx.stroke();
                
                pipCtx.fillStyle = '#ffffff';
                pipCtx.textAlign = 'center';
                pipCtx.textBaseline = 'middle';
                pipCtx.fillText(label, pos.x, pos.y + offset + boxHeight / 2);
            }
        });
    }
    
    // 3. Draw remote players seen by friends in PiP
    if (state.sharedPeers) {
        state.sharedPeers.forEach(peer => {
            if (peer.dimension === state.dimension) {
                peer.seenPlayers.forEach(sp => {
                    const isLocal = sp.uuid === state.player.uuid;
                    const isLocalOther = state.players.some(x => x.uuid === sp.uuid);
                    if (!isLocal && !isLocalOther) {
                        drawPlayerMarkerOnCanvas(pipCtx, sp, false, pipWorldToScreen, 0.8 * pipScale, "remote");
                    }
                });
            }
        });
    }

    // 4. Draw other players in PiP (drawn with custom size factors & scale)
    state.players.forEach(p => {
        drawPlayerMarkerOnCanvas(pipCtx, p, false, pipWorldToScreen, 0.8 * pipScale, "other");
    });

    // 5. Draw Shared Peers (Friends) in PiP
    if (state.sharedPeers) {
        state.sharedPeers.forEach(peer => {
            if (peer.dimension === state.dimension) {
                drawPlayerMarkerOnCanvas(pipCtx, peer, false, pipWorldToScreen, 0.8 * pipScale, "friend");
            }
        });
    }
    
    // 6. Draw Local Player in PiP (centered & scale)
    drawPlayerMarkerOnCanvas(pipCtx, state.player, true, (wx, wz) => ({ x: pipCanvas.width / 2, y: pipCanvas.height / 2 }), 1.0 * pipScale, "local");
}

function interpolatePlayerPositions() {
    const now = Date.now();
    
    // Clean up inactive local player in cloud mode
    if (isCloudMode && state.player && state.player.uuid && state.player.lastUpdate && (now - state.player.lastUpdate) > 15000) {
        delete interpolatedPlayers[state.player.uuid];
        state.player.uuid = '';
        renderPlayerList();
    }
    
    // Clean up inactive shared peers
    if (state.sharedPeers) {
        const initialLen = state.sharedPeers.length;
        state.sharedPeers = state.sharedPeers.filter(peer => {
            const active = (now - peer.lastUpdate) < 15000;
            if (!active) {
                delete interpolatedPlayers[peer.uuid];
                peer.seenPlayers.forEach(sp => {
                    delete interpolatedPlayers[sp.uuid];
                });
            }
            return active;
        });
        if (state.sharedPeers.length !== initialLen) {
            renderPlayerList();
        }
    }

    // Local Player
    if (state.player && state.player.uuid) {
        interpolateSinglePlayer(state.player, 'local');
    }
    
    // Other Players
    state.players.forEach(p => {
        interpolateSinglePlayer(p, 'local');
    });

    // Shared peers and their seen players
    if (state.sharedPeers) {
        state.sharedPeers.forEach(peer => {
            if (peer.dimension === state.dimension) {
                interpolateSinglePlayer(peer, 'remote');
            }
            peer.seenPlayers.forEach(sp => {
                interpolateSinglePlayer(sp, 'remote');
            });
        });
    }
}

function interpolateSinglePlayer(p, role = 'local') {
    if (!p || !p.uuid) return;
    const lerp = (start, end, amt) => (1 - amt) * start + amt * end;
    if (!interpolatedPlayers[p.uuid]) {
        interpolatedPlayers[p.uuid] = { x: p.x, z: p.z, yaw: p.yaw };
    } else {
        const ip = interpolatedPlayers[p.uuid];
        const amt = (role === 'local') ? 0.15 : 0.04;
        ip.x = lerp(ip.x, p.x, amt);
        ip.z = lerp(ip.z, p.z, amt);
        
        let diff = p.yaw - ip.yaw;
        while (diff < -180) diff += 360;
        while (diff > 180) diff -= 360;
        ip.yaw += diff * amt;
    }
}

function drawPlayerMarkers() {
    // 1. Draw remote players seen by friends
    if (state.sharedPeers) {
        state.sharedPeers.forEach(peer => {
            if (peer.dimension === state.dimension) {
                peer.seenPlayers.forEach(sp => {
                    const isLocal = sp.uuid === state.player.uuid;
                    const isLocalOther = state.players.some(x => x.uuid === sp.uuid);
                    if (!isLocal && !isLocalOther) {
                        drawPlayerMarkerOnCanvas(ctx, sp, false, worldToScreen, 1.0, "remote");
                    }
                });
            }
        });
    }

    // 2. Draw Other Players (locally seen)
    state.players.forEach(p => {
        drawPlayerMarkerOnCanvas(ctx, p, false, worldToScreen, 1.0, "other");
    });

    // 3. Draw Shared Peers (Friends)
    if (state.sharedPeers) {
        state.sharedPeers.forEach(peer => {
            if (peer.dimension === state.dimension) {
                drawPlayerMarkerOnCanvas(ctx, peer, false, worldToScreen, 1.0, "friend");
            }
        });
    }

    // 4. Draw Local Player on top
    drawPlayerMarkerOnCanvas(ctx, state.player, true, worldToScreen, 1.0, "local");
}

// Reusable player drawer function for drawing players on any canvas (main and PiP)
function drawPlayerMarkerOnCanvas(ctxToUse, p, isLocal, convertCoordsFunc, scale = 1.0, role = null) {
    const ip = interpolatedPlayers[p.uuid];
    if (!ip) return;
    
    if (!role) {
        role = isLocal ? "local" : "other";
    }
    
    const isRemote = (role === "remote");
    if (isRemote) {
        ctxToUse.save();
        ctxToUse.globalAlpha = 0.55;
    }

    const pos = convertCoordsFunc(ip.x, ip.z);
    
    // Draw Outer Pulse for selected focused player
    if (p.uuid === state.focusedPlayerUuid) {
        ctxToUse.beginPath();
        const pulseRadius = (sizes.dot * 2.2 + Math.sin(Date.now() / 200) * 3) * scale;
        ctxToUse.arc(pos.x, pos.y, pulseRadius, 0, Math.PI * 2);
        ctxToUse.strokeStyle = (role === 'local') ? 'rgba(59, 130, 246, 0.4)' : 
                              ((role === 'friend') ? 'rgba(6, 182, 212, 0.4)' : 'rgba(16, 185, 129, 0.4)');
        ctxToUse.lineWidth = 2 * scale;
        ctxToUse.stroke();
    }
    
    // Draw Yaw direction triangle
    ctxToUse.save();
    ctxToUse.translate(pos.x, pos.y);
    ctxToUse.rotate((ip.yaw + 180) * Math.PI / 180);
    
    ctxToUse.beginPath();
    ctxToUse.moveTo(0, -sizes.arrow * scale);
    ctxToUse.lineTo(-sizes.arrow / 2 * scale, sizes.arrow / 2.3 * scale);
    ctxToUse.lineTo(sizes.arrow / 2 * scale, sizes.arrow / 2.3 * scale);
    ctxToUse.closePath();
    
    let arrowColor = '#10b981'; // other (green)
    if (role === 'local') arrowColor = '#3b82f6'; // blue
    else if (role === 'friend') arrowColor = '#06b6d4'; // cyan
    else if (role === 'remote') arrowColor = '#10b981'; // remote green

    ctxToUse.fillStyle = arrowColor;
    ctxToUse.shadowBlur = 8 * scale;
    ctxToUse.shadowColor = arrowColor;
    ctxToUse.fill();
    ctxToUse.restore();
    
    // Draw Player Head circular image
    ctxToUse.save();
    ctxToUse.beginPath();
    ctxToUse.arc(pos.x, pos.y, sizes.dot * scale, 0, Math.PI * 2);
    ctxToUse.closePath();
    ctxToUse.clip();
    
    const avatar = avatarCache[p.uuid];
    if (avatar && avatar.complete && !avatar.failed) {
        ctxToUse.imageSmoothingEnabled = false;
        ctxToUse.drawImage(avatar, pos.x - sizes.dot * scale, pos.y - sizes.dot * scale, sizes.dot * 2 * scale, sizes.dot * 2 * scale);
    } else {
        ctxToUse.fillStyle = (role === 'local') ? '#2563eb' : ((role === 'friend') ? '#0891b2' : '#059669');
        ctxToUse.beginPath();
        ctxToUse.arc(pos.x, pos.y, sizes.dot * scale, 0, Math.PI * 2);
        ctxToUse.fill();
    }
    ctxToUse.restore();
    
    // Draw Head Border
    ctxToUse.beginPath();
    ctxToUse.arc(pos.x, pos.y, sizes.dot * scale, 0, Math.PI * 2);
    ctxToUse.strokeStyle = (role === 'friend') ? '#06b6d4' : '#ffffff';
    ctxToUse.lineWidth = 1.5 * scale;
    ctxToUse.stroke();
    
    // Show details logic (Respect settings OR if TAB is held in Minecraft)
    const isPip = (ctxToUse === pipCtx);
    let showNames, showHeight, showHp;
    
    if (isPip) {
        showNames = document.getElementById('set-pip-show-names').checked || state.tabPressed;
        showHeight = document.getElementById('set-pip-show-height').checked || state.tabPressed;
        showHp = document.getElementById('set-pip-show-hp').checked || state.tabPressed;
    } else {
        showNames = true; // Names are always visible on main map
        showHeight = document.getElementById('set-show-height').checked || state.tabPressed;
        showHp = document.getElementById('set-show-hp').checked || state.tabPressed;
    }
    
    const shouldDrawLabel = showNames || showHeight || showHp;
    
    if (shouldDrawLabel) {
        ctxToUse.fillStyle = 'rgba(7, 9, 19, 0.85)';
        ctxToUse.strokeStyle = 'rgba(255, 255, 255, 0.08)';
        ctxToUse.lineWidth = 1;
        
        let label = "";
        if (showNames) {
            label = p.name;
        }
        if (showHeight) {
            const hDiff = Math.round(p.y - state.player.y);
            const heightLabel = (role === 'local') ? `[Y:${Math.round(p.y)}]` : (hDiff > 1 ? `[▲+${hDiff}]` : (hDiff < -1 ? `[▼${hDiff}]` : `[=]`));
            if (label) {
                label += " " + heightLabel;
            } else {
                label = heightLabel;
            }
        }
        
        const fontSize = Math.max(8, Math.round(sizes.nick * scale));
        ctxToUse.font = 'bold ' + fontSize + 'px Outfit';
        
        const minLabelWidth = showHp ? 40 * scale : 0;
        const textWidth = Math.max(minLabelWidth, ctxToUse.measureText(label).width);
        
        const labelHeight = showHp ? ((sizes.nick + sizes.hp + 10) * scale) : ((sizes.nick + 6) * scale);
        const offsetHP = showHp ? ((sizes.hp + 3) * scale) : 0;
        
        const bubbleYOffset = (sizes.dot + sizes.arrow + 2) * scale;
        
        // Draw background bubble
        ctxToUse.beginPath();
        ctxToUse.roundRect(pos.x - textWidth / 2 - 6, pos.y - bubbleYOffset - labelHeight, textWidth + 12, labelHeight, 4);
        ctxToUse.fill();
        ctxToUse.stroke();
        
        // Draw text
        if (label) {
            ctxToUse.fillStyle = '#ffffff';
            ctxToUse.textAlign = 'center';
            ctxToUse.textBaseline = 'top';
            ctxToUse.fillText(label, pos.x, pos.y - bubbleYOffset - labelHeight + 3 * scale);
        }
        
        if (showHp) {
            const hpWidth = textWidth;
            const hpX = pos.x - hpWidth / 2;
            const hpY = pos.y - bubbleYOffset - offsetHP;
            const hpHeight = sizes.hp * scale;
            
            ctxToUse.fillStyle = 'rgba(255, 255, 255, 0.15)';
            ctxToUse.fillRect(hpX, hpY, hpWidth, hpHeight);
            
            const healthPercent = Math.max(0, Math.min(1.0, (p.health / 20.0)));
            if (healthPercent > 0.5) {
                ctxToUse.fillStyle = '#10b981';
            } else if (healthPercent > 0.2) {
                ctxToUse.fillStyle = '#f59e0b';
            } else {
                ctxToUse.fillStyle = '#ef4444';
            }
            ctxToUse.fillRect(hpX, hpY, hpWidth * healthPercent, hpHeight);
        }
    }

    if (isRemote) {
        ctxToUse.restore();
    }
}

// Bind pip button click listener
document.getElementById('btn-pip-map').addEventListener('click', openPipMinimap);

// Cloud Mode Worlds Dropdown Manager
let availableWorlds = [];

async function fetchAvailableWorlds() {
    try {
        const response = await fetch('/api/worlds');
        availableWorlds = await response.json();
        renderWorldDropdown();
    } catch (e) {
        console.error("Failed to fetch available worlds:", e);
    }
}

// Helper to translate worldKey format to display name
function parseWorldKeyToName(worldKey) {
    if (!worldKey) return "Nieznany Świat";
    const isServer = worldKey.startsWith('server_');
    const isSingle = worldKey.startsWith('singleplayer_');
    let parts = worldKey.split('_');
    let name = "Świat";
    let dimLabel = "Overworld";

    if (worldKey.endsWith('_the_nether') || worldKey.endsWith('_nether')) dimLabel = "Nether";
    else if (worldKey.endsWith('_the_end') || worldKey.endsWith('_end')) dimLabel = "End";

    if (isServer) {
        if (parts.length >= 3) {
            const host = parts[1];
            const port = parts[2];
            name = `${host}:${port}`;
        } else {
            name = worldKey;
        }
        return `${name} (${dimLabel})`;
    } else if (isSingle) {
        if (parts.length >= 2) {
            name = parts[1];
            name = name.charAt(0).toUpperCase() + name.slice(1);
        } else {
            name = worldKey;
        }
        return `${name} (Singleplayer ${dimLabel})`;
    }
    return worldKey;
}

function renderWorldDropdown() {
    const select = document.getElementById('sidebar-world-select');
    if (!select) return;
    
    const currentValue = select.value;
    select.innerHTML = '<option value="">-- Wybierz serwer / świat --</option>';
    
    availableWorlds.forEach(w => {
        const opt = document.createElement('option');
        opt.value = JSON.stringify(w);
        const statusText = w.onlineCount > 0 ? ` (ONLINE - graczy: ${w.onlineCount})` : ' (OFFLINE)';
        opt.innerText = parseWorldKeyToName(w.worldKey) + statusText;
        select.appendChild(opt);
    });
    
    if (currentValue) {
        select.value = currentValue;
    } else {
        const stored = localStorage.getItem('optimc_last_viewed_world');
        if (stored) {
            const found = availableWorlds.find(w => JSON.stringify(w) === stored);
            if (found) {
                select.value = stored;
                const worldObj = JSON.parse(stored);
                selectWorld(worldObj.topic, worldObj.worldKey);
            }
        }
    }
}

async function fetchActivePlayers(worldKey) {
    if (!worldKey) return;
    try {
        const response = await fetch(`/api/players?worldKey=${encodeURIComponent(worldKey)}`);
        const playersList = await response.json();
        
        const now = Date.now();
        state.sharedPeers = [];
        
        playersList.forEach(p => {
            const isMe = myCloudUuid ? (p.uuid === myCloudUuid) : (!state.player || !state.player.uuid || state.player.uuid === p.uuid);
            
            if (isMe) {
                if (!myCloudUuid) {
                    myCloudUuid = p.uuid;
                    localStorage.setItem('optimc_my_cloud_uuid', myCloudUuid);
                }
                state.player = {
                    uuid: p.uuid,
                    name: p.name,
                    x: p.x,
                    y: p.y,
                    z: p.z,
                    yaw: p.yaw,
                    health: p.health,
                    dimension: p.dimension,
                    lastUpdate: now
                };
                state.dimension = p.dimension;
                if (!state.focusedPlayerUuid) {
                    state.focusedPlayerUuid = p.uuid;
                }
            } else {
                state.sharedPeers.push({
                    uuid: p.uuid,
                    name: p.name,
                    x: p.x,
                    y: p.y,
                    z: p.z,
                    yaw: p.yaw,
                    health: p.health,
                    dimension: p.dimension,
                    waypoints: p.waypoints || [],
                    seenPlayers: p.seenPlayers || [],
                    lastUpdate: now
                });
            }
        });
        
        renderPlayerList();
    } catch (e) {
        console.error("Failed to fetch active players:", e);
    }
}

function selectWorld(topic, worldKey) {
    if (!topic || !worldKey) return;
    const worldObj = { topic, worldKey };
    localStorage.setItem('optimc_last_viewed_world', JSON.stringify(worldObj));
    
    state.worldKey = worldKey;
    connectToCloudSSE(topic);
    
    const statusSpan = document.getElementById('cloud-channel-status');
    if (statusSpan) {
        statusSpan.innerText = 'Połączono';
        statusSpan.style.color = '#10b981';
    }
    
    for (let key in tileCache) delete tileCache[key];
    fetchChunks();
    fetchActivePlayers(worldKey);
}

// Start Draw & Initialize
loadSettings();
loadSizes();
setupSizeListeners();
loadSharingSettings();
setupSharingListeners();
requestAnimationFrame(draw);

if (isCloudMode) {
    const manager = document.getElementById('cloud-channel-manager');
    if (manager) manager.style.display = 'flex';
    
    const select = document.getElementById('sidebar-world-select');
    if (select) {
        select.addEventListener('change', (e) => {
            const val = e.target.value;
            if (val) {
                const worldObj = JSON.parse(val);
                selectWorld(worldObj.topic, worldObj.worldKey);
            } else {
                state.worldKey = '';
                state.player = { name: '', uuid: '', x: 0, y: 0, z: 0, yaw: 0, health: 20 };
                state.focusedPlayerUuid = null;
                state.sharedPeers = [];
                if (sseSource) sseSource.close();
                const statusSpan = document.getElementById('cloud-channel-status');
                if (statusSpan) {
                    statusSpan.innerText = 'Rozłączony';
                    statusSpan.style.color = '#ef4444';
                }
                renderPlayerList();
            }
        });
    }
    
    fetchAvailableWorlds();
    setInterval(fetchAvailableWorlds, 8000); // refresh list of worlds every 8 seconds
} else {
    pollStatus();
}

fetchChunks();
updateDimensionUI();

function connectToCloudSSE(topic) {
    if (sseSource) {
        sseSource.close();
    }
    
    state.active = true;
    state.focusedPlayerUuid = null;
    state.sharedPeers = [];
    
    // Clear existing cache to reload new chunks
    for (let key in tileCache) delete tileCache[key];
    
    const sseUrl = window.location.origin + '/' + topic + '/json';
    console.log("[Cloud] Connecting to SSE stream:", sseUrl);
    sseSource = new EventSource(sseUrl);
    
    sseSource.addEventListener('message', (e) => {
        try {
            const eventData = JSON.parse(e.data);
            if (eventData.event === 'message' && eventData.message) {
                const peerData = JSON.parse(eventData.message);
                handleCloudPeerUpdate(peerData);
            }
        } catch (err) {
            console.error("[Cloud] Error parsing SSE payload:", err);
        }
    });
    
    sseSource.addEventListener('error', (e) => {
        console.error("[Cloud] SSE stream connection error. Reconnecting...", e);
    });
}

function handleCloudPeerUpdate(p) {
    const now = Date.now();
    
    // Only process updates that match our currently selected worldKey
    if (state.worldKey && p.worldKey !== state.worldKey) {
        return;
    }
    
    // Check if this peer is the primary player we follow (respect myCloudUuid if set)
    const isMe = myCloudUuid ? (p.senderUuid === myCloudUuid) : (!state.player || !state.player.uuid || state.player.uuid === p.senderUuid);
    
    if (isMe) {
        if (!myCloudUuid) {
            myCloudUuid = p.senderUuid;
            localStorage.setItem('optimc_my_cloud_uuid', myCloudUuid);
        }
        
        const oldWorldKey = state.worldKey;
        const oldDim = state.dimension;
        
        state.player = {
            uuid: p.senderUuid,
            name: p.senderName,
            x: p.x,
            y: p.y,
            z: p.z,
            yaw: p.yaw,
            health: p.health,
            dimension: p.dimension,
            lastUpdate: now
        };
        state.worldKey = p.worldKey;
        state.dimension = p.dimension;
        
        if (!state.focusedPlayerUuid) {
            state.focusedPlayerUuid = p.senderUuid;
        }

        // If world key or dimension changed, clear tiles cache to reload new ones
        if (oldWorldKey !== state.worldKey || oldDim !== state.dimension) {
            for (let key in tileCache) delete tileCache[key];
            updateDimensionUI();
            fetchChunks();
        }
    } else {
        // Update or add to shared peers
        let peer = state.sharedPeers.find(x => x.uuid === p.senderUuid);
        if (!peer) {
            peer = {
                uuid: p.senderUuid,
                name: p.senderName,
                x: p.x,
                y: p.y,
                z: p.z,
                yaw: p.yaw,
                health: p.health,
                dimension: p.dimension,
                waypoints: p.waypoints || [],
                seenPlayers: p.players || [],
                lastUpdate: now
            };
            state.sharedPeers.push(peer);
        } else {
            peer.x = p.x;
            peer.y = p.y;
            peer.z = p.z;
            peer.yaw = p.yaw;
            peer.health = p.health;
            peer.dimension = p.dimension;
            peer.waypoints = p.waypoints || [];
            peer.seenPlayers = p.players || [];
            peer.lastUpdate = now;
        }
        syncSharedWaypoints(state.sharedPeers);
    }

    // Clean up inactive peers
    state.sharedPeers = state.sharedPeers.filter(x => (now - x.lastUpdate) < 20000);

    // Update coordinates display
    document.getElementById('connection-status').innerText = "Live Cloud";
    document.getElementById('connection-status').className = "status-badge online";
    document.getElementById('local-coords').innerText = `X: ${Math.round(state.player.x)} | Y: ${Math.round(state.player.y)} | Z: ${Math.round(state.player.z)}`;

    renderPlayerList();
}

function showTopicChooserModal() {
    if (document.getElementById('cloud-topic-modal')) return;

    const modal = document.createElement('div');
    modal.id = 'cloud-topic-modal';
    modal.style.position = 'fixed';
    modal.style.top = '0';
    modal.style.left = '0';
    modal.style.width = '100vw';
    modal.style.height = '100vh';
    modal.style.backgroundColor = 'rgba(10, 12, 16, 0.9)';
    modal.style.backdropFilter = 'blur(16px)';
    modal.style.zIndex = '9999';
    modal.style.display = 'flex';
    modal.style.alignItems = 'center';
    modal.style.justifyContent = 'center';
    modal.style.color = '#e2e8f0';
    modal.style.fontFamily = "'Outfit', 'Inter', sans-serif";

    modal.innerHTML = `
        <div style="background: rgba(22, 28, 38, 0.8); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 20px; padding: 40px; width: 440px; box-shadow: 0 30px 60px rgba(0,0,0,0.6); text-align: center; display: flex; flex-direction: column; gap: 24px; box-sizing: border-box;">
            <div style="font-size: 1.8rem; font-weight: 900; color: #38bdf8; letter-spacing: -0.5px;">OptiMC Coop Map</div>
            <div style="font-size: 0.9rem; color: #94a3b8; line-height: 1.6;">Wprowadź kod kanału (Topic) wygenerowany w grze przez Ciebie lub znajomego, aby przeglądać mapę i pozycje w czasie rzeczywistym.</div>
            
            <input type="text" id="modal-topic-input" placeholder="np. omc_289c4f02..." style="width: 100%; padding: 14px 18px; border-radius: 10px; border: 1px solid rgba(255, 255, 255, 0.15); background: rgba(10, 12, 16, 0.7); color: #fff; font-size: 1rem; font-family: monospace; outline: none; box-sizing: border-box; text-align: center; transition: all 0.2s;" onfocus="this.style.borderColor='#38bdf8'; this.style.boxShadow='0 0 10px rgba(56,189,248,0.2)'" onblur="this.style.borderColor='rgba(255,255,255,0.15)'; this.style.boxShadow='none'">
            
            <button id="modal-connect-btn" style="width: 100%; padding: 14px; border-radius: 10px; border: none; background: #38bdf8; color: #0a0c10; font-weight: 800; font-size: 1rem; cursor: pointer; transition: all 0.2s; box-shadow: 0 4px 15px rgba(56, 189, 248, 0.3);">Połącz z Mapą</button>
        </div>
    `;

    document.body.appendChild(modal);

    const input = document.getElementById('modal-topic-input');
    const btn = document.getElementById('modal-connect-btn');

    const connect = () => {
        const val = input.value.trim();
        if (val) {
            currentTopic = val;
            window.history.pushState(null, '', `?topic=${currentTopic}`);
            document.body.removeChild(modal);
            connectToCloudSSE(currentTopic);
        }
    };

    btn.addEventListener('click', connect);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') connect();
    });
}

// Stale peer check for Cloud Mode
setInterval(() => {
    if (isCloudMode && state.player && state.player.uuid) {
        const now = Date.now();
        if (state.player.lastUpdate && (now - state.player.lastUpdate) > 20000) {
            console.log("[Cloud] Primary player went offline.");
            if (state.sharedPeers.length > 0) {
                const next = state.sharedPeers.shift();
                state.player = {
                    uuid: next.uuid,
                    name: next.name,
                    x: next.x,
                    y: next.y,
                    z: next.z,
                    yaw: next.yaw,
                    health: next.health,
                    dimension: next.dimension,
                    lastUpdate: next.lastUpdate
                };
                state.worldKey = next.worldKey || state.worldKey;
                state.dimension = next.dimension;
                state.focusedPlayerUuid = next.uuid;
                updateDimensionUI();
                fetchChunks();
            } else {
                state.player = { name: '', uuid: '', x: 0, y: 0, z: 0, yaw: 0, health: 20 };
                state.focusedPlayerUuid = null;
                setOffline();
            }
            renderPlayerList();
        }
    }
}, 2000);
