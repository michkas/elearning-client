# Voucher Webview App - User Guide

## Overview

The Voucher Webview App is an automated kiosk-style application built with Electron. It is designed to navigate to a specific URL (the "Target URL") and automatically refresh the page on a schedule, while ensuring the application recovers from unexpected network errors, site redirect loops, and session expirations.

## Features

- **Auto-Refresh**: Automatically refreshes the target page at configured intervals.
- **Schedule Management**: Only allows navigation and refreshing during a specified daily schedule. If out-of-schedule, the app waits on a dashboard page.
- **Auto-Restart on Schedule**: Optionally restarts navigation immediately when the scheduled window begins.
- **Fail-Safe Session Recovery**: Automatically attempts to recover your session if the app encounters infinite redirect loops or gets stuck in non-target pages.
- **Interactive Configuration**: Access the configuration screen via the app to change settings without manually editing JSON files.
- **Log Splitting**: Application logs are automatically split into separate files per execution session and include timestamps for easier debugging.
- **Non-Obtrusive Status Bar**: A clean, fixed-height status bar at the bottom gives you quick access to configuration and app state without covering any page content.

## System Requirements

- Windows 10/11 (64-bit)
- Internet connection

*Note: `ffmpeg` library components are bundled as part of the standard Chromium engine inside Electron, allowing for media playback if the target site requires it.*

## Getting Started

### Launching the App
Run the executable file `Voucher Webview App.exe` or `Main` from your unzipped package folder. The app will open and immediately read the `app-config.json` file.

### First Boot
1. The app will load the target URL defined in the configuration.
2. The bottom status bar will indicate the current refresh status and the countdown timer.
3. If you are outside of the allowed schedule, the app will show an "Out of Schedule" message and pause operations until the allowed time window begins.

## Configuration (app-config.json)

The app reads its settings from `app-config.json`. You can modify this file directly or use the built-in Settings UI.

```json
{
  "targetUrl": "https://example.com/voucher",
  "refresh": {
    "enabled": true,
    "intervalSeconds": 300,
    "restartNavigationWhenAllowed": true
  },
  "schedule": {
    "enabled": true,
    "allowedHours": [9, 10, 11, 12, 13, 14, 15, 16, 17]
  }
}
```

### Settings Breakdown

- **targetUrl**: The web address the application will monitor and display.
- **refresh.enabled**: Toggle to enable/disable the automatic refresh interval. When disabled, you are free to manually navigate without the app trying to pull you back to the target URL.
- **refresh.intervalSeconds**: Number of seconds to wait between automatic page refreshes.
- **refresh.restartNavigationWhenAllowed**: When true, the app will automatically load the Target URL as soon as the scheduled `allowedHours` begins (e.g., at exactly 9:00 AM).
- **schedule.enabled**: Turns the daily schedule restrictions on or off. 
- **schedule.allowedHours**: A list of hours (in 24-hour format) during which the application is actively allowed to run and navigate. 

## Application Menus

A top-level application menu provides quick actions:
- **Refresh**: Manually trigged a page reload.
- **Auto-Refresh**: Toggle whether the auto-refresh loop is active.
- **Restart Navigation on Schedule**: Quick toggle for the `restartNavigationWhenAllowed` feature.

## Status Bar

Located at the bottom of the window is the Status Bar. It contains:
- **Status Readout**: Displays countdown timers, current schedule state, and the target URL.
- **Settings Toggle Button**: Click this compact button to open the Configuration UI.

## Troubleshooting

### App Not Navigating
- Check the **Status Bar** to ensure you are within the allowed schedule window.
- Ensure **Auto-Refresh** is enabled in the top native menu or Settings.
- If manually navigating freely, remember that the app won't redirect you if Auto-Refresh is disabled.

### Finding Logs
The app splits logs automatically. You can find your log files in the same relative directory or user-data location. Each log file is uniquely named with the execution session timestamp to keep things organized.

### Infinite Redirects
If the target website encounters a glitch and throws the app into a redirect loop, the app's **Session Recovery** system will automatically detect this and attempt to re-stabilize the navigation by cooling down for a few seconds before retrying the target URL.
