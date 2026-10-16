#!/bin/bash
# =====================================================================
# OEE Dashboard Kiosk Mode Launcher
# Tunggu backend FastAPI aktif di port 8000 sebelum membuka Chromium
# =====================================================================

# Sembunyikan kursor jika tidak disentuh (opsional, jika unclutter terpasang)
if command -v unclutter >/dev/null 2>&1; then
    unclutter -idle 2 -root &
fi

# Tunggu backend FastAPI online
echo "Menunggu OEE backend online..."
for i in {1..30}; do
    if curl -s http://127.0.0.1:8000/api/health >/dev/null 2>&1; then
        echo "Backend online!"
        break
    fi
    sleep 1
done

# Matikan mode screensaver / blanking layar
xset s off -dpms 2>/dev/null || true

# Buka Chromium dalam mode Kiosk Fullscreen (tanpa toolbar, tanpa pop-up update/error)
# Menggunakan chromium-browser atau chromium sesuai OS
BROWSER_CMD="chromium-browser"
if ! command -v chromium-browser >/dev/null 2>&1; then
    BROWSER_CMD="chromium"
fi

exec $BROWSER_CMD \
    --kiosk \
    --noerrdialogs \
    --disable-infobars \
    --no-first-run \
    --fast \
    --fast-start \
    --disable-pinch \
    --overscroll-history-navigation=0 \
    --disable-features=Translate \
    --check-for-update-interval=31536000 \
    --app=http://127.0.0.1:8000
