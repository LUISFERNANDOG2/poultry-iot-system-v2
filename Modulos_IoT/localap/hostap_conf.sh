#!/bin/bash

echo "[+] Instalando dependencias..."
sudo apt update
sudo apt install -y hostapd dnsmasq

echo "[+] Deteniendo servicios antes de configurar..."
sudo systemctl stop hostapd
sudo systemctl stop dnsmasq

SSID="${AP_SSID:-Modulo_Local}"
PASS="${AP_PASSWORD:-CHANGE_ME_LOCAL_AP_PASSWORD}"

echo "[+] Desactivando NetworkManager para wlan0..."
sudo mkdir -p /etc/NetworkManager/conf.d
sudo bash -c 'cat > /etc/NetworkManager/conf.d/unmanaged-wlan0.conf <<EOF
[keyfile]
unmanaged-devices=interface-name:wlan0
EOF'

sudo systemctl restart NetworkManager

echo "[+] Configurando IP estática en dhcpcd.conf sin borrar el archivo..."
sudo sed -i '/interface wlan0/,+3d' /etc/dhcpcd.conf

sudo bash -c 'cat >> /etc/dhcpcd.conf <<EOF

interface wlan0
static ip_address=10.10.0.1/24
nohook wpa_supplicant
EOF'

echo "[+] Configurando dnsmasq (DHCP server)..."
sudo mv /etc/dnsmasq.conf /etc/dnsmasq.conf.bak 2>/dev/null

sudo bash -c 'cat > /etc/dnsmasq.conf <<EOF
interface=wlan0
dhcp-range=10.10.0.10,10.10.0.200,255.255.255.0,24h
dhcp-option=3,10.10.0.1
dhcp-option=6,10.10.0.1
EOF'

echo "[+] Configurando hostapd..."
sudo bash -c "cat > /etc/hostapd/hostapd.conf <<EOF
interface=wlan0
driver=nl80211
ssid=$SSID
hw_mode=g
channel=6
wmm_enabled=1
auth_algs=1
ignore_broadcast_ssid=0
wpa=2
wpa_passphrase=$PASS
wpa_key_mgmt=WPA-PSK
rsn_pairwise=CCMP
EOF"

echo 'DAEMON_CONF="/etc/hostapd/hostapd.conf"' | sudo tee /etc/default/hostapd >/dev/null

echo "[+] Habilitando IP forwarding..."
sudo bash -c 'echo "net.ipv4.ip_forward=1" > /etc/sysctl.d/routed-ap.conf'
sudo sysctl -p /etc/sysctl.d/routed-ap.conf

echo "[+] Configurando reglas NAT persistentes..."
sudo iptables -t nat -F
sudo iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE

sudo sh -c "iptables-save > /etc/iptables.ipv4.nat"

sudo bash -c 'cat > /etc/rc.local <<EOF
#!/bin/sh -e
iptables-restore < /etc/iptables.ipv4.nat
exit 0
EOF'

sudo chmod +x /etc/rc.local
sudo systemctl enable rc-local.service 2>/dev/null

echo "[+] Habilitando servicios..."
sudo systemctl unmask hostapd
sudo systemctl enable hostapd
sudo systemctl enable dnsmasq

sudo systemctl restart dhcpcd
sudo systemctl restart dnsmasq
sudo systemctl restart hostapd

echo ""
echo "============================================="
echo "   AP configurado correctamente"
echo "   SSID: $SSID"
echo "   Password: $PASS"
echo "   IP del AP: 10.10.0.1"
echo "============================================="
echo ""
echo "[+] Reinicia la Raspberry Pi:"
echo "    sudo reboot"


