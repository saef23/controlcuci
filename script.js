// ==================== KONFIGURASI MQTT & BLE ====================
let mqttClient;
const mqttBroker = "broker.hivemq.com";
const mqttPort   = 8884; // Port WSS HiveMQ
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
    cekStatusIzinNotifikasi();
});

// ==================== NOTIFIKASI & GETAR HP ====================
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
            } else {
                alert("Izin notifikasi ditolak oleh browser!");
            }
        });
    } else {
        alert("Browser Anda tidak mendukung Notifikasi.");
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
    btn.innerText = `Hubungkan ke ${mode}`;
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
        alert("Browser tidak mendukung Bluetooth API! Gunakan Chrome / Edge.");
        return;
    }

    try {
        log("Mencari perangkat BLE...");
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
    document.getElementById("labelDurasiVal").innerText = val + " Menit";
}

function jalankanSpinCustom() {
    let durasi = parseInt(document.getElementById("sliderDurasi").value) || 5;
    durasi = Math.min(Math.max(durasi, 1), 7);
    log(`[Manual] Spin Only (${durasi}m)`);
    kirimPerintah(`CMD:4:${durasi}`);
}

function jalankanCuciSajaCustom() {
    let durasi = parseInt(document.getElementById("sliderDurasi").value) || 10;
    durasi = Math.min(Math.max(durasi, 1), 15);
    log(`[Manual] Cuci Saja (${durasi}m)`);
    kirimPerintah(`CMD:5:${durasi}`);
}

// ==================== KONTROL UTAMA ====================
function kirimPerintah(cmd) {
    if (cmd.startsWith("CMD:") && cmd !== "CMD:STOP") {
        startLapTimer();
        setProgressRing(0);
    } else if (cmd === "CMD:STOP") {
        stopLapTimer();
        document.getElementById("namaProsesAktif").innerText = "DIHENTIKAN";
        document.getElementById("prosesStepTimer").innerText = "0s";
        document.getElementById("percentLabel").innerText = "0%";
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
    if (payload.startsWith("TIMER|")) {
        const parts = payload.split("|");
        const namaProses = parts[1].trim();
        const sisaWaktu = parts[2];
        const sisaAngka = parseInt(sisaWaktu);

        document.getElementById("namaProsesAktif").innerText = namaProses.toUpperCase();
        document.getElementById("prosesStepTimer").innerText = sisaWaktu;

        if (prosesSebelumnya !== "" && prosesSebelumnya !== namaProses) {
            pemicuGetarDanBeep(150);
            log(`[Step] Pindah ke: ${namaProses}`);
        }
        prosesSebelumnya = namaProses;

        if (!isNaN(sisaAngka) && sisaAngka > 0) {
            const percent = Math.min(100, Math.max(5, (100 - (sisaAngka % 100))));
            setProgressRing(percent);
            document.getElementById("percentLabel").innerText = percent + "%";
        }
    } else if (payload.startsWith("DATA|")) {
        const waterMatch = payload.match(/WATER:(PENUH|KOSONG)/);
        const inletMatch = payload.match(/INLET:(ON|OFF)/);
        const drainMatch = payload.match(/DRAIN:(ON|OFF)/);
        const kiriMatch  = payload.match(/KIRI:(ON|OFF)/);
        const kananMatch = payload.match(/KANAN:(ON|OFF)/); // Perbaikan kurung tutup

        const water = waterMatch ? waterMatch[1] : "-";
        const inlet = inletMatch ? inletMatch[1] : "OFF";
        const drain = drainMatch ? drainMatch[1] : "OFF";
        let motor = "OFF";
        if (kiriMatch && kiriMatch[1] === "ON") motor = "KIRI";
        else if (kananMatch && kananMatch[1] === "ON") motor = "KANAL" || "KANAN";

        updateHardwareUI(water, inlet, drain, motor);
    } else if (payload === "SELESAI" || payload === "DIHENTIKAN") {
        stopLapTimer();
        document.getElementById("namaProsesAktif").innerText = payload;
        document.getElementById("prosesStepTimer").innerText = "0s";
        document.getElementById("percentLabel").innerText = payload === "SELESAI" ? "100%" : "0%";
        setProgressRing(payload === "SELESAI" ? 100 : 0);
        updateHardwareUI("KOSONG", "OFF", "OFF", "OFF");
        log("ESP32: " + payload);

        if (payload === "SELESAI") {
            kirimNotifikasiSelesai();
        }
    } else {
        log("ESP32: " + payload);
    }
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
    if(!circle) return;
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
        document.getElementById("totalLapTimer").innerText = `Total: ${menit}:${detik}`;
    }, 1000);
}

function stopLapTimer() {
    if (lapInterval) clearInterval(lapInterval);
    lapInterval = null;
    prosesSebelumnya = "";
}

function updateHardwareUI(water, inlet, drain, motor) {
    document.getElementById("statusWaterVal").innerText = water;
    document.getElementById("statusInletVal").innerText = inlet;
    document.getElementById("statusDrainVal").innerText = drain;
    document.getElementById("statusMotorVal").innerText = motor;

    document.getElementById("hwWater").className = `hw-item ${water === "PENUH" ? "active" : ""}`;
    document.getElementById("hwInlet").className = `hw-item ${inlet === "ON" ? "active" : ""}`;
    document.getElementById("hwDrain").className = `hw-item ${drain === "ON" ? "active" : ""}`;
    document.getElementById("hwMotor").className = `hw-item ${motor !== "OFF" ? "active" : ""}`;
}

function log(msg) {
    const box = document.getElementById("logTerminal");
    if(!box) return;
    box.innerHTML += msg + "<br>";
    box.scrollTop = box.scrollHeight;
}
