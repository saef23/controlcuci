#include "BluetoothSerial.h"

#if !defined(CONFIG_BT_ENABLED) || !defined(CONFIG_BLUEDROID_ENABLED)
#error Bluetooth tidak diaktifkan!
#endif

BluetoothSerial SerialBT;

// --- PIN OUT RELAY & KOMPONEN ---
const int PIN_POWER_AC         = 18;
const int PIN_WATER_INLET      = 23;
const int PIN_RELAY_MOTOR_KIRI = 22;
const int PIN_RELAY_MOTOR_KANAN = 21;
const int PIN_MOTOR_DRAIN      = 19;
const int PIN_BUZZER           = 5;

// --- PIN SENSOR ---
const int PIN_WATER_LEVEL      = 4; // PENUH = LOW, KOSONG = HIGH

// --- KONSTANTA WAKTU ---
const unsigned long JEDA_40_DETIK = 40000;
const unsigned long JEDA_7_MENIT  = 420000;

enum ModeCuci {
  MODE_CEPAT = 1,
  MODE_NORMAL = 2,
  MODE_BERAT = 3,
  MODE_SPIN_ONLY = 4
};

String statusProses = "STANDBY";
bool sedangBerjalan = false;
bool stopDiminta = false; 

// Prototype Fungsi
void matikanSemuaRelay();
void powerOn();
void powerOff();
void kirimStatus(String pesan);
void kirimTelemetry();
bool cekPerintahStop();
bool jalankanTimerProses(unsigned long msTotal, String namaProses);
bool isiAirOtomatis();
bool buangAirOtomatis();
bool prosesCuci(int durasiMenit, int waktuPutarMs, int waktuJedaMs);
bool prosesBilas(int jumlahBilas, int durasiBilasMenit, int waktuPutarMs, int waktuJedaMs);
bool prosesPerendamanSoftener(int durasiPutarMenit, unsigned long durasiJedaMs);
bool prosesSpinUtama(int durasiMenit);
void bunyikanBuzzerSelesai();
void jalankanProgram(ModeCuci mode);

void setup() {
  Serial.begin(115200);      
  Serial2.begin(115200, SERIAL_8N1, 16, 17); // Serial komunikasi ke ESP32 Bridge

  digitalWrite(PIN_POWER_AC, HIGH);
  digitalWrite(PIN_WATER_INLET, HIGH);
  digitalWrite(PIN_RELAY_MOTOR_KIRI, HIGH);
  digitalWrite(PIN_RELAY_MOTOR_KANAN, HIGH);
  digitalWrite(PIN_MOTOR_DRAIN, HIGH);
  digitalWrite(PIN_BUZZER, LOW);

  pinMode(PIN_POWER_AC, OUTPUT);
  pinMode(PIN_WATER_INLET, OUTPUT);
  pinMode(PIN_RELAY_MOTOR_KIRI, OUTPUT);
  pinMode(PIN_RELAY_MOTOR_KANAN, OUTPUT);
  pinMode(PIN_MOTOR_DRAIN, OUTPUT);
  pinMode(PIN_BUZZER, OUTPUT);

  pinMode(PIN_WATER_LEVEL, INPUT_PULLUP);

  SerialBT.begin("ESP32_MesinCuci"); 
  Serial.println("ESP32 Utama Ready!");

  matikanSemuaRelay();
}

void loop() {
  // 1. Menerima Perintah dari ESP32 Bridge (MQTT)
  if (Serial2.available()) {
    String commandMQTT = Serial2.readStringUntil('\n');
    commandMQTT.trim();
    commandMQTT.toUpperCase();

    if (!sedangBerjalan) {
      if (commandMQTT == "CMD:1") jalankanProgram(MODE_CEPAT);
      else if (commandMQTT == "CMD:2") jalankanProgram(MODE_NORMAL);
      else if (commandMQTT == "CMD:3") jalankanProgram(MODE_BERAT);
      else if (commandMQTT == "CMD:4") jalankanProgram(MODE_SPIN_ONLY);
    } else {
      if (commandMQTT == "CMD:X" || commandMQTT == "CMD:STOP" || commandMQTT == "CMD:CANCEL" || commandMQTT == "CMD:RESET") {
        stopDiminta = true;
      }
    }
  }

  // 2. Menerima Perintah Cadangan dari Bluetooth HP
  if (SerialBT.available()) {
    String input = SerialBT.readStringUntil('\n');
    input.trim();
    input.toUpperCase();
    
    if (!sedangBerjalan) {
      if (input == "1" || input == "MODE1") jalankanProgram(MODE_CEPAT);
      else if (input == "2" || input == "MODE2") jalankanProgram(MODE_NORMAL);
      else if (input == "3" || input == "MODE3") jalankanProgram(MODE_BERAT);
      else if (input == "4" || input == "MODE4") jalankanProgram(MODE_SPIN_ONLY);
    } else {
      if (input == "X" || input == "STOP" || input == "CANCEL" || input == "RESET") {
        stopDiminta = true;
      }
    }
  }

  delay(50);
}

bool cekPerintahStop() {
  if (Serial2.available()) {
    String cmd = Serial2.readStringUntil('\n');
    cmd.trim();
    cmd.toUpperCase();
    if (cmd == "CMD:X" || cmd == "CMD:STOP" || cmd == "CMD:CANCEL" || cmd == "CMD:RESET") {
      stopDiminta = true;
    }
  }

  if (SerialBT.available()) {
    String input = SerialBT.readStringUntil('\n');
    input.trim();
    input.toUpperCase();
    if (input == "X" || input == "STOP" || input == "CANCEL" || input == "RESET") {
      stopDiminta = true;
    }
  }

  if (stopDiminta) {
    kirimStatus("DIHENTIKAN");
    powerOff();
    sedangBerjalan = false;
    return true; 
  }
  return false;
}

void kirimStatus(String pesan) {
  statusProses = pesan;
  Serial.println(pesan);
  SerialBT.println("STATUS:" + pesan);
  Serial2.println(pesan); 
  kirimTelemetry();
}

void kirimTelemetry() {
  String statusWater = (digitalRead(PIN_WATER_LEVEL) == LOW) ? "PENUH" : "KOSONG";
  
  String statusRelay = "PWR:" + String(digitalRead(PIN_POWER_AC) == LOW ? "ON" : "OFF") +
                       "|INLET:" + String(digitalRead(PIN_WATER_INLET) == LOW ? "ON" : "OFF") +
                       "|KIRI:" + String(digitalRead(PIN_RELAY_MOTOR_KIRI) == LOW ? "ON" : "OFF") +
                       "|KANAN:" + String(digitalRead(PIN_RELAY_MOTOR_KANAN) == LOW ? "ON" : "OFF") +
                       "|DRAIN:" + String(digitalRead(PIN_MOTOR_DRAIN) == LOW ? "ON" : "OFF");

  String telemetryMsg = "DATA|WATER:" + statusWater + "|" + statusRelay;
  SerialBT.println(telemetryMsg);
  Serial2.println(telemetryMsg); 
}

bool jalankanTimerProses(unsigned long msTotal, String namaProses) {
  unsigned long start = millis();
  unsigned long lastTelemetry = 0;
  
  while (millis() - start < msTotal) {
    if (cekPerintahStop()) return false;

    if (millis() - lastTelemetry >= 1000) {
      lastTelemetry = millis();
      unsigned long sisaDetik = (msTotal - (millis() - start)) / 1000;
      
      String timerMsg = "TIMER|" + namaProses + "|" + String(sisaDetik) + "s";
      SerialBT.println(timerMsg);
      Serial2.println(timerMsg); 
    }
    delay(10);
  }
  return true;
}

void jalankanProgram(ModeCuci mode) {
  sedangBerjalan = true;
  stopDiminta = false;
  powerOn();

  switch (mode) {
    case MODE_CEPAT:
      kirimStatus("PROSES: Cuci Cepat");
      if (!prosesCuci(5, 2500, 1500)) return;   
      if (!prosesBilas(1, 5, 2500, 1500)) return;  
      if (!prosesPerendamanSoftener(2, JEDA_7_MENIT)) return; 
      if (!prosesSpinUtama(3)) return;   
      break;

    case MODE_NORMAL:
      kirimStatus("PROSES: Cuci Normal");
      if (!prosesCuci(10, 3500, 2000)) return;  
      if (!prosesBilas(1, 5, 3500, 2000)) return;  
      if (!prosesPerendamanSoftener(2, JEDA_7_MENIT)) return; 
      if (!prosesSpinUtama(5)) return;   
      break;

    case MODE_BERAT:
      kirimStatus("PROSES: Cuci Berat");
      if (!prosesCuci(15, 4000, 3000)) return;  
      if (!prosesBilas(1, 5, 4000, 3000)) return;  
      if (!prosesPerendamanSoftener(2, JEDA_7_MENIT)) return; 
      if (!prosesSpinUtama(7)) return;   
      break;

    case MODE_SPIN_ONLY:
      kirimStatus("PROSES: Spin Only");
      if (!prosesSpinUtama(5)) return;   
      break;
  }

  bunyikanBuzzerSelesai();
  kirimStatus("SELESAI");
  powerOff();
  sedangBerjalan = false;
}

void powerOn() {
  digitalWrite(PIN_POWER_AC, LOW); 
  kirimStatus("Power AC: ON");
  delay(1000);
}

void powerOff() {
  matikanSemuaRelay();
  digitalWrite(PIN_POWER_AC, HIGH); 
  kirimStatus("Power AC: OFF");
}

void matikanSemuaRelay() {
  digitalWrite(PIN_WATER_INLET, HIGH);
  digitalWrite(PIN_RELAY_MOTOR_KIRI, HIGH);
  digitalWrite(PIN_RELAY_MOTOR_KANAN, HIGH);
  digitalWrite(PIN_MOTOR_DRAIN, HIGH);
  digitalWrite(PIN_BUZZER, LOW);
}

// FUNGSI ISI AIR DENGAN FITUR TIMEOUT 20 MENIT
bool isiAirOtomatis() {
  if (digitalRead(PIN_WATER_LEVEL) == HIGH) {
    kirimStatus("AIR: Mengisi Air...");
    digitalWrite(PIN_WATER_INLET, LOW); 

    unsigned long startPengisian = millis();
    const unsigned long TIMEOUT_AIR_MS = 1200000; // 20 Menit = 20 x 60 x 1000 ms

    while (digitalRead(PIN_WATER_LEVEL) == HIGH) {
      if (cekPerintahStop()) return false;

      // Pengecekan Timeout 20 Menit
      if (millis() - startPengisian >= TIMEOUT_AIR_MS) {
        kirimStatus("ERROR: Timeout Isi Air (>20m)!");
        powerOff();
        sedangBerjalan = false;
        return false;
      }

      kirimTelemetry();
      delay(200);
    }

    digitalWrite(PIN_WATER_INLET, HIGH); 
    kirimStatus("AIR: Penuh");
  }
  return true;
}

bool buangAirOtomatis() {
  kirimStatus("DRAIN: Membuang Air (ON)...");
  digitalWrite(PIN_MOTOR_DRAIN, LOW); 
  
  while (digitalRead(PIN_WATER_LEVEL) == LOW) {
    if (cekPerintahStop()) return false;
    kirimTelemetry();
    delay(200);
  }

  if (!jalankanTimerProses(5000, "Ekstra Pengurasan")) return false;

  digitalWrite(PIN_MOTOR_DRAIN, HIGH); 
  kirimStatus("DRAIN: Selesai");

  kirimStatus("DRAIN: Jeda 40 Detik Setelah Buang Air...");
  return jalankanTimerProses(JEDA_40_DETIK, "Jeda Drain");
}

bool prosesCuci(int durasiMenit, int waktuPutarMs, int waktuJedaMs) {
  if (!isiAirOtomatis()) return false;
  kirimStatus("CUCI: Motor Berputar...");

  unsigned long totalMs = (unsigned long)durasiMenit * 60000;
  unsigned long start = millis();

  while (millis() - start < totalMs) {
    digitalWrite(PIN_RELAY_MOTOR_KIRI, LOW);
    digitalWrite(PIN_RELAY_MOTOR_KANAN, HIGH);
    if (!jalankanTimerProses(waktuPutarMs, "Cuci Putar Kiri")) return false;

    digitalWrite(PIN_RELAY_MOTOR_KIRI, HIGH);
    if (!jalankanTimerProses(waktuJedaMs, "Cuci Jeda")) return false;

    digitalWrite(PIN_RELAY_MOTOR_KANAN, LOW);
    digitalWrite(PIN_RELAY_MOTOR_KIRI, HIGH);
    if (!jalankanTimerProses(waktuPutarMs, "Cuci Putar Kanan")) return false;

    digitalWrite(PIN_RELAY_MOTOR_KANAN, HIGH);
    if (!jalankanTimerProses(waktuJedaMs, "Cuci Jeda")) return false;
  }

  matikanSemuaRelay();
  return buangAirOtomatis();
}

bool prosesBilas(int jumlahBilas, int durasiBilasMenit, int waktuPutarMs, int waktuJedaMs) {
  for (int i = 1; i <= jumlahBilas; i++) {
    kirimStatus("BILAS: Siklus ke-" + String(i));
    if (!prosesCuci(durasiBilasMenit, waktuPutarMs, waktuJedaMs)) return false;

    kirimStatus("BILAS: Peras 1 Menit (Motor Drain & Spin ON)...");
    digitalWrite(PIN_MOTOR_DRAIN, LOW);        
    digitalWrite(PIN_RELAY_MOTOR_KANAN, LOW); 
    
    if (!jalankanTimerProses(60000, "Peras Bilas")) return false;
    
    digitalWrite(PIN_RELAY_MOTOR_KANAN, HIGH); 
    kirimStatus("BILAS: Peras Selesai. Jeda Drain 40 Detik...");
    
    if (!jalankanTimerProses(JEDA_40_DETIK, "Jeda Drain Bilas")) return false;
    
    digitalWrite(PIN_MOTOR_DRAIN, HIGH);       
  }
  return true;
}

bool prosesPerendamanSoftener(int durasiPutarMenit, unsigned long durasiJedaMs) {
  kirimStatus("SOFTENER: Pengisian Air Softener...");
  if (!isiAirOtomatis()) return false;

  kirimStatus("SOFTENER: Motor Berputar 2 Menit...");
  unsigned long totalMs = (unsigned long)durasiPutarMenit * 60000;
  unsigned long start = millis();

  while (millis() - start < totalMs) {
    digitalWrite(PIN_RELAY_MOTOR_KIRI, LOW);
    digitalWrite(PIN_RELAY_MOTOR_KANAN, HIGH);
    if (!jalankanTimerProses(2500, "Softener Putar Kiri")) return false;

    digitalWrite(PIN_RELAY_MOTOR_KIRI, HIGH);
    if (!jalankanTimerProses(1500, "Softener Jeda")) return false;

    digitalWrite(PIN_RELAY_MOTOR_KANAN, LOW);
    digitalWrite(PIN_RELAY_MOTOR_KIRI, HIGH);
    if (!jalankanTimerProses(2500, "Softener Putar Kanan")) return false;

    digitalWrite(PIN_RELAY_MOTOR_KANAN, HIGH);
    if (!jalankanTimerProses(1500, "Softener Jeda")) return false;
  }

  matikanSemuaRelay();
  kirimStatus("SOFTENER: Perendaman (Jeda 7 Menit)...");
  return jalankanTimerProses(durasiJedaMs, "Perendaman Softener");
}

bool prosesSpinUtama(int durasiMenit) {
  kirimStatus("SPIN: Motor Drain ON, Menunggu Air Perendaman Kosong...");
  digitalWrite(PIN_MOTOR_DRAIN, LOW); 

  while (digitalRead(PIN_WATER_LEVEL) == LOW) {
    if (cekPerintahStop()) return false;
    kirimTelemetry();
    delay(200);
  }

  kirimStatus("SPIN: Air Kosong. Jeda 40 Detik Sebelum Putar Kanan...");
  if (!jalankanTimerProses(JEDA_40_DETIK, "Jeda Sebelum Spin")) return false;

  kirimStatus("SPIN: Motor Putar Kanan (Spin) ON...");
  digitalWrite(PIN_RELAY_MOTOR_KANAN, LOW); 
  
  if (!jalankanTimerProses((unsigned long)durasiMenit * 60000, "Durasi Spin Utama")) return false;
  
  digitalWrite(PIN_RELAY_MOTOR_KANAN, HIGH); 
  kirimStatus("SPIN: Waktu Spin Habis. Jeda Drain 40 Detik...");
  
  if (!jalankanTimerProses(JEDA_40_DETIK, "Jeda Drain Akhir")) return false;
  
  digitalWrite(PIN_MOTOR_DRAIN, HIGH); 
  kirimStatus("SPIN: Selesai");
  return true;
}

void bunyikanBuzzerSelesai() {
  kirimStatus("SELESAI: Membunyikan Buzzer");
  for (int i = 0; i < 5; i++) {
    digitalWrite(PIN_BUZZER, HIGH);
    delay(300);
    digitalWrite(PIN_BUZZER, LOW);
    delay(300);
  }
}
