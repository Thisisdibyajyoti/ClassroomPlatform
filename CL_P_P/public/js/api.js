// public/js/api.js
async function api(path, body) {
  const opts = {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' }
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  return res.json();
}

async function apiAuth(path, body) {
  const token = localStorage.getItem('token');
  if (!token) {
    location.href = 'index.html';
    return;
  }
  const opts = {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  if (res.status === 401) {
    localStorage.clear();
    location.href = 'index.html';
    return;
  }
  return res.json();
}

async function me() {
  const token = localStorage.getItem('token');
  if (!token) { location.href = 'index.html'; return; }
  const res = await fetch('/api/me', { headers: { 'Authorization': 'Bearer ' + token } });
  if (res.status === 401) { localStorage.clear(); location.href = 'index.html'; return; }
  return res.json();
}
