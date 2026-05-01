# Build And Run Commands

This project uses the npm scripts defined in `package.json`.

## Install Dependencies

Run this once after cloning or whenever dependencies change:

```bash
npm install
```

## Run In Development

Starts the Electron app directly from the workspace:

```bash
npm start
```

Notes:

- Uses `src/main.js` as the Electron entry point.
- Reads the local workspace config file `app-config.json`.

## Build Portable Windows App

Creates a portable Windows build with Electron Builder:

```bash
npm run build
```

Output:

- Writes build artifacts to `dist/`.

## Build Distribution Packages

Creates both NSIS installer output and a portable build with Electron Builder:

```bash
npm run dist
```

Output:

- Writes distribution artifacts to `dist/`.

## Package Unpacked Windows App

Creates an unpacked Windows application folder with Electron Packager:

```bash
npm run package-win
```

Output:

- Writes the packaged app folder to `dist-packager/`.

## Typical Workflow

1. Install dependencies:

   ```bash
   npm install
   ```

2. Run the app locally while developing:

   ```bash
   npm start
   ```

3. Build a portable executable when you want a release artifact:

   ```bash
   npm run build
   ```

4. Build full distribution artifacts when you need installer output:

   ```bash
   npm run dist
   ```

5. Package an unpacked Windows app folder when you want a raw packaged directory:

   ```bash
   npm run package-win
   ```
