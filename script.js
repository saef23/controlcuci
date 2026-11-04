const mqttBroker = "wss://broker.hivemq.com:8884/mqtt"; 
const topicControl = "washing_machine/control";
const topicStatus = "washing_machine/status";

console.log("Menghubungkan ke MQTT Broker...");
const client = mqtt.connect(mqttBroker);

client.on("connect", () => {
    console.log("Berhasil terhubung ke MQTT Broker!");
    client.subscribe(topicStatus, (err) => {
        if (!err) console.log("Berhasil subscribe ke topik status");
    });
});

// Fungsi Kontrol Power Utama AC
function sendPower(state) {
    let payload = "POWER:" + state;
    client.publish(topicControl, payload);
    console.log("Perintah dikirim: " + payload);
}

// Fungsi Kirim Profil Cucian
function sendProfile(profileName) {
    let payload = "MANUAL:" + profileName;
    client.publish(topicControl, payload);
    console.log("Perintah dikirim: " + payload);
}

// Fungsi Tombol Stop Darurat
function stopMachine() {
    let payload = "MODE:STOP";
    client.publish(topicControl, payload);
    console.log("Perintah darurat dikirim: " + payload);
}

// Terima Update Status dari Mesin Cuci
client.on("message", (topic, payload) => {
    if (topic === topicStatus) {
        let statusMsg = payload.toString();
        document.getElementById("statusLabel").innerText = statusMsg;
        
        let statusBox = document.getElementById("status-box");
        if (statusMsg.includes("WASHING")) {
            statusBox.style.background = "#d4edda";
            statusBox.style.color = "#155724";
        } else if (statusMsg.includes("COMPLETE") || statusMsg.includes("POWER OFF")) {
            statusBox.style.background = "#cce5ff";
            statusBox.style.color = "#004085";
        } else if (statusMsg.includes("IDLE")) {
            statusBox.style.background = "#e2e3e5";
            statusBox.style.color = "#383d41";
        } else {
            statusBox.style.background = "#fff3cd";
            statusBox.style.color = "#856404";
        }
    }
});
