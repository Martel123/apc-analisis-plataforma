#!/bin/bash
pkill -f "python3 -m http.server" 2>/dev/null || true
sleep 1
exec node server.js
