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
