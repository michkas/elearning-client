# Voucher Webview App

This Electron app opens a website in a desktop window, performs a configurable login/navigation flow, and refreshes the page on a timer.

## What it does

- Loads a configured website URL in a desktop window.
- Runs scripted login and navigation steps.
- Detects when the start page already represents an authenticated session and can skip the login form.
- Keeps refreshing the page at a fixed interval.
- Disables Chromium background throttling so JavaScript timers and page activity continue while the app window is unfocused.
- Shows an in-page info panel with the target URL of the currently hovered or focused interactive element.
- Provides a View menu and a Settings menu for panel control, URL capture, runtime navigation, and configuration editing.
- Detects redirects away from the target page and can automatically restart the login/navigation flow.
- Can enforce a weekly logout schedule that clears the active session and blocks access during configured windows.

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Edit `app-config.json` with the real values for:

- `startUrl`
- `targetUrl`
- `route.classId`
- `route.assetId`
- `credentials.username`
- `credentials.password`
- `authState.loggedInSelector`
- `accessSchedule.enabled`
- `accessSchedule.weekly`
- `infoPanel.enabled`
- `infoPanel.position`
- `flow` selectors and actions for your website

3. Start the app:

   ```bash
   npm start
   ```

## Menus

- View -> Toggle Target URL Panel toggles the in-page caption and is also available on `Ctrl+Shift+U`.
- Settings -> Open Settings opens a desktop settings window for URLs, credentials, refresh behavior, window size, and panel options.
- Settings -> Enable Auto Refresh is a persistent menu-bar checkbox that immediately turns the refresh loop on or off.
- Settings -> Open Settings also lets you configure automatic session recovery when the server drops you back to login or another page.
- Settings -> Open Settings also lets you configure weekly blocked windows where the app must log out and keep the site inaccessible.
- Settings -> Capture Current URL as Target stores the current page as the saved target, extracts `classID` and `assetID` when present, and rewrites the URL into a reusable template.
- Settings -> Navigate to Saved Target loads the saved target URL immediately.
- Settings -> Restart Automation reruns the login and navigation flow using the current saved settings.

## Flow actions

The `flow` array supports these actions:

- `wait`: pause for a number of milliseconds
- `waitForSelector`: wait until an element exists
- `type`: set an input value and fire input/change events
- `click`: click an element, optionally waiting for a full page navigation
- `clickIfExists`: poll for an element and click it if it appears before timeout
- `goto`: navigate directly to a URL
- `waitForUrlContains`: wait until the current URL contains a specific string

## Notes

- Session data is stored in a persistent Electron partition, so cookies can survive app restarts.
- The default destination URL is templated from `route.classId` and `route.assetId`, so when only the asset changes you only need to update that one number.
- The Settings window edits the persisted `app-config.json` file for you, so changes remain after the app closes.
- Capturing the current URL persists `classID` and `assetID` separately and normalizes matching URLs to use `{{CLASS_ID}}` and `{{ASSET_ID}}`, so later edits to those fields remain effective.
- If the start page shows an already-logged-in banner instead of username/password inputs, configure `authState.loggedInSelector` and the app will skip straight to the target page.
- Session recovery watches steady-state navigations after login. If the app is redirected away from the target page path, it can pause briefly and restart the automation flow automatically.
- The weekly logout schedule accepts `HH:MM-HH:MM` ranges per weekday. When a blocked window starts, the app clears the browser session, shows a local blocked page, and only resumes automation after the schedule opens again.
- The info panel tracks interactive elements in the main page and any same-origin iframes. Cross-origin iframe content cannot be inspected by the app because of browser security boundaries.
- Some websites use anti-automation protections, multi-factor auth, or custom JS controls. In those cases you may need to adjust the selectors and flow steps.
- If the site is a single-page app, prefer `waitForSelector` or `waitForUrlContains` rather than relying only on full page navigation events.