// Thin fetch wrapper. Always sends cookies (same-origin).
(function () {
  async function request(method, path, body, isForm) {
    const opts = {
      method,
      credentials: 'include',
      headers: {},
    };
    if (body !== undefined && body !== null) {
      if (isForm) {
        opts.body = body; // FormData
      } else {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
      }
    }
    const res = await fetch(path, opts);
    const ct = res.headers.get('content-type') || '';
    let data = null;
    if (ct.includes('application/json')) {
      data = await res.json().catch(() => null);
    } else {
      data = await res.text().catch(() => '');
    }
    if (!res.ok) {
      const msg = (data && data.error && data.error.message) || (data && data.error) || res.statusText || 'request failed';
      const err = new Error(typeof msg === 'string' ? msg : 'request failed');
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  window.api = {
    get: (p) => request('GET', p),
    post: (p, b) => request('POST', p, b),
    patch: (p, b) => request('PATCH', p, b),
    del: (p) => request('DELETE', p),
    upload: async (path, file) => {
      const fd = new FormData();
      fd.append('file', file, file.name || 'blob');
      return request('POST', path, fd, true);
    },
  };
})();
