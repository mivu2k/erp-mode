import type { CapacitorConfig } from '@capacitor/cli';

/**
 * The app is the hosted web ERP inside a native shell. The web code already uses the native-capable
 * browser APIs (Web NFC, BarcodeDetector camera scan, geolocation, window.print), which the Android
 * WebView exposes; add @capacitor-community plugins only where a WebView lacks one (e.g. iOS NFC, ESC/POS over BT).
 */
const config: CapacitorConfig = {
  appId: 'com.example.erp',
  appName: 'ERP',
  webDir: 'www',
  server: { url: process.env.ERP_URL ?? 'https://erp.example.com', cleartext: false },
  android: { allowMixedContent: false },
};
export default config;
