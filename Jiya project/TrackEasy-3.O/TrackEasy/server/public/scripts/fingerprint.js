/**
 * Browser Fingerprinting Utility
 * Generates a unique hash for the browser based on device characteristics.
 */

async function generateHash(input) {
  const msgUint8 = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

function getCanvasFingerprint() {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return 'no-canvas';
  
  canvas.width = 200;
  canvas.height = 50;
  
  // Create a complex visual pattern
  ctx.textBaseline = "top";
  ctx.font = "14px 'Arial'";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#f60";
  ctx.fillRect(125,1,62,20);
  ctx.fillStyle = "#069";
  ctx.fillText("TrackEasy-Fingerprint-V1", 2, 15);
  ctx.fillStyle = "rgba(102, 204, 0, 0.7)";
  ctx.fillText("TrackEasy-Fingerprint-V1", 4, 17);
  
  return canvas.toDataURL();
}

export async function getBrowserFingerprint() {
  const components = [
    navigator.userAgent,
    navigator.language,
    screen.colorDepth,
    screen.width + "x" + screen.height,
    new Date().getTimezoneOffset(),
    !!window.sessionStorage,
    !!window.localStorage,
    !!window.indexedDB,
    getCanvasFingerprint()
  ];
  
  const fingerprintString = components.join('|');
  return await generateHash(fingerprintString);
}
