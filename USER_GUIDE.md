# Voucher Webview App - User Guide

## Overview

The Voucher Webview App is an automated kiosk-style application built with Electron. It is designed to navigate to a specific URL (the "Target URL"), automatically refresh the page on a schedule, and recover from unexpected network errors, site redirect loops, dashboard redirects, and session expirations.

## Features

- **Auto-Refresh**: Automatically refreshes the target page at configured intervals.
- **Weekly Logout Schedule**: Forces logout and blocks access during configured weekly windows. When blocked, the app shows a local blocked page instead of leaving the site open.
- **Auto-Restart on Schedule**: Optionally restarts navigation immediately when the scheduled window begins.
- **Fail-Safe Session Recovery**: Automatically attempts to recover your session if the app encounters redirect loops, drops back to login, lands on the dashboard, or gets stuck away from the saved target page.
- **Interactive Configuration**: Access the configuration screen via the app to change settings without manually editing JSON files.
- **Log Splitting**: Application logs are automatically split into separate files per execution session and include timestamps for easier debugging.
- **Non-Obtrusive Status Bar**: A clean, fixed-height status bar at the bottom gives you quick access to configuration and app state without covering any page content.
- **Portable Writable Storage**: Packaged builds create a local `user-data` folder next to the executable for the live config file and generated logs.

## System Requirements

- Windows 10/11 (64-bit)
- Internet connection

*Note: `ffmpeg` library components are bundled as part of the standard Chromium engine inside Electron, allowing for media playback if the target site requires it.*

## Getting Started

### Quick Start

1. Prefer the portable build for distribution. Place `Voucher Webview App 1.0.0.exe` in its own folder before you run it.
2. Launch the app. On first start, the packaged build creates `user-data/app-config.json` next to the executable and uses that file for all future settings changes.
3. Open **Settings** from the bottom status bar button or from **Settings > Open Settings** in the top menu.
4. Set up your account credentials first in the **Credentials** section. Enter the username and password before testing anything else.
5. Set up and revise the **Weekly Logout Schedule** before going live. This is critical: if the blocking schedule is wrong, the user may remain logged in during prohibited hours, which can put the account at risk and may even get it banned.
6. Read and set the **Auto Refresh** toggle. Confirm whether it should be enabled, then review the interval and refresh strategy so the page behaves the way you expect.
7. Set the **Target URL** in the **Navigation** section of Settings. This is the normal and recommended way to change where the app should land.
8. Save your settings and confirm the status bar reflects the expected refresh and schedule state.

### Launching the App

Run the portable executable `Voucher Webview App 1.0.0.exe` from its own folder. The app will open and read its configuration immediately.

For packaged builds, keep the executable in a writable folder because the app stores `user-data/app-config.json` and session log files beside it.

### First Boot

1. Open **Settings** immediately and verify the saved values.
2. Confirm the **Credentials** section is complete.
3. Confirm the **Weekly Logout Schedule** is correct for the user and revise every blocked range that should not apply.
4. Confirm the **Auto Refresh** toggle and interval are correct.
5. Confirm the **Target URL** in the **Navigation** section points to the right destination.
6. Optionally test **Capture Current URL As Target**, **Navigate To Saved Target**, and **Restart Automation** from either Settings or the top menu.
7. Only after those checks should you let the app run unattended.

## Configuration (app-config.json)

The app reads its settings from `app-config.json`, but most users should use the built-in Settings UI instead of editing JSON directly. Use the file only for advanced manual changes or support/debugging.

- In development, the file is the workspace copy: `app-config.json`.
- In packaged builds, the live file is `user-data/app-config.json` next to the executable.
- On first packaged launch, the app copies the template config, then clears any bundled username and password values before writing the live file.

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
    "checkIntervalSeconds": 30,
    "blockedMessage": "Access to this web application is disabled during the current scheduled time window.",
    "weekly": {
      "monday": ["09:00-12:00", "14:00-18:00"],
      "tuesday": ["09:00-12:00"]
    }
  },
  "sessionRecovery": {
    "enabled": true,
    "cooldownMs": 8000,
    "restartDelayMs": 1200,
    "targetRetryLimit": 1,
    "dashboardRedirectRestart": true
  },
  "route": {
    "classId": "24974",
    "assetId": "85335"
  },
  "infoPanel": {
    "enabled": true,
    "position": "bottom-right",
    "showPageUrlWhenIdle": true
  }
}
```

### Settings Breakdown

- **startUrl**: The first page the app opens before it begins any automated login or navigation.
- **targetUrl**: The web address the application will monitor and display.
- **route.classId / route.assetId**: Stored values used to keep target URLs reusable when `classID` or `assetID` changes.
- **credentials.username / credentials.password**: The account details the app uses during automated login. Set these first.
- **authState.loggedInSelector**: Optional selector used to detect an already-authenticated page.
- **refresh.enabled**: Toggle to enable/disable the automatic refresh interval. Review this carefully before unattended use.
- **refresh.intervalSeconds**: Number of seconds to wait between automatic page refreshes.
- **refresh.strategy**: `goto` returns to the saved Target URL, while `reload` refreshes the current page.
- **refresh.timeoutMs**: Maximum time to wait for a refresh navigation to load.
- **accessSchedule.enabled**: Turns the blocking schedule on or off.
- **accessSchedule.restartNavigationWhenAllowed**: When true, the app automatically resumes navigation after a blocked window ends.
- **accessSchedule.checkIntervalSeconds**: How often the app reevaluates whether a blocked window has started or ended.
- **accessSchedule.blockedMessage**: Message shown on the local blocked page while access is disabled.
- **accessSchedule.weekly**: Per-day blocked time ranges in `HH:MM-HH:MM` format. Comma-separated, line-separated, and overnight ranges are supported.
- **sessionRecovery.enabled**: Enables automatic recovery when the app is pushed away from the saved target.
- **sessionRecovery.cooldownMs**: Minimum delay between recovery attempts.
- **sessionRecovery.restartDelayMs**: Wait before restarting the automation flow after a recovery trigger.
- **sessionRecovery.targetRetryLimit**: Number of extra target retries allowed before the app fully restarts the automation flow.
- **sessionRecovery.dashboardRedirectRestart**: Whether a redirect to the dashboard should trigger recovery.
- **infoPanel.enabled**: Controls whether the hover/focus target URL panel is shown.
- **infoPanel.position**: Chooses the corner where that panel is rendered.
- **infoPanel.showPageUrlWhenIdle**: Shows the current page URL in the panel when no interactive target is active.

## Application Menus

A top-level application menu provides quick actions:

- **Settings > Open Settings**: The easiest way to change credentials, Target URL, blocking schedule, and refresh behavior.
- **Settings > Enable Auto Refresh**: Toggle whether the auto-refresh loop is active.
- **Settings > Auto Restart After Schedule**: Quick toggle for `accessSchedule.restartNavigationWhenAllowed`.
- **Settings > Capture Current URL as Target**: Saves the current page as the target and normalizes matching `classID` and `assetID` parameters.
- **Settings > Navigate to Saved Target**: Immediately loads the saved target URL.
- **Settings > Restart Automation**: Reruns the configured login and navigation flow.
- **View > Toggle Target URL Panel**: Show or hide the target URL panel.

## Status Bar

Located at the bottom of the window is the Status Bar. It contains:

- **Status Readout**: Displays app state including the configured username and whether the target URL panel is visible.
- **Settings Toggle Button**: Click this compact button to open the Settings window and update credentials, schedule, refresh, or the Target URL without editing JSON.
- **Target Panel Toggle**: Lets you show or hide the in-page target URL panel without opening Settings.

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

- Check the **Status Bar** and **Weekly Logout Schedule** settings to ensure the app is not currently inside a blocked window.
- Ensure **Enable Auto Refresh** is enabled in the top menu or in Settings.
- If manually navigating freely, remember that the app won't redirect you if Auto-Refresh is disabled.
- If the site dropped you back to login or the dashboard, use **Restart Automation** or verify **Session Recovery** is enabled.

### Finding Logs

The app splits logs automatically. In packaged builds they are written into the local `user-data` folder beside the executable. In development they are written under Electron's user-data directory. Each log file is uniquely named with the execution session timestamp and usually includes the configured username as a prefix.

### Infinite Redirects

If the target website encounters a glitch and throws the app into a redirect loop, or bounces the session back to the dashboard, the app's **Session Recovery** system will automatically detect this and attempt to re-stabilize the navigation by cooling down briefly before retrying the target URL or restarting the automation flow.
