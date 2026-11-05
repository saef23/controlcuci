let client;
const mqttBroker = "broker.hivemq.com";
const mqttPort = 8884; // Port SSL/WSS yang aman untuk HTTPS
const clientId = "WebClient_MesinCuci_" + Math.random().toString(16).substr(2, 8);

const topicCommand = "mesincuci/command";
const topicStatus  = "mesincuci/status";

let lapInterval = null;
let lapDetikTotal = 0;
const circumference = 534;

function setProgressRing(percent) {
    const circle = document.getElementById("circleProgress");
    if(!circle) return;
    const offset = circumference - (percent / 100 * circumference);
    circle.style.strokeDashoffset = offset;
}

function startLapTimer() {
    stopLapTimer();
    lapDetikTotal = 0;
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
}

function connectMQTT() {
    log("Menghubungkan ke Broker MQTT...");
    client = new Paho.MQTT.Client(mqttBroker, Number(mqttPort), clientId);
    client.onConnectionLost = onConnectionLost;
    client.onMessageArrived = onMessageArrived;
    client.connect({ 
        onSuccess: onConnect, 
        onFailure: onFail, 
        useSSL: true // Wajib aktif jika web diakses via HTTPS
    });
}

function onConnect() {
    log("MQTT Terhubung!");
    const statusElem = document.getElementById("statusKoneksi");
    statusElem.innerText = "MQTT: ON";
    statusElem.style.background = "#00e676";
    statusElem.style.color = "#000";
    client.subscribe(topicStatus);
}

function onFail(response) {
    log("Gagal Konek MQTT: " + response.errorMessage);
}

function onConnectionLost(responseObject) {
    if (responseObject.errorCode !== 0) {
        log("Koneksi terputus: " + responseObject.errorMessage);
        const statusElem = document.getElementById("statusKoneksi");
        statusElem.innerText = "MQTT: OFF";
        statusElem.style.background = "#e53935";
        statusElem.style.color = "#fff";
        stopLapTimer();
    }
}

function kirimPerintah(cmd) {
    if (!client || !client.isConnected()) {
        alert("MQTT Belum Terhubung!");
        return;
    }

    if (cmd.startsWith("CMD:") && cmd !== "CMD:STOP") {
        startLapTimer();
        setProgressRing(0);
    } else if (cmd === "CMD:STOP") {
        stopLapTimer();
        document.getElementById("namaProsesAktif").innerText = "DIHENTIKAN";
        document.getElementById("prosesStepTimer").innerText = "0s";
        setProgressRing(0);
        updateHardwareUI("KOSONG", "OFF", "OFF", "OFF");
    }

    const message = new Paho.MQTT.Message(cmd);
    message.destinationName = topicCommand;
    client.send(message);
    log("Kirim MQTT -> " + cmd);
}

function onMessageArrived(message) {
    const payload = message.payloadString.trim();

    if (payload.startsWith("TIMER|")) {
        const parts = payload.split("|");
        const namaProses = parts[1];
        const sisaWaktu = parts[2];
        const sisaAngka = parseInt(sisaWaktu);

        document.getElementById("namaProsesAktif").innerText = namaProses.toUpperCase();
        document.getElementById("prosesStepTimer").innerText = sisaWaktu;

        if (!isNaN(sisaAngka) && sisaAngka > 0) {
            const percent = Math.min(100, Math.max(5, (100 - (sisaAngka % 100))));
            setProgressRing(percent);
        }
    } else if (payload.startsWith("DATA|")) {
        const waterMatch = payload.match(/WATER:(PENUH|KOSONG)/);
        const inletMatch = payload.match(/INLET:(ON|OFF)/);
        const drainMatch = payload.match(/DRAIN:(ON|OFF)/);
        const kiriMatch  = payload.match(/KIRI:(ON|OFF)/);
        const kananMatch = payload.match(/KANAN:(ON|OFF)/);

        const water = waterMatch ? waterMatch[1] : "-";
        const inlet = inletMatch ? inletMatch[1] : "OFF";
        const drain = drainMatch ? drainMatch[1] : "OFF";
        
        let motor = "OFF";
        if (kiriMatch && kiriMatch[1] === "ON") motor = "KIRI";
        else if (kananMatch && kananMatch[1] === "ON") motor = "KANAN";

        updateHardwareUI(water, inlet, drain, motor);
    } else if (payload === "SELESAI" || payload === "DIHENTIKAN") {
        stopLapTimer();
        document.getElementById("namaProsesAktif").innerText = payload;
        document.getElementById("prosesStepTimer").innerText = "0s";
        setProgressRing(payload === "SELESAI" ? 100 : 0);
        updateHardwareUI("KOSONG", "OFF", "OFF", "OFF");
        log("ESP32: " + payload);
    } else {
        log("ESP32: " + payload);
    }
}

function updateHardwareUI(water, inlet, drain, motor) {
    document.getElementById("statusWaterVal").innerText = water;
    document.getElementById("statusInletVal").innerText = inlet;
    document.getElementById("statusDrainVal").innerText = drain;
    document.getElementById("statusMotorVal").innerText = motor;

    toggleHwActive("hwWater", water === "PENUH");
    toggleHwActive("hwInlet", inlet === "ON");
    toggleHwActive("hwDrain", drain === "ON");
    toggleHwActive("hwMotor", motor !== "OFF");
}

function toggleHwActive(id, isActive) {
    const elem = document.getElementById(id);
    if (!elem) return;
    if (isActive) elem.classList.add("active");
    else elem.classList.remove("active");
}

function log(msg) {
    const box = document.getElementById("logTerminal");
    if(!box) return;
    box.innerHTML += msg + "<br>";
    box.scrollTop = box.scrollHeight;
}
