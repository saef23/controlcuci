#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

// BLE Config
#define SERVICE_UUID        "4fafc201-1fb5-459e-8fcc-c5c9c331914b"
#define CHARACTERISTIC_UUID "beb5483e-36e1-4688-b7f5-ea07361b26a8"

BLECharacteristic *pCharacteristic = nullptr;
bool deviceConnected = false;

// Config Pin Hardware
const int RELAY_INLET_WATER  = 18; // Relay Solenoid Inlet Air
const int RELAY_DRAIN_VALVE  = 19; // Relay Motor Drain/Kuras
const int RELAY_WASH_CW     = 21; // Relay Motor Cuci Kanan
const int RELAY_WASH_CCW    = 22; // Relay Motor Cuci Kiri
const int RELAY_SPIN        = 23; // Relay Motor Spin/Pengering
const int SENSOR_WATER_LEVEL = 34; // Pin Sensor Air (LOW = Terputus/Kosong, HIGH = Terhubung/Penuh)

// Global Control Variables
String selectedWashMode = "STANDARD";
int userSelectedDuration = 450; // Detik (dari Slider Web)
unsigned long motorOnTime = 5000;
unsigned long motorOffTime = 3000;
bool motorStatus = false;
unsigned long lastMotorToggleTime = 0;
unsigned long currentElapsedSeconds = 0;
unsigned long currentRemainSeconds = 0;

// Finite State Machine Enums
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
  if (deviceConnected && pCharacteristic != nullptr) {
    String payload = "REMAIN:" + String(sisaDetik) + ",ELAPSED:" + String(berjalanDetik) + ",STATUS:" + statusProses;
    pCharacteristic->setValue(payload.c_str());
    pCharacteristic->notify();
  }
}

void configureModeTiming(String mode) {
  selectedWashMode = mode;
  if (mode == "SOFT") { motorOnTime = 3000; motorOffTime = 5000; }
  else if (mode == "STRONG") { motorOnTime = 7000; motorOffTime = 2000; }
  else if (mode == "SPEED") { motorOnTime = 4000; motorOffTime = 2000; }
  else { motorOnTime = 5000; motorOffTime = 3000; } // STANDARD / AUTO
}

void startAutoCycle(int durationSeconds, String mode) {
  stopAllRelays();
  configureModeTiming(mode);
  autoWashDurationMillis = (unsigned long)durationSeconds * 1000;
  currentWashOnlyState = WASH_IDLE;
  currentSpinOnlyState = SPIN_IDLE;
  currentAutoState = FILLING_WATER;
  autoStartTime = millis();
}

void startWashOnlyCycle(int durationSeconds, String mode) {
  stopAllRelays();
  configureModeTiming(mode);
  washOnlyDurationMillis = (unsigned long)durationSeconds * 1000;
  currentAutoState = IDLE;
  currentSpinOnlyState = SPIN_IDLE;
  currentWashOnlyState = WASH_FILLING_WATER;
  washOnlyStartTime = millis();
}

void startSpinOnlyCycle(int durationSeconds, String mode) {
  stopAllRelays();
  configureModeTiming(mode);
  spinOnlyDurationMillis = (unsigned long)durationSeconds * 1000;
  currentAutoState = IDLE;
  currentWashOnlyState = WASH_IDLE;
  currentSpinOnlyState = SPIN_DRAINING;
  spinOnlyStartTime = millis();
}

// Handler Mode AUTO (Sesuai Catatan Tangan)
void handleAutoProcess() {
  unsigned long currentMillis = millis();
  switch (currentAutoState) {
    case IDLE: break;

    case FILLING_WATER:
      digitalWrite(RELAY_INLET_WATER, HIGH);
      if (digitalRead(SENSOR_WATER_LEVEL) == HIGH) { // Terhubung = Air Penuh
        digitalWrite(RELAY_INLET_WATER, LOW);
        currentAutoState = WASHING;
        autoStartTime = currentMillis;
        lastMotorToggleTime = currentMillis;
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
      }
      break;
    }

    case DRAINING_BEFORE_SPIN:
      digitalWrite(RELAY_DRAIN_VALVE, HIGH);
      if (digitalRead(SENSOR_WATER_LEVEL) == LOW || (currentMillis - autoStartTime >= 40000)) { // Terputus = Air Kosong
        currentAutoState = WAITING_FOR_SPIN;
        autoStartTime = currentMillis;
      }
      break;

    case WAITING_FOR_SPIN:
      if (currentMillis - autoStartTime >= 40000) { // Jeda 40 Detik
        currentAutoState = SPINNING;
        autoStartTime = currentMillis;
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
      }
      break;
    }

    case DRAINING_FINISH:
      if (currentMillis - autoStartTime >= 40000) { // Menunggu 40 Detik Sebelum Drain Ditutup
        digitalWrite(RELAY_DRAIN_VALVE, LOW);
        stopAllRelays();
        currentAutoState = DONE;
        sendRealtimeStatusToWeb(0, 0, "STANDBY"); // Memicu Notifikasi Suara/Getar/Pop-up di Web
      }
      break;

    case DONE: break;
  }
}

// Handler Mode WASH Only
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
        sendRealtimeStatusToWeb(0, currentElapsedSeconds, "STANDBY"); // Memicu Notifikasi Web
      }
      break;
    }

    case WASH_DONE: break;
  }
}

// Handler Mode SPIN Only
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
        sendRealtimeStatusToWeb(0, currentElapsedSeconds, "STANDBY"); // Memicu Notifikasi Web
      }
      break;
  }
}

void processCommand(String cmd) {
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

class MyServerCallbacks: public BLEServerCallbacks {
    void onConnect(BLEServer* pServer) { deviceConnected = true; };
    void onDisconnect(BLEServer* pServer) { deviceConnected = false; pServer->getAdvertising()->start(); }
};

class MyCallbacks: public BLECharacteristicCallbacks {
    void onWrite(BLECharacteristic *pCharacteristic) {
      std::string rxValue = pCharacteristic->getValue();
      if (rxValue.length() > 0) processCommand(String(rxValue.c_str()));
    }
};

void setup() {
  Serial.begin(115200);
  pinMode(RELAY_INLET_WATER, OUTPUT);
  pinMode(RELAY_DRAIN_VALVE, OUTPUT);
  pinMode(RELAY_WASH_CW, OUTPUT);
  pinMode(RELAY_WASH_CCW, OUTPUT);
  pinMode(RELAY_SPIN, OUTPUT);
  pinMode(SENSOR_WATER_LEVEL, INPUT);
  stopAllRelays();

  BLEDevice::init("ESP32_WashingMachine");
  BLEServer *pServer = BLEDevice::createServer();
  pServer->setCallbacks(new MyServerCallbacks());
  BLEService *pService = pServer->createService(SERVICE_UUID);
  pCharacteristic = pService->createCharacteristic(CHARACTERISTIC_UUID, BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_NOTIFY);
  pCharacteristic->addDescriptor(new BLE2902());
  pCharacteristic->setCallbacks(new MyCallbacks());
  pService->start();
  pServer->getAdvertising()->start();
}

void loop() {
  handleAutoProcess();
  handleWashOnlyProcess();
  handleSpinOnlyProcess();
}