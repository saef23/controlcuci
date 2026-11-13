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
const circumference = 502; // Disesuaikan dengan r = 80 (2 * pi * 80)
let prosesSebelumnya = "";

let totalDurasiDetik = 0;
let sisaDetikBerjalan = 0;

// Status 4 Saklar (Lampu 1-3 & Relay 4 untuk Charger HP)
const statusLampu = { 1: false, 2: false, 3: false, 4: false };

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
            } else if (permission === "denied") {
                alert("Izin notifikasi ditolak! Aktifkan manual dari pengaturan browser.");
            }
        });
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

// ==================== PERINTAH SUARA KONTINYU & RESPON AUDIO ====================
let recognition = null;
let isContinuousActive = false;

function toggleVoiceControl() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    
    if (!SpeechRecognition) {
        alert("Browser kamu tidak mendukung Web Speech API. Gunakan Google Chrome.");
        return;
    }

    if (!recognition) {
        recognition = new SpeechRecognition();
        recognition.lang = 'id-ID'; // Bahasa Indonesia
        recognition.interimResults = false;
        recognition.maxAlternatives = 1;
        recognition.continuous = true; 

        recognition.onstart = function() {
            isContinuousActive = true;
            updateVoiceBtnUI(true);
            log("[Voice] Mode Asisten Suara Aktif. Silakan bicara kapan saja...");
        };

        recognition.onresult = function(event) {
            const speechResult = event.results[event.results.length - 1][0].transcript.toLowerCase().trim();
            log(`[Voice Mendengar]: "${speechResult}"`);
            prosesPerintahSuara(speechResult);
        };

        recognition.onerror = function(event) {
            log("[Voice Error]: " + event.error);
            if (event.error === 'no-speech' && isContinuousActive) {
                return;
            }
        };

        recognition.onend = function() {
            if (isContinuousActive) {
                try {
                    recognition.start();
                } catch (e) {
                    console.log("Restart mic error:", e);
                }
            } else {
                updateVoiceBtnUI(false);
                log("[Voice] Asisten Suara Dimatikan.");
            }
        };
    }

    if (isContinuousActive) {
        isContinuousActive = false;
        recognition.stop();
        ucap("Asisten suara dimatikan.");
    } else {
        recognition.start();
        ucap("Asisten suara siap. Silakan berikan perintah.");
    }
}

function updateVoiceBtnUI(aktif) {
    const btn = document.getElementById("btnVoice");
    if (!btn) return;
    if (aktif) {
        btn.innerText = "🎙️ Asisten Suara: STANDBY (Mendengarkan...)";
        btn.style.background = "#2e7d32";
        btn.style.borderColor = "#4caf50";
    } else {
        btn.innerText = "🎤 Aktifkan Asisten Suara (Auto-Listen)";
        btn.style.background = "#1a2332";
        btn.style.borderColor = "#28303d";
    }
}

function ucap(teks) {
    if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(teks);
        utterance.lang = 'id-ID';
        utterance.rate = 1.0;
        window.speechSynthesis.speak(utterance);
    }
}

function setLampuLangsung(noLampu, nyala, pesanSuara) {
    if (statusLampu[noLampu] !== nyala) {
        toggleLampu(noLampu);
    }
    ucap(pesanSuara);
}

function prosesPerintahSuara(text) {
    if (text.includes("cepat")) {
        ucap("Oke, siap jalankan mode cepat.");
        log("[Voice Exec] Menjalankan Mode Cepat");
        kirimPerintah('CMD:1');
    } else if (text.includes("normal")) {
        ucap("Siap, mode normal diaktifkan.");
        log("[Voice Exec] Menjalankan Mode Normal");
        kirimPerintah('CMD:2');
    } else if (text.includes("berat")) {
        ucap("Baik, mode berat.");
        log("[Voice Exec] Menjalankan Mode Berat");
        kirimPerintah('CMD:3');
    } else if (text.includes("spin") || text.includes("peras")) {
        ucap("Siap, memproses peras.");
        log("[Voice Exec] Menjalankan Spin");
        jalankanSpinCustom();
    } else if (text.includes("cuci saja")) {
        ucap("Siap, mencuci saja.");
        log("[Voice Exec] Menjalankan Cuci Saja");
        jalankanCuciSajaCustom();
    } else if (text.includes("stop") || text.includes("darurat") || text.includes("berhenti")) {
        ucap("Perhatian! Darurat dihentikan!");
        log("[Voice Exec] STOP DARURAT");
        kirimPerintah('CMD:STOP');
    } else if (text.includes("charger hidup") || text.includes("nyalakan charger") || text.includes("charger nyala")) {
        setLampuLangsung(4, true, "Charger HP dinyalakan.");
    } else if (text.includes("charger mati") || text.includes("matikan charger")) {
        setLampuLangsung(4, false, "Charger HP dimatikan.");
    } else if (text.includes("lampu satu hidup") || text.includes("lampu 1 hidup") || text.includes("nyalakan lampu satu") || text.includes("nyalakan lampu 1")) {
        setLampuLangsung(1, true, "Lampu 1 dinyalakan.");
    } else if (text.includes("lampu satu mati") || text.includes("lampu 1 mati") || text.includes("matikan lampu satu") || text.includes("matikan lampu 1")) {
        setLampuLangsung(1, false, "Lampu 1 dimatikan.");
    } else if (text.includes("lampu dua hidup") || text.includes("lampu 2 hidup") || text.includes("nyalakan lampu dua") || text.includes("nyalakan lampu 2")) {
        setLampuLangsung(2, true, "Lampu 2 dinyalakan.");
    } else if (text.includes("lampu dua mati") || text.includes("lampu 2 mati") || text.includes("matikan lampu dua") || text.includes("matikan lampu 2")) {
        setLampuLangsung(2, false, "Lampu 2 dimatikan.");
    } else if (text.includes("lampu tiga hidup") || text.includes("lampu 3 hidup") || text.includes("nyalakan lampu tiga") || text.includes("nyalakan lampu 3")) {
        setLampuLangsung(3, true, "Lampu 3 dinyalakan.");
    } else if (text.includes("lampu tiga mati") || text.includes("lampu 3 mati") || text.includes("matikan lampu tiga") || text.includes("matikan lampu 3")) {
        setLampuLangsung(3, false, "Lampu 3 dimatikan.");
    } else {
        log(`[Voice] Perintah "${text}" tidak dikenali.`);
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
        alert("Browser tidak mendukung Web Bluetooth API! Gunakan Google Chrome.");
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

// ==================== MANUAL SLIDER ====================
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

// ==================== KONTROL SAKLAR (OPTIMISTIC UI) ====================
function toggleLampu(noLampu) {
    statusLampu[noLampu] = !statusLampu[noLampu];
    updateUIStatusLampu(noLampu, statusLampu[noLampu]);

    const cmd = `LAMPU${noLampu}_${statusLampu[noLampu] ? "ON" : "OFF"}`;
    kirimPerintah(cmd);
}

function updateUIStatusLampu(noLampu, isNyala) {
    statusLampu[noLampu] = isNyala;
    const btn = document.getElementById(`btnLampu${noLampu}`);
    const card = document.getElementById(`cardLampu${noLampu}`);

    if (btn) btn.innerText = isNyala ? "ON" : "OFF";
    if (card) {
        if (isNyala) {
            card.classList.add("active");
        } else {
            card.classList.remove("active");
        }
    }
}

// ==================== KIRIM PERINTAH & PARSER ====================
function kirimPerintah(cmd) {
    if (cmd.startsWith("CMD:") && cmd !== "CMD:STOP") {
        startLapTimer();
        setProgressRing(0);
        totalDurasiDetik = 0;
    } else if (cmd === "CMD:STOP") {
        stopLapTimer();
        totalDurasiDetik = 0;
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
    if (payload.startsWith("STATUS:")) {
        payload = payload.replace(/^STATUS:/, "").trim();
    }

    if (payload.startsWith("TIMER|")) {
        const parts = payload.split("|");
        const namaProses = parts[1] ? parts[1].trim() : "PROSES";
        const sisaWaktuStr = parts[2] ? parts[2].trim() : "0s";
        const sisaAngka = parseInt(sisaWaktuStr);

        updateElemenTeks("namaProsesAktif", namaProses.toUpperCase());
        updateElemenTeks("prosesStepTimer", sisaWaktuStr);

        if (prosesSebelumnya !== "" && prosesSebelumnya !== namaProses) {
            pemicuGetarDanBeep(150);
            log(`[Step] Pindah ke: ${namaProses}`);
        }
        prosesSebelumnya = namaProses;

        if (!isNaN(sisaAngka) && sisaAngka > 0) {
            if (totalDurasiDetik === 0 || sisaAngka > totalDurasiDetik) {
                totalDurasiDetik = sisaAngka;
            }
            sisaDetikBerjalan = sisaAngka;

            const elapsed = totalDurasiDetik - sisaDetikBerjalan;
            const percent = Math.min(100, Math.max(0, Math.round((elapsed / totalDurasiDetik) * 100)));

            setProgressRing(percent);
            updateElemenTeks("percentLabel", percent + "%");
        }
    } else if (payload.startsWith("DATA|")) {
        const waterMatch = payload.match(/WATER:(PENUH|KOSONG)/);
        const inletMatch = payload.match(/INLET:(ON|OFF)/);
        const drainMatch = payload.match(/DRAIN:(ON|OFF)/);
        const kiriMatch  = payload.match(/KIRI:(ON|OFF)/);
        const kananMatch = payload.match(/KANAN:(ON|OFF)/);
        const motorMatch = payload.match(/MOTOR:(KIRI|KANAN|ON|OFF)/);

        const l1Match = payload.match(/L1:(ON|OFF)/);
        const l2Match = payload.match(/L2:(ON|OFF)/);
        const l3Match = payload.match(/L3:(ON|OFF)/);
        const l4Match = payload.match(/L4:(ON|OFF)/);

        const water = waterMatch ? waterMatch[1] : "-";
        const inlet = inletMatch ? inletMatch[1] : "OFF";
        const drain = drainMatch ? drainMatch[1] : "OFF";

        let motor = "OFF";
        if (kiriMatch && kiriMatch[1] === "ON") motor = "KIRI";
        else if (kananMatch && kananMatch[1] === "ON") motor = "KANAN";
        else if (motorMatch) motor = motorMatch[1];

        updateHardwareUI(water, inlet, drain, motor);

        if (l1Match) updateUIStatusLampu(1, l1Match[1] === "ON");
        if (l2Match) updateUIStatusLampu(2, l2Match[1] === "ON");
        if (l3Match) updateUIStatusLampu(3, l3Match[1] === "ON");
        if (l4Match) updateUIStatusLampu(4, l4Match[1] === "ON");

    } else if (payload.includes("SELESAI") || payload.includes("DIHENTIKAN")) {
        stopLapTimer();
        totalDurasiDetik = 0;
        const statusAkhir = payload.includes("SELESAI") ? "SELESAI" : "DIHENTIKAN";

        updateElemenTeks("namaProsesAktif", statusAkhir);
        updateElemenTeks("prosesStepTimer", "0s");
        updateElemenTeks("percentLabel", statusAkhir === "SELESAI" ? "100%" : "0%");
        setProgressRing(statusAkhir === "SELESAI" ? 100 : 0);
        updateHardwareUI("PENUH", "OFF", "OFF", "OFF");
        log("ESP32: " + payload);

        if (statusAkhir === "SELESAI") {
            kirimNotifikasiSelesai();
        }
    } else {
        updateElemenTeks("namaProsesAktif", payload.replace("ESP32:", "").trim().toUpperCase());
        log("ESP32: " + payload);
    }
}

// ==================== UTILITAS UI ====================
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

    if (hwWater) hwWater.classList.toggle("active", water === "PENUH");
    if (hwInlet) hwInlet.classList.toggle("active", inlet === "ON");
    if (hwDrain) hwDrain.classList.toggle("active", drain === "ON");
    if (hwMotor) hwMotor.classList.toggle("active", motor !== "OFF");
}

function log(pesan) {
    const logBox = document.getElementById("logTerminal");
    if (!logBox) return;
    const waktu = new Date().toLocaleTimeString('id-ID', { hour12: false });
    logBox.innerHTML += `[${waktu}] ${pesan}<br>`;
    logBox.scrollTop = logBox.scrollHeight;
}
