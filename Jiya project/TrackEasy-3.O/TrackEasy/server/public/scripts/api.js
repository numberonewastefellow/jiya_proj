import { getBrowserFingerprint } from './fingerprint.js';
const API_BASE = '/api';

async function authHeaders() {
  const token = localStorage.getItem('authToken');
  const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
  
  try {
    const fingerprint = await getBrowserFingerprint();
    headers['x-device-fingerprint'] = fingerprint;
  } catch (e) {
    console.error('Error attaching fingerprint to headers', e);
  }
  
  return headers;
}

export async function get(path) {
  const headers = await authHeaders();
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'GET',
    headers: headers
  });
  return res.json();
}

export async function post(path, body) {
  const isFormData = body instanceof FormData;
  const headers = await authHeaders();
  if (!isFormData) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: headers,
    body: isFormData ? body : JSON.stringify(body)
  });
  return res.json();
}

export async function patch(path, body) {
  const headers = await authHeaders();
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
  return res.json();
}

export async function put(path, body) {
  const isFormData = body instanceof FormData;
  const headers = await authHeaders();
  if (!isFormData) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(`${API_BASE}${path}`, {
    method: 'PUT',
    headers: headers,
    body: isFormData ? body : JSON.stringify(body)
  });
  return res.json();
}

export async function del(path) {
  const headers = await authHeaders();
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'DELETE',
    headers: headers
  });
  return res.json();
}

export default { get, post, patch, put, del };
