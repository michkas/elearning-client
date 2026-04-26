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

### Quick Start

1. Prefer the portable build for distribution. Place `Voucher Webview App 1.0.0.exe` in its own folder before you run it.
2. Launch the app, then open **Settings** from the bottom status bar button or from **Settings > Open Settings** in the top menu.
3. Set up your account credentials first in the **Credentials** section. Enter the username and password before testing anything else.
4. Set up and revise the **Weekly Logout Schedule** before going live. If this blocking schedule is wrong, the app can intentionally log out the user and block access during the wrong time window.
5. Read and set the **Auto Refresh** toggle. Confirm whether it should be enabled, then review the interval and refresh strategy so the page behaves the way you expect.
6. Set the **Target URL** in the **Navigation** section of Settings. This is the easiest way to change where the app should land without editing JSON by hand.
7. Save your settings and confirm the status bar reflects the expected refresh and schedule state.

### Launching the App

Run the portable executable `Voucher Webview App 1.0.0.exe` from its own folder. The app will open and read its configuration immediately.

### First Boot

1. Open **Settings** immediately and verify the saved values.
2. Confirm the **Credentials** section is complete.
3. Confirm the **Weekly Logout Schedule** is correct for the user and revise every blocked range that should not apply.
4. Confirm the **Auto Refresh** toggle and interval are correct.
5. Confirm the **Target URL** in the **Navigation** section points to the right destination.
6. Only after those checks should you let the app run unattended.

## Configuration (app-config.json)

The app reads its settings from `app-config.json`. You can modify this file directly or use the built-in Settings UI.

```json
{
  "startUrl": "https://example.com/login",
  "targetUrl": "https://example.com/voucher",
  "credentials": {
    "username": "your-username",
    "password": "your-password"
  },
  "authState": {
    "loggedInSelector": "#already-logged-in"
  },
  "refresh": {
    "enabled": true,
    "intervalSeconds": 300,
    "strategy": "goto"
  },
  "accessSchedule": {
    "enabled": true,
    "restartNavigationWhenAllowed": true,
    "weekly": {
      "monday": ["09:00-12:00", "14:00-18:00"],
      "tuesday": ["09:00-12:00"]
    }
  }
}
```

### Settings Breakdown

- **startUrl**: The first page the app opens before it begins any automated login or navigation.
- **targetUrl**: The web address the application will monitor and display.
- **credentials.username / credentials.password**: The account details the app uses during automated login. Set these first.
- **authState.loggedInSelector**: Optional selector used to detect an already-authenticated page.
- **refresh.enabled**: Toggle to enable/disable the automatic refresh interval. Review this carefully before unattended use.
- **refresh.intervalSeconds**: Number of seconds to wait between automatic page refreshes.
- **refresh.strategy**: `goto` returns to the saved Target URL, while `reload` refreshes the current page.
- **accessSchedule.enabled**: Turns the blocking schedule on or off.
- **accessSchedule.restartNavigationWhenAllowed**: When true, the app automatically resumes navigation after a blocked window ends.
- **accessSchedule.weekly**: Per-day blocked time ranges in `HH:MM-HH:MM` format. Review these ranges carefully before use.

## Application Menus

A top-level application menu provides quick actions:

- **Settings > Open Settings**: The easiest way to change credentials, Target URL, blocking schedule, and refresh behavior.
- **Settings > Enable Auto Refresh**: Toggle whether the auto-refresh loop is active.
- **Settings > Auto Restart After Schedule**: Quick toggle for `accessSchedule.restartNavigationWhenAllowed`.
- **View > Toggle Target URL Panel**: Show or hide the target URL panel.

## Status Bar

Located at the bottom of the window is the Status Bar. It contains:

- **Status Readout**: Displays countdown timers, current schedule state, and the target URL.
- **Settings Toggle Button**: Click this compact button to open the Settings window and update credentials, schedule, refresh, or the Target URL without editing JSON.

## Recommended Setup Order

1. Use the portable build and keep each user or account in its own folder.
2. Open **Settings**.
3. Enter the account credentials first.
4. Set up and revise the **Weekly Logout Schedule** so the blocking windows are correct.
5. Read and set the **Enable Auto Refresh** toggle and its interval.
6. Set or revise the **Target URL** in **Navigation**.
7. Save the settings and verify the status bar.

## Troubleshooting

### App Not Navigating

- Check the **Status Bar** to ensure you are within the allowed schedule window.
- Ensure **Enable Auto Refresh** is enabled in the top menu or in Settings.
- If manually navigating freely, remember that the app won't redirect you if Auto-Refresh is disabled.

### Finding Logs

The app splits logs automatically. You can find your log files in the same relative directory or user-data location. Each log file is uniquely named with the execution session timestamp to keep things organized.

### Infinite Redirects

If the target website encounters a glitch and throws the app into a redirect loop, the app's **Session Recovery** system will automatically detect this and attempt to re-stabilize the navigation by cooling down for a few seconds before retrying the target URL.
