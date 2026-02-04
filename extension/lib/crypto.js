/**
 * Perkins Crypto Utilities
 * Handles API key encryption/decryption using Web Crypto API
 *
 * Note: This provides encryption at rest. The key derivation uses a
 * device-specific salt stored in chrome.storage.local. This protects
 * against casual snooping but not a determined attacker with full
 * browser access.
 */

const ALGORITHM = 'AES-GCM';
const KEY_LENGTH = 256;
const SALT_KEY = 'perkins_crypto_salt';
const IV_LENGTH = 12;

/**
 * Get or create a device-specific salt
 */
async function getSalt() {
  const stored = await chrome.storage.local.get([SALT_KEY]);
  if (stored[SALT_KEY]) {
    return new Uint8Array(stored[SALT_KEY]);
  }

  // Generate new salt
  const salt = crypto.getRandomValues(new Uint8Array(16));
  await chrome.storage.local.set({ [SALT_KEY]: Array.from(salt) });
  return salt;
}

/**
 * Derive an encryption key from the extension ID + salt
 * This ties the encryption to this specific extension installation
 */
async function deriveKey() {
  const salt = await getSalt();

  // Use extension ID as base key material (unique per installation)
  const baseKey = chrome.runtime.id || 'perkins-extension';
  const encoder = new TextEncoder();

  // Import base key
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(baseKey),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  // Derive AES key
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt,
      iterations: 100000,
      hash: 'SHA-256'
    },
    keyMaterial,
    { name: ALGORITHM, length: KEY_LENGTH },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypt a string (e.g., API key)
 * @param {string} plaintext - The text to encrypt
 * @returns {Promise<string>} - Base64 encoded encrypted data (iv + ciphertext)
 */
export async function encrypt(plaintext) {
  if (!plaintext) return '';

  try {
    const key = await deriveKey();
    const encoder = new TextEncoder();
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));

    const ciphertext = await crypto.subtle.encrypt(
      { name: ALGORITHM, iv },
      key,
      encoder.encode(plaintext)
    );

    // Combine IV + ciphertext
    const combined = new Uint8Array(iv.length + ciphertext.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(ciphertext), iv.length);

    // Return as base64
    return btoa(String.fromCharCode(...combined));
  } catch (err) {
    console.error('Encryption failed:', err);
    throw new Error('Failed to encrypt data');
  }
}

/**
 * Decrypt a string
 * @param {string} encryptedBase64 - Base64 encoded encrypted data
 * @returns {Promise<string>} - Decrypted plaintext
 */
export async function decrypt(encryptedBase64) {
  if (!encryptedBase64) return '';

  try {
    const key = await deriveKey();

    // Decode base64
    const combined = Uint8Array.from(atob(encryptedBase64), c => c.charCodeAt(0));

    // Extract IV and ciphertext
    const iv = combined.slice(0, IV_LENGTH);
    const ciphertext = combined.slice(IV_LENGTH);

    const decrypted = await crypto.subtle.decrypt(
      { name: ALGORITHM, iv },
      key,
      ciphertext
    );

    return new TextDecoder().decode(decrypted);
  } catch (err) {
    console.error('Decryption failed:', err);
    // Return empty string on failure (key might have been stored before encryption)
    return '';
  }
}

/**
 * Check if a string looks like it's already encrypted (base64 with min length)
 */
export function isEncrypted(value) {
  if (!value || value.length < 20) return false;
  // Check if it's valid base64 and doesn't look like a raw API key
  const base64Regex = /^[A-Za-z0-9+/]+=*$/;
  const looksLikeApiKey = value.startsWith('sk-') || value.startsWith('sk-ant-');
  return base64Regex.test(value) && !looksLikeApiKey;
}
