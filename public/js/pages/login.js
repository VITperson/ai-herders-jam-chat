(function () {
  const form = document.getElementById('login-form');
  const err = document.getElementById('err');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    const login = document.getElementById('login-id').value.trim();
    const password = document.getElementById('login-password').value;
    try {
      await api.post('/api/auth/login', { login, password });
      location.href = '/app.html';
    } catch (ex) {
      err.textContent = ex.message || 'Login failed';
    }
  });
  // If already logged in, bounce.
  api.get('/api/auth/me').then(() => { location.href = '/app.html'; }).catch(() => {});
})();
