import time
import network
import bluetooth
from machine import Pin
from umqtt.simple import MQTTClient

# ==================== KONFIGURASI WIRING PIN ====================
PIN_POWER_AC         = 18
PIN_WATER_INLET      = 23
PIN_BOOSTER_PUMP     = 15  # Pin Pompa Dorong
PIN_RELAY_MOTOR_KIRI = 22
PIN_RELAY_MOTOR_KANAN = 21
PIN_MOTOR_DRAIN      = 19
PIN_BUZZER           = 5   # Active HIGH (1 = Nyala, 0 = Mati)
PIN_WATER_LEVEL      = 4   # PENUH = 0 (LOW), KOSONG = 1 (HIGH)

# --- 4 PIN TAMBAHAN UNTUK RELAY LAMPU/BEBAN EKSTERNAL ---
PIN_LAMPU_1          = 13
PIN_LAMPU_2          = 12
PIN_LAMPU_3          = 14
PIN_LAMPU_4          = 27

# ==================== KONFIGURASI WIFI & MQTT ====================
WIFI_SSID      = "realme C75"
WIFI_PASS      = "123456789"
MQTT_SERVER    = "broker.hivemq.com"
MQTT_CLIENT_ID = "ESP32_Washer_Hybrid"
TOPIC_SUB      = b"mesincuci/command"
TOPIC_PUB      = b"mesincuci/status"

# Konstanta Waktu (ms) - Jeda setelah kosong (90 Detik / 1 Menit 30 Detik)
JEDA_SETELAH_KOSONG = 90000 
JEDA_90_DETIK       = 90000   
JEDA_7_MENIT        = 420000

# ==================== INISIALISASI PIN (Active LOW untuk Relay) ====================
# Nilai value=1 memastikan Relay MATI saat ESP32 baru menyala
power_ac     = Pin(PIN_POWER_AC, Pin.OUT, value=1)
water_inlet  = Pin(PIN_WATER_INLET, Pin.OUT, value=1)
booster_pump = Pin(PIN_BOOSTER_PUMP, Pin.OUT, value=1)
relay_kiri   = Pin(PIN_RELAY_MOTOR_KIRI, Pin.OUT, value=1)
relay_kanan  = Pin(PIN_RELAY_MOTOR_KANAN, Pin.OUT, value=1)
motor_drain  = Pin(PIN_MOTOR_DRAIN, Pin.OUT, value=1)

# Buzzer Active HIGH (0 = Mati)
buzzer       = Pin(PIN_BUZZER, Pin.OUT, value=0)

water_level_sensor = Pin(PIN_WATER_LEVEL, Pin.IN, Pin.PULL_UP)

# Relay Lampu Active LOW (value=1 agar Mati saat booting)
lampu1 = Pin(PIN_LAMPU_1, Pin.OUT, value=1)
lampu2 = Pin(PIN_LAMPU_2, Pin.OUT, value=1)
lampu3 = Pin(PIN_LAMPU_3, Pin.OUT, value=1)
lampu4 = Pin(PIN_LAMPU_4, Pin.OUT, value=1)

# Variable Global
perintah_terakhir = ""
sedang_berjalan = False
stop_diminta = False

# ==================== MODUL WEB BLE (NORDIC UART SERVICE) ====================
_BLE_SERVICE_UUID = bluetooth.UUID("6e400001-b5a3-f393-e0a9-e50e24dcca9e")
_BLE_RX_UUID      = bluetooth.UUID("6e400002-b5a3-f393-e0a9-e50e24dcca9e")
_BLE_TX_UUID      = bluetooth.UUID("6e400003-b5a3-f393-e0a9-e50e24dcca9e")

class ESP32_BLE:
    def __init__(self, name="ESP32_MesinCuci"):
        self.ble = bluetooth.BLE()
        self.ble.active(True)
        self.ble.irq(self._irq)
        
        UART_SERVICE = (_BLE_SERVICE_UUID, ((_BLE_TX_UUID, bluetooth.FLAG_NOTIFY), (_BLE_RX_UUID, bluetooth.FLAG_WRITE),),)
        ((self.tx_handle, self.rx_handle),) = self.ble.gatts_register_services((UART_SERVICE,))
        
        self.rx_buffer = ""
        self.conn_handle = None
        self._advertise(name)

    def _irq(self, event, data):
        if event == 1: # CONNECT
            self.conn_handle, _, _ = data
            print("BLE: Connected!")
        elif event == 2: # DISCONNECT
            self.conn_handle = None
            print("BLE: Disconnected!")
            self._advertise("ESP32_MesinCuci")
        elif event == 3: # WRITE
            conn_handle, value_handle = data
            if value_handle == self.rx_handle:
                self.rx_buffer = self.ble.gatts_read(self.rx_handle).decode('utf-8').strip()

    def _advertise(self, name):
        name_bytes = name.encode('utf-8')
        payload = bytearray([len(name_bytes) + 1, 0x09]) + name_bytes
        self.ble.gap_advertise(100000, payload)

    def read(self):
        msg = self.rx_buffer
        self.rx_buffer = ""
        return msg

    def send(self, data):
        if self.conn_handle is not None:
            try:
                self.ble.gatts_notify(self.conn_handle, self.tx_handle, data.encode('utf-8'))
            except:
                pass

ble = ESP32_BLE("ESP32_MesinCuci")

# ==================== KONEKSI WIFI & MQTT ====================
def hubungkan_wifi():
    wlan = network.WLAN(network.STA_IF)
    wlan.active(True)
    if not wlan.isconnected():
        print("Menghubungkan ke Wi-Fi...")
        wlan.connect(WIFI_SSID, WIFI_PASS)
        timeout = 0
        while not wlan.isconnected() and timeout < 10:
            time.sleep(1)
            timeout += 1
    if wlan.isconnected():
        print("Wi-Fi Connected! IP:", wlan.ifconfig()[0])
    else:
        print("Wi-Fi Offline (Mode BLE Saja)")

def mqtt_callback(topic, msg):
    global perintah_terakhir
    perintah_terakhir = msg.decode('utf-8').strip().upper()

hubungkan_wifi()
try:
    client = MQTTClient(MQTT_CLIENT_ID, MQTT_SERVER)
    client.set_callback(mqtt_callback)
    client.connect()
    client.subscribe(TOPIC_SUB)
    print("MQTT Ready!")
except Exception as e:
    print("MQTT Offline:", e)
    client = None

# ==================== KONTROL HARDWARE ====================
def matikan_semua_relay():
    water_inlet.value(1)   # 1 = MATI
    booster_pump.value(1)  # 1 = MATI
    relay_kiri.value(1)    # 1 = MATI
    relay_kanan.value(1)   # 1 = MATI
    motor_drain.value(1)   # 1 = MATI
    buzzer.value(0)        # 0 = MATI (Buzzer Active HIGH)

def power_on():
    power_ac.value(0)      # 0 = NYALA (Active LOW)
    kirim_status("Power AC: ON")
    time.sleep(1)

def power_off():
    matikan_semua_relay()
    power_ac.value(1)      # 1 = MATI
    kirim_status("Power AC: OFF")

def kirim_status(pesan):
    print(pesan)
    ble.send("STATUS:" + pesan + "\n")
    if client:
        try:
            client.publish(TOPIC_PUB, ("STATUS:" + pesan).encode())
        except:
            pass

def kirim_telemetry():
    status_water = "PENUH" if water_level_sensor.value() == 0 else "KOSONG"
    status_relay = "PWR:" + ("ON" if power_ac.value() == 0 else "OFF") + \
                   "|INLET:" + ("ON" if water_inlet.value() == 0 else "OFF") + \
                   "|BOOSTER:" + ("ON" if booster_pump.value() == 0 else "OFF") + \
                   "|DRAIN:" + ("ON" if motor_drain.value() == 0 else "OFF") + \
                   "|KIRI:" + ("ON" if relay_kiri.value() == 0 else "OFF") + \
                   "|KANAN:" + ("ON" if relay_kanan.value() == 0 else "OFF") + \
                   "|L1:" + ("ON" if lampu1.value() == 0 else "OFF") + \
                   "|L2:" + ("ON" if lampu2.value() == 0 else "OFF") + \
                   "|L3:" + ("ON" if lampu3.value() == 0 else "OFF") + \
                   "|L4:" + ("ON" if lampu4.value() == 0 else "OFF")
    telemetry_msg = "DATA|WATER:" + status_water + "|" + status_relay + "\n"
    
    ble.send(telemetry_msg)
    if client:
        try:
            client.publish(TOPIC_PUB, telemetry_msg.strip().encode())
        except:
            pass

def cek_perintah_masuk():
    global perintah_terakhir, stop_diminta, sedang_berjalan
    
    if client:
        try:
            client.check_msg()
        except:
            pass

    cmd_ble = ble.read().upper()
    cmd = cmd_ble if cmd_ble != "" else perintah_terakhir
    perintah_terakhir = ""

    if cmd in ["CMD:X", "CMD:STOP", "CMD:CANCEL", "CMD:RESET", "X", "STOP", "CANCEL", "RESET"]:
        stop_diminta = True

    if stop_diminta:
        kirim_status("DIHENTIKAN")
        power_off()
        sedang_berjalan = False
        return True
    return False

# ==================== KONTROL 4 LAMPU TAMBAHAN (Active LOW) ====================
def atur_lampu(cmd):
    global lampu1, lampu2, lampu3, lampu4
    if cmd == "LAMPU1_ON":
        lampu1.value(0) # 0 = NYALA
        kirim_status("Lampu 1: ON")
    elif cmd == "LAMPU1_OFF":
        lampu1.value(1) # 1 = MATI
        kirim_status("Lampu 1: OFF")
    elif cmd == "LAMPU2_ON":
        lampu2.value(0)
        kirim_status("Lampu 2: ON")
    elif cmd == "LAMPU2_OFF":
        lampu2.value(1)
        kirim_status("Lampu 2: OFF")
    elif cmd == "LAMPU3_ON":
        lampu3.value(0)
        kirim_status("Lampu 3: ON")
    elif cmd == "LAMPU3_OFF":
        lampu3.value(1)
        kirim_status("Lampu 3: OFF")
    elif cmd == "LAMPU4_ON":
        lampu4.value(0)
        kirim_status("Lampu 4: ON")
    elif cmd == "LAMPU4_OFF":
        lampu4.value(1)
        kirim_status("Lampu 4: OFF")

def jalankan_timer_proses(ms_total, nama_proses):
    start_ticks = time.ticks_ms()
    last_telemetry = start_ticks
    
    while time.ticks_diff(time.ticks_ms(), start_ticks) < ms_total:
        if cek_perintah_masuk():
            return False

        if time.ticks_diff(time.ticks_ms(), last_telemetry) >= 1000:
            last_telemetry = time.ticks_ms()
            sisa_detik = (ms_total - time.ticks_diff(time.ticks_ms(), start_ticks)) // 1000
            kirim_status(f"TIMER|{nama_proses}|{sisa_detik}s")
            kirim_telemetry()
            
        time.sleep_ms(10)
    return True

def isi_air_otomatis():
    global sedang_berjalan
    if water_level_sensor.value() == 1:
        kirim_status("AIR & BOOSTER: Mengisi Air...")
        water_inlet.value(0)   # 0 = NYALA
        booster_pump.value(0) # 0 = NYALA
        
        start_pengisian = time.ticks_ms()
        timeout_air_ms = 1200000 # 20 Menit Timeout
        detik_stabil = 0

        while True:
            if cek_perintah_masuk():
                return False

            if time.ticks_diff(time.ticks_ms(), start_pengisian) >= timeout_air_ms:
                kirim_status("ERROR: Timeout Isi Air (>20m)! OFF Total...")
                power_off()
                sedang_berjalan = False
                return False

            if water_level_sensor.value() == 0:
                detik_stabil += 1
                if detik_stabil >= 3:
                    break
            else:
                detik_stabil = 0

            kirim_telemetry()
            time.sleep_ms(1000)

        water_inlet.value(1)   # 1 = MATI
        booster_pump.value(1) # 1 = MATI
        kirim_status("AIR: Penuh (Pompa Dorong OFF)")
    return True

def buang_air_otomatis():
    kirim_status("DRAIN: Membuang Air...")
    motor_drain.value(0) # 0 = NYALA
    
    start_drain = time.ticks_ms()
    timeout_drain_ms = 600000
    detik_stabil = 0

    while True:
        if cek_perintah_masuk():
            return False

        if time.ticks_diff(time.ticks_ms(), start_drain) >= timeout_drain_ms:
            kirim_status("ERROR: Timeout Drain (>10m)! OFF Total...")
            power_off()
            global sedang_berjalan
            sedang_berjalan = False
            return False

        if water_level_sensor.value() == 1:
            detik_stabil += 1
            if detik_stabil >= 3:
                break
        else:
            detik_stabil = 0

        kirim_telemetry()
        time.sleep_ms(1000)

    if not jalankan_timer_proses(5000, "Ekstra Pengurasan"): return False

    motor_drain.value(1) # 1 = MATI
    kirim_status("DRAIN: Selesai. Jeda 1 Menit 30 Detik...")
    return jalankan_timer_proses(JEDA_SETELAH_KOSONG, "Jeda Drain")

def proses_cuci(durasi_menit, waktu_putar_ms, waktu_jeda_ms):
    if not isi_air_otomatis(): return False
    kirim_status("CUCI: Motor Berputar...")

    total_ms = durasi_menit * 60000
    start = time.ticks_ms()

    while time.ticks_diff(time.ticks_ms(), start) < total_ms:
        relay_kiri.value(0)  # 0 = NYALA
        relay_kanan.value(1) # 1 = MATI
        if not jalankan_timer_proses(waktu_putar_ms, "Putar Kiri"): return False

        relay_kiri.value(1)  # 1 = MATI
        if not jalankan_timer_proses(waktu_jeda_ms, "Jeda"): return False

        relay_kanan.value(0) # 0 = NYALA
        relay_kiri.value(1)  # 1 = MATI
        if not jalankan_timer_proses(waktu_putar_ms, "Putar Kanan"): return False

        relay_kanan.value(1) # 1 = MATI
        if not jalankan_timer_proses(waktu_jeda_ms, "Jeda"): return False

    matikan_semua_relay()
    return buang_air_otomatis()

def proses_cuci_saja(durasi_menit, waktu_putar_ms=3500, waktu_jeda_ms=2000):
    if not isi_air_otomatis(): return False
    kirim_status("CUCI SAJA: Motor Berputar...")

    total_ms = durasi_menit * 60000
    start = time.ticks_ms()

    while time.ticks_diff(time.ticks_ms(), start) < total_ms:
        relay_kiri.value(0)
        relay_kanan.value(1)
        if not jalankan_timer_proses(waktu_putar_ms, "Cuci Saja Kiri"): return False

        relay_kiri.value(1)
        if not jalankan_timer_proses(waktu_jeda_ms, "Cuci Saja Jeda"): return False

        relay_kanan.value(0)
        relay_kiri.value(1)
        if not jalankan_timer_proses(waktu_putar_ms, "Cuci Saja Kanan"): return False

        relay_kanan.value(1)
        if not jalankan_timer_proses(waktu_jeda_ms, "Cuci Saja Jeda"): return False

    matikan_semua_relay()
    return True

def proses_bilas(jumlah_bilas, durasi_bilas_menit, waktu_putar_ms, waktu_jeda_ms):
    for i in range(1, jumlah_bilas + 1):
        kirim_status("BILAS: Siklus " + str(i))
        if not proses_cuci(durasi_bilas_menit, waktu_putar_ms, waktu_jeda_ms): return False

        kirim_status("BILAS: Peras 1 Menit...")
        motor_drain.value(0)  # 0 = NYALA
        relay_kanan.value(0) # 0 = NYALA
        if not jalankan_timer_proses(60000, "Peras Bilas"): return False
        
        relay_kanan.value(1) # 1 = MATI
        if not jalankan_timer_proses(JEDA_SETELAH_KOSONG, "Jeda Drain Bilas"): return False
        motor_drain.value(1)  # 1 = MATI
    return True

def proses_perendaman_softener(durasi_putar_menit, durasi_jeda_ms):
    kirim_status("SOFTENER: Isi Air...")
    if not isi_air_otomatis(): return False

    kirim_status("SOFTENER: Motor Berputar 2 Menit...")
    total_ms = durasi_putar_menit * 60000
    start = time.ticks_ms()

    while time.ticks_diff(time.ticks_ms(), start) < total_ms:
        relay_kiri.value(0)
        relay_kanan.value(1)
        if not jalankan_timer_proses(2500, "Softener Kiri"): return False

        relay_kiri.value(1)
        if not jalankan_timer_proses(1500, "Softener Jeda"): return False

        relay_kanan.value(0)
        relay_kiri.value(1)
        if not jalankan_timer_proses(2500, "Softener Kanan"): return False

        relay_kanan.value(1)
        if not jalankan_timer_proses(1500, "Softener Jeda"): return False

    matikan_semua_relay()
    kirim_status("SOFTENER: Perendaman (7 Menit)...")
    return jalankan_timer_proses(durasi_jeda_ms, "Perendaman Softener")

def proses_spin_utama(durasi_menit):
    kirim_status("SPIN: Motor Drain ON...")
    motor_drain.value(0) # 0 = NYALA

    detik_stabil = 0
    while True:
        if cek_perintah_masuk(): return False
        
        if water_level_sensor.value() == 1:
            detik_stabil += 1
            if detik_stabil >= 3:
                break
        else:
            detik_stabil = 0
            
        kirim_telemetry()
        time.sleep_ms(1000)

    kirim_status("SPIN: Air Kosong. Jeda 1 Menit 30 Detik...")
    if not jalankan_timer_proses(JEDA_SETELAH_KOSONG, "Jeda Sebelum Spin"): return False

    kirim_status("SPIN: Motor Putar Kanan ON...")
    relay_kanan.value(0) # 0 = NYALA
    
    if not jalankan_timer_proses(durasi_menit * 60000, "Spin Utama"): return False
    
    relay_kanan.value(1) # 1 = MATI
    kirim_status("SPIN: Selesai. Jeda Drain 1.5 Menit...")
    
    if not jalankan_timer_proses(JEDA_90_DETIK, "Jeda Drain Akhir"): return False
    
    motor_drain.value(1) # 1 = MATI
    kirim_status("SPIN: Selesai")
    return True

def bunyikan_buzzer_selesai():
    kirim_status("SELESAI: Membunyikan Buzzer")
    for _ in range(5):
        buzzer.value(1) # 1 = NYALA (Buzzer Active HIGH)
        time.sleep_ms(300)
        buzzer.value(0) # 0 = MATI
        time.sleep_ms(300)

def jalankan_program(mode, durasi_custom=0):
    global sedang_berjalan, stop_diminta
    sedang_berjalan = True
    stop_diminta = False
    power_on()

    if mode == 1:
        kirim_status("PROSES: Cuci Cepat")
        if not proses_cuci(5, 2500, 1500): return
        if not proses_bilas(1, 5, 2500, 1500): return
        if not proses_perendaman_softener(2, JEDA_7_MENIT): return
        if not proses_spin_utama(3): return
        
    elif mode == 2:
        kirim_status("PROSES: Cuci Normal")
        if not proses_cuci(10, 3500, 2000): return
        if not proses_bilas(1, 5, 3500, 2000): return
        if not proses_perendaman_softener(2, JEDA_7_MENIT): return
        if not proses_spin_utama(5): return
        
    elif mode == 3:
        kirim_status("PROSES: Cuci Berat")
        if not proses_cuci(15, 4000, 3000): return
        if not proses_bilas(1, 5, 4000, 3000): return
        if not proses_perendaman_softener(2, JEDA_7_MENIT): return
        if not proses_spin_utama(7): return
        
    elif mode == 4:
        durasi = durasi_custom if durasi_custom > 0 else 5
        durasi = min(max(durasi, 1), 7)
        kirim_status(f"PROSES: Spin Only ({durasi}m)")
        if not proses_spin_utama(durasi): return

    elif mode == 5:
        durasi = durasi_custom if durasi_custom > 0 else 10
        durasi = min(max(durasi, 1), 15)
        kirim_status(f"PROSES: Cuci Saja ({durasi}m)")
        if not proses_cuci_saja(durasi): return

    bunyikan_buzzer_selesai()
    kirim_status("SELESAI")
    power_off()
    sedang_berjalan = False

# ==================== SETUP & LOOP UTAMA ====================
matikan_semua_relay()
print("ESP32 MicroPython Washer Ready (FIX Booting All OFF)!")

while True:
    if client:
        try:
            client.check_msg()
        except:
            pass

    cmd_ble = ble.read().upper()
    cmd_input = cmd_ble if cmd_ble != "" else perintah_terakhir
    perintah_terakhir = ""

    if cmd_input != "":
        print("Perintah Diterima:", cmd_input)
        
        if "LAMPU" in cmd_input:
            atur_lampu(cmd_input)
        elif cmd_input in ["1", "2", "3", "4", "5"] and not sedang_berjalan:
            jalankan_program(int(cmd_input), 0)
        elif cmd_input.startswith("CMD:") and not sedang_berjalan:
            parts = cmd_input.split(":")
            if len(parts) >= 2:
                try:
                    m_code = int(parts[1])
                    m_durasi = int(parts[2]) if len(parts) > 2 else 0
                    jalankan_program(m_code, m_durasi)
                except ValueError:
                    pass

    time.sleep_ms(100)
