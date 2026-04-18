(function () {
  const form = document.getElementById('register-form');
  const err = document.getElementById('err');
  function validatePw(p) {
    return p.length >= 8 && /\d/.test(p);
  }
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    const email = document.getElementById('r-email').value.trim();
    const username = document.getElementById('r-username').value.trim();
    const password = document.getElementById('r-password').value;
    const password2 = document.getElementById('r-password2').value;
    if (!validatePw(password)) { err.textContent = 'Password must be ≥ 8 chars and contain at least 1 digit.'; return; }
    if (password !== password2) { err.textContent = 'Passwords do not match.'; return; }
    try {
      await api.post('/api/auth/register', { email, username, password });
      location.href = '/app.html';
    } catch (ex) {
      err.textContent = ex.message || 'Registration failed';
    }
  });
})();
