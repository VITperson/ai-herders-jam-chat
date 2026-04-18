(function () {
  const rq = document.getElementById('req-form');
  const rs = document.getElementById('reset-form');
  const rqErr = document.getElementById('rq-err');
  const rqOk = document.getElementById('rq-ok');
  const rsErr = document.getElementById('rs-err');
  const rsOk = document.getElementById('rs-ok');
  const tokenField = document.getElementById('rs-token');

  rq.addEventListener('submit', async (e) => {
    e.preventDefault();
    rqErr.textContent = ''; rqOk.textContent = '';
    const email = document.getElementById('rq-email').value.trim();
    try {
      const r = await api.post('/api/auth/password/reset-request', { email });
      const token = (r && (r.token || r.reset_token)) || '';
      if (token) {
        rqOk.innerHTML = 'Token: <code>' + token + '</code> — copied into the form below.';
        tokenField.value = token;
      } else {
        rqOk.textContent = 'If the email exists, a reset token has been generated.';
      }
    } catch (ex) {
      rqErr.textContent = ex.message || 'Request failed';
    }
  });

  rs.addEventListener('submit', async (e) => {
    e.preventDefault();
    rsErr.textContent = ''; rsOk.textContent = '';
    const token = tokenField.value.trim();
    const newPassword = document.getElementById('rs-pw').value;
    if (newPassword.length < 8 || !/\d/.test(newPassword)) { rsErr.textContent = 'Password must be ≥ 8 chars and contain at least 1 digit.'; return; }
    try {
      await api.post('/api/auth/password/reset', { token, newPassword, new_password: newPassword });
      rsOk.textContent = 'Password reset. You can now sign in.';
    } catch (ex) {
      rsErr.textContent = ex.message || 'Reset failed';
    }
  });
})();
