// server.js - BACKEND MINIMAL UNTUK RAILWAY + MONGODB

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const cors = require('cors');

// Muat variabel lingkungan dari file .env
dotenv.config();

const app = express();
const server = http.createServer(app);

// Izinkan koneksi dari frontend Vercel Anda (ganti * dengan URL Vercel Anda!)
const io = new Server(server, {
    cors: {
        origin: "*", 
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;

// Middleware
app.use(cors());
app.use(express.json());

// --- MONGODB CONNECTION ---
mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ MongoDB Connected!'))
    .catch(err => console.error('❌ MongoDB Connection Error:', err));

// --- MONGODB SCHEMA (Contoh Sederhana) ---
const JobSchema = new mongoose.Schema({
    id: String,
    courierId: String,
    status: String, // new, on_delivery, completed, cancelled
    payment: Number,
    pickup: { name: String, address: String },
    delivery: { name: String, address: String },
    distance: String,
    estimate: Number,
    createdAt: { type: Date, default: Date.now },
    completedAt: Date,
});
const Job = mongoose.model('Job', JobSchema);

// --- SIMULASI DATA & STATE BACKEND ---
let backendState = {
    couriers: {}, // { 'courier_001': { socketId: '...', online: true, whatsappStatus: 'disconnected' } }
    jobs: [], // Daftar job di database
};

let qrCodeData = null; // Simpan QR code sementara
let whatsappStatus = 'connecting'; 
let jobCounter = 1000;

// Fungsi Simulasi Job
function createNewJob(courierId) {
    jobCounter++;
    const newJobId = 'S' + jobCounter; 
    const locations = [
        { name: 'Toko Baju A', address: 'Jl. Riau No. 50, Bandung, Jawa Barat, 40115' },
        { name: 'Warung Nasi Cepat Saji', address: 'Jl. Pemuda No. 101, Jakarta Timur, 13220' },
        { name: 'Gudang Logistik X', address: 'Jl. Raya Bekasi KM 20, Jakarta Timur, 13910' },
        { name: 'Kantor Pusat', address: 'Jl. HR Rasuna Said Kav. X-2 No. 5, Jakarta Selatan, 12950' },
    ];
    
    const pickup = locations[Math.floor(Math.random() * locations.length)];
    const delivery = locations[Math.floor(Math.random() * locations.length)];
    const payment = Math.floor(Math.random() * 80 + 30) * 1000;

    const newJob = new Job({
        id: newJobId,
        courierId: courierId, // Belum ada kurir
        status: 'new',
        payment: payment,
        pickup: pickup,
        delivery: delivery,
        distance: (Math.random() * 5 + 2).toFixed(1),
        estimate: Math.floor(Math.random() * 20 + 15),
        createdAt: new Date(),
    });
    
    return newJob;
}

// SIMULASI QR CODE (Ganti dengan logika WhatsApp Anda)
function simulateQR() {
    qrCodeData = 'https://quickchart.io/qr?text=COURIER_APP_QR_SIMULATION' + Date.now();
    whatsappStatus = 'qr_received';
    // Kirim QR ke semua kurir yang terhubung
    io.to('courier').emit('whatsapp_status', { status: whatsappStatus, qr: qrCodeData });
}
setTimeout(simulateQR, 5000); // Simulasi QR muncul setelah 5 detik

// SIMULASI KONEKSI WA BERHASIL
setTimeout(() => {
    whatsappStatus = 'connected';
    qrCodeData = null;
    io.to('courier').emit('whatsapp_status', { status: whatsappStatus, qr: null });
}, 30000); // Simulasi koneksi berhasil setelah 30 detik

// SIMULASI JOB BARU (SETIAP 60 DETIK)
setInterval(async () => {
    if (Object.keys(backendState.couriers).length > 0) {
        const newJob = createNewJob(null);
        await newJob.save(); // Simpan ke MongoDB
        backendState.jobs.push(newJob);
        // Kirim ke semua kurir yang online
        io.to('courier').emit('new_job_available', newJob);
        console.log(`📢 Job Baru #${newJob.id} dikirim.`);
    }
}, 60000);


// --- SOCKET.IO HANDLERS ---
io.on('connection', (socket) => {
    const role = socket.handshake.query.role;
    const courierId = socket.handshake.query.courierId;

    if (role === 'courier' && courierId) {
        // Gabungkan ke 'courier' room
        socket.join('courier');
        backendState.couriers[courierId] = { socketId: socket.id, online: true, whatsappStatus: whatsappStatus };
        console.log(`Kurir ${courierId} terhubung.`);
        
        // Kirim status WhatsApp saat kurir terhubung
        socket.emit('whatsapp_status', { status: whatsappStatus, qr: qrCodeData });
    }

    // [EVENT] Kurir meminta data awal
    socket.on('request_initial_data', async (data) => {
        try {
            const newJobs = await Job.find({ status: 'new' }).sort({ createdAt: -1 }).limit(5);
            newJobs.forEach(job => backendState.jobs.push(job)); // Update state lokal
            
            // Kirim 5 job terbaru yang statusnya 'new'
            socket.emit('initial_jobs', newJobs);
            console.log(`Mengirim ${newJobs.length} job awal ke kurir ${data.courierId}.`);
        } catch (error) {
            console.error('Error fetching initial data:', error);
        }
    });

    // [EVENT] Kurir menerima job
    socket.on('job_accepted', async (data) => {
        console.log(`Job #${data.jobId} diterima oleh ${data.courierId}`);
        const job = await Job.findOneAndUpdate({ id: data.jobId, status: 'new' }, 
            { $set: { status: 'on_delivery', courierId: data.courierId, startedAt: new Date() } }, 
            { new: true }
        );
        // Hapus job dari daftar 'new' di state lokal agar tidak dikirim ke kurir lain
        backendState.jobs = backendState.jobs.filter(j => j.id !== data.jobId);

        // Notifikasi ke sistem lain (opsional)
        // io.emit('job_status_update', job);
    });

    // [EVENT] Kurir menolak job (opsional, bisa saja hanya dilakukan di frontend)
    socket.on('job_rejected', (data) => {
        console.log(`Job #${data.jobId} ditolak oleh ${data.courierId}`);
        // Logika untuk mengirim ke kurir lain
    });

    // [EVENT] Kurir menyelesaikan job
    socket.on('job_completed', async (data) => {
        console.log(`Job #${data.jobId} diselesaikan oleh ${data.courierId}`);
        await Job.findOneAndUpdate({ id: data.jobId }, 
            { $set: { status: 'completed', completedAt: new Date() } }
        );
        // Logika update saldo di database (jika ada skema Saldo Kurir)
    });
    
    // [EVENT] Cek status WhatsApp (dari frontend)
    socket.on('get_whatsapp_status', () => {
        socket.emit('whatsapp_status', { status: whatsappStatus, qr: qrCodeData });
    });

    // [EVENT] Kurir mengirim pesan
    socket.on('send_message', (data) => {
        console.log(`Pesan dari Kurir ${data.sender} untuk Job ${data.jobId}: ${data.message}`);
        // Logika di sini untuk meneruskan pesan ke Customer via WhatsApp
        // Jika sukses, kirim balik event 'message_sent'
        // io.to('customer_room_' + data.jobId).emit('new_message', data);
    });

    socket.on('disconnect', () => {
        if (courierId && backendState.couriers[courierId]) {
            backendState.couriers[courierId].online = false;
            console.log(`Kurir ${courierId} terputus.`);
        }
    });
}

// --- EXPRESS ENDPOINTS ---
app.get('/', (req, res) => {
    res.send('Courier Backend is Running! (Socket.IO port: ' + PORT + ')');
});

// Endpoint untuk Health Check (diakses dari Vercel/luar)
app.get('/api/health', (req, res) => {
    res.json({
        status: 'OK',
        whatsapp: whatsappStatus,
        database: mongoose.connection.readyState === 1 ? 'Connected' : 'Disconnected'
    });
});


// Jalankan Server
server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});