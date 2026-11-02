#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

// Config BLE UUID
#define SERVICE_UUID        "4fafc201-1fb5-459e-8fcc-c5c9c331914b"
#define CHARACTERISTIC_UUID "beb5483e-36e1-4688-b7f5-ea07361b26a8"

BLECharacteristic *pCharacteristic = nullptr;
bool deviceConnected = false;

// Hardware Pin Configuration (4 Relay)
const int RELAY_INLET_WATER  = 18; // Relay Solenoid Air Masuk
const int RELAY_DRAIN_VALVE  = 19; // Relay Pembuangan Air (Drain)
const int RELAY_WASH_CW     = 21; // Relay Putaran Kanan (Juga digunakan untuk SPIN)
const int RELAY_WASH_CCW    = 22; // Relay Putaran Kiri
const int SENSOR_WATER_LEVEL = 34; // LOW = Kosong, HIGH = Penuh

// Logika Relay Active LOW
#define RELAY_ON  LOW
#define RELAY_OFF HIGH

// Global Control Variables
String selectedWashMode = "STANDARD";
int userSelectedDuration = 450;
unsigned long motorOnTime = 5000;
unsigned long motorOffTime = 3000;
bool motorStatus = false;
unsigned long lastMotorToggleTime = 0;
unsigned long currentElapsedSeconds = 0;
unsigned long currentRemainSeconds = 0;
unsigned long safetyTimeoutStart = 0;

// State Machine Enums & Variables
enum MachineState {
  STATE_IDLE,
  STATE_FILLING,
  STATE_WASHING,
  STATE_DRAINING,
  STATE_WAITING_SPIN,
  STATE_SPINNING,
  STATE_DRAIN_FINISH,
  STATE_DONE
};

MachineState currentMasterState = STATE_IDLE;
String activeProcessType = "NONE";

unsigned long processStartTime = 0;
unsigned long processDurationMillis = 450000;

void stopAllRelays() {
  digitalWrite(RELAY_INLET_WATER, RELAY_OFF);
  digitalWrite(RELAY_DRAIN_VALVE, RELAY_OFF);
  digitalWrite(RELAY_WASH_CW, RELAY_OFF);
  digitalWrite(RELAY_WASH_CCW, RELAY_OFF);
  activeProcessType = "NONE";
  currentMasterState = STATE_IDLE;
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
  else { motorOnTime = 5000; motorOffTime = 3000; }
}

void startCycle(String type, int durationSeconds, String mode) {
  stopAllRelays();
  configureModeTiming(mode);
  processDurationMillis = (unsigned long)durationSeconds * 1000;
  activeProcessType = type;
  processStartTime = millis();
  safetyTimeoutStart = millis();

  if (type == "AUTO" || type == "WASH") {
    currentMasterState = STATE_FILLING;
  } else if (type == "SPIN") {
    currentMasterState = STATE_DRAINING;
  }
}

void handleMachineProcess() {
  unsigned long currentMillis = millis();

  switch (currentMasterState) {
    case STATE_IDLE: break;

    // 1. TAHAP ISI AIR
    case STATE_FILLING:
      digitalWrite(RELAY_INLET_WATER, RELAY_ON);
      if (currentMillis - safetyTimeoutStart > 60000) {
        stopAllRelays();
        sendRealtimeStatusToWeb(0, 0, "STANDBY");
        break;
      }
      if (digitalRead(SENSOR_WATER_LEVEL) == HIGH) {
        digitalWrite(RELAY_INLET_WATER, RELAY_OFF);
        currentMasterState = STATE_WASHING;
        processStartTime = currentMillis;
        lastMotorToggleTime = currentMillis;
      }
      break;

    // 2. TAHAP CUCI (CW / CCW dengan Jeda Kekuatan)
    case STATE_WASHING: {
      unsigned long elapsed = currentMillis - processStartTime;
      unsigned long washDuration = (activeProcessType == "AUTO") ? 600000 : processDurationMillis;
      
      currentElapsedSeconds = elapsed / 1000;
      currentRemainSeconds = (washDuration > elapsed) ? (washDuration - elapsed) / 1000 : 0;
      
      if (currentMillis - lastMotorToggleTime >= (motorStatus ? motorOnTime : motorOffTime)) {
        lastMotorToggleTime = currentMillis;
        motorStatus = !motorStatus;
        static bool dir = true;
        
        digitalWrite(RELAY_WASH_CW, motorStatus && dir ? RELAY_ON : RELAY_OFF);
        digitalWrite(RELAY_WASH_CCW, motorStatus && !dir ? RELAY_ON : RELAY_OFF);
        
        if (!motorStatus) dir = !dir;
      }
      
      sendRealtimeStatusToWeb(currentRemainSeconds, currentElapsedSeconds, "WASH");
      
      if (elapsed >= washDuration) {
        digitalWrite(RELAY_WASH_CW, RELAY_OFF);
        digitalWrite(RELAY_WASH_CCW, RELAY_OFF);
        if (activeProcessType == "AUTO") {
          currentMasterState = STATE_DRAINING;
          processStartTime = currentMillis;
          safetyTimeoutStart = currentMillis;
        } else {
          stopAllRelays();
          currentMasterState = STATE_DONE;
          sendRealtimeStatusToWeb(0, currentElapsedSeconds, "STANDBY");
        }
      }
      break;
    }

    // 3. TAHAP KURAS AIR
    case STATE_DRAINING:
      digitalWrite(RELAY_DRAIN_VALVE, RELAY_ON);
      if (digitalRead(SENSOR_WATER_LEVEL) == LOW || (currentMillis - safetyTimeoutStart >= 40000)) {
        currentMasterState = STATE_WAITING_SPIN;
        processStartTime = currentMillis;
      }
      break;

    // 4. JEDA TUNGGU 35 DETIK
    case STATE_WAITING_SPIN:
      if (currentMillis - processStartTime >= 35000) {
        currentMasterState = STATE_SPINNING;
        processStartTime = currentMillis;
      }
      break;

    // 5. TAHAP SPIN (Menggunakan RELAY_WASH_CW)
    case STATE_SPINNING: {
      digitalWrite(RELAY_WASH_CW, RELAY_ON);
      
      unsigned long elapsed = currentMillis - processStartTime;
      unsigned long spinDuration = (activeProcessType == "AUTO") ? 300000 : ((processDurationMillis == 450000) ? 120000 : processDurationMillis);
      
      currentElapsedSeconds = elapsed / 1000;
      currentRemainSeconds = (spinDuration > elapsed) ? (spinDuration - elapsed) / 1000 : 0;
      sendRealtimeStatusToWeb(currentRemainSeconds, currentElapsedSeconds, "SPIN");
      
      if (elapsed >= spinDuration) {
        digitalWrite(RELAY_WASH_CW, RELAY_OFF);
        currentMasterState = STATE_DRAIN_FINISH;
        processStartTime = currentMillis;
      }
      break;
    }

    // 6. TAHAP DRAIN FINISH
    case STATE_DRAIN_FINISH: {
      unsigned long drainFinishDelay = (activeProcessType == "AUTO") ? 35000 : 30000;
      if (currentMillis - processStartTime >= drainFinishDelay) {
        digitalWrite(RELAY_DRAIN_VALVE, RELAY_OFF);
        stopAllRelays();
        currentMasterState = STATE_DONE;
        sendRealtimeStatusToWeb(0, currentElapsedSeconds, "STANDBY");
      }
      break;
    }

    case STATE_DONE:
      currentMasterState = STATE_IDLE;
      break;
  }
}

void processCommand(String cmd) {
  if (cmd.startsWith("MODE:")) {
    String mode = cmd.substring(5);
    if (mode == "STOP") {
      stopAllRelays();
      sendRealtimeStatusToWeb(0, 0, "STANDBY");
    } else if (mode == "AUTO") {
      startCycle("AUTO", userSelectedDuration, mode);
    } else {
      configureModeTiming(mode);
    }
  } else if (cmd.startsWith("DURATION:")) {
    userSelectedDuration = cmd.substring(9).toInt();
  } else if (cmd.startsWith("ACTION:")) {
    String action = cmd.substring(7);
    if (action == "WASH") startCycle("WASH", userSelectedDuration, selectedWashMode);
    else if (action == "SPIN") startCycle("SPIN", userSelectedDuration, selectedWashMode);
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

  digitalWrite(RELAY_INLET_WATER, RELAY_OFF);
  digitalWrite(RELAY_DRAIN_VALVE, RELAY_OFF);
  digitalWrite(RELAY_WASH_CW, RELAY_OFF);
  digitalWrite(RELAY_WASH_CCW, RELAY_OFF);

  pinMode(RELAY_INLET_WATER, OUTPUT);
  pinMode(RELAY_DRAIN_VALVE, OUTPUT);
  pinMode(RELAY_WASH_CW, OUTPUT);
  pinMode(RELAY_WASH_CCW, OUTPUT);
  pinMode(SENSOR_WATER_LEVEL, INPUT);

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
  handleMachineProcess();
}