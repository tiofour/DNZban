const express = require('express');
const mysql = require('mysql2');
const bodyParser = require('body-parser');
const path = require('path');
const cors = require('cors');
const session = require('express-session');
const multer = require('multer');
require('dotenv').config();

// Integrasi SDK Cloudinary Storage
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware parser data
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Konfigurasi Session untuk Proteksi Login Admin
app.use(session({
    secret: process.env.SESSION_SECRET || 'bengkel-dnzban-secret-key-2026',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 60 * 60 * 1000, secure: false }
}));

// ==========================================
// CONFIG STORAGE DRIVER: CLOUDINARY
// ==========================================
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// Menyiapkan engine storage multer berbasis awan permanen
const storage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
        folder: 'dnzban_cloud_uploads', // Foto otomatis masuk ke folder ini di cloud cloudinary
        allowed_formats: ['jpg', 'png', 'jpeg', 'webp'],
        transformation: [{ width: 1200, crop: 'limit' }] // Otomatis kompresi gambar besar
    }
});
const upload = multer({ storage: storage, limits: { fileSize: 500 * 1024 } }); // Batas aman 500KB

// Middleware catcher error upload file
const handleUploadError = (err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'Ukuran file terlalu besar! Maksimal 500KB.' });
        return res.status(400).json({ error: err.message });
    } else if (err) {
        return res.status(400).json({ error: err.message });
    }
    next();
};

// ==========================================
// DATA CONNECTION: AIVEN DATABASE MYSQL
// ==========================================
const db = mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 3306,
    ssl: { rejectUnauthorized: false } // WAJIB ADA: bypass handshake SSL wajib bawaan Cloud Aiven
});

db.connect((err) => {
    if (err) { console.error('Koneksi Aiven MySQL Gagal:', err); return; }
    console.log('Koneksi Aiven MySQL Cloud Berhasil Terbuka!');
});

// ==========================================
// 1. API AUTHENTICATION ROUTING
// ==========================================
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    db.query('SELECT * FROM admins WHERE username = ? AND password = ?', [username, password], (err, results) => {
        if (err) return res.status(500).json({ success: false, message: 'Server error' });
        if (results.length > 0) {
            req.session.isAdminLoggedIn = true;
            req.session.adminUser = username;
            res.json({ success: true, message: 'Login berhasil!' });
        } else {
            res.status(401).json({ success: false, message: 'Username atau password salah!' });
        }
    });
});

app.get('/api/check-session', (req, res) => {
    if (req.session.isAdminLoggedIn) res.json({ loggedIn: true, username: req.session.adminUser });
    else res.json({ loggedIn: false });
});

app.get('/api/logout', (req, res) => { req.session.destroy(() => res.json({ success: true })); });

// ==========================================
// 2. API JAM OPERASIONAL ROUTING
// ==========================================
app.get('/api/opening-hours', (req, res) => {
    db.query('SELECT * FROM opening_hours ORDER BY id ASC', (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

app.put('/api/opening-hours', (req, res) => {
    if (!req.session.isAdminLoggedIn) return res.status(403).json({ error: 'Akses ditolak' });
    const schedules = req.body; 
    const days = Object.keys(schedules);
    let completed = 0; let errorOccurred = false;
    days.forEach(day => {
        db.query('UPDATE opening_hours SET hours = ? WHERE day_name = ?', [schedules[day], day], (err) => {
            if (err) errorOccurred = true;
            completed++;
            if (completed === days.length) {
                if (errorOccurred) return res.status(500).json({ error: 'Gagal update beberapa jadwal.' });
                res.json({ message: 'Jam operasional berhasil disimpan!' });
            }
        });
    });
});

// ==========================================
// 3. API SETTINGS (Mendukung Dual Multi-Upload)
// ==========================================
app.get('/api/settings', (req, res) => {
    db.query('SELECT * FROM settings WHERE id = 1', (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results[0]);
    });
});

const cpUpload = upload.fields([{ name: 'logo_file', maxCount: 1 }, { name: 'hero_file', maxCount: 1 }]);
app.put('/api/settings', cpUpload, handleUploadError, (req, res) => {
    if (!req.session.isAdminLoggedIn) return res.status(403).json({ error: 'Akses ditolak' });
    const { site_title, phone, email, address, maps_iframe } = req.body;
    let logo_url = req.body.logo_url;
    let hero_image_url = req.body.hero_image_url;

    // Menangkap URL absolut HTTPS permanen hasil unggahan Cloudinary (.path)
    if (req.files && req.files['logo_file']) logo_url = req.files['logo_file'][0].path; 
    if (req.files && req.files['hero_file']) hero_image_url = req.files['hero_file'][0].path; 

    const query = `UPDATE settings SET site_title = ?, phone = ?, email = ?, address = ?, maps_iframe = ?, logo_url = ?, hero_image_url = ? WHERE id = 1`;
    db.query(query, [site_title, phone, email, address, maps_iframe, logo_url, hero_image_url], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'Profil web & Gambar awan berhasil disimpan!' });
    });
});

// ==========================================
// 4. API SERVICES (LAYANAN BENGKEL)
// ==========================================
app.get('/api/services', (req, res) => {
    db.query('SELECT * FROM services', (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

app.get('/api/services/:id', (req, res) => {
    db.query('SELECT * FROM services WHERE id = ?', [req.params.id], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results[0]);
    });
});

app.post('/api/services', upload.single('service_file'), handleUploadError, (req, res) => {
    if (!req.session.isAdminLoggedIn) return res.status(403).json({ error: 'Akses ditolak' });
    const { name, description, price } = req.body;
    let image_url = 'https://via.placeholder.com/150';
    if (req.file) image_url = req.file.path;

    db.query('INSERT INTO services (name, description, price, image_url) VALUES (?, ?, ?, ?)', [name, description, price, image_url], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'Layanan baru berhasil ditambahkan!' });
    });
});

app.put('/api/services/:id', upload.single('service_file'), handleUploadError, (req, res) => {
    if (!req.session.isAdminLoggedIn) return res.status(403).json({ error: 'Akses ditolak' });
    const { name, description, price } = req.body;
    let image_url = req.body.image_url;
    if (req.file) image_url = req.file.path;

    db.query('UPDATE services SET name = ?, description = ?, price = ?, image_url = ? WHERE id = ?', [name, description, price, image_url, req.params.id], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'Layanan berhasil diperbarui!' });
    });
});

app.delete('/api/services/:id', (req, res) => {
    if (!req.session.isAdminLoggedIn) return res.status(403).json({ error: 'Akses ditolak' });
    db.query('DELETE FROM services WHERE id = ?', [req.params.id], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'Layanan berhasil dihapus!' });
    });
});

// ==========================================
// 5. API PRODUCTS (BAN & SPAREPART)
// ==========================================
app.get('/api/products', (req, res) => {
    db.query('SELECT * FROM products', (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

app.get('/api/products/:id', (req, res) => {
    db.query('SELECT * FROM products WHERE id = ?', [req.params.id], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results[0]);
    });
});

app.post('/api/products', upload.single('product_file'), handleUploadError, (req, res) => {
    if (!req.session.isAdminLoggedIn) return res.status(403).json({ error: 'Akses ditolak' });
    const { name, category, price } = req.body;
    let image_url = 'https://via.placeholder.com/300';
    if (req.file) image_url = req.file.path;

    db.query('INSERT INTO products (name, category, price, image_url) VALUES (?, ?, ?, ?)', [name, category, price, image_url], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'Produk berhasil ditambahkan!' });
    });
});

app.put('/api/products/:id', upload.single('product_file'), handleUploadError, (req, res) => {
    if (!req.session.isAdminLoggedIn) return res.status(403).json({ error: 'Akses ditolak' });
    const { name, category, price } = req.body;
    let image_url = req.body.image_url;
    if (req.file) image_url = req.file.path;

    db.query('UPDATE products SET name = ?, category = ?, price = ?, image_url = ? WHERE id = ?', [name, category, price, image_url, req.params.id], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'Data inventori berhasil diperbarui!' });
    });
});

app.delete('/api/products/:id', (req, res) => {
    if (!req.session.isAdminLoggedIn) return res.status(403).json({ error: 'Akses ditolak' });
    db.query('DELETE FROM products WHERE id = ?', [req.params.id], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'Produk berhasil dihapus!' });
    });
});

// Menyajikan file statis dari folder public
app.use(express.static(path.join(__dirname, '../public')));

// Jalankan listener jika dijalankan di localhost
if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => { console.log(`Server lokal berjalan aktif di http://localhost:${PORT}`); });
}

// Ekspor modul app demi kebutuhan serverless Vercel engine
module.exports = app;