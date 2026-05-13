#!/usr/bin/env bash
# install/lib/detect.sh — OS / arch / package-manager detection

detect_os() { uname -s; }            # Darwin / Linux
detect_arch() { uname -m; }
detect_pkg() {
  if command -v brew >/dev/null 2>&1; then echo "brew"
  elif command -v apt-get >/dev/null 2>&1; then echo "apt"
  elif command -v dnf >/dev/null 2>&1; then echo "dnf"
  elif command -v pacman >/dev/null 2>&1; then echo "pacman"
  else echo "unknown"; fi
}
