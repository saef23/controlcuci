#include <WiFi.h>
#include <PubSubClient.h>

const char* ssid        = "realme C75";
const char* password    = "123456789";
const char* mqtt_server = "broker.hivemq.com";
const int   mqtt_port   = 1883;

const char* topic_command = "mesincuci/command";
const char* topic_status  = "mesincuci/status";

WiFiClient espClient;
PubSubClient client(espClient);

// Variabel filter anti-bounce (mencegah double trigger)
String perintahTerakhir = "";
unsigned long waktuTerakhir = 0;

void callback(char* topic, byte* payload, unsigned int length) {
  String message = "";
  for (int i = 0; i < length; i++) {
    message += (char)payload[i];
  }
  message.trim();

  // Filter: abaikan jika perintah sama dikirim < 500 ms
  if (message == perintahTerakhir && (millis() - waktuTerakhir < 500)) {
    return;
  }

  perintahTerakhir = message;
  waktuTerakhir = millis();

  // Teruskan perintah ke ESP32 Utama via Serial2
  Serial2.println(message);
  Serial.println("[WEB -> ESP32 UTAMA]: " + message);
}

void reconnectMQTT() {
  while (!client.connected()) {
    Serial.print("Menghubungkan ke Broker MQTT...");
    String clientId = "ESP32Bridge_";
    clientId += String(random(0xffff), HEX);
    
    if (client.connect(clientId.c_str())) {
      Serial.println(" Terhubung!");
      client.subscribe(topic_command);
    } else {
      Serial.print(" Gagal (rc=");
      Serial.print(client.state());
      Serial.println(") Coba lagi 2 detik...");
      delay(2000);
    }
  }
}

void setup() {
  Serial.begin(115200);
  Serial2.begin(115200, SERIAL_8N1, 16, 17); // RX2=16, TX2=17 ke ESP32 Utama

  WiFi.begin(ssid, password);
  Serial.print("Menghubungkan Wi-Fi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\nWi-Fi Terhubung!");

  client.setServer(mqtt_server, mqtt_port);
  client.setCallback(callback);
}

void loop() {
  if (!client.connected()) {
    reconnectMQTT();
  }
  client.loop();

  // Terima data telemetry dari ESP32 Utama lalu kirim ke MQTT Web
  if (Serial2.available()) {
    String dataUtama = Serial2.readStringUntil('\n');
    dataUtama.trim();

    if (dataUtama.length() > 0) {
      client.publish(topic_status, dataUtama.c_str());
      Serial.println("[ESP32 UTAMA -> WEB]: " + dataUtama);
    }
  }
}
