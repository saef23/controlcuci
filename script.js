const SERVICE_UUID = "4fafc201-1fb5-459e-8fcc-c5c9c331914b";
const CHARACTERISTIC_UUID = "beb5483e-36e1-4688-b7f5-ea07361b26a8";

let currentProtocol = "MQTT";
let bleDevice, bleCharacteristic;
let mqttClient;
let previousStatus = "STANDBY";

let currentStrengthMode = "STANDARD";
let currentExecutionMode = "AUTO";
let currentAction = "";

function switchProtocol(mode) {
    currentProtocol = mode;
    if (mode === "BLE") {
        document.getElementById("ble-bar").style.display = "flex";
        document.getElementById("mqtt-bar").style.display = "none";
    } else {
        document.getElementById("ble-bar").style.display = "none";
        document.getElementById("mqtt-bar").style.display = "flex";
    }
}

// ================= BLE LOGIC =================
async function toggleBluetooth() {
    if (!bleDevice || !bleDevice.gatt.connected) {
        try {
            bleDevice = await navigator.bluetooth.requestDevice({
                filters: [{ name: 'ESP32_WashingMachine' }],
                optionalServices: [SERVICE_UUID]
            });
            const server = await bleDevice.gatt.connect();
            const service = await server.getPrimaryService(SERVICE_UUID);
            bleCharacteristic = await service.getCharacteristic(CHARACTERISTIC_UUID);

            setupBLENotifications(bleCharacteristic);

            document.getElementById('bt-indicator').classList.add('connected');
            document.getElementById('bt-text').innerText = 'BLE: Terhubung';
            document.getElementById('bt-btn').innerText = 'Putus';
        } catch (err) {
            console.error("BLE Error:", err);
        }
    } else {
        if (bleDevice.gatt.connected) bleDevice.gatt.disconnect();
        document.getElementById('bt-indicator').classList.remove('connected');
        document.getElementById('bt-text').innerText = 'BLE: Terputus';
        document.getElementById('bt-btn').innerText = 'Konek BLE';
    }
}

function setupBLENotifications(characteristic) {
    characteristic.startNotifications().then(() => {
        characteristic.addEventListener('characteristicvaluechanged', (event) => {
            const decoder = new TextDecoder('utf-8');
            parseRealtimeData(decoder.decode(event.target.value));
        });
    });
}

// ================= MQTT LOGIC (FIXED WEBSOCKET SSL) =================
function toggleMQTT() {
    if (!mqttClient || !mqttClient.isConnected()) {
        const broker = "broker.hivemq.com";
        const port = 8884; // SSL WebSocket Port
        const path = "/mqtt";
        
        mqttClient = new Paho.MQTT.Client(broker, port, path, "web_client_" + parseInt(Math.random() * 10000, 10));

        mqttClient.onConnectionLost = (responseObject) => {
            console.log("MQTT Lost Connection:", responseObject.errorMessage);
            document.getElementById('mqtt-indicator').classList.remove('connected');
            document.getElementById('mqtt-text').innerText = 'MQTT: Terputus';
            document.getElementById('mqtt-btn').innerText = 'Konek MQTT';
        };

        mqttClient.onMessageArrived = (message) => {
            parseRealtimeData(message.payloadString);
        };

        const options = {
            useSSL: true,
            timeout: 5,
            onSuccess: () => {
                console.log("MQTT SSL WebSocket Connected!");
                document.getElementById('mqtt-indicator').classList.add('connected');
                document.getElementById('mqtt-text').innerText = 'MQTT: Terhubung';
                document.getElementById('mqtt-btn').innerText = 'Putus';
                mqttClient.subscribe("washing_machine/status");
            },
            onFailure: (err) => {
                console.error("MQTT Connect Error:", err.errorMessage);
                alert("Gagal konek ke MQTT Broker. Periksa koneksi internet!");
            }
        };

        mqttClient.connect(options);
    } else {
        mqttClient.disconnect();
        document.getElementById('mqtt-indicator').classList.remove('connected');
        document.getElementById('mqtt-text').innerText = 'MQTT: Terputus';
        document.getElementById('mqtt-btn').innerText = 'Konek MQTT';
    }
}

// ================= GLOBAL SENDER =================
function sendData(payload) {
    console.log(`Sending via ${currentProtocol}:`, payload);

    if (currentProtocol === "BLE" && bleCharacteristic) {
        const encoder = new TextEncoder();
        bleCharacteristic.writeValue(encoder.encode(payload)).catch(console.error);
    } else if (currentProtocol === "MQTT" && mqttClient && mqttClient.isConnected()) {
        const message = new Paho.MQTT.Message(payload);
        message.destinationName = "washing_machine/control";
        mqttClient.send(message);
    } else {
        console.warn(`Koneksi ${currentProtocol} belum aktif!`);
    }
}

// ================= MODE SELECTOR (DUAL ACTIVE) =================
function selectMode(mode, btn) {
    const strengthModes = ['SOFT', 'STRONG', 'STANDARD', 'SPEED'];
    const executionModes = ['AUTO', 'STOP'];

    if (strengthModes.includes(mode)) {
        document.querySelectorAll('.strength-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentStrengthMode = mode;
        
        let labelDisplay = `${currentStrengthMode}`;
        if (currentAction) labelDisplay += ` - ${currentAction}`;
        document.getElementById('process-display').innerText = labelDisplay;
        
        sendData(`MODE:${mode}`);
    } 
    else if (executionModes.includes(mode)) {
        document.querySelectorAll('.exec-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentExecutionMode = mode;

        if (mode === 'STOP') {
            currentAction = "";
            document.getElementById('process-display').innerText = 'STOP';
            document.getElementById('wash-btn').classList.remove('active-action');
            document.getElementById('spin-btn').classList.remove('active-action');
            sendData('MODE:STOP');
        } else if (mode === 'AUTO') {
            document.getElementById('process-display').innerText = `AUTO (${currentStrengthMode})`;
            sendData('MODE:AUTO');
        }
    }
}

function formatTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

function updateSlider(val) {
    document.getElementById('slider-val').innerText = `${val} Detik (${formatTime(val)})`;
}

function sendSliderData(val) {
    sendData(`DURATION:${val}`);
}

// ================= ACTION BUTTONS (WASH & SPIN) =================
function triggerAction(action) {
    const washBtn = document.getElementById('wash-btn');
    const spinBtn = document.getElementById('spin-btn');

    if (action === 'WASH') {
        if (washBtn.classList.contains('active-action')) {
            washBtn.classList.remove('active-action');
            currentAction = "";
            document.getElementById('process-display').innerText = `STANDBY`;
            sendData("MODE:STOP");
        } else {
            washBtn.classList.add('active-action');
            spinBtn.classList.remove('active-action');
            currentAction = "WASH";
            document.getElementById('process-display').innerText = `WASH (${currentStrengthMode})`;
            sendData('ACTION:WASH');
        }
    } else if (action === 'SPIN') {
        if (spinBtn.classList.contains('active-action')) {
            spinBtn.classList.remove('active-action');
            currentAction = "";
            document.getElementById('process-display').innerText = `STANDBY`;
            sendData("MODE:STOP");
        } else {
            spinBtn.classList.add('active-action');
            washBtn.classList.remove('active-action');
            currentAction = "SPIN";
            document.getElementById('process-display').innerText = `SPIN (${currentStrengthMode})`;
            sendData('ACTION:SPIN');
        }
    }
}

// ================= NOTIFIKASI SUARA & GETAR =================
function playCompletionSound() {
    try {
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const playBeep = (freq, startTime, duration) => {
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.type = 'sine';
            osc.frequency.value = freq;
            osc.connect(gain);
            gain.connect(audioCtx.destination);
            osc.start(startTime);
            osc.stop(startTime + duration);
        };
        const now = audioCtx.currentTime;
        playBeep(523.25, now, 0.15);       // Note C5
        playBeep(659.25, now + 0.2, 0.15); // Note E5
        playBeep(783.99, now + 0.4, 0.35); // Note G5
    } catch (e) {
        console.error("Audio Web error:", e);
    }
}

function triggerVibration() {
    if ("vibrate" in navigator) {
        navigator.vibrate([500, 200, 500]);
    }
}

function triggerMachineFinishNotification() {
    playCompletionSound();
    triggerVibration();
    document.getElementById("finish-modal").style.display = "flex";
}

function closeFinishModal() {
    document.getElementById("finish-modal").style.display = "none";
}

// ================= PARSER DATA REALTIME =================
function parseRealtimeData(dataString) {
    console.log("Realtime Data Received:", dataString);
    const items = dataString.split(',');
    
    items.forEach(item => {
        const [key, value] = item.split(':');
        
        if (key === 'REMAIN') {
            document.getElementById('timer-display').innerText = formatTime(parseInt(value));
        } 
        else if (key === 'ELAPSED') {
            document.getElementById('elapsed-display').innerText = formatTime(parseInt(value));
        } 
        else if (key === 'STATUS') {
            document.getElementById('process-display').innerText = value;
            
            if ((value === 'STANDBY' || value === 'DONE') && (previousStatus === 'WASH' || previousStatus === 'SPIN' || previousStatus === 'AUTO')) {
                document.getElementById('wash-btn').classList.remove('active-action');
                document.getElementById('spin-btn').classList.remove('active-action');
                currentAction = "";
                triggerMachineFinishNotification();
            }

            previousStatus = value;
        }
    });
}