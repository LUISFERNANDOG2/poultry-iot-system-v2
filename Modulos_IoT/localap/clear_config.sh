#!/bin/bash

echo "[+] Eliminando conexión del AP en NetworkManager..."
sudo nmcli connection delete "Modulo_2" 2>/dev/null
sudo rm -f /etc/NetworkManager/system-connections/Modulo_2.nmconnection

echo "[+] Eliminando servicio auto-ap.service..."
sudo systemctl disable auto-ap.service 2>/dev/null
sudo rm -f /etc/systemd/system/auto-ap.service

echo "[+] Restaurando autoconnect de todas las redes..."
for c in $(nmcli -t -f NAME connection show); do
    sudo nmcli connection modify "$c" connection.autoconnect yes
done

echo "[+] Deteniendo NetworkManager sobre wlan0..."
sudo nmcli radio wifi off
sudo nmcli radio wifi on

echo "[+] Asegurando que NetworkManager no toque wlan0..."
sudo bash -c 'cat > /etc/NetworkManager/conf.d/ignore-wlan0.conf <<EOF
[keyfile]
unmanaged-devices=interface-name:wlan0
EOF'

echo ""
echo "====================================="
echo " LIMPIEZA COMPLETADA "
echo " NetworkManager ya NO controla wlan0"
echo " Puedes usar hostapd sin conflictos"
echo "====================================="
echo ""
echo "Reinicia antes de ejecutar el script de hostapd:"
echo "    sudo reboot"
