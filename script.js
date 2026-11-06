// ==================== KONFIGURASI MQTT & BLE ====================
let mqttClient;
const mqttBroker = "broker.hivemq.com";
const mqttPort   = 8884; // Port WSS HiveMQ (SSL)
const clientId   = "WebClient_Washer_" + Math.floor(Math.random() * 100000);
const topicCommand = "mesincuci/command";
const topicStatus  = "mesincuci/status";

let bleDevice = null;
let bleServer = null;
let bleCharacteristic = null;
const SERVICE_UUID           = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const CHARACTERISTIC_UUID_RX = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";
const CHARACTERISTIC_UUID_TX = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";

let modeAktif = "MQTT";
let lapInterval = null;
let lapDetikTotal = 0;
const circumference = 440;
let prosesSebelumnya = "";

document.addEventListener("DOMContentLoaded", () => {
    // Hanya mengecek status izin saat dimuat (TIDAK langsung meminta izin otomatis)
    cekStatusIzinNotifikasi();
});

// ==================== NOTIFIKASI & GETAR HP ====================
// Dipanggil HANYA saat tombol "🔔 Aktifkan Notifikasi" diklik oleh user
function mintaIzinNotifikasi() {
    if ("Notification" in window) {
        Notification.requestPermission().then((permission) => {
            if (permission === "granted") {
                log("[System] Notifikasi & Getar Berhasil Diaktifkan!");
                pemicuGetarDanBeep(200);
                updateTombolNotif(true);
                new Notification("Smart Washer", {
                    body: "Notifikasi & Getar siap digunakan!",
                    icon: "https://cdn-icons-png.flaticon.com/512/2965/2965358.png"
                });
            } else if (permission === "denied") {
                alert("Izin notifikasi ditolak! Silakan aktifkan izin notifikasi dari pengaturan browser / ikon gembok di URL.");
            }
        });
    } else {
        alert("Browser Anda tidak mendukung Web Notification API.");
    }
}

function cekStatusIzinNotifikasi() {
    if ("Notification" in window && Notification.permission === "granted") {
        updateTombolNotif(true);
    }
}

function updateTombolNotif(isGranted) {
    const btn = document.getElementById("btnNotif");
    if (!btn) return;
    if (isGranted) {
        btn.innerText = "🔔 Notifikasi & Getar: AKTIF";
        btn.style.background = "#2e7d32";
        btn.style.borderColor = "#4caf50";
    }
}

function pemicuGetarDanBeep(durasiMs) {
    if ("vibrate" in navigator) navigator.vibrate(durasiMs);
    try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) return;
        const ctx = new AudioContext();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.type = 'sine';
        osc.frequency.setValueAtTime(750, ctx.currentTime);
        gain.gain.setValueAtTime(0.1, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.00001, ctx.currentTime + (durasiMs / 1000));

        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + (durasiMs / 1000));
    } catch (e) {
        console.log("Audio Error:", e);
    }
}

function kirimNotifikasiSelesai() {
    if ("vibrate" in navigator) navigator.vibrate([400, 150, 400, 150, 800]);

    try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (AudioContext) {
            const ctx = new AudioContext();
            [0, 0.3, 0.6].forEach((delay) => {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.type = 'sine';
                osc.frequency.setValueAtTime(880, ctx.currentTime + delay);
                gain.gain.setValueAtTime(0.12, ctx.currentTime + delay);
                gain.gain.exponentialRampToValueAtTime(0.00001, ctx.currentTime + delay + 0.25);
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.start(ctx.currentTime + delay);
                osc.stop(ctx.currentTime + delay + 0.25);
            });
        }
    } catch (e) {
        console.log("Audio Error:", e);
    }

    if ("Notification" in window && Notification.permission === "granted") {
        new Notification("Smart Washer", {
            body: "🎉 Semua proses pencucian telah SELESAI!",
            icon: "https://cdn-icons-png.flaticon.com/512/2965/2965358.png",
            vibrate: [400, 150, 400, 150, 800],
            requireInteraction: true
        });
    }
}

// ==================== KONEKSI HYBRID (MQTT & BLE) ====================
function gantiModeKoneksi(mode) {
    modeAktif = mode;
    const btn = document.getElementById("btnConnect");
    if (btn) btn.innerText = `Hubungkan ke ${mode}`;
    log(`[Mode System] Berpindah ke mode ${mode}`);
}

function hubungkanPerangkat() {
    if (modeAktif === "MQTT") connectMQTT();
    else if (modeAktif === "BLE") connectBLE();
}

function connectMQTT() {
    log(`Menghubungkan ke HiveMQ (${mqttBroker}:${mqttPort})...`);
    updateStatusUI("CONNECTING...", "#ff9800", "#000");

    mqttClient = new Paho.MQTT.Client(mqttBroker, Number(mqttPort), clientId);
    mqttClient.onConnectionLost = onConnectionLost;
    mqttClient.onMessageArrived = onMessageArrived;

    const options = {
        timeout: 10,
        useSSL: true,
        cleanSession: true,
        onSuccess: () => {
            log("HiveMQ Terhubung!");
            updateStatusUI("MQTT: ON", "#00e676", "#000");
            mqttClient.subscribe(topicStatus);
        },
        onFailure: (res) => {
            log("Gagal Konek MQTT: " + res.errorMessage);
            updateStatusUI("MQTT: OFF", "#e53935", "#fff");
        }
    };

    mqttClient.connect(options);
}

function onConnectionLost(responseObject) {
    if (responseObject.errorCode !== 0) {
        log("Koneksi MQTT Terputus: " + responseObject.errorMessage);
        updateStatusUI("MQTT: OFF", "#e53935", "#fff");
        stopLapTimer();
    }
}

async function connectBLE() {
    if (!navigator.bluetooth) {
        alert("Browser tidak mendukung Web Bluetooth API! Gunakan Google Chrome / Microsoft Edge.");
        return;
    }

    try {
        log("Mencari perangkat BLE ESP32...");
        bleDevice = await navigator.bluetooth.requestDevice({
            acceptAllDevices: true,
            optionalServices: [SERVICE_UUID]
        });

        bleServer = await bleDevice.gatt.connect();
        const service = await bleServer.getPrimaryService(SERVICE_UUID);
        bleCharacteristic = await service.getCharacteristic(CHARACTERISTIC_UUID_RX);
        
        const txCharacteristic = await service.getCharacteristic(CHARACTERISTIC_UUID_TX);
        await txCharacteristic.startNotifications();
        txCharacteristic.addEventListener('characteristicvaluechanged', handleBLENotify);

        updateStatusUI("BLE: ON", "#00e676", "#000");
        log("Bluetooth BLE Terhubung!");
        bleDevice.addEventListener('gattserverdisconnected', () => {
            log("Koneksi Bluetooth Terputus!");
            updateStatusUI("BLE: OFF", "#e53935", "#fff");
            stopLapTimer();
        });
    } catch (error) {
        log("Gagal Koneksi BLE: " + error);
        updateStatusUI("BLE: OFF", "#e53935", "#fff");
    }
}

function handleBLENotify(event) {
    let decoder = new TextDecoder('utf-8');
    prosesPayloadData(decoder.decode(event.target.value).trim());
}

// ==================== SLIDER & MANUAL MODE ====================
function updateSliderLabel(val) {
    const label = document.getElementById("labelDurasiVal");
    if (label) label.innerText = val + " Menit";
}

function jalankanSpinCustom() {
    const slider = document.getElementById("sliderDurasi");
    let durasi = slider ? parseInt(slider.value) : 5;
    durasi = Math.min(Math.max(durasi, 1), 7);
    log(`[Manual] Spin Only (${durasi}m)`);
    kirimPerintah(`CMD:4:${durasi}`);
}

function jalankanCuciSajaCustom() {
    const slider = document.getElementById("sliderDurasi");
    let durasi = slider ? parseInt(slider.value) : 10;
    durasi = Math.min(Math.max(durasi, 1), 15);
    log(`[Manual] Cuci Saja (${durasi}m)`);
    kirimPerintah(`CMD:5:${durasi}`);
}

// ==================== KONTROL UTAMA & PAYLOAD PARSER ====================
function kirimPerintah(cmd) {
    if (cmd.startsWith("CMD:") && cmd !== "CMD:STOP") {
        startLapTimer();
        setProgressRing(0);
    } else if (cmd === "CMD:STOP") {
        stopLapTimer();
        updateElemenTeks("namaProsesAktif", "DIHENTIKAN");
        updateElemenTeks("prosesStepTimer", "0s");
        updateElemenTeks("percentLabel", "0%");
        setProgressRing(0);
        updateHardwareUI("KOSONG", "OFF", "OFF", "OFF");
    }

    if (modeAktif === "MQTT") {
        if (!mqttClient || !mqttClient.isConnected()) {
            alert("MQTT Belum Terhubung!");
            return;
        }
        const message = new Paho.MQTT.Message(cmd);
        message.destinationName = topicCommand;
        mqttClient.send(message);
        log("Kirim MQTT -> " + cmd);
    } else if (modeAktif === "BLE") {
        if (!bleCharacteristic) {
            alert("Bluetooth BLE Belum Terhubung!");
            return;
        }
        let encoder = new TextEncoder('utf-8');
        bleCharacteristic.writeValue(encoder.encode(cmd + "\n"));
        log("Kirim BLE -> " + cmd);
    }
}

function onMessageArrived(message) {
    prosesPayloadData(message.payloadString.trim());
}

function prosesPayloadData(payload) {
    // Menghilangkan awalan STATUS: jika ada dari broadcast ESP32
    if (payload.startsWith("STATUS:")) {
        payload = payload.replace("STATUS:", "").trim();
    }

    if (payload.startsWith("TIMER|")) {
        // Format: TIMER|NamaProses|SisaDetiks
        const parts = payload.split("|");
        const namaProses = parts[1] ? parts[1].trim() : "PROSES";
        const sisaWaktu = parts[2] ? parts[2].trim() : "0s";
        const sisaAngka = parseInt(sisaWaktu);

        updateElemenTeks("namaProsesAktif", namaProses.toUpperCase());
        updateElemenTeks("prosesStepTimer", sisaWaktu);

        if (prosesSebelumnya !== "" && prosesSebelumnya !== namaProses) {
            pemicuGetarDanBeep(150);
            log(`[Step] Pindah ke: ${namaProses}`);
        }
        prosesSebelumnya = namaProses;

        if (!isNaN(sisaAngka) && sisaAngka >= 0) {
            // Kalkulasi persentase visual ring
            const percent = Math.min(100, Math.max(0, (100 - (sisaAngka % 100))));
            setProgressRing(percent);
            updateElemenTeks("percentLabel", percent + "%");
        }
    } else if (payload.startsWith("DATA|")) {
        // Format: DATA|WATER:PENUH|PWR:ON|INLET:ON|BOOSTER:ON|DRAIN:OFF|KIRI:OFF|KANAN:ON
        const waterMatch = payload.match(/WATER:(PENUH|KOSONG)/);
        const inletMatch = payload.match(/INLET:(ON|OFF)/);
        const drainMatch = payload.match(/DRAIN:(ON|OFF)/);
        const kiriMatch  = payload.match(/KIRI:(ON|OFF)/);
        const kananMatch = payload.match(/KANAN:(ON|OFF)/);

        const water = waterMatch ? waterMatch[1] : "-";
        const inlet = inletMatch ? inletMatch[1] : "OFF";
        const drain = drainMatch ? drainMatch[1] : "OFF";
        
        let motor = "OFF";
        if (kiriMatch && kiriMatch[1] === "ON") {
            motor = "KIRI";
        } else if (kananMatch && kananMatch[1] === "ON") {
            motor = "KANAN";
        }

        updateHardwareUI(water, inlet, drain, motor);
    } else if (payload.includes("SELESAI") || payload.includes("DIHENTIKAN")) {
        stopLapTimer();
        const statusAkhir = payload.includes("SELESAI") ? "SELESAI" : "DIHENTIKAN";
        updateElemenTeks("namaProsesAktif", statusAkhir);
        updateElemenTeks("prosesStepTimer", "0s");
        updateElemenTeks("percentLabel", statusAkhir === "SELESAI" ? "100%" : "0%");
        setProgressRing(statusAkhir === "SELESAI" ? 100 : 0);
        updateHardwareUI("KOSONG", "OFF", "OFF", "OFF");
        log("ESP32: " + payload);

        if (statusAkhir === "SELESAI") {
            kirimNotifikasiSelesai();
        }
    } else {
        log("ESP32: " + payload);
    }
}

// ==================== UTILITAS UPDATE UI ====================
function updateElemenTeks(id, teks) {
    const elem = document.getElementById(id);
    if (elem) elem.innerText = teks;
}

function updateStatusUI(teks, bg, warnaTeks) {
    const statusElem = document.getElementById("statusKoneksi");
    if (!statusElem) return;
    statusElem.innerText = teks;
    statusElem.style.background = bg;
    statusElem.style.color = warnaTeks;
}

function setProgressRing(percent) {
    const circle = document.getElementById("circleProgress");
    if (!circle) return;
    circle.style.strokeDashoffset = circumference - (percent / 100 * circumference);
}

function startLapTimer() {
    stopLapTimer();
    lapDetikTotal = 0;
    prosesSebelumnya = "";
    lapInterval = setInterval(() => {
        lapDetikTotal++;
        const menit = String(Math.floor(lapDetikTotal / 60)).padStart(2, '0');
        const detik = String(lapDetikTotal % 60).padStart(2, '0');
        updateElemenTeks("totalLapTimer", `Total: ${menit}:${detik}`);
    }, 1000);
}

function stopLapTimer() {
    if (lapInterval) clearInterval(lapInterval);
    lapInterval = null;
    prosesSebelumnya = "";
}

function updateHardwareUI(water, inlet, drain, motor) {
    updateElemenTeks("statusWaterVal", water);
    updateElemenTeks("statusInletVal", inlet);
    updateElemenTeks("statusDrainVal", drain);
    updateElemenTeks("statusMotorVal", motor);

    const hwWater = document.getElementById("hwWater");
    const hwInlet = document.getElementById("hwInlet");
    const hwDrain = document.getElementById("hwDrain");
    const hwMotor = document.getElementById("hwMotor");

    if (hwWater) hwWater.className = `hw-item ${water === "PENUH" ? "active" : ""}`;
    if (hwInlet) hwInlet.className = `hw-item ${inlet === "ON" ? "active" : ""}`;
    if (hwDrain) hwDrain.className = `hw-item ${drain === "ON" ? "active" : ""}`;
    if (hwMotor) hwMotor.className = `hw-item ${motor !== "OFF" ? "active" : ""}`;
}

function log(msg) {
    const box = document.getElementById("logTerminal");
    if (!box) return;
    box.innerHTML += msg + "<br>";
    box.scrollTop = box.scrollHeight;
}
