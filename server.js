const express = require('express');
const http = require('http');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const qrcode = require('qrcode-terminal');
const archiver = require('archiver');
const { exec } = require('child_process');

const app = express();
const server = http.createServer(app);

// Token único de sesión principal que cambia en cada reinicio del servidor
const SESSION_TOKEN = crypto.randomBytes(16).toString('hex');
const SERVER_BOOT_ID = Date.now().toString();

const uploadDir = path.join(os.homedir(), 'Desktop', 'LocalDrop_Recibidos');

if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
} else {
    fs.readdirSync(uploadDir).forEach(file => {
        const curPath = path.join(uploadDir, file);
        try {
            if (fs.lstatSync(curPath).isFile()) {
                fs.unlinkSync(curPath);
            }
        } catch (e) {}
    });
    console.log('🧹 Limpieza automática: Sesión anterior purgada.');
}

let networkMode = 'domestic'; // 'domestic' o 'public'
let publicPin = '123456';     

const pinAttempts = {};
const RATE_LIMIT_WINDOW = 60 * 1000;
const MAX_ATTEMPTS = 5;

function checkRateLimit(req, res, next) {
    const ip = req.ip || req.connection.remoteAddress;
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

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, Buffer.from(file.originalname, 'latin1').toString('utf8'))
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

app.use(express.static(path.join(__dirname)));

app.get('/', verifyToken, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Ruta móvil protegida por el token de sesión (Muere si se reinicia el server)
app.get('/movil', verifyToken, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Endpoint de estado LIBRE (sin verifyToken) para que el celular consulte la red en vivo
app.get('/api/status', (req, res) => {
    const ip = getLocalIP();
    const mobileUrl = `http://${ip}:${PORT}/movil?token=${SESSION_TOKEN}`;
    
    fs.readdir(uploadDir, (err, files) => {
        if (err) {
            return res.json({ mobileUrl, networkMode, publicPin, serverBootId: SERVER_BOOT_ID, files: [] });
        }
        const fileList = files.map(filename => {
            const filePath = path.join(uploadDir, filename);
            const stats = fs.statSync(filePath);
            return {
                filename: filename,
                originalName: filename,
                size: stats.size,
                createdAt: stats.birthtime
            };
        });
        res.json({ mobileUrl, networkMode, publicPin, serverBootId: SERVER_BOOT_ID, files: fileList });
    });
});

app.get('/api/verify-pin', checkRateLimit, (req, res) => {
    const { pin } = req.query;
    const ip = req.ip || req.connection.remoteAddress;

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
    if (mode) networkMode = mode;
    if (pin && pin.trim().length === 6) publicPin = pin.trim();
    
    console.log(`🌐 Modo de red actualizado a: ${networkMode.toUpperCase()}`);
    res.json({ success: true, networkMode, publicPin });
});

// Endpoint de subida limpio y definitivo
app.post('/upload', upload.array('files'), (req, res) => {
    const clientPin = req.headers['x-local-drop-pin'] || req.query.pin;

    // Solo validamos PIN si estamos estrictamente en modo público
    if (networkMode === 'public') {
        if (clientPin !== publicPin) {
            return res.status(401).json({ error: 'PIN incorrecto o red cambiada a modo público.' });
        }
    }

    try {
        console.log(`📁 Archivos recibidos (${req.files ? req.files.length : 0}) guardados en: ${uploadDir}`);
        res.status(200).json({ success: true, message: 'Archivos recibidos correctamente' });
    } catch (error) {
        console.error('Error al guardar archivos:', error);
        res.status(500).json({ success: false, error: 'Error interno al guardar' });
    }
});

app.get('/download/:filename', verifyToken, (req, res) => {
    const filename = req.params.filename;
    const filePath = path.join(uploadDir, filename);
    if (fs.existsSync(filePath)) {
        res.download(filePath);
    } else {
        res.status(404).send('Archivo no encontrado');
    }
});

app.get('/download-all', verifyToken, (req, res) => {
    res.attachment('LocalDrop_Archivos.zip');
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.pipe(res);
    archive.directory(uploadDir, false);
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
                <p>Ya podés cerrar esta ventana y la terminal.</p>
            </body>
            </html>
        `);
        
        setTimeout(() => {
            console.log('\n🛑 Servidor cerrado por el usuario. Limpiando y saliendo...');
            try {
                fs.readdirSync(uploadDir).forEach(file => {
                    fs.unlinkSync(path.join(uploadDir, file));
                });
            } catch (e) {}
            process.exit(0);
        }, 1000);
    } else {
        res.status(403).send('Token inválido');
    }
});

function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const net of interfaces[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                return net.address;
            }
        }
    }
    return '127.0.0.1';
}

const PORT = 3000;
server.listen(PORT, '0.0.0.0', () => {
    const ip = getLocalIP();
    const urlDashboard = `http://localhost:${PORT}/?token=${SESSION_TOKEN}`;
    const urlMovil = `http://${ip}:${PORT}/movil?token=${SESSION_TOKEN}`;
    
    console.log('\n====================================================');
    console.log(`🚀 Local Drop activo en la red Wi-Fi`);
    console.log(`📱 Escaneá este QR con el celular para enviar archivos:`);
    console.log('====================================================\n');
    
    qrcode.generate(urlMovil, { small: true }, function (qrcodeStr) {
        console.log(qrcodeStr);
    });
    
    exec(`open "${urlDashboard}"`);
});