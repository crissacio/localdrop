const express = require('express');
const http = require('http');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const qrcode = require('qrcode-terminal');
const archiver = require('archiver');
const { exec, execFile, spawn } = require('child_process');

const app = express();
const server = http.createServer(app);

// Token único de sesión principal que cambia en cada reinicio del servidor
const SESSION_TOKEN = crypto.randomBytes(16).toString('hex');
const SERVER_BOOT_ID = Date.now().toString();

// ------------------------------------------------------------------
// Carpeta de destino (elegible por el usuario y recordada entre sesiones)
// ------------------------------------------------------------------
const CONFIG_FILE = path.join(os.homedir(), '.localdrop.json');

function defaultUploadDir() {
    const downloads = path.join(os.homedir(), 'Downloads');
    const base = fs.existsSync(downloads) ? downloads : os.homedir();
    return path.join(base, 'LocalDrop');
}

function loadConfig() {
    try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (e) { return {}; }
}

function saveConfig(cfg) {
    try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); } catch (e) {
        console.error('No se pudo guardar la configuración:', e.message);
    }
}

let config = loadConfig();
let uploadDir = (config.saveDir && fs.existsSync(config.saveDir)) ? config.saveDir : defaultUploadDir();
fs.mkdirSync(uploadDir, { recursive: true });

// Archivos recibidos en ESTA sesión (nombre único -> ruta absoluta).
// Solo estos se listan y se pueden descargar desde el panel: nunca se expone
// el resto del contenido de la carpeta elegida, y nunca se borra nada.
const sessionFiles = new Map();

let networkMode = 'domestic'; // 'domestic' o 'public'
let publicPin = String(crypto.randomInt(0, 1000000)).padStart(6, '0');

const pinAttempts = {};
const RATE_LIMIT_WINDOW = 60 * 1000;
const MAX_ATTEMPTS = 5;

function checkRateLimit(req, res, next) {
    const ip = req.ip || req.socket.remoteAddress;
    const now = Date.now();

    if (!pinAttempts[ip]) {
        pinAttempts[ip] = { count: 0, firstAttempt: now };
    }

    const record = pinAttempts[ip];
    if (now - record.firstAttempt > RATE_LIMIT_WINDOW) {
        record.count = 0;
        record.firstAttempt = now;
    }

    if (record.count >= MAX_ATTEMPTS) {
        return res.status(429).json({ valid: false, error: 'Demasiados intentos fallidos. Acceso bloqueado temporalmente.' });
    }
    next();
}

// Devuelve un nombre que no pise archivos existentes: foto.jpg -> foto (1).jpg
function uniqueName(dir, name) {
    const safe = path.basename(name).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_') || 'archivo';
    const ext = path.extname(safe);
    const stem = safe.slice(0, safe.length - ext.length);
    let candidate = safe;
    let i = 1;
    while (fs.existsSync(path.join(dir, candidate))) {
        candidate = `${stem} (${i++})${ext}`;
    }
    return candidate;
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        fs.mkdir(uploadDir, { recursive: true }, (err) => cb(err, uploadDir));
    },
    filename: (req, file, cb) => {
        const original = Buffer.from(file.originalname, 'latin1').toString('utf8');
        const name = uniqueName(uploadDir, original);
        // Reservamos el nombre de inmediato para que dos subidas simultáneas no choquen
        sessionFiles.set(name, path.join(uploadDir, name));
        cb(null, name);
    }
});
const upload = multer({ storage });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Validador de token estricto (Protege tanto PC como Móvil)
function verifyToken(req, res, next) {
    const token = req.query.token || req.headers['x-token'];
    if (token === SESSION_TOKEN) {
        next();
    } else {
        res.status(403).send(`
            <!DOCTYPE html>
            <html lang="es">
            <head><meta charset="UTF-8"><title>Sesión Expirada</title></head>
            <body style="background:#090d16; color:#f8fafc; font-family:sans-serif; text-align:center; padding-top:50px;">
                <h2>⚠️ Sesión expirada o servidor reiniciado</h2>
                <p>El servidor se reinició. Escaneá el nuevo código QR desde la PC para continuar.</p>
            </body>
            </html>
        `);
    }
}

// Solo la propia PC (no el celular) puede cambiar la carpeta o abrirla
function onlyLocalhost(req, res, next) {
    const addr = (req.socket.remoteAddress || '').replace('::ffff:', '');
    if (addr === '127.0.0.1' || addr === '::1') return next();
    res.status(403).json({ error: 'Solo disponible desde la computadora anfitriona.' });
}

app.get('/', verifyToken, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Ruta móvil protegida por el token de sesión (Muere si se reinicia el server)
app.get('/movil', verifyToken, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Estado. Sin token solo se informa el modo de red (lo que necesita el celular).
// Con token se devuelve todo (para el panel de la PC).
app.get('/api/status', (req, res) => {
    const token = req.query.token || req.headers['x-token'];
    if (token !== SESSION_TOKEN) {
        return res.json({ networkMode, serverBootId: SERVER_BOOT_ID });
    }

    const ip = getLocalIP();
    const mobileUrl = `http://${ip}:${PORT}/movil?token=${SESSION_TOKEN}`;

    const files = [];
    for (const [name, filePath] of sessionFiles) {
        try {
            const stats = fs.statSync(filePath);
            files.push({ filename: name, originalName: name, size: stats.size, createdAt: stats.mtime });
        } catch (e) {
            // El usuario lo movió o borró: lo sacamos de la lista
            sessionFiles.delete(name);
        }
    }
    res.json({ mobileUrl, networkMode, publicPin, serverBootId: SERVER_BOOT_ID, saveDir: uploadDir, files });
});

app.get('/api/verify-pin', checkRateLimit, (req, res) => {
    const { pin } = req.query;
    const ip = req.ip || req.socket.remoteAddress;

    if (networkMode === 'domestic') {
        return res.json({ valid: true });
    }

    if (pin === publicPin) {
        if (pinAttempts[ip]) delete pinAttempts[ip];
        return res.json({ valid: true });
    }

    if (pinAttempts[ip]) {
        pinAttempts[ip].count++;
    }

    return res.status(401).json({ valid: false, error: 'PIN incorrecto. Intentá de nuevo.' });
});

app.post('/api/set-network', verifyToken, (req, res) => {
    const { mode, pin } = req.body;
    if (mode === 'domestic' || mode === 'public') networkMode = mode;
    if (pin && /^\d{6}$/.test(pin.trim())) publicPin = pin.trim();

    console.log(`🌐 Modo de red actualizado a: ${networkMode.toUpperCase()}`);
    res.json({ success: true, networkMode, publicPin });
});

// ------------------------------------------------------------------
// Selector nativo de carpeta en la PC anfitriona (Windows / macOS / Linux)
// ------------------------------------------------------------------
function pickFolderNative(startDir) {
    return new Promise((resolve, reject) => {
        const done = (err, stdout) => {
            const out = (stdout || '').toString().trim();
            if (out) return resolve(out.replace(/[\\/]$/, '') || out);
            // Cancelado por el usuario (o sin selección)
            if (!err || err.code === 1) return resolve(null);
            reject(err);
        };

        if (process.platform === 'win32') {
            const ps = `
                [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
                Add-Type -AssemblyName System.Windows.Forms
                $d = New-Object System.Windows.Forms.FolderBrowserDialog
                $d.Description = 'Elegí dónde guardar los archivos de Local Drop'
                $d.ShowNewFolderButton = $true
                $d.SelectedPath = $env:LD_START
                $owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }
                if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }
            `;
            execFile('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', ps],
                { env: { ...process.env, LD_START: startDir }, windowsHide: true }, done);
        } else if (process.platform === 'darwin') {
            // "frontmost application" hace que el diálogo aparezca encima del navegador
            const script = `
                set startDir to POSIX file (system attribute "LD_START")
                tell application (path to frontmost application as text)
                    activate
                    set f to choose folder with prompt "Elegí dónde guardar los archivos de Local Drop" default location startDir
                end tell
                return POSIX path of f`;
            execFile('osascript', ['-e', script], { env: { ...process.env, LD_START: startDir } }, done);
        } else {
            execFile('zenity', ['--file-selection', '--directory', '--title=Elegí dónde guardar los archivos', `--filename=${startDir}/`], (err, stdout) => {
                if (err && err.code === 'ENOENT') {
                    return execFile('kdialog', ['--getexistingdirectory', startDir], (err2, out2) => {
                        if (err2 && err2.code === 'ENOENT') return reject(new Error('Instalá zenity o kdialog para elegir carpeta.'));
                        done(err2, out2);
                    });
                }
                done(err, stdout);
            });
        }
    });
}

let pickerOpen = false;
app.post('/api/pick-folder', verifyToken, onlyLocalhost, async (req, res) => {
    if (pickerOpen) return res.status(409).json({ error: 'Ya hay un selector de carpeta abierto.' });
    pickerOpen = true;
    try {
        const chosen = await pickFolderNative(uploadDir);
        if (!chosen) return res.json({ success: false, cancelled: true, saveDir: uploadDir });

        fs.mkdirSync(chosen, { recursive: true });
        fs.accessSync(chosen, fs.constants.W_OK);

        uploadDir = chosen;
        config.saveDir = chosen;
        saveConfig(config);
        console.log(`📂 Nueva carpeta de destino: ${uploadDir}`);
        res.json({ success: true, saveDir: uploadDir });
    } catch (e) {
        console.error('Error al elegir carpeta:', e.message);
        res.status(500).json({ error: 'No se pudo usar esa carpeta: ' + e.message });
    } finally {
        pickerOpen = false;
    }
});

app.post('/api/open-folder', verifyToken, onlyLocalhost, (req, res) => {
    openPath(uploadDir);
    res.json({ success: true });
});

// El PIN se valida ANTES de escribir nada en disco
function checkUploadPin(req, res, next) {
    if (networkMode === 'public') {
        const clientPin = req.headers['x-local-drop-pin'] || req.query.pin;
        if (clientPin !== publicPin) {
            return res.status(401).json({ error: 'PIN incorrecto o red cambiada a modo público.' });
        }
    }
    next();
}

app.post('/upload', checkUploadPin, upload.array('files'), (req, res) => {
    console.log(`📁 Archivos recibidos (${req.files ? req.files.length : 0}) guardados en: ${uploadDir}`);
    res.status(200).json({ success: true, message: 'Archivos recibidos correctamente' });
});

app.get('/download/:filename', verifyToken, (req, res) => {
    const filePath = sessionFiles.get(req.params.filename);
    if (filePath && fs.existsSync(filePath)) {
        res.download(filePath);
    } else {
        res.status(404).send('Archivo no encontrado');
    }
});

app.get('/download-all', verifyToken, (req, res) => {
    res.attachment('LocalDrop_Archivos.zip');
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.pipe(res);
    for (const [name, filePath] of sessionFiles) {
        if (fs.existsSync(filePath)) archive.file(filePath, { name });
    }
    archive.finalize();
});

app.get('/shutdown', (req, res) => {
    const { token } = req.query;
    if (token === SESSION_TOKEN) {
        res.send(`
            <!DOCTYPE html>
            <html lang="es">
            <head><meta charset="UTF-8"><title>Sesión Cerrada</title></head>
            <body style="background:#090d16; color:#f8fafc; font-family:sans-serif; text-align:center; padding-top:50px;">
                <h2>🚪 Sesión finalizada correctamente.</h2>
                <p>Tus archivos quedaron guardados en tu carpeta. Ya podés cerrar esta ventana.</p>
            </body>
            </html>
        `);

        setTimeout(() => {
            console.log('\n🛑 Servidor cerrado por el usuario.');
            process.exit(0);
        }, 1000);
    } else {
        res.status(403).send('Token inválido');
    }
});

// Prioriza la IP de la red Wi-Fi/LAN real e ignora adaptadores virtuales
function getLocalIP() {
    const interfaces = os.networkInterfaces();
    const candidates = [];
    for (const name of Object.keys(interfaces)) {
        for (const net of interfaces[name]) {
            if ((net.family === 'IPv4' || net.family === 4) && !net.internal) {
                candidates.push({ name, address: net.address });
            }
        }
    }
    const virtual = /(vEthernet|VirtualBox|VMware|WSL|Hyper-V|docker|br-|veth|utun|vboxnet|Loopback|Tailscale|ZeroTier)/i;
    const score = (c) => {
        let s = 0;
        if (!virtual.test(c.name)) s += 10;
        if (/^192\.168\./.test(c.address)) s += 5;
        else if (/^10\./.test(c.address)) s += 4;
        else if (/^172\.(1[6-9]|2\d|3[01])\./.test(c.address)) s += 3;
        if (/^169\.254\./.test(c.address)) s -= 20;
        return s;
    };
    candidates.sort((a, b) => score(b) - score(a));
    return candidates.length ? candidates[0].address : '127.0.0.1';
}

// Abre una URL o carpeta con la app por defecto de cada sistema
function openPath(target) {
    if (process.platform === 'win32') {
        // "start" es un comando interno de cmd; el "" vacío es el título de la ventana
        spawn('cmd', ['/c', 'start', '""', target.replace(/&/g, '^&')], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else if (process.platform === 'darwin') {
        spawn('open', [target], { detached: true, stdio: 'ignore' }).unref();
    } else {
        spawn('xdg-open', [target], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
    }
}

let PORT = Number(process.env.PORT) || 3000;

function start(port, attemptsLeft) {
    PORT = port;
    server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
            console.log(`⚠️  El puerto ${port} está ocupado, probando con ${port + 1}...`);
            start(port + 1, attemptsLeft - 1);
        } else {
            console.error('No se pudo iniciar el servidor:', err.message);
            console.log('Presioná Enter para cerrar...');
            process.stdin.resume();
            process.stdin.once('data', () => process.exit(1));
        }
    });
    server.listen(port, '0.0.0.0', onListening);
}

function onListening() {
    const ip = getLocalIP();
    const urlDashboard = `http://localhost:${PORT}/?token=${SESSION_TOKEN}`;
    const urlMovil = `http://${ip}:${PORT}/movil?token=${SESSION_TOKEN}`;

    console.log('\n====================================================');
    console.log(`🚀 Local Drop activo en la red Wi-Fi`);
    console.log(`📂 Los archivos se guardan en: ${uploadDir}`);
    console.log(`   (podés cambiar la carpeta desde el panel del navegador)`);
    console.log(`💻 Panel: ${urlDashboard}`);
    console.log(`📱 Escaneá este QR con el celular para enviar archivos:`);
    console.log('====================================================\n');

    qrcode.generate(urlMovil, { small: true }, function (qrcodeStr) {
        console.log(qrcodeStr);
    });
    console.log('ℹ️  No cierres esta ventana mientras uses Local Drop.\n');

    openPath(urlDashboard);
}

start(PORT, 10);
