#include <WiFi.h>
#include <PubSubClient.h>

// WiFi Virtual Wokwi (Jika di Hardware Asli, ganti dengan SSID & Password WiFi rumah kamu)
const char* ssid = "Wokwi-GUEST";
const char* password = "";
const char* mqtt_server = "broker.hivemq.com";

WiFiClient espClient;
PubSubClient mqttClient(espClient);

// Pin Hardware Configuration
const int RELAY_INLET_WATER  = 18; // LED Biru
const int RELAY_DRAIN_VALVE  = 19; // LED Kuning
const int RELAY_WASH_CW     = 21; // LED Hijau
const int RELAY_WASH_CCW    = 22; // LED Orange
const int RELAY_SPIN        = 23; // LED Merah
const int SENSOR_WATER_LEVEL = 34; // Switch Water Level (LOW = Kosong, HIGH = Penuh)

// Global Control Variables
String selectedWashMode = "STANDARD";
int userSelectedDuration = 450;
unsigned long motorOnTime = 5000;
unsigned long motorOffTime = 3000;
bool motorStatus = false;
unsigned long lastMotorToggleTime = 0;
unsigned long currentElapsedSeconds = 0;
unsigned long currentRemainSeconds = 0;

// State Machine Enums
enum WashState { IDLE, FILLING_WATER, WASHING, DRAINING_BEFORE_SPIN, WAITING_FOR_SPIN, SPINNING, DRAINING_FINISH, DONE };
WashState currentAutoState = IDLE;
unsigned long autoStartTime = 0;
unsigned long autoWashDurationMillis = 900000;

enum WashOnlyState { WASH_IDLE, WASH_FILLING_WATER, WASH_RUNNING, WASH_DONE };
WashOnlyState currentWashOnlyState = WASH_IDLE;
unsigned long washOnlyStartTime = 0;
unsigned long washOnlyDurationMillis = 450000;

enum SpinOnlyState { SPIN_IDLE, SPIN_DRAINING, SPIN_WAITING, SPIN_RUNNING, SPIN_DONE };
SpinOnlyState currentSpinOnlyState = SPIN_IDLE;
unsigned long spinOnlyStartTime = 0;
unsigned long spinOnlyDurationMillis = 180000;

void stopAllRelays() {
  digitalWrite(RELAY_INLET_WATER, LOW);
  digitalWrite(RELAY_DRAIN_VALVE, LOW);
  digitalWrite(RELAY_WASH_CW, LOW);
  digitalWrite(RELAY_WASH_CCW, LOW);
  digitalWrite(RELAY_SPIN, LOW);
}

void sendRealtimeStatusToWeb(int sisaDetik, int berjalanDetik, String statusProses) {
  if (mqttClient.connected()) {
    String payload = "REMAIN:" + String(sisaDetik) + ",ELAPSED:" + String(berjalanDetik) + ",STATUS:" + statusProses;
    mqttClient.publish("washing_machine/status", payload.c_str());
  }
}

void configureModeTiming(String mode) {
  selectedWashMode = mode;
  if (mode == "SOFT") { motorOnTime = 3000; motorOffTime = 5000; }
  else if (mode == "STRONG") { motorOnTime = 7000; motorOffTime = 2000; }
  else if (mode == "SPEED") { motorOnTime = 4000; motorOffTime = 2000; }
  else { motorOnTime = 5000; motorOffTime = 3000; }
}

void startAutoCycle(int durationSeconds, String mode) {
  stopAllRelays();
  configureModeTiming(mode);
  autoWashDurationMillis = (unsigned long)durationSeconds * 1000;
  currentWashOnlyState = WASH_IDLE;
  currentSpinOnlyState = SPIN_IDLE;
  currentAutoState = FILLING_WATER;
  autoStartTime = millis();
  Serial.println("[ESP32] Memulai Siklus AUTO...");
}

void startWashOnlyCycle(int durationSeconds, String mode) {
  stopAllRelays();
  configureModeTiming(mode);
  washOnlyDurationMillis = (unsigned long)durationSeconds * 1000;
  currentAutoState = IDLE;
  currentSpinOnlyState = SPIN_IDLE;
  currentWashOnlyState = WASH_FILLING_WATER;
  washOnlyStartTime = millis();
  Serial.println("[ESP32] Memulai Siklus WASH ONLY...");
}

void startSpinOnlyCycle(int durationSeconds, String mode) {
  stopAllRelays();
  configureModeTiming(mode);
  spinOnlyDurationMillis = (unsigned long)durationSeconds * 1000;
  currentAutoState = IDLE;
  currentWashOnlyState = WASH_IDLE;
  currentSpinOnlyState = SPIN_DRAINING;
  spinOnlyStartTime = millis();
  Serial.println("[ESP32] Memulai Siklus SPIN ONLY...");
}

void handleAutoProcess() {
  unsigned long currentMillis = millis();
  switch (currentAutoState) {
    case IDLE: break;

    case FILLING_WATER:
      digitalWrite(RELAY_INLET_WATER, HIGH);
      if (digitalRead(SENSOR_WATER_LEVEL) == HIGH) { // Sakelar Terhubung = Penuh
        digitalWrite(RELAY_INLET_WATER, LOW);
        currentAutoState = WASHING;
        autoStartTime = currentMillis;
        lastMotorToggleTime = currentMillis;
        Serial.println("[ESP32] Air Penuh -> Mulai Pencucian...");
      }
      break;

    case WASHING: {
      unsigned long elapsed = currentMillis - autoStartTime;
      currentElapsedSeconds = elapsed / 1000;
      currentRemainSeconds = (autoWashDurationMillis > elapsed) ? (autoWashDurationMillis - elapsed) / 1000 : 0;
      
      if (currentMillis - lastMotorToggleTime >= (motorStatus ? motorOnTime : motorOffTime)) {
        lastMotorToggleTime = currentMillis;
        motorStatus = !motorStatus;
        static bool dir = true;
        digitalWrite(RELAY_WASH_CW, motorStatus && dir ? HIGH : LOW);
        digitalWrite(RELAY_WASH_CCW, motorStatus && !dir ? HIGH : LOW);
        if (!motorStatus) dir = !dir;
      }
      
      sendRealtimeStatusToWeb(currentRemainSeconds, currentElapsedSeconds, "WASH");
      
      if (elapsed >= autoWashDurationMillis) {
        digitalWrite(RELAY_WASH_CW, LOW);
        digitalWrite(RELAY_WASH_CCW, LOW);
        currentAutoState = DRAINING_BEFORE_SPIN;
        autoStartTime = currentMillis;
        Serial.println("[ESP32] Cuci Selesai -> Membuka Katup Kuras...");
      }
      break;
    }

    case DRAINING_BEFORE_SPIN:
      digitalWrite(RELAY_DRAIN_VALVE, HIGH);
      if (digitalRead(SENSOR_WATER_LEVEL) == LOW || (currentMillis - autoStartTime >= 40000)) { // Sakelar Terputus = Kosong
        currentAutoState = WAITING_FOR_SPIN;
        autoStartTime = currentMillis;
        Serial.println("[ESP32] Air Kosong -> Menunggu Jeda 40 Detik...");
      }
      break;

    case WAITING_FOR_SPIN:
      if (currentMillis - autoStartTime >= 40000) { // Jeda 40 Detik Sesuai Catatan
        currentAutoState = SPINNING;
        autoStartTime = currentMillis;
        Serial.println("[ESP32] Memulai Mode Spin (Pengering)...");
      }
      break;

    case SPINNING: {
      digitalWrite(RELAY_SPIN, HIGH);
      unsigned long elapsed = currentMillis - autoStartTime;
      sendRealtimeStatusToWeb(0, elapsed / 1000, "SPIN");
      
      if (elapsed >= 180000) { // 3 Menit Spin
        digitalWrite(RELAY_SPIN, LOW);
        currentAutoState = DRAINING_FINISH;
        autoStartTime = currentMillis;
        Serial.println("[ESP32] Spin Selesai -> Menunggu 40 Detik Sebelum Drain Ditutup...");
      }
      break;
    }

    case DRAINING_FINISH:
      if (currentMillis - autoStartTime >= 40000) { // Menunggu 40 Detik Baru Drain Ditutup
        digitalWrite(RELAY_DRAIN_VALVE, LOW);
        stopAllRelays();
        currentAutoState = DONE;
        sendRealtimeStatusToWeb(0, 0, "STANDBY"); // Kembali ke STANDBY & Pemicu Notifikasi Web
        Serial.println("[ESP32] Proses AUTO Selesai Total -> Standby");
      }
      break;

    case DONE: break;
  }
}

void handleWashOnlyProcess() {
  unsigned long currentMillis = millis();
  switch (currentWashOnlyState) {
    case WASH_IDLE: break;

    case WASH_FILLING_WATER:
      digitalWrite(RELAY_INLET_WATER, HIGH);
      if (digitalRead(SENSOR_WATER_LEVEL) == HIGH) {
        digitalWrite(RELAY_INLET_WATER, LOW);
        currentWashOnlyState = WASH_RUNNING;
        washOnlyStartTime = currentMillis;
        lastMotorToggleTime = currentMillis;
      }
      break;

    case WASH_RUNNING: {
      unsigned long elapsed = currentMillis - washOnlyStartTime;
      currentElapsedSeconds = elapsed / 1000;
      currentRemainSeconds = (washOnlyDurationMillis > elapsed) ? (washOnlyDurationMillis - elapsed) / 1000 : 0;
      
      if (currentMillis - lastMotorToggleTime >= (motorStatus ? motorOnTime : motorOffTime)) {
        lastMotorToggleTime = currentMillis;
        motorStatus = !motorStatus;
        static bool dir = true;
        digitalWrite(RELAY_WASH_CW, motorStatus && dir ? HIGH : LOW);
        digitalWrite(RELAY_WASH_CCW, motorStatus && !dir ? HIGH : LOW);
        if (!motorStatus) dir = !dir;
      }
      
      sendRealtimeStatusToWeb(currentRemainSeconds, currentElapsedSeconds, "WASH");
      
      if (elapsed >= washOnlyDurationMillis) {
        stopAllRelays();
        currentWashOnlyState = WASH_DONE;
        sendRealtimeStatusToWeb(0, currentElapsedSeconds, "STANDBY");
      }
      break;
    }

    case WASH_DONE: break;
  }
}

void handleSpinOnlyProcess() {
  unsigned long currentMillis = millis();
  switch (currentSpinOnlyState) {
    case SPIN_IDLE: break;

    case SPIN_DRAINING:
      digitalWrite(RELAY_DRAIN_VALVE, HIGH);
      if (digitalRead(SENSOR_WATER_LEVEL) == LOW || (currentMillis - spinOnlyStartTime >= 40000)) {
        currentSpinOnlyState = SPIN_WAITING;
        spinOnlyStartTime = currentMillis;
      }
      break;

    case SPIN_WAITING:
      if (currentMillis - spinOnlyStartTime >= 40000) {
        currentSpinOnlyState = SPIN_RUNNING;
        spinOnlyStartTime = currentMillis;
        lastMotorToggleTime = currentMillis;
      }
      break;

    case SPIN_RUNNING: {
      unsigned long elapsed = currentMillis - spinOnlyStartTime;
      currentElapsedSeconds = elapsed / 1000;
      currentRemainSeconds = (spinOnlyDurationMillis > elapsed) ? (spinOnlyDurationMillis - elapsed) / 1000 : 0;
      
      if (currentMillis - lastMotorToggleTime >= (motorStatus ? motorOnTime : motorOffTime)) {
        lastMotorToggleTime = currentMillis;
        motorStatus = !motorStatus;
        digitalWrite(RELAY_SPIN, motorStatus ? HIGH : LOW);
      }
      
      sendRealtimeStatusToWeb(currentRemainSeconds, currentElapsedSeconds, "SPIN");
      
      if (elapsed >= spinOnlyDurationMillis) {
        digitalWrite(RELAY_SPIN, LOW);
        currentSpinOnlyState = SPIN_DONE;
        spinOnlyStartTime = currentMillis;
      }
      break;
    }

    case SPIN_DONE:
      if (currentMillis - spinOnlyStartTime >= 40000) {
        digitalWrite(RELAY_DRAIN_VALVE, LOW);
        stopAllRelays();
        currentSpinOnlyState = SPIN_IDLE;
        sendRealtimeStatusToWeb(0, currentElapsedSeconds, "STANDBY");
      }
      break;
  }
}

void processCommand(String cmd) {
  Serial.print("[DATA MQTT TERIMA]: ");
  Serial.println(cmd);

  if (cmd.startsWith("MODE:")) {
    String mode = cmd.substring(5);
    if (mode == "STOP") {
      stopAllRelays();
      currentAutoState = IDLE;
      currentWashOnlyState = WASH_IDLE;
      currentSpinOnlyState = SPIN_IDLE;
      sendRealtimeStatusToWeb(0, 0, "STANDBY");
    } else if (mode == "AUTO") {
      startAutoCycle(userSelectedDuration, mode);
    } else {
      configureModeTiming(mode);
    }
  } else if (cmd.startsWith("DURATION:")) {
    userSelectedDuration = cmd.substring(9).toInt();
  } else if (cmd.startsWith("ACTION:")) {
    String action = cmd.substring(7);
    if (action == "WASH") startWashOnlyCycle(userSelectedDuration, selectedWashMode);
    else if (action == "SPIN") startSpinOnlyCycle(userSelectedDuration, selectedWashMode);
  }
}

void mqttCallback(char* topic, byte* payload, unsigned int length) {
  String message = "";
  for (unsigned int i = 0; i < length; i++) message += (char)payload[i];
  processCommand(message);
}

void reconnectMQTT() {
  while (!mqttClient.connected()) {
    Serial.print("Koneksi ke Broker MQTT...");
    String clientId = "ESP32Wash-" + String(random(0xffff), HEX);
    if (mqttClient.connect(clientId.c_str())) {
      Serial.println(" TERHUBUNG!");
      mqttClient.subscribe("washing_machine/control");
    } else {
      Serial.print(" Gagal (rc=");
      Serial.print(mqttClient.state());
      Serial.println("). Coba lagi dalam 2 detik...");
      delay(2000);
    }
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(RELAY_INLET_WATER, OUTPUT);
  pinMode(RELAY_DRAIN_VALVE, OUTPUT);
  pinMode(RELAY_WASH_CW, OUTPUT);
  pinMode(RELAY_WASH_CCW, OUTPUT);
  pinMode(RELAY_SPIN, OUTPUT);
  pinMode(SENSOR_WATER_LEVEL, INPUT);
  stopAllRelays();

  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid, password);
  Serial.print("Menghubungkan ke WiFi...");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println(" WiFi Terhubung!");

  mqttClient.setServer(mqtt_server, 1883);
  mqttClient.setCallback(mqttCallback);
  mqttClient.setKeepAlive(15);
}

void loop() {
  if (WiFi.status() == WL_CONNECTED) {
    if (!mqttClient.connected()) reconnectMQTT();
    mqttClient.loop();
  }
  handleAutoProcess();
  handleWashOnlyProcess();
  handleSpinOnlyProcess();
}