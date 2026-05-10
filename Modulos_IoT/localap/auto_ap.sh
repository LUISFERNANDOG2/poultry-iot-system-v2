#!/bin/bash

echo "[+] Configurando Access Point automático con NetworkManager"

SSID="${AP_SSID:-Modulo_Local}"
PASS="${AP_PASSWORD:-CHANGE_ME_LOCAL_AP_PASSWORD}"
IFACE="wlan0"
CHANNEL=7

echo "[+] Eliminando conexión previa si existe..."
sudo nmcli connection delete "$SSID" 2>/dev/null
sudo rm -f /etc/NetworkManager/system-connections/$SSID.nmconnection 2>/dev/null

echo "[+] Creando conexión AP limpia..."
sudo nmcli connection add type wifi ifname "$IFACE" con-name "$SSID" autoconnect yes ssid "$SSID"

echo "[+] Configurando modo AP y red..."
sudo nmcli connection modify "$SSID" 802-11-wireless.mode ap
sudo nmcli connection modify "$SSID" 802-11-wireless.band bg
sudo nmcli connection modify "$SSID" 802-11-wireless.channel "$CHANNEL"
sudo nmcli connection modify "$SSID" ipv4.method shared

echo "[+] Configurando seguridad WPA2-PSK..."
sudo nmcli connection modify "$SSID" wifi-sec.key-mgmt wpa-psk
sudo nmcli connection modify "$SSID" wifi-sec.psk "$PASS"

echo "[+] Desactivando WPS (causaba que ESP32 no se conectara)..."
sudo nmcli connection modify "$SSID" wifi-sec.wps-method disabled

echo "[+] Eliminando cualquier rastro de claves WEP accidental..."
sudo nmcli connection modify "$SSID" 802-11-wireless-security.wep-key0 ""
sudo nmcli connection modify "$SSID" 802-11-wireless-security.wep-key-type 0

echo "[+] Desactivando autoconnect de otras redes..."
for c in $(nmcli -t -f NAME connection show | grep -v "$SSID"); do
    sudo nmcli connection modify "$c" connection.autoconnect no
done

echo "[+] Activando AP..."
sudo nmcli connection up "$SSID"

echo "[+] Creando servicio systemd..."

sudo bash -c "cat > /etc/systemd/system/auto-ap.service <<EOF
[Unit]
Description=Levantar AP automáticamente con nmcli
After=NetworkManager.service

[Service]
ExecStart=/usr/bin/nmcli connection up $SSID
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF"

echo "[+] Habilitando servicio..."
sudo systemctl enable auto-ap.service

echo ""
echo "============================================="
echo "   AP configurado correctamente"
echo "   SSID: $SSID"
echo "   Contraseña: $PASS"
echo "   Canal: $CHANNEL"
echo "   Seguridad: WPA2-PSK (WPS DESACTIVADO)"
echo "============================================="
echo ""
echo "[+] Reinicia la Raspberry Pi:"
echo "    sudo reboot"
